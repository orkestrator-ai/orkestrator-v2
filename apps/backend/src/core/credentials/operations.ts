import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CREDENTIAL_HTTP_METHODS,
  CREDENTIAL_LIMITS,
  CREDENTIAL_READ_ONLY_HTTP_METHODS,
  CREDENTIAL_TIMING,
  CredentialError,
  type CredentialOperationRecord,
  type CredentialOperationState,
  type CredentialUse,
} from "@orkestrator/protocol/agent-credentials";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  grantUnusableReason,
  deniesShell,
  type CredentialAccess,
  type CredentialCaller,
} from "./access.js";
import { connectionAllowsProject, type CredentialConnections } from "./connections.js";
import type { CredentialContext } from "./context.js";
import {
  prepareCredentialHttpRequest,
  sendCredentialHttpRequest,
  type CredentialHttpAnswer,
  type CredentialHttpInput,
} from "./http-operation.js";
import { publicRecord, type StoredGrant, type StoredOperation } from "./records.js";
import type { RedactionValue } from "./redaction.js";
import {
  cleanupContainerRun,
  startCredentialRun,
  type CredentialRunOutput,
  type CredentialRunResult,
} from "./runner.js";

const log = createLogger("credentials");

/** What an agent gets back about one use. Never a value. */
export interface CredentialOperationView extends CredentialOperationRecord {
  stdout?: CredentialRunOutput;
  stderr?: CredentialRunOutput;
  http?: CredentialHttpAnswer;
  /** Plain-language note for the agent (still running, output not kept, …). */
  note?: string;
}

export interface CredentialRunInput {
  grantId: string;
  command: string;
  timeoutMs?: number;
  idempotencyKey?: string;
  waitMs?: number;
}

export interface CredentialHttpRunInput extends CredentialHttpInput {
  grantId: string;
  idempotencyKey?: string;
}

/** Most uses that may be reserved or running in one tab at once. */
const MAX_RUNNING_PER_TAB = 4;
/** Outputs kept in memory for retrieval; records outlive them. */
const MAX_KEPT_RESULTS = 128;
const FINAL_STATES = new Set<CredentialOperationState>([
  "succeeded",
  "failed",
  "failed_no_effect",
  "outcome_unknown",
  "cancelled_before_start",
]);

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function summarizeCommand(command: string): string {
  const firstLine = command.split("\n", 1)[0] ?? "";
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

function boundedWait(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CREDENTIAL_TIMING.waitDefaultMs;
  return Math.min(Math.max(0, Math.round(value)), CREDENTIAL_TIMING.waitMaxMs);
}

function isReadOnly(grant: StoredGrant, policyId: string | undefined): boolean {
  return grant.runtime.kind === "coordinator" || policyId === "coordinator-read-only";
}

export class CredentialOperations {
  private readonly running = new Map<string, { cancel(options?: { hard?: boolean }): void }>();
  private readonly results = new Map<string, Partial<CredentialOperationView>>();

  constructor(
    private readonly context: CredentialContext,
    private readonly access: CredentialAccess,
    private readonly connections: CredentialConnections,
  ) {}

  /**
   * Every check a use must pass, in order: the grant belongs to this tab and
   * is live; the tab still runs the conversation and runtime the grant was
   * bound to; a connection still has the revision and value it pinned; the
   * session's execution policy allows this kind of use. A binding failure
   * ends the grant: nothing later can make it valid again.
   */
  private async authorize(
    caller: CredentialCaller,
    grantId: string,
    kind: CredentialUse,
  ): Promise<{
    grant: StoredGrant;
    readOnly: boolean;
    approvals: string | null;
    shellDenied: boolean;
  }> {
    const grant = this.context.records.getGrant(grantId);
    if (
      !grant ||
      grant.environmentId !== caller.environmentId ||
      grant.tabId !== caller.tabId ||
      grant.projectId !== caller.projectId
    ) {
      throw new CredentialError("GRANT_NOT_FOUND", "No such grant for this tab.");
    }
    const unusable = grantUnusableReason(this.context, grant);
    if (unusable) throw unusable;
    if (grant.use !== kind) {
      throw new CredentialError(
        "SCOPE_MISMATCH",
        grant.use === "http"
          ? "This grant is for trusted HTTP requests; use http_request_with_credential."
          : "This grant is for commands; use run_with_credential.",
      );
    }
    const [session, runtime] = await Promise.all([
      this.context.host.session(caller.environmentId, caller.tabId),
      this.context.host.runtime(caller.environmentId),
    ]);
    const end = (reason: string) => {
      this.access.endGrants(
        (candidate) => candidate.id === grant.id,
        "invalidated",
        reason,
        grant.environmentId,
      );
      return new CredentialError("SCOPE_MISMATCH", reason);
    };
    if ((session?.providerSessionId ?? null) !== grant.internal.providerSessionId) {
      throw end("This tab started a new conversation; grants of the earlier one ended.");
    }
    if (!runtime || runtime.identity !== grant.internal.runtimeIdentity) {
      throw end(
        "The environment's runtime changed (rebuilt, moved or stopped); request access again.",
      );
    }
    if (grant.source.kind === "connection") {
      const connection = this.context.records.getConnection(grant.source.connectionId);
      // The value version is pinned; the policy is checked as it is now (a
      // policy change also ends grants when it is saved). A rename changes
      // neither.
      if (!connection || connection.valueVersion !== grant.internal.valueVersion) {
        throw end("The saved connection's value changed or was removed; request access again.");
      }
      if (!connectionAllowsProject(connection, grant.projectId)) {
        throw end("The saved connection is no longer available to this project.");
      }
      if (grant.http && grant.http.hosts.some((host) => !connection.httpHosts.includes(host))) {
        throw end("The saved connection no longer allows these hosts.");
      }
    }
    const policy = session?.policy ?? null;
    return {
      grant,
      readOnly: isReadOnly(grant, policy?.id),
      approvals: policy?.approvals ?? null,
      shellDenied: policy ? deniesShell(policy) : false,
    };
  }

  /**
   * Reserves one use in one transaction: rechecks the grant, applies the
   * per-tab running bound and the idempotency key, counts the use. A key
   * already used with the same request returns that operation (no new use);
   * with a different request it is refused.
   */
  private reserve(
    caller: CredentialCaller,
    grantId: string,
    kind: CredentialUse,
    idempotencyKey: string | undefined,
    print: string,
    summary: string,
  ): { operation: StoredOperation; existing: boolean } {
    return this.context.records.transaction((rows) => {
      const grant = rows.grant(grantId);
      if (!grant) throw new CredentialError("GRANT_NOT_FOUND", "No such grant for this tab.");
      const operations = rows.operations(caller.environmentId);
      if (idempotencyKey) {
        const existing = operations.find(
          (operation) =>
            operation.grantId === grantId && operation.internal.idempotencyKey === idempotencyKey,
        );
        if (existing) {
          if (existing.internal.fingerprint !== print) {
            throw new CredentialError(
              "IDEMPOTENCY_CONFLICT",
              "That idempotency key was used for a different request on this grant.",
            );
          }
          return { operation: existing, existing: true };
        }
      }
      const unusable = grantUnusableReason(this.context, grant);
      if (unusable) throw unusable;
      const open = operations.filter(
        (operation) =>
          operation.tabId === caller.tabId &&
          (operation.state === "reserved" || operation.state === "running"),
      );
      if (open.length >= MAX_RUNNING_PER_TAB) {
        throw new CredentialError(
          "REQUEST_LIMIT",
          "Four credential operations are already running in this tab; wait for one to finish.",
        );
      }
      rows.putGrant({ ...grant, uses: grant.uses + 1 });
      const operation: StoredOperation = {
        id: randomUUID(),
        grantId,
        environmentId: caller.environmentId,
        tabId: caller.tabId,
        kind,
        state: "reserved",
        summary,
        createdAt: this.context.now(),
        cleanup: "none",
        internal: {
          idempotencyKey: idempotencyKey ?? null,
          fingerprint: print,
          bootId: this.context.bootId,
        },
      };
      rows.putOperation(operation);
      return { operation, existing: false };
    });
  }

  private update(id: string, patch: Partial<StoredOperation>): StoredOperation | null {
    const next = this.context.records.transaction((rows) => {
      const current = rows.operation(id);
      if (!current) return null;
      const updated: StoredOperation = { ...current, ...patch };
      rows.putOperation(updated);
      return updated;
    });
    if (next) {
      this.context.notify(id);
      this.context.announce(next.environmentId);
    }
    return next;
  }

  /**
   * A use that ended before anything ran gives its use back: nothing could
   * have happened, so counting it would only shorten the grant.
   */
  private cancelBeforeStart(operation: StoredOperation, error: string): StoredOperation {
    const next = this.context.records.transaction((rows) => {
      const current = rows.operation(operation.id);
      if (!current || current.state !== "reserved") return current;
      const grant = rows.grant(operation.grantId);
      if (grant && grant.uses > 0) rows.putGrant({ ...grant, uses: grant.uses - 1 });
      const updated: StoredOperation = {
        ...current,
        state: "cancelled_before_start",
        finishedAt: this.context.now(),
        error,
      };
      rows.putOperation(updated);
      return updated;
    });
    this.context.notify(operation.id);
    this.context.announce(operation.environmentId);
    return next ?? operation;
  }

  private async resolveValue(grant: StoredGrant): Promise<string | null> {
    try {
      const value =
        grant.source.kind === "temporary"
          ? await this.context.temporary.get(grant.internal.entryId)
          : await this.context.vault.get(grant.internal.entryId);
      if (value === null && grant.source.kind === "connection") {
        // Only when the connection still points at this entry: a value
        // replaced a moment ago leaves the old entry gone, not the connection.
        this.connections.markUnavailable(grant.source.connectionId, grant.internal.entryId);
      }
      return value;
    } catch (error) {
      log.warn("vault.read-failed", { error: formatLogError(error) });
      return null;
    }
  }

  private redaction(grant: StoredGrant, value: string): RedactionValue[] {
    return [
      {
        value,
        label: grant.label,
        ...(grant.http?.auth.scheme === "basic" ? { basicUser: grant.http.auth.username } : {}),
      },
    ];
  }

  /** Releases a grant whose uses ran out once nothing of it is running. */
  private settleUsedUp(grantId: string): void {
    const grant = this.context.records.getGrant(grantId);
    if (
      !grant ||
      grant.state !== "active" ||
      grant.maxUses === null ||
      grant.uses < grant.maxUses
    ) {
      return;
    }
    const busy = this.context.records
      .listOperations(grant.environmentId)
      .some(
        (operation) =>
          operation.grantId === grantId &&
          (operation.state === "reserved" || operation.state === "running"),
      );
    if (busy) return;
    this.access.endGrants(
      (candidate) => candidate.id === grantId,
      "expired",
      "All of its uses were consumed.",
      grant.environmentId,
    );
  }

  private keep(id: string, result: Partial<CredentialOperationView>): void {
    this.results.delete(id);
    this.results.set(id, result);
    while (this.results.size > MAX_KEPT_RESULTS) {
      const oldest = this.results.keys().next().value;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
  }

  view(operation: StoredOperation): CredentialOperationView {
    const kept = this.results.get(operation.id);
    const view: CredentialOperationView = { ...publicRecord(operation), ...kept };
    if (operation.state === "reserved" || operation.state === "running") {
      view.note =
        "Still running. Call get_credential_operation with this operationId to wait for the result; do not start it again.";
    } else if (!kept && operation.kind === "command" && FINAL_STATES.has(operation.state)) {
      view.note =
        "The output of this run is no longer kept (Orkestrator restarted or many runs followed).";
    }
    if (operation.state === "outcome_unknown") {
      view.note =
        (view.note ? `${view.note} ` : "") +
        "It may have had an effect before it stopped. Check before repeating it.";
    }
    return view;
  }

  // --- Commands ---------------------------------------------------------------

  async runCommand(
    caller: CredentialCaller,
    input: CredentialRunInput,
  ): Promise<CredentialOperationView> {
    if (typeof input.command !== "string" || !input.command.trim()) {
      throw new CredentialError("INVALID_INPUT", "command is required.");
    }
    if (input.command.length > CREDENTIAL_LIMITS.commandMaxChars) {
      throw new CredentialError("INVALID_INPUT", "The command is too long.");
    }
    const timeoutMs = Math.min(
      Math.max(1_000, Math.round(input.timeoutMs ?? CREDENTIAL_TIMING.runDefaultTimeoutMs)),
      CREDENTIAL_TIMING.runMaxTimeoutMs,
    );
    const print = fingerprint({ kind: "command", command: input.command, timeoutMs });
    const replayed = await this.replay(
      caller,
      input.grantId,
      input.idempotencyKey,
      print,
      input.waitMs,
    );
    if (replayed) return replayed;
    const authorized = await this.authorize(caller, input.grantId, "command");
    const { grant } = authorized;
    if (authorized.readOnly) {
      throw new CredentialError("UNSUPPORTED_RUNTIME", "A read-only session cannot run commands.");
    }
    if (authorized.approvals === "deny" || authorized.shellDenied) {
      throw new CredentialError(
        "POLICY_DENIED",
        "This session's execution policy does not allow running commands.",
      );
    }
    if (grant.command !== undefined && grant.command !== input.command) {
      throw new CredentialError(
        "SCOPE_MISMATCH",
        "This grant allows only the exact command that was approved.",
      );
    }
    if (authorized.approvals === "ask" && grant.command === undefined) {
      throw new CredentialError(
        "POLICY_DENIED",
        "This session asks before running commands, so only an approved exact command can run.",
      );
    }
    const { operation, existing } = this.reserve(
      caller,
      grant.id,
      "command",
      input.idempotencyKey,
      print,
      summarizeCommand(input.command),
    );
    if (!existing) await this.startCommand(operation, grant, input.command, timeoutMs);
    return this.wait(caller, operation.id, boundedWait(input.waitMs));
  }

  private async startCommand(
    operation: StoredOperation,
    grant: StoredGrant,
    command: string,
    timeoutMs: number,
  ): Promise<void> {
    const value = await this.resolveValue(grant);
    if (value === null) {
      this.cancelBeforeStart(operation, "The credential value is unavailable.");
      return;
    }
    let launch;
    try {
      launch = await this.context.host.launch(grant.environmentId, grant.tabId);
    } catch (error) {
      this.cancelBeforeStart(
        operation,
        error instanceof Error ? error.message.slice(0, 300) : "Unavailable",
      );
      return;
    }
    // Recheck after the awaits: a revocation in between wins.
    const current = this.context.records.getGrant(grant.id);
    if (!current || current.state !== "active" || current.expiresAt <= this.context.now()) {
      launch.release?.();
      this.cancelBeforeStart(operation, "The grant ended before the command started.");
      return;
    }
    if (grant.binding === undefined) {
      launch.release?.();
      this.cancelBeforeStart(operation, "The grant has no binding.");
      return;
    }
    const handle = startCredentialRun({
      id: operation.id,
      launch,
      command,
      bindings: [{ binding: grant.binding, value }],
      redaction: this.redaction(grant, value),
      timeoutMs,
      runRoot: this.context.runRoot,
      ...(this.context.spawnProcess ? { spawnProcess: this.context.spawnProcess } : {}),
    });
    this.running.set(operation.id, { cancel: (options) => handle.cancel(options) });
    this.update(operation.id, {
      state: "running",
      startedAt: this.context.now(),
      // Kept so a later process can clean up a container run this one leaves.
      ...(launch.target === "container" && launch.containerId
        ? { internal: { ...operation.internal, containerId: launch.containerId } }
        : {}),
    });
    if (grant.source.kind === "connection") this.connections.noteUsed(grant.source.connectionId);
    void handle.result
      .then((result) => this.finishCommand(operation, result))
      .catch((error: unknown) => {
        log.warn("run.failed", { error: formatLogError(error) });
        this.update(operation.id, {
          state: "outcome_unknown",
          finishedAt: this.context.now(),
          cleanup: "unconfirmed",
          error: "The run failed unexpectedly.",
        });
      })
      .finally(() => {
        this.running.delete(operation.id);
        this.context.notify(operation.id);
        this.settleUsedUp(grant.id);
      });
  }

  /**
   * A retry with an idempotency key already used on this grant by this tab
   * answers the earlier operation, before any other check: the grant may have
   * been used up or ended by that very operation, and a retry after a lost
   * answer must still find it. The same key with a different request is
   * refused. Null when the key is new (or absent).
   */
  private async replay(
    caller: CredentialCaller,
    grantId: string,
    idempotencyKey: string | undefined,
    print: string,
    waitMs?: number,
  ): Promise<CredentialOperationView | null> {
    if (!idempotencyKey) return null;
    const existing = this.context.records
      .listOperations(caller.environmentId)
      .find(
        (operation) =>
          operation.tabId === caller.tabId &&
          operation.grantId === grantId &&
          operation.internal.idempotencyKey === idempotencyKey,
      );
    if (!existing) return null;
    if (existing.internal.fingerprint !== print) {
      throw new CredentialError(
        "IDEMPOTENCY_CONFLICT",
        "That idempotency key was used for a different request on this grant.",
      );
    }
    return this.wait(caller, existing.id, boundedWait(waitMs));
  }

  private finishCommand(operation: StoredOperation, result: CredentialRunResult): void {
    if (result.spawnError) {
      // Nothing ran: the use is given back, as for any start that never happened.
      this.context.records.transaction((rows) => {
        const grant = rows.grant(operation.grantId);
        if (grant && grant.uses > 0) rows.putGrant({ ...grant, uses: grant.uses - 1 });
      });
    }
    const state: CredentialOperationState = result.spawnError
      ? "cancelled_before_start"
      : result.timedOut || result.cancelled || result.exitCode === null
        ? "outcome_unknown"
        : result.exitCode === 0
          ? "succeeded"
          : "failed";
    this.keep(operation.id, { stdout: result.stdout, stderr: result.stderr });
    this.update(operation.id, {
      state,
      finishedAt: this.context.now(),
      exitCode: result.exitCode,
      ...(result.timedOut ? { timedOut: true } : {}),
      cleanup: result.cleanup,
      ...(result.spawnError
        ? { error: `The command could not start (${result.spawnError}).` }
        : result.cancelled
          ? { error: "Cancelled." }
          : result.timedOut
            ? { error: "Stopped at its deadline." }
            : result.signal
              ? { error: `Ended by ${result.signal}.` }
              : {}),
    });
  }

  // --- Trusted HTTP -------------------------------------------------------------

  async httpRequest(
    caller: CredentialCaller,
    input: CredentialHttpRunInput,
  ): Promise<CredentialOperationView> {
    const print = fingerprint({
      kind: "http",
      method: String(input.method).toUpperCase(),
      url: String(input.url),
      headers: Object.entries(input.headers ?? {})
        .map(([name, value]) => [name.toLowerCase(), value])
        .sort(),
      body: input.body === undefined ? null : fingerprint(input.body),
    });
    const replayed = await this.replay(caller, input.grantId, input.idempotencyKey, print);
    if (replayed) return replayed;
    const authorized = await this.authorize(caller, input.grantId, "http");
    const { grant } = authorized;
    if (!grant.http) throw new CredentialError("SCOPE_MISMATCH", "This grant has no HTTP policy.");
    const prepared = prepareCredentialHttpRequest(
      input,
      grant.http,
      authorized.readOnly ? CREDENTIAL_READ_ONLY_HTTP_METHODS : CREDENTIAL_HTTP_METHODS,
    );
    const { operation, existing } = this.reserve(
      caller,
      grant.id,
      "http",
      input.idempotencyKey,
      print,
      prepared.summary,
    );
    if (existing) return this.wait(caller, operation.id, CREDENTIAL_TIMING.waitDefaultMs);
    const value = await this.resolveValue(grant);
    if (value === null) {
      return this.view(this.cancelBeforeStart(operation, "The credential value is unavailable."));
    }
    const current = this.context.records.getGrant(grant.id);
    if (!current || current.state !== "active" || current.expiresAt <= this.context.now()) {
      return this.view(
        this.cancelBeforeStart(operation, "The grant ended before the request was sent."),
      );
    }
    const controller = new AbortController();
    this.running.set(operation.id, { cancel: () => controller.abort() });
    this.update(operation.id, { state: "running", startedAt: this.context.now() });
    if (grant.source.kind === "connection") this.connections.noteUsed(grant.source.connectionId);
    try {
      const outcome = await sendCredentialHttpRequest(
        prepared,
        grant.http,
        value,
        this.redaction(grant, value),
        {
          ...(this.context.fetch ? { fetch: this.context.fetch } : {}),
          signal: controller.signal,
        },
      );
      const safe = prepared.method === "GET" || prepared.method === "HEAD";
      if (outcome.kind === "answered") {
        this.keep(operation.id, { http: outcome.answer });
        this.update(operation.id, {
          state: "succeeded",
          finishedAt: this.context.now(),
          httpStatus: outcome.answer.status,
        });
      } else if (outcome.kind === "not-sent") {
        this.update(operation.id, {
          state: "failed_no_effect",
          finishedAt: this.context.now(),
          error: `The request was not sent (${outcome.reason}).`,
        });
      } else {
        this.update(operation.id, {
          state: safe ? "failed" : "outcome_unknown",
          finishedAt: this.context.now(),
          error: `No answer arrived (${outcome.reason}).`,
        });
      }
    } finally {
      this.running.delete(operation.id);
      this.settleUsedUp(grant.id);
    }
    const finished = this.context.records.getOperation(operation.id);
    return finished ? this.view(finished) : this.view(operation);
  }

  // --- Reading, waiting, cancelling ---------------------------------------------

  private owned(caller: CredentialCaller, operationId: string): StoredOperation {
    const operation = this.context.records.getOperation(operationId);
    if (
      !operation ||
      operation.environmentId !== caller.environmentId ||
      operation.tabId !== caller.tabId
    ) {
      throw new CredentialError("REQUEST_NOT_FOUND", "No such credential operation for this tab.");
    }
    return operation;
  }

  async wait(
    caller: CredentialCaller,
    operationId: string,
    waitMs: number,
  ): Promise<CredentialOperationView> {
    this.owned(caller, operationId);
    await this.context.waitFor(operationId, waitMs, () => {
      const current = this.context.records.getOperation(operationId);
      return !current || (FINAL_STATES.has(current.state) && !this.running.has(operationId));
    });
    return this.view(this.owned(caller, operationId));
  }

  cancel(caller: CredentialCaller, operationId: string): CredentialOperationView {
    const operation = this.owned(caller, operationId);
    this.running.get(operationId)?.cancel();
    return this.view(operation);
  }

  /** Stops the running work of ended grants. */
  cancelForGrants(grantIds: readonly string[]): void {
    const ids = new Set(grantIds);
    for (const operation of this.context.records.listOperations()) {
      if (ids.has(operation.grantId)) this.running.get(operation.id)?.cancel();
    }
  }

  cancelEnvironment(environmentId: string): void {
    for (const operation of this.context.records.listOperations(environmentId)) {
      this.running.get(operation.id)?.cancel();
    }
  }

  /**
   * Startup: an operation a previous process left open cannot be resumed.
   * A reserved one never started; a running one may have done anything, and
   * its processes and files are not confirmed gone.
   */
  async reconcileStartup(): Promise<void> {
    const reconciled: string[] = [];
    const containerRuns: Array<{ id: string; containerId: string }> = [];
    const changed = this.context.records.transaction((rows) => {
      const environments = new Set<string>();
      for (const operation of rows.operations()) {
        if (operation.internal.bootId === this.context.bootId) continue;
        if (operation.state === "reserved") {
          rows.putOperation({
            ...operation,
            state: "cancelled_before_start",
            finishedAt: this.context.now(),
            error: "Orkestrator restarted before it started.",
          });
          environments.add(operation.environmentId);
        } else if (operation.state === "running") {
          rows.putOperation({
            ...operation,
            state: "outcome_unknown",
            finishedAt: this.context.now(),
            cleanup: "unconfirmed",
            error: "Orkestrator restarted while it ran.",
          });
          environments.add(operation.environmentId);
          reconciled.push(operation.id);
          if (operation.internal.containerId) {
            containerRuns.push({ id: operation.id, containerId: operation.internal.containerId });
          }
        }
      }
      return [...environments];
    });
    for (const environmentId of changed) this.context.announce(environmentId);
    // Private files of worktree runs the previous process left behind. Only
    // those runs' own directories: the names are their operation ids.
    for (const id of reconciled) {
      await fs
        .rm(path.join(this.context.runRoot, id), { recursive: true, force: true })
        .catch(() => undefined);
    }
    // A container run's processes and files are inside the container, which
    // may still be running: end them there. Best effort; the record stays
    // "unconfirmed" either way.
    for (const run of containerRuns) {
      await cleanupContainerRun({
        containerId: run.containerId,
        id: run.id,
        env: process.env,
        ...(this.context.spawnProcess ? { spawnProcess: this.context.spawnProcess } : {}),
      });
    }
  }

  /** Shutdown: running commands are killed at once, not after a grace period. */
  stop(): void {
    for (const entry of this.running.values()) entry.cancel({ hard: true });
  }

  overview(limit = 50): CredentialOperationRecord[] {
    return this.context.records
      .listOperations()
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map((operation) => publicRecord(operation));
  }
}
