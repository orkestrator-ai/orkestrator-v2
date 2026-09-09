import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { StructuredOutputProvider } from "@orkestrator/protocol/structured-output";
import {
  isReviewFindingPool,
  safeParseStructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import {
  WORKFLOW_RESULT_MAX_BYTES,
  WORKFLOW_RESULT_MAX_ENTRIES,
  WORKFLOW_RESULT_MAX_PENDING_BYTES,
  WORKFLOW_RESULT_MAX_PENDING_CALLS,
  WORKFLOW_RESULT_MAX_PENDING_CALLS_PER_KEY,
  WORKFLOW_RESULT_MAX_REJECTIONS,
  WORKFLOW_RESULT_SCHEMA_VERSION,
  WORKFLOW_RESULT_STORE_VERSION,
  isWorkflowResultKind,
  type WorkflowResultKind,
  type WorkflowResultReceipt,
  type WorkflowResultSlotInput,
  type WorkflowResultStatus,
  type WorkflowResultSubmission,
  type WorkflowResultSubmissionState,
} from "@orkestrator/protocol/workflow-results";
import { validateWorkflowResult } from "./workflow-result-contracts.js";
import { WorkflowResultMetrics } from "./workflow-result-metrics.js";

const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_CAPABILITY_IDENTITY_BYTES = 4 * 1024;
const CAPABILITY_IDENTITY_VERSION = 1;

interface WorkflowResultCapabilityIdentity {
  version: 1;
  secret: string;
  port?: number;
}

export interface WorkflowResultCallerScope {
  environmentId: string;
  projectId: string;
}

interface StoredWorkflowResult extends WorkflowResultSlotInput {
  schemaVersion: number;
  lifecycle: "open" | "accepted" | "consumed" | "cancelled" | "superseded";
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  digest?: string;
  receipt?: WorkflowResultReceipt;
  rejectedDigests: string[];
  /** First delivery attempt, used only for the acceptance-latency metric. */
  firstSubmissionAt?: string;
}

interface WorkflowResultStore {
  version: 1;
  entries: Record<string, StoredWorkflowResult>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, canonical(source[key])]),
  );
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(canonical(value));
  if (serialized === undefined) throw new Error("Result is not JSON serializable");
  return serialized;
}

const STRUCTURED_OUTPUT_PROVIDERS = new Set<StructuredOutputProvider>([
  "claude",
  "codex",
  "opencode",
  "cursor",
  "grok",
  "pi",
]);

function validReceipt(value: unknown, entry: Partial<StoredWorkflowResult>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<WorkflowResultReceipt>;
  return (
    receipt.version === 1 &&
    receipt.resultKey === entry.resultKey &&
    receipt.kind === entry.kind &&
    receipt.schemaVersion === entry.schemaVersion &&
    typeof receipt.receiptId === "string" &&
    typeof receipt.acceptedAt === "string"
  );
}

function validContext(value: WorkflowResultSlotInput["context"]): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.type === "review-reconciliation") {
    return isReviewFindingPool(value.pool) && safeParseStructuredReviewReport(value.report).success;
  }
  return (
    value.type === "consolidated-review" &&
    value.sources !== null &&
    typeof value.sources === "object" &&
    !Array.isArray(value.sources) &&
    Object.keys(value.sources).length <= 4_096 &&
    Object.values(value.sources).every(
      (candidate) => candidate === "issue" || candidate === "coverage-gap",
    )
  );
}

function validStoredEntry(key: string, value: unknown): value is StoredWorkflowResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<StoredWorkflowResult>;
  const validIdentity =
    entry.resultKey === key &&
    isWorkflowResultKind(entry.kind) &&
    typeof entry.environmentId === "string" &&
    typeof entry.projectId === "string" &&
    STRUCTURED_OUTPUT_PROVIDERS.has(entry.provider as StructuredOutputProvider) &&
    (entry.expectedStoryId === undefined || typeof entry.expectedStoryId === "string") &&
    validContext(entry.context) &&
    entry.schemaVersion === WORKFLOW_RESULT_SCHEMA_VERSION &&
    ["open", "accepted", "consumed", "cancelled", "superseded"].includes(String(entry.lifecycle)) &&
    typeof entry.createdAt === "string" &&
    typeof entry.updatedAt === "string" &&
    (entry.firstSubmissionAt === undefined || typeof entry.firstSubmissionAt === "string") &&
    Array.isArray(entry.rejectedDigests) &&
    entry.rejectedDigests.every(
      (candidate) => typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate),
    );
  if (!validIdentity) return false;
  if (entry.lifecycle === "open") {
    return entry.result === undefined && entry.digest === undefined && entry.receipt === undefined;
  }
  if (entry.lifecycle === "accepted") {
    return (
      entry.result !== undefined &&
      typeof entry.digest === "string" &&
      /^[a-f0-9]{64}$/.test(entry.digest) &&
      validReceipt(entry.receipt, entry)
    );
  }
  if (entry.lifecycle === "consumed") {
    return (
      entry.result === undefined &&
      typeof entry.digest === "string" &&
      /^[a-f0-9]{64}$/.test(entry.digest) &&
      validReceipt(entry.receipt, entry)
    );
  }
  if (entry.result !== undefined) return false;
  if (entry.receipt === undefined && entry.digest === undefined) return true;
  return (
    typeof entry.digest === "string" &&
    /^[a-f0-9]{64}$/.test(entry.digest) &&
    validReceipt(entry.receipt, entry)
  );
}

/** Durable result inbox shared by workflow controllers and the agent tool server. */
export class WorkflowResultService {
  private readonly filePath: string;
  private readonly capabilityIdentityPath: string;
  private capabilityIdentity: WorkflowResultCapabilityIdentity | null = null;
  private mutation: Promise<unknown> = Promise.resolve();
  private pendingCalls = 0;
  private pendingBytes = 0;
  private readonly pendingCallsByKey = new Map<string, number>();
  readonly metrics: WorkflowResultMetrics;

  constructor(dataDir: string, metrics: WorkflowResultMetrics = new WorkflowResultMetrics()) {
    this.filePath = path.join(dataDir, "workflow-results.json");
    this.capabilityIdentityPath = path.join(dataDir, "workflow-result-tools.json");
    this.metrics = metrics;
  }

  async initializeCapabilityIdentity(): Promise<void> {
    if (this.capabilityIdentity) return;
    await mkdir(path.dirname(this.capabilityIdentityPath), { recursive: true });
    try {
      const parsed = await this.readCapabilityIdentity();
      if (!validCapabilityIdentity(parsed)) throw new Error("invalid capability identity");
      this.capabilityIdentity = parsed;
      return;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    }
    const identity: WorkflowResultCapabilityIdentity = {
      version: CAPABILITY_IDENTITY_VERSION,
      secret: randomBytes(32).toString("base64url"),
    };
    try {
      await writeFile(this.capabilityIdentityPath, `${JSON.stringify(identity)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      this.capabilityIdentity = identity;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      const parsed = await this.readCapabilityIdentity();
      if (!validCapabilityIdentity(parsed)) throw new Error("invalid capability identity");
      this.capabilityIdentity = parsed;
    }
  }

  capabilityPort(): number | undefined {
    return this.requireCapabilityIdentity().port;
  }

  async recordCapabilityPort(port: number): Promise<void> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
      throw new Error("Invalid workflow result tool port");
    const identity = { ...this.requireCapabilityIdentity(), port };
    const temp = `${this.capabilityIdentityPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    await rename(temp, this.capabilityIdentityPath);
    this.capabilityIdentity = identity;
  }

  capabilityToken(scope: WorkflowResultCallerScope, resultKey: string): string {
    const signature = this.signCapability(scope, resultKey);
    return `${resultKey}_${signature}`;
  }

  async authenticateCapability(token: string): Promise<
    | (WorkflowResultCallerScope & {
        workflowResultKey: string;
      })
    | null
  > {
    const separator = token.indexOf("_");
    if (separator <= 0) return null;
    const resultKey = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!/^[0-9a-f-]{36}$/i.test(resultKey) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
    const store = await this.load();
    const entry = store.entries[resultKey];
    if (!entry) return null;
    const expected = this.signCapability(entry, resultKey);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
      return null;
    return {
      environmentId: entry.environmentId,
      projectId: entry.projectId,
      workflowResultKey: resultKey,
    };
  }

  async prepare(input: WorkflowResultSlotInput): Promise<void> {
    await this.mutate(async (store) => {
      const existing = store.entries[input.resultKey];
      if (existing) {
        if (
          existing.kind !== input.kind ||
          existing.environmentId !== input.environmentId ||
          existing.projectId !== input.projectId ||
          existing.provider !== input.provider ||
          existing.expectedStoryId !== input.expectedStoryId ||
          serialize(existing.context ?? null) !== serialize(input.context ?? null)
        ) {
          throw new Error("Workflow result key is already bound to another attempt");
        }
        return;
      }
      const now = new Date().toISOString();
      const { schema: _schema, ...identity } = input;
      store.entries[input.resultKey] = {
        ...identity,
        schemaVersion: WORKFLOW_RESULT_SCHEMA_VERSION,
        lifecycle: "open",
        createdAt: now,
        updatedAt: now,
        rejectedDigests: [],
      };
      this.prune(store);
      this.metrics.recordAttempt({
        provider: input.provider,
        kind: input.kind,
        transport: "tool-v1",
        schemaVersion: WORKFLOW_RESULT_SCHEMA_VERSION,
      });
    });
  }

  /**
   * Bounded delivery state for one slot, safe to project into a renderer
   * snapshot. Carries no receipt, digest, or diagnostic text.
   */
  async projection(resultKey: string): Promise<WorkflowResultSubmissionState | undefined> {
    const entry = (await this.load()).entries[resultKey];
    if (!entry) return undefined;
    if (entry.lifecycle === "accepted") return "received";
    if (entry.lifecycle !== "open") return undefined;
    if (entry.rejectedDigests.length === 0) return "preparing";
    return entry.rejectedDigests.length >= WORKFLOW_RESULT_MAX_REJECTIONS
      ? "needs-attention"
      : "correcting";
  }

  async submit(
    scope: WorkflowResultCallerScope,
    resultKey: string,
    result: unknown,
  ): Promise<WorkflowResultSubmission> {
    let serialized: string;
    let resultDigest: string;
    try {
      serialized = serialize(result);
      resultDigest = createHash("sha256").update(serialized).digest("hex");
    } catch {
      return {
        ok: false,
        error: {
          code: "invalid_result",
          nextAction: "correct",
          message: "The result must be a JSON-serializable value.",
        },
      };
    }
    if (Buffer.byteLength(serialized, "utf8") > WORKFLOW_RESULT_MAX_BYTES) {
      return {
        ok: false,
        error: {
          code: "result_too_large",
          nextAction: "stop",
          message: `The result exceeds the ${WORKFLOW_RESULT_MAX_BYTES}-byte limit.`,
        },
      };
    }
    const pendingForKey = this.pendingCallsByKey.get(resultKey) ?? 0;
    if (
      this.pendingCalls >= WORKFLOW_RESULT_MAX_PENDING_CALLS ||
      pendingForKey >= WORKFLOW_RESULT_MAX_PENDING_CALLS_PER_KEY ||
      this.pendingBytes + Buffer.byteLength(serialized, "utf8") > WORKFLOW_RESULT_MAX_PENDING_BYTES
    ) {
      return {
        ok: false,
        error: {
          code: "backpressure",
          nextAction: "lookup_or_resubmit",
          message: "The workflow result service is busy. Check status before retrying.",
        },
      };
    }
    const submissionBytes = Buffer.byteLength(serialized, "utf8");
    this.pendingCalls += 1;
    this.pendingBytes += submissionBytes;
    this.pendingCallsByKey.set(resultKey, pendingForKey + 1);
    try {
      return await this.mutate(async (store) => {
        const entry = store.entries[resultKey];
        if (
          !entry ||
          entry.environmentId !== scope.environmentId ||
          entry.projectId !== scope.projectId
        ) {
          return {
            ok: false,
            error: {
              code: "capability_denied",
              nextAction: "stop",
              message: "This tool connection cannot submit that workflow result.",
            },
          } satisfies WorkflowResultSubmission;
        }
        if (entry.receipt) {
          if (entry.digest !== resultDigest) {
            this.metrics.recordSubmission({
              provider: entry.provider,
              kind: entry.kind,
              outcome: "conflict",
              code: "submission_conflict",
            });
            return {
              ok: false,
              error: {
                code: "submission_conflict",
                nextAction: "stop",
                message: "A different result was already accepted for this key.",
              },
            } satisfies WorkflowResultSubmission;
          }
          this.metrics.recordSubmission({
            provider: entry.provider,
            kind: entry.kind,
            outcome: "duplicate",
          });
          return {
            ok: true,
            receipt: entry.receipt,
            lifecycle: entry.lifecycle,
            duplicate: true,
          } satisfies WorkflowResultSubmission;
        }
        if (entry.lifecycle !== "open") {
          this.metrics.recordSubmission({
            provider: entry.provider,
            kind: entry.kind,
            outcome: "rejected",
            code: "attempt_closed",
          });
          return {
            ok: false,
            error: {
              code: "attempt_closed",
              nextAction: "stop",
              message: "This workflow result attempt is closed.",
            },
          } satisfies WorkflowResultSubmission;
        }
        if (!entry.firstSubmissionAt) entry.firstSubmissionAt = new Date().toISOString();
        const validationStartedAt = Date.now();
        const issues = validateWorkflowResult(entry.kind, result, entry.schema, entry.context);
        if (
          issues.length === 0 &&
          entry.kind === "story-refinement" &&
          entry.expectedStoryId &&
          (!result ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            (result as Record<string, unknown>).storyId !== entry.expectedStoryId)
        ) {
          issues.push({
            path: "$.storyId",
            code: "context_mismatch",
            message: "The result belongs to a different story.",
          });
        }
        this.metrics.recordValidationDuration(entry.kind, Date.now() - validationStartedAt);
        if (issues.length > 0) {
          // A repeated delivery of the same invalid payload is one correction,
          // not two, so the budget and the metric both key on the digest.
          const distinctCorrection = !entry.rejectedDigests.includes(resultDigest);
          if (distinctCorrection) {
            entry.rejectedDigests.push(resultDigest);
            this.metrics.recordCorrection({ provider: entry.provider, kind: entry.kind });
          }
          entry.rejectedDigests = entry.rejectedDigests.slice(-WORKFLOW_RESULT_MAX_REJECTIONS);
          entry.updatedAt = new Date().toISOString();
          if (entry.rejectedDigests.length >= WORKFLOW_RESULT_MAX_REJECTIONS) {
            this.metrics.recordSubmission({
              provider: entry.provider,
              kind: entry.kind,
              outcome: "rejected",
              code: "correction_budget_exhausted",
            });
            return {
              ok: false,
              error: {
                code: "correction_budget_exhausted",
                nextAction: "stop",
                message: "The result is still invalid after the allowed correction attempts.",
                issues,
              },
            } satisfies WorkflowResultSubmission;
          }
          this.metrics.recordSubmission({
            provider: entry.provider,
            kind: entry.kind,
            outcome: "rejected",
            code: "invalid_result",
          });
          return {
            ok: false,
            error: {
              code: "invalid_result",
              nextAction: "correct",
              message: "The result was not accepted. Correct the reported fields and submit again.",
              issues,
            },
          } satisfies WorkflowResultSubmission;
        }
        const acceptedAt = new Date().toISOString();
        const receipt: WorkflowResultReceipt = {
          version: 1,
          resultKey,
          receiptId: randomUUID(),
          kind: entry.kind,
          schemaVersion: entry.schemaVersion,
          acceptedAt,
        };
        entry.lifecycle = "accepted";
        entry.result = result;
        entry.digest = resultDigest;
        entry.receipt = receipt;
        entry.updatedAt = acceptedAt;
        this.metrics.recordSubmission({
          provider: entry.provider,
          kind: entry.kind,
          outcome: "accepted",
        });
        this.metrics.recordAcceptanceLatency(
          entry.kind,
          Date.parse(acceptedAt) - Date.parse(entry.firstSubmissionAt ?? acceptedAt),
        );
        return { ok: true, receipt, lifecycle: entry.lifecycle, duplicate: false };
      });
    } finally {
      this.pendingCalls -= 1;
      this.pendingBytes -= submissionBytes;
      const remainingForKey = (this.pendingCallsByKey.get(resultKey) ?? 1) - 1;
      if (remainingForKey > 0) this.pendingCallsByKey.set(resultKey, remainingForKey);
      else this.pendingCallsByKey.delete(resultKey);
      this.metrics.setGauge("pending_calls", this.pendingCalls);
      this.metrics.setGauge("pending_bytes", this.pendingBytes);
    }
  }

  async status(
    scope: WorkflowResultCallerScope,
    resultKey: string,
  ): Promise<WorkflowResultStatus | null> {
    const store = await this.load();
    const entry = store.entries[resultKey];
    if (
      !entry ||
      entry.environmentId !== scope.environmentId ||
      entry.projectId !== scope.projectId
    )
      return null;
    return {
      resultKey,
      lifecycle: entry.lifecycle,
      completion:
        entry.lifecycle === "consumed"
          ? "completed"
          : entry.lifecycle === "cancelled" || entry.lifecycle === "superseded"
            ? "blocked"
            : "pending",
      ...(entry.receipt ? { receipt: entry.receipt } : {}),
    };
  }

  async structured<T>(resultKey: string): Promise<StructuredOutputResult<T> | null> {
    const store = await this.load();
    const entry = store.entries[resultKey];
    if (!entry?.receipt || entry.lifecycle !== "accepted" || entry.result === undefined)
      return null;
    return {
      ok: true,
      provider: entry.provider,
      requestId: resultKey,
      value: entry.result as T,
    };
  }

  async registered(resultKey: string): Promise<boolean> {
    return (await this.load()).entries[resultKey] !== undefined;
  }

  async binding(
    scope: WorkflowResultCallerScope,
    resultKey: string,
  ): Promise<{ kind: StoredWorkflowResult["kind"] } | null> {
    const entry = (await this.load()).entries[resultKey];
    if (
      !entry ||
      entry.environmentId !== scope.environmentId ||
      entry.projectId !== scope.projectId
    ) {
      return null;
    }
    return { kind: entry.kind };
  }

  async consume(resultKey: string): Promise<void> {
    await this.mutate(async (store) => {
      const entry = store.entries[resultKey];
      if (!entry || entry.lifecycle === "consumed") return;
      if (entry.lifecycle !== "accepted") throw new Error("Workflow result is not accepted");
      const consumedAt = new Date().toISOString();
      entry.lifecycle = "consumed";
      entry.result = undefined;
      entry.updatedAt = consumedAt;
      this.metrics.recordConsumptionLatency(
        entry.kind,
        Date.parse(consumedAt) - Date.parse(entry.receipt?.acceptedAt ?? consumedAt),
      );
    });
  }

  async close(resultKey: string, lifecycle: "cancelled" | "superseded"): Promise<void> {
    await this.mutate(async (store) => {
      const entry = store.entries[resultKey];
      if (!entry || entry.lifecycle === "consumed") return;
      // A slot closed while still open was never submitted to. That is the
      // signal for a worker that finished without calling its tool, which is
      // what the missing-submission counter exists to surface.
      if (entry.lifecycle === "open" && !entry.firstSubmissionAt) {
        this.metrics.recordMissingSubmission({
          provider: entry.provider,
          kind: entry.kind,
          reason: lifecycle,
        });
      }
      entry.lifecycle = lifecycle;
      entry.result = undefined;
      entry.updatedAt = new Date().toISOString();
    });
  }

  /**
   * Records a reporting-only continuation for an attempt that already closed.
   * Kept on the service so the counter shares the metrics table with delivery.
   */
  recordReportingOnlyContinuation(
    provider: StructuredOutputProvider,
    kind: WorkflowResultKind,
  ): void {
    this.metrics.recordReportingOnlyContinuation({ provider, kind });
  }

  private async load(): Promise<WorkflowResultStore> {
    const startedAt = Date.now();
    try {
      const metadata = await stat(this.filePath);
      if (metadata.size > MAX_STORE_BYTES)
        throw new Error("Workflow result store exceeds its size limit");
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid store");
      const candidate = parsed as Partial<WorkflowResultStore>;
      if (candidate.version !== WORKFLOW_RESULT_STORE_VERSION || !candidate.entries)
        throw new Error("invalid store");
      if (
        typeof candidate.entries !== "object" ||
        candidate.entries === null ||
        Array.isArray(candidate.entries)
      ) {
        throw new Error("invalid store");
      }
      const rawEntries = Object.entries(candidate.entries);
      if (!rawEntries.every(([key, value]) => validStoredEntry(key, value))) {
        throw new Error("invalid store");
      }
      const entries = Object.fromEntries(rawEntries) as Record<string, StoredWorkflowResult>;
      this.metrics.recordStorageDuration("load", Date.now() - startedAt);
      return { version: WORKFLOW_RESULT_STORE_VERSION, entries };
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT")
        return { version: WORKFLOW_RESULT_STORE_VERSION, entries: {} };
      throw error;
    }
  }

  private async save(store: WorkflowResultStore): Promise<void> {
    const startedAt = Date.now();
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(store, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_STORE_BYTES) throw new Error("Workflow result store exceeds its size limit");
    await writeFile(temp, serialized, { mode: 0o600 });
    await rename(temp, this.filePath);
    this.metrics.recordStorageDuration("save", Date.now() - startedAt);
    this.metrics.setGauge("retained_bytes", bytes);
    this.metrics.setGauge(
      "active_slots",
      Object.values(store.entries).filter(
        (entry) => entry.lifecycle === "open" || entry.lifecycle === "accepted",
      ).length,
    );
  }

  private prune(store: WorkflowResultStore): void {
    const entries = Object.values(store.entries);
    if (entries.length <= WORKFLOW_RESULT_MAX_ENTRIES) return;
    const removable = entries
      .filter(
        (entry) =>
          entry.lifecycle === "consumed" ||
          entry.lifecycle === "cancelled" ||
          entry.lifecycle === "superseded",
      )
      .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
    for (const entry of removable) {
      if (Object.keys(store.entries).length <= WORKFLOW_RESULT_MAX_ENTRIES) break;
      delete store.entries[entry.resultKey];
    }
    if (Object.keys(store.entries).length > WORKFLOW_RESULT_MAX_ENTRIES)
      throw new Error("Workflow result store has too many active entries");
  }

  private async mutate<T>(operation: (store: WorkflowResultStore) => Promise<T> | T): Promise<T> {
    const run = this.mutation.then(async () => {
      const release = await this.acquireMutationLock();
      try {
        const store = await this.load();
        const result = await operation(store);
        await this.save(store);
        return result;
      } finally {
        await release();
      }
    });
    this.mutation = run.catch(() => undefined);
    return run;
  }

  private requireCapabilityIdentity(): WorkflowResultCapabilityIdentity {
    if (!this.capabilityIdentity)
      throw new Error("Workflow result capability identity is not ready");
    return this.capabilityIdentity;
  }

  private async readCapabilityIdentity(): Promise<unknown> {
    const metadata = await stat(this.capabilityIdentityPath);
    if (metadata.size > MAX_CAPABILITY_IDENTITY_BYTES)
      throw new Error("Workflow result capability identity exceeds its size limit");
    return JSON.parse(await readFile(this.capabilityIdentityPath, "utf8")) as unknown;
  }

  private signCapability(scope: WorkflowResultCallerScope, resultKey: string): string {
    return createHmac("sha256", this.requireCapabilityIdentity().secret)
      .update(`${resultKey}\0${scope.environmentId}\0${scope.projectId}`)
      .digest("base64url");
  }

  private async acquireMutationLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.filePath}.lock`;
    const token = randomUUID();
    const staleMs = 15_000;
    const deadline = Date.now() + 20_000;
    await mkdir(path.dirname(lockPath), { recursive: true });
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(token, "utf8");
        } catch (error) {
          await handle.close();
          await rm(lockPath, { force: true });
          throw error;
        }
        const heartbeat = setInterval(() => {
          void handle.utimes(new Date(), new Date()).catch(() => undefined);
        }, 5_000);
        heartbeat.unref();
        return async () => {
          clearInterval(heartbeat);
          await handle.close();
          const currentToken = await readFile(lockPath, "utf8").catch(() => null);
          if (currentToken === token) await rm(lockPath, { force: true });
        };
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
        const metadata = await stat(lockPath).catch(() => null);
        if (metadata && Date.now() - metadata.mtimeMs > staleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for workflow result lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}

function validCapabilityIdentity(value: unknown): value is WorkflowResultCapabilityIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkflowResultCapabilityIdentity>;
  return (
    candidate.version === CAPABILITY_IDENTITY_VERSION &&
    typeof candidate.secret === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(candidate.secret) &&
    (candidate.port === undefined ||
      (Number.isSafeInteger(candidate.port) && candidate.port! >= 1 && candidate.port! <= 65_535))
  );
}

export interface WorkflowResultReader {
  structured<T>(resultKey: string): Promise<StructuredOutputResult<T> | null>;
  registered(resultKey: string): Promise<boolean>;
}
