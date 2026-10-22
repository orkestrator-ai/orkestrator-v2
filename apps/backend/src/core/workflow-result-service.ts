import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { STORAGE_COLLECTION_MARKER } from "@orkestrator/protocol/node/storage-database";
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
  workflowResultToolName,
  type WorkflowResultDelivery,
  type WorkflowResultKind,
  type WorkflowResultReceipt,
  type WorkflowResultSlotInput,
  type WorkflowResultStatus,
  type WorkflowResultSubmission,
  type WorkflowResultSubmissionState,
  type WorkflowResultValidation,
  type WorkflowResultValidationIssue,
} from "@orkestrator/protocol/workflow-results";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { StoreCorruptError, type StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import { validateWorkflowResult } from "./workflow-result-contracts.js";
import {
  WorkflowResultMetrics,
  type WorkflowResultPreflightOutcome,
} from "./workflow-result-metrics.js";

/** Database stores that replaced `workflow-results.json` and `workflow-result-tools.json`. */
export const WORKFLOW_RESULTS_STORE = "workflow-results";
export const WORKFLOW_RESULT_TOOLS_STORE = "workflow-result-tools";
const ENTRIES = "entries";
/**
 * Bound on the serialized entry rows (the sum of their JSON sizes). The JSON
 * file measured its whole pretty-printed text; rows carry no indentation or
 * envelope, so the same bound now holds slightly more entries.
 */
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_CAPABILITY_IDENTITY_BYTES = 4 * 1024;
const CAPABILITY_IDENTITY_VERSION = 1;
/** A validated payload is held only long enough for the model to commit it. */
const HELD_VALIDATION_TTL_MS = 30 * 60_000;
const HELD_VALIDATION_MAX_ENTRIES = WORKFLOW_RESULT_MAX_PENDING_CALLS;
const HELD_VALIDATION_MAX_BYTES = WORKFLOW_RESULT_MAX_PENDING_BYTES;

/** The newest payload that passed validation for one slot. In memory only. */
interface HeldValidation {
  digest: string;
  result: unknown;
  bytes: number;
  at: number;
}

interface DeliveryCounters {
  validationCalls: number;
  submissionCalls: number;
  lastValidation?: "valid" | "invalid";
}

interface WorkflowResultCapabilityIdentity {
  version: 1;
  secret: string;
  port?: number;
}

export interface WorkflowResultCallerScope {
  environmentId: string;
  projectId: string;
}

/** A committed, first acceptance of a workflow result. Identifiers stay in-process. */
export interface WorkflowResultAcceptance {
  resultKey: string;
  environmentId: string;
}

interface StoredWorkflowResult extends WorkflowResultSlotInput {
  schemaVersion: number;
  lifecycle: "open" | "accepted" | "consumed" | "cancelled" | "superseded" | "exhausted";
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  digest?: string;
  receipt?: WorkflowResultReceipt;
  rejectedDigests: string[];
  /** First delivery attempt, used only for the acceptance-latency metric. */
  firstSubmissionAt?: string;
}

/** What a mutation needs to know about an entry without parsing its row. */
interface IndexedEntry {
  environmentId: string;
  settled: boolean;
  updatedAt: number;
  bytes: number;
}

/**
 * Every entry's identity, lifecycle and row size at one committed revision of
 * the store. It lets pruning, environment deletion and the gauges run without
 * parsing the store. It is trusted only while the store's revision matches, so
 * another backend's commit forces a rebuild (which also revalidates every
 * entry: a store another process corrupted fails closed).
 */
interface EntryIndex {
  revision: number;
  entries: Map<string, IndexedEntry>;
  bytes: number;
}

function invalidStore(): Error {
  return new Error("invalid store");
}

function isSettled(lifecycle: StoredWorkflowResult["lifecycle"]): boolean {
  return (
    lifecycle === "consumed" ||
    lifecycle === "cancelled" ||
    lifecycle === "superseded" ||
    lifecycle === "exhausted"
  );
}

function indexedEntry(entry: StoredWorkflowResult, bytes: number): IndexedEntry {
  return {
    environmentId: entry.environmentId,
    settled: isSettled(entry.lifecycle),
    updatedAt: Date.parse(entry.updatedAt),
    bytes,
  };
}

/**
 * Checks the store's envelope (`version` and the `entries` collection) from
 * its header row without assembling the entries. `false` when the store does
 * not exist yet. A store held whole as a document (a legacy file whose
 * entries were not a record, or one that was not JSON at all), or one with
 * another version, is invalid: fail closed rather than read it as empty.
 */
function checkEnvelope(database: StorageDatabase): boolean {
  const header = database.readStoreHeader(WORKFLOW_RESULTS_STORE);
  if (!header) return false;
  if (header.layout !== "envelope" || header.mode !== "rows" || header.document === null) {
    throw invalidStore();
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(header.document) as unknown;
  } catch {
    throw invalidStore();
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    (envelope as Record<string, unknown>).version !== WORKFLOW_RESULT_STORE_VERSION ||
    (envelope as Record<string, unknown>)[ENTRIES] !== STORAGE_COLLECTION_MARKER
  ) {
    throw invalidStore();
  }
  return true;
}

function validateEntryResult(
  entry: StoredWorkflowResult,
  result: unknown,
): WorkflowResultValidationIssue[] {
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
  return issues;
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
    ["open", "accepted", "consumed", "cancelled", "superseded", "exhausted"].includes(
      String(entry.lifecycle),
    ) &&
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

/**
 * Durable result inbox shared by workflow controllers and the agent tool server.
 *
 * Entries live in the backend database (`workflow-results`, one row per
 * result key). Every mutation is one synchronous IMMEDIATE transaction, which
 * SQLite serializes against every other connection and process sharing the
 * data directory; a crash leaves the previous commit. Reads parse only the
 * requested row.
 */
export class WorkflowResultService {
  private readonly dataDir: string;
  private storage: StorageDatabase | null = null;
  private index: EntryIndex | null = null;
  private capabilityIdentity: WorkflowResultCapabilityIdentity | null = null;
  private pendingAuthentications = 0;
  private pendingCalls = 0;
  private pendingBytes = 0;
  private readonly pendingCallsByKey = new Map<string, number>();
  private readonly held = new Map<string, HeldValidation>();
  private readonly nudgedResults = new Set<string>();
  private heldBytes = 0;
  private readonly deliveryCounters = new Map<string, DeliveryCounters>();
  private readonly acceptanceListeners = new Set<(event: WorkflowResultAcceptance) => void>();
  readonly metrics: WorkflowResultMetrics;

  constructor(dataDir: string, metrics: WorkflowResultMetrics = new WorkflowResultMetrics()) {
    this.dataDir = dataDir;
    this.metrics = metrics;
  }

  /** The data directory's database, opened on first use (and again after {@link closeStorage}). */
  private get database(): StorageDatabase {
    if (!this.storage || this.storage.isClosed()) {
      this.storage = openBackendDatabase(this.dataDir);
      this.index = null;
    }
    return this.storage;
  }

  /**
   * Closes this service's database connection (backend shutdown, tests). A
   * later call reopens it. In-memory delivery state and the capability
   * identity are kept.
   */
  closeStorage(): void {
    this.storage?.close();
    this.storage = null;
    this.index = null;
  }

  /** Counters exist only for slots the store knows, so a caller cannot grow them. */
  private counters(resultKey: string): DeliveryCounters {
    let counters = this.deliveryCounters.get(resultKey);
    if (!counters) {
      counters = { validationCalls: 0, submissionCalls: 0 };
      this.deliveryCounters.set(resultKey, counters);
      while (this.deliveryCounters.size > WORKFLOW_RESULT_MAX_ENTRIES) {
        const oldest = this.deliveryCounters.keys().next().value;
        if (oldest === undefined) break;
        this.deliveryCounters.delete(oldest);
      }
    }
    return counters;
  }

  private releaseHeld(resultKey: string): void {
    const held = this.held.get(resultKey);
    if (!held) return;
    this.held.delete(resultKey);
    this.heldBytes -= held.bytes;
  }

  /** Drops everything the service remembers about a slot that has settled. */
  private forgetDelivery(resultKey: string): void {
    this.releaseHeld(resultKey);
    this.deliveryCounters.delete(resultKey);
    this.nudgedResults.delete(resultKey);
  }

  private hold(resultKey: string, digest: string, result: unknown, bytes: number): void {
    this.releaseHeld(resultKey);
    const now = Date.now();
    for (const [key, entry] of Array.from(this.held)) {
      if (now - entry.at > HELD_VALIDATION_TTL_MS) this.releaseHeld(key);
    }
    this.held.set(resultKey, { digest, result, bytes, at: now });
    this.heldBytes += bytes;
    while (
      this.held.size > 0 &&
      (this.held.size > HELD_VALIDATION_MAX_ENTRIES || this.heldBytes > HELD_VALIDATION_MAX_BYTES)
    ) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.releaseHeld(oldest);
    }
  }

  /**
   * The payload that last passed validation for a slot, if it is still held.
   * `ageMs` lets a supervisor notice a model that validated a result and then
   * never committed it.
   */
  heldValidation(resultKey: string): { digest: string; ageMs: number } | undefined {
    const held = this.held.get(resultKey);
    if (!held) return undefined;
    const ageMs = Date.now() - held.at;
    if (ageMs > HELD_VALIDATION_TTL_MS) {
      this.releaseHeld(resultKey);
      return undefined;
    }
    return { digest: held.digest, ageMs };
  }

  /** Claims a best-effort nudge once per slot across supervisor passes. */
  claimCommitNudge(resultKey: string): boolean {
    if (!this.heldValidation(resultKey)) return false;
    if (this.nudgedResults.has(resultKey) || this.nudgedResults.size >= WORKFLOW_RESULT_MAX_ENTRIES)
      return false;
    this.nudgedResults.add(resultKey);
    return true;
  }

  private beginPending(resultKey: string, bytes: number): boolean {
    const pendingForKey = this.pendingCallsByKey.get(resultKey) ?? 0;
    if (
      this.pendingCalls >= WORKFLOW_RESULT_MAX_PENDING_CALLS ||
      pendingForKey >= WORKFLOW_RESULT_MAX_PENDING_CALLS_PER_KEY ||
      this.pendingBytes + bytes > WORKFLOW_RESULT_MAX_PENDING_BYTES
    ) {
      return false;
    }
    this.pendingCalls += 1;
    this.pendingBytes += bytes;
    this.pendingCallsByKey.set(resultKey, pendingForKey + 1);
    this.metrics.setGauge("pending_calls", this.pendingCalls);
    this.metrics.setGauge("pending_bytes", this.pendingBytes);
    return true;
  }

  private endPending(resultKey: string, bytes: number): void {
    this.pendingCalls -= 1;
    this.pendingBytes -= bytes;
    const remainingForKey = (this.pendingCallsByKey.get(resultKey) ?? 1) - 1;
    if (remainingForKey > 0) this.pendingCallsByKey.set(resultKey, remainingForKey);
    else this.pendingCallsByKey.delete(resultKey);
    this.metrics.setGauge("pending_calls", this.pendingCalls);
    this.metrics.setGauge("pending_bytes", this.pendingBytes);
  }

  /**
   * Loads the signing identity, creating it when absent. One transaction:
   * two backends starting together agree on one secret, and a valid stored
   * identity is never replaced.
   */
  async initializeCapabilityIdentity(): Promise<void> {
    if (this.capabilityIdentity) return;
    const database = this.database;
    this.capabilityIdentity = database.transaction(() => {
      // An unreadable value reads as absent. The identity contains no user
      // data and is useful only while valid: regenerating it invalidates stale
      // bearer capabilities but keeps the agent-tools server available.
      const stored = database.readStoreValueInTransaction(WORKFLOW_RESULT_TOOLS_STORE)?.value;
      if (
        validCapabilityIdentity(stored) &&
        Buffer.byteLength(JSON.stringify(stored), "utf8") <= MAX_CAPABILITY_IDENTITY_BYTES
      ) {
        return stored;
      }
      const identity: WorkflowResultCapabilityIdentity = {
        version: CAPABILITY_IDENTITY_VERSION,
        secret: randomBytes(32).toString("base64url"),
      };
      database.writeStoreInTransaction(WORKFLOW_RESULT_TOOLS_STORE, identity);
      return identity;
    });
  }

  capabilityPort(): number | undefined {
    return this.requireCapabilityIdentity().port;
  }

  async recordCapabilityPort(port: number): Promise<void> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
      throw new Error("Invalid workflow result tool port");
    const identity = { ...this.requireCapabilityIdentity(), port };
    this.database.writeStore(WORKFLOW_RESULT_TOOLS_STORE, identity);
    this.capabilityIdentity = identity;
  }

  capabilityToken(scope: WorkflowResultCallerScope, resultKey: string): string {
    const signature = this.signCapability(scope, resultKey);
    const environmentId = Buffer.from(scope.environmentId, "utf8").toString("base64url");
    const projectId = Buffer.from(scope.projectId, "utf8").toString("base64url");
    return `${resultKey}.${environmentId}.${projectId}.${signature}`;
  }

  async authenticateCapability(token: string): Promise<
    | (WorkflowResultCallerScope & {
        workflowResultKey: string;
      })
    | null
  > {
    if (this.pendingAuthentications >= 16 || token.length > 2_048) return null;
    const [resultKey, encodedEnvironmentId, encodedProjectId, signature, ...extra] =
      token.split(".");
    if (
      extra.length > 0 ||
      !resultKey ||
      !encodedEnvironmentId ||
      !encodedProjectId ||
      !signature ||
      !/^[0-9a-f-]{36}$/i.test(resultKey) ||
      !/^[A-Za-z0-9_-]{1,684}$/.test(encodedEnvironmentId) ||
      !/^[A-Za-z0-9_-]{1,684}$/.test(encodedProjectId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    )
      return null;
    const environmentId = decodeCapabilityScope(encodedEnvironmentId);
    const projectId = decodeCapabilityScope(encodedProjectId);
    if (!environmentId || !projectId) return null;
    const scope = { environmentId, projectId };
    const expected = this.signCapability(scope, resultKey);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
      return null;
    this.pendingAuthentications += 1;
    try {
      const entry = this.readEntry(resultKey);
      if (!entry || entry.environmentId !== environmentId || entry.projectId !== projectId)
        return null;
      return { environmentId, projectId, workflowResultKey: resultKey };
    } finally {
      this.pendingAuthentications -= 1;
    }
  }

  /** Verify a signed attempt capability presented through a persistent broker. */
  async authorizeCapability(
    scope: WorkflowResultCallerScope,
    resultKey: string,
    capability: string,
    expectedProvider?: StructuredOutputProvider,
  ): Promise<boolean> {
    const authorized = await this.authenticateCapability(capability);
    if (
      authorized?.environmentId === scope.environmentId &&
      authorized.projectId === scope.projectId &&
      authorized.workflowResultKey === resultKey
    ) {
      if (!expectedProvider) return true;
      return (await this.binding(scope, resultKey))?.provider === expectedProvider;
    }
    return false;
  }

  async prepare(input: WorkflowResultSlotInput): Promise<void> {
    this.mutateEntry<void>(input.resultKey, (existing) => {
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
        return { result: undefined };
      }
      const now = new Date().toISOString();
      const { schema: _schema, ...identity } = input;
      const entry: StoredWorkflowResult = {
        ...identity,
        schemaVersion: WORKFLOW_RESULT_SCHEMA_VERSION,
        lifecycle: "open",
        createdAt: now,
        updatedAt: now,
        rejectedDigests: [],
      };
      this.metrics.recordAttempt({
        provider: input.provider,
        kind: input.kind,
        transport: "tool-v1",
        schemaVersion: WORKFLOW_RESULT_SCHEMA_VERSION,
      });
      return { result: undefined, entry };
    });
  }

  /**
   * Bounded delivery state for one slot, safe to project into a renderer
   * snapshot. Carries no receipt, digest, or diagnostic text.
   */
  async projection(resultKey: string): Promise<WorkflowResultSubmissionState | undefined> {
    const entry = this.readEntry(resultKey);
    if (!entry) return undefined;
    if (entry.lifecycle === "accepted") return "received";
    if (entry.lifecycle === "exhausted") return "needs-attention";
    if (entry.lifecycle !== "open") return undefined;
    if (entry.rejectedDigests.length === 0) return "preparing";
    return entry.rejectedDigests.length >= WORKFLOW_RESULT_MAX_REJECTIONS
      ? "needs-attention"
      : "correcting";
  }

  /** Validate one complete candidate without consuming its correction budget or changing state. */
  async validate(
    scope: WorkflowResultCallerScope,
    resultKey: string,
    result: unknown,
  ): Promise<WorkflowResultValidation> {
    let serialized: string;
    try {
      serialized = serialize(result);
    } catch {
      this.metrics.recordPreflight("invalid_result");
      return {
        ok: false,
        error: {
          code: "invalid_result",
          nextAction: "correct",
          message: "The result must be a JSON-serializable value.",
        },
      };
    }
    const validationBytes = Buffer.byteLength(serialized, "utf8");
    if (validationBytes > WORKFLOW_RESULT_MAX_BYTES) {
      this.metrics.recordPreflight("result_too_large");
      return {
        ok: false,
        error: {
          code: "result_too_large",
          nextAction: "stop",
          message: `The result exceeds the ${WORKFLOW_RESULT_MAX_BYTES}-byte limit.`,
        },
      };
    }
    if (!this.beginPending(resultKey, validationBytes)) {
      this.metrics.recordPreflight("backpressure");
      return {
        ok: false,
        error: {
          code: "backpressure",
          nextAction: "lookup_or_resubmit",
          message: "The workflow result service is busy. Check status before retrying.",
        },
      };
    }
    let outcome: WorkflowResultPreflightOutcome = "invalid_result";
    try {
      // Read-only: the entry's row, never the whole store.
      const evaluate = (): WorkflowResultValidation => {
        const entry = this.readEntry(resultKey);
        if (
          !entry ||
          entry.environmentId !== scope.environmentId ||
          entry.projectId !== scope.projectId
        ) {
          outcome = "capability_denied";
          return {
            ok: false,
            error: {
              code: "capability_denied",
              nextAction: "stop",
              message: "This tool connection cannot validate that workflow result.",
            },
          };
        }
        if (entry.lifecycle !== "open") {
          outcome =
            entry.lifecycle === "exhausted" ? "correction_budget_exhausted" : "attempt_closed";
          return {
            ok: false,
            error: {
              code: outcome,
              nextAction: "stop",
              message:
                entry.lifecycle === "exhausted"
                  ? "The correction budget for this workflow result is exhausted."
                  : "This workflow result attempt is closed.",
            },
          };
        }
        const validationStartedAt = Date.now();
        let issues: WorkflowResultValidationIssue[];
        try {
          issues = validateEntryResult(entry, result);
        } finally {
          this.metrics.recordValidationDuration(entry.kind, Date.now() - validationStartedAt);
        }
        const delivery = this.counters(resultKey);
        delivery.validationCalls += 1;
        delivery.lastValidation = issues.length > 0 ? "invalid" : "valid";
        if (issues.length > 0) {
          return {
            ok: false,
            error: {
              code: "invalid_result",
              nextAction: "correct",
              message: "The result is not valid. Correct the reported fields before submitting it.",
              issues,
            },
          };
        }
        outcome = "valid";
        const validatedDigest = createHash("sha256").update(serialized).digest("hex");
        this.hold(resultKey, validatedDigest, result, validationBytes);
        return { ok: true, valid: true, validatedDigest };
      };
      return evaluate();
    } catch (error) {
      outcome = "storage_unavailable";
      throw error;
    } finally {
      this.metrics.recordPreflight(outcome);
      this.endPending(resultKey, validationBytes);
    }
  }

  /**
   * Observes durable acceptances, after the commit, so a workflow supervisor
   * can wake the waiting workflow instead of finding the result on its next
   * poll. A listener must not throw; one that does is isolated.
   */
  onAccepted(listener: (event: WorkflowResultAcceptance) => void): () => void {
    this.acceptanceListeners.add(listener);
    return () => this.acceptanceListeners.delete(listener);
  }

  async submit(
    scope: WorkflowResultCallerScope,
    resultKey: string,
    result: unknown,
  ): Promise<WorkflowResultSubmission> {
    return this.deliver(scope, resultKey, result);
  }

  private async deliver(
    scope: WorkflowResultCallerScope,
    resultKey: string,
    result: unknown,
    validatedDigest?: string,
  ): Promise<WorkflowResultSubmission> {
    const submission = await this.submitOnce(scope, resultKey, result, validatedDigest);
    if (submission.ok && !submission.duplicate) {
      for (const listener of Array.from(this.acceptanceListeners)) {
        try {
          listener({ resultKey, environmentId: scope.environmentId });
        } catch {
          // Waking is an optimization; the workflow still polls the result.
        }
      }
    }
    return submission;
  }

  /**
   * Commits the payload that last passed validation, identified by digest.
   *
   * It is an ordinary submission of that exact payload, so every acceptance
   * rule (lifecycle, budget, duplicate and conflict handling) still applies.
   * Only the transport differs: the model names the payload instead of
   * re-emitting it.
   */
  async submitValidated(
    scope: WorkflowResultCallerScope,
    resultKey: string,
    validatedDigest: string,
  ): Promise<WorkflowResultSubmission> {
    return this.deliver(scope, resultKey, undefined, validatedDigest);
  }

  private async submitOnce(
    scope: WorkflowResultCallerScope,
    resultKey: string,
    result: unknown,
    validatedDigest?: string,
  ): Promise<WorkflowResultSubmission> {
    let serialized: string;
    let resultDigest: string;
    try {
      serialized = validatedDigest === undefined ? serialize(result) : "";
      resultDigest = validatedDigest ?? createHash("sha256").update(serialized).digest("hex");
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
    const submissionBytes = Buffer.byteLength(serialized, "utf8");
    if (submissionBytes > WORKFLOW_RESULT_MAX_BYTES) {
      return {
        ok: false,
        error: {
          code: "result_too_large",
          nextAction: "stop",
          message: `The result exceeds the ${WORKFLOW_RESULT_MAX_BYTES}-byte limit.`,
        },
      };
    }
    if (!this.beginPending(resultKey, submissionBytes)) {
      return {
        ok: false,
        error: {
          code: "backpressure",
          nextAction: "lookup_or_resubmit",
          message: "The workflow result service is busy. Check status before retrying.",
        },
      };
    }
    try {
      return this.mutateEntry<WorkflowResultSubmission>(
        resultKey,
        (entry) => {
          if (
            !entry ||
            entry.environmentId !== scope.environmentId ||
            entry.projectId !== scope.projectId
          ) {
            return {
              result: {
                ok: false,
                error: {
                  code: "capability_denied",
                  nextAction: "stop",
                  message: "This tool connection cannot submit that workflow result.",
                },
              } satisfies WorkflowResultSubmission,
            };
          }
          this.counters(resultKey).submissionCalls += 1;
          if (
            entry.lifecycle === "cancelled" ||
            entry.lifecycle === "superseded" ||
            entry.lifecycle === "exhausted"
          ) {
            const exhausted = entry.lifecycle === "exhausted";
            this.metrics.recordSubmission({
              provider: entry.provider,
              kind: entry.kind,
              outcome: "rejected",
              code: exhausted ? "correction_budget_exhausted" : "attempt_closed",
            });
            return {
              result: {
                ok: false,
                error: {
                  code: exhausted ? "correction_budget_exhausted" : "attempt_closed",
                  nextAction: "stop",
                  message: exhausted
                    ? "The correction budget for this workflow result is exhausted."
                    : "This workflow result attempt is closed.",
                },
              } satisfies WorkflowResultSubmission,
            };
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
                result: {
                  ok: false,
                  error: {
                    code: "submission_conflict",
                    nextAction: "stop",
                    message: "A different result was already accepted for this key.",
                  },
                } satisfies WorkflowResultSubmission,
              };
            }
            this.metrics.recordSubmission({
              provider: entry.provider,
              kind: entry.kind,
              outcome: "duplicate",
            });
            return {
              result: {
                ok: true,
                receipt: entry.receipt,
                lifecycle: entry.lifecycle,
                duplicate: true,
              } satisfies WorkflowResultSubmission,
            };
          }
          if (entry.lifecycle !== "open") {
            this.metrics.recordSubmission({
              provider: entry.provider,
              kind: entry.kind,
              outcome: "rejected",
              code: "attempt_closed",
            });
            return {
              result: {
                ok: false,
                error: {
                  code: "attempt_closed",
                  nextAction: "stop",
                  message: "This workflow result attempt is closed.",
                },
              } satisfies WorkflowResultSubmission,
            };
          }
          if (validatedDigest !== undefined) {
            const held = this.held.get(resultKey);
            if (!held || held.digest !== validatedDigest || !this.heldValidation(resultKey)) {
              return {
                result: {
                  ok: false,
                  error: {
                    code: "invalid_result",
                    nextAction: "correct",
                    message:
                      "No validated result with that digest is held. Validate the complete result again, or submit it in full.",
                    issues: [
                      {
                        path: "$.validatedDigest",
                        code: "unknown_validation",
                        message: "The digest does not match a held validated result.",
                      },
                    ],
                  },
                } satisfies WorkflowResultSubmission,
              };
            }
            result = held.result;
          }
          if (!entry.firstSubmissionAt) entry.firstSubmissionAt = new Date().toISOString();
          const validationStartedAt = Date.now();
          const issues = validateEntryResult(entry, result);
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
              entry.lifecycle = "exhausted";
              this.metrics.recordSubmission({
                provider: entry.provider,
                kind: entry.kind,
                outcome: "rejected",
                code: "correction_budget_exhausted",
              });
              return {
                result: {
                  ok: false,
                  error: {
                    code: "correction_budget_exhausted",
                    nextAction: "stop",
                    message: "The result is still invalid after the allowed correction attempts.",
                    issues,
                  },
                } satisfies WorkflowResultSubmission,
                entry,
              };
            }
            this.metrics.recordSubmission({
              provider: entry.provider,
              kind: entry.kind,
              outcome: "rejected",
              code: "invalid_result",
            });
            return {
              result: {
                ok: false,
                error: {
                  code: "invalid_result",
                  nextAction: "correct",
                  message:
                    "The result was not accepted. Correct the reported fields and submit again.",
                  issues,
                },
              } satisfies WorkflowResultSubmission,
              entry,
            };
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
          return {
            result: { ok: true, receipt, lifecycle: entry.lifecycle, duplicate: false },
            entry,
          };
        },
        {
          afterCommit: (submission) => {
            if (
              submission.ok ||
              submission.error.code === "attempt_closed" ||
              submission.error.code === "correction_budget_exhausted"
            ) {
              this.forgetDelivery(resultKey);
            }
          },
        },
      );
    } finally {
      this.endPending(resultKey, submissionBytes);
    }
  }

  async status(
    scope: WorkflowResultCallerScope,
    resultKey: string,
  ): Promise<WorkflowResultStatus | null> {
    const entry = this.readEntry(resultKey);
    if (
      !entry ||
      entry.environmentId !== scope.environmentId ||
      entry.projectId !== scope.projectId
    )
      return null;
    const delivery =
      entry.lifecycle === "open" ? this.deliveryOf(resultKey, entry.kind) : undefined;
    return {
      resultKey,
      lifecycle: entry.lifecycle,
      completion:
        entry.lifecycle === "consumed"
          ? "completed"
          : entry.lifecycle === "cancelled" ||
              entry.lifecycle === "superseded" ||
              entry.lifecycle === "exhausted"
            ? "blocked"
            : "pending",
      ...(entry.receipt ? { receipt: entry.receipt } : {}),
      ...(delivery ? { delivery } : {}),
    };
  }

  /**
   * Completed validation/submission work for an open slot, with delivery guidance.
   */
  private deliveryOf(resultKey: string, kind: WorkflowResultKind): WorkflowResultDelivery {
    const counters = this.deliveryCounters.get(resultKey);
    const held = this.heldValidation(resultKey);
    const validationCalls = counters?.validationCalls ?? 0;
    const submissionCalls = counters?.submissionCalls ?? 0;
    let hint: string | undefined;
    if (held) {
      hint = `A validated result is held. Commit it by calling ${workflowResultToolName(kind)} with this resultKey and validatedDigest; do not re-send the result.`;
    } else if (validationCalls === 0 && submissionCalls === 0) {
      hint =
        "No validation or submission has been processed for this resultKey. Calls may have been rejected by the client or by service size or capacity limits before processing. Check the actual call error before retrying.";
    } else if (counters?.lastValidation === "invalid") {
      hint = "The last validation reported problems. Correct them and validate again.";
    }
    return {
      validationCalls,
      submissionCalls,
      ...(counters?.lastValidation ? { lastValidation: counters.lastValidation } : {}),
      ...(held ? { validatedDigest: held.digest } : {}),
      ...(hint ? { hint } : {}),
    };
  }

  async structured<T>(resultKey: string): Promise<StructuredOutputResult<T> | null> {
    const entry = this.readEntry(resultKey);
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
    return this.readEntry(resultKey) !== undefined;
  }

  async lookup<T>(
    resultKey: string,
  ): Promise<{ registered: boolean; result: StructuredOutputResult<T> | null }> {
    const entry = this.readEntry(resultKey);
    return {
      registered: entry !== undefined,
      result:
        entry?.receipt && entry.lifecycle === "accepted" && entry.result !== undefined
          ? {
              ok: true,
              provider: entry.provider,
              requestId: resultKey,
              value: entry.result as T,
            }
          : null,
    };
  }

  async binding(
    scope: WorkflowResultCallerScope,
    resultKey: string,
  ): Promise<{
    kind: StoredWorkflowResult["kind"];
    provider: StoredWorkflowResult["provider"];
  } | null> {
    const entry = this.readEntry(resultKey);
    if (
      !entry ||
      entry.environmentId !== scope.environmentId ||
      entry.projectId !== scope.projectId
    ) {
      return null;
    }
    return { kind: entry.kind, provider: entry.provider };
  }

  async consume(resultKey: string): Promise<void> {
    this.mutateEntry<void>(
      resultKey,
      (entry) => {
        if (!entry || entry.lifecycle === "consumed") return { result: undefined };
        if (entry.lifecycle !== "accepted") throw new Error("Workflow result is not accepted");
        const consumedAt = new Date().toISOString();
        entry.lifecycle = "consumed";
        entry.result = undefined;
        entry.context = undefined;
        entry.schema = undefined;
        entry.expectedStoryId = undefined;
        entry.rejectedDigests = [];
        entry.firstSubmissionAt = undefined;
        entry.updatedAt = consumedAt;
        this.metrics.recordConsumptionLatency(
          entry.kind,
          Date.parse(consumedAt) - Date.parse(entry.receipt?.acceptedAt ?? consumedAt),
        );
        // The overwritten row held the payload.
        return { result: undefined, entry, removesContent: true };
      },
      { afterCommit: () => this.forgetDelivery(resultKey) },
    );
  }

  /**
   * Environment deletion. Pruning only reclaims settled slots, so an open slot
   * whose environment is gone would otherwise count against the active-entry
   * limit forever. Returns the number of slots removed.
   */
  async deleteByEnvironment(environmentId: string): Promise<number> {
    const removedKeys: string[] = [];
    return this.commit(
      (database, index) => {
        for (const [resultKey, entry] of index.entries) {
          if (entry.environmentId === environmentId) removedKeys.push(resultKey);
        }
        for (const resultKey of removedKeys) this.removeEntry(database, index, resultKey);
        return { result: removedKeys.length, removesContent: removedKeys.length > 0 };
      },
      {
        afterCommit: () => {
          for (const resultKey of removedKeys) this.forgetDelivery(resultKey);
        },
      },
    );
  }

  async close(resultKey: string, lifecycle: "cancelled" | "superseded"): Promise<void> {
    this.mutateEntry<void>(
      resultKey,
      (entry) => {
        if (!entry || entry.lifecycle === "consumed") return { result: undefined };
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
        entry.context = undefined;
        entry.schema = undefined;
        entry.expectedStoryId = undefined;
        entry.rejectedDigests = [];
        entry.firstSubmissionAt = undefined;
        entry.updatedAt = new Date().toISOString();
        // The overwritten row may have held an accepted payload or context.
        return { result: undefined, entry, removesContent: true };
      },
      { afterCommit: () => this.forgetDelivery(resultKey) },
    );
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

  /**
   * The entry stored under `resultKey`, read from its row alone (supervisors
   * poll these reads). An invalid envelope or entry throws "invalid store", as
   * the whole-file read did: corruption is never mistaken for an absent slot.
   */
  private readEntry(resultKey: string): StoredWorkflowResult | undefined {
    const database = this.database;
    try {
      if (!checkEnvelope(database)) return undefined;
      const value = database.readStoreRow(WORKFLOW_RESULTS_STORE, resultKey, ENTRIES);
      if (value === undefined) return undefined;
      if (!validStoredEntry(resultKey, value)) throw invalidStore();
      return value;
    } catch (error) {
      if (error instanceof StoreCorruptError || error instanceof SyntaxError) throw invalidStore();
      throw error;
    }
  }

  /**
   * The entry index at the committed revision, or `null` when the store does
   * not exist. Rebuilt (parsing and revalidating every entry) only when the
   * revision moved since this service last committed: on first use and after
   * another backend's write.
   */
  private currentIndex(database: StorageDatabase): EntryIndex | null {
    const revision = database.storeRevision(WORKFLOW_RESULTS_STORE);
    if (revision === null) return null;
    if (this.index?.revision === revision) {
      // Reuses entries decoded at this revision: a stat, not a read.
      recurringWorkMetrics.work("storage-stat");
      return this.index;
    }
    this.index = null;
    const startedAt = Date.now();
    let snapshot: { value: unknown; revision: number } | null;
    try {
      if (!checkEnvelope(database)) return null;
      snapshot = database.readStore(WORKFLOW_RESULTS_STORE);
    } catch (error) {
      if (error instanceof StoreCorruptError) throw invalidStore();
      throw error;
    }
    if (!snapshot) return null;
    const entries = (snapshot.value as { entries?: unknown }).entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw invalidStore();
    const sizes = new Map(
      (database.storeRowStats(WORKFLOW_RESULTS_STORE, ENTRIES) ?? []).map((row) => [
        row.key,
        row.bytes,
      ]),
    );
    const index: EntryIndex = { revision: snapshot.revision, entries: new Map(), bytes: 0 };
    for (const [key, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (!validStoredEntry(key, entry)) throw invalidStore();
      const bytes = sizes.get(key) ?? Buffer.byteLength(JSON.stringify(entry), "utf8");
      index.entries.set(key, indexedEntry(entry, bytes));
      index.bytes += bytes;
    }
    this.metrics.recordStorageDuration("load", Date.now() - startedAt);
    this.index = index;
    this.publishGauges(index);
    return index;
  }

  /** {@link currentIndex} inside the write transaction, creating the store when absent. */
  private indexInTransaction(database: StorageDatabase): EntryIndex {
    const index = this.currentIndex(database);
    if (index) return index;
    database.writeStoreInTransaction(WORKFLOW_RESULTS_STORE, {
      version: WORKFLOW_RESULT_STORE_VERSION,
      entries: {},
    });
    const created: EntryIndex = {
      revision: database.storeRevision(WORKFLOW_RESULTS_STORE)!,
      entries: new Map(),
      bytes: 0,
    };
    this.index = created;
    return created;
  }

  /**
   * Runs one mutation as one synchronous IMMEDIATE transaction, with the
   * store's bounds enforced inside it. `afterCommit` runs only once the
   * commit returned, so in-memory delivery state never reflects a write that
   * rolled back. Content removed by the mutation is scrubbed from the
   * database files after the commit.
   */
  private commit<T>(
    operation: (
      database: StorageDatabase,
      index: EntryIndex,
    ) => { result: T; removesContent?: boolean },
    options: { afterCommit?: (result: T) => void } = {},
  ): T {
    const database = this.database;
    // Revalidate, and after another backend's commit rebuild, before taking
    // the write lock; the transaction rebuilds again only if it raced.
    this.currentIndex(database);
    const startedAt = Date.now();
    let outcome: { result: T; removesContent: boolean };
    try {
      outcome = database.transaction(() => {
        const index = this.indexInTransaction(database);
        const { result, removesContent = false } = operation(database, index);
        const pruned = this.enforceBounds(database, index);
        index.revision = database.storeRevision(WORKFLOW_RESULTS_STORE)!;
        return { result, removesContent: removesContent || pruned };
      });
    } catch (error) {
      // The index may describe writes that rolled back.
      this.index = null;
      throw error;
    }
    this.metrics.recordStorageDuration("save", Date.now() - startedAt);
    if (this.index) this.publishGauges(this.index);
    if (outcome.removesContent) database.scrubDeletedContent();
    options.afterCommit?.(outcome.result);
    return outcome.result;
  }

  /**
   * Reads, changes and writes ONE entry's row (O(entry), not O(store)).
   * `operation` gets a private copy of the entry (`undefined` when absent)
   * and returns the entry to persist, if any. A stored entry that fails
   * validation throws "invalid store" instead of being replaced.
   */
  private mutateEntry<T>(
    resultKey: string,
    operation: (entry: StoredWorkflowResult | undefined) => {
      result: T;
      entry?: StoredWorkflowResult;
      removesContent?: boolean;
    },
    options: { afterCommit?: (result: T) => void } = {},
  ): T {
    return this.commit((database, index) => {
      const outcome = database.updateStoreRow(
        WORKFLOW_RESULTS_STORE,
        resultKey,
        (current) => {
          if (current !== undefined && !validStoredEntry(resultKey, current)) throw invalidStore();
          const outcome = operation(current as StoredWorkflowResult | undefined);
          return outcome.entry === undefined
            ? { result: outcome }
            : { result: outcome, value: outcome.entry };
        },
        { collection: ENTRIES, unreadable: "throw" },
      );
      if (outcome.entry !== undefined) {
        const bytes = Buffer.byteLength(JSON.stringify(outcome.entry), "utf8");
        index.bytes += bytes - (index.entries.get(resultKey)?.bytes ?? 0);
        index.entries.set(resultKey, indexedEntry(outcome.entry, bytes));
      }
      return {
        result: outcome.result,
        removesContent: outcome.removesContent === true && outcome.entry !== undefined,
      };
    }, options);
  }

  private removeEntry(database: StorageDatabase, index: EntryIndex, resultKey: string): void {
    database.updateStoreRow(
      WORKFLOW_RESULTS_STORE,
      resultKey,
      () => ({ result: undefined, delete: true as const }),
      { collection: ENTRIES, unreadable: "throw" },
    );
    const existing = index.entries.get(resultKey);
    if (!existing) return;
    index.bytes -= existing.bytes;
    index.entries.delete(resultKey);
  }

  /**
   * Keeps the store within its entry and byte bounds by deleting the oldest
   * settled slots. Throws (rolling the mutation back) when only active slots
   * remain over a bound. Returns whether anything was deleted.
   */
  private enforceBounds(database: StorageDatabase, index: EntryIndex): boolean {
    const retainedByteLimit = MAX_STORE_BYTES - WORKFLOW_RESULT_MAX_BYTES;
    if (index.entries.size <= WORKFLOW_RESULT_MAX_ENTRIES && index.bytes <= retainedByteLimit) {
      return false;
    }
    const removable = Array.from(index.entries)
      .filter(([, entry]) => entry.settled)
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .map(([resultKey]) => resultKey);
    let removed = 0;
    while (
      removed < removable.length &&
      (index.entries.size > WORKFLOW_RESULT_MAX_ENTRIES || index.bytes > retainedByteLimit)
    ) {
      this.removeEntry(database, index, removable[removed++]!);
    }
    if (index.entries.size > WORKFLOW_RESULT_MAX_ENTRIES)
      throw new Error("Workflow result store has too many active entries");
    if (index.bytes > MAX_STORE_BYTES)
      throw new Error("Workflow result store exceeds its size limit");
    return removed > 0;
  }

  /** Gauges from the committed index: row bytes retained, and open or accepted slots. */
  private publishGauges(index: EntryIndex): void {
    let active = 0;
    for (const entry of index.entries.values()) if (!entry.settled) active += 1;
    this.metrics.setGauge("retained_bytes", index.bytes);
    this.metrics.setGauge("active_slots", active);
  }

  private requireCapabilityIdentity(): WorkflowResultCapabilityIdentity {
    if (!this.capabilityIdentity)
      throw new Error("Workflow result capability identity is not ready");
    return this.capabilityIdentity;
  }

  private signCapability(scope: WorkflowResultCallerScope, resultKey: string): string {
    return createHmac("sha256", this.requireCapabilityIdentity().secret)
      .update(`${resultKey}\0${scope.environmentId}\0${scope.projectId}`)
      .digest("base64url");
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
  lookup?<T>(
    resultKey: string,
  ): Promise<{ registered: boolean; result: StructuredOutputResult<T> | null }>;
}

function decodeCapabilityScope(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (!decoded || Buffer.from(decoded, "utf8").toString("base64url") !== encoded) return null;
    return decoded;
  } catch {
    return null;
  }
}
