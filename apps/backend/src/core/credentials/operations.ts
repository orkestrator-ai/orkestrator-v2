import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CREDENTIAL_LIMITS,
  CREDENTIAL_TIMING,
  CredentialError,
  credentialBindingNameProblem,
  credentialValueProblem,
  normalizeCredentialHosts,
  type CredentialOperationRecord,
  type CredentialOperationState,
  type CredentialUse,
} from "@orkestrator/protocol/agent-credentials";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { grantUnusableReason, type CredentialAccess, type CredentialCaller } from "./access.js";
import { connectionAllowsProject, type CredentialConnections } from "./connections.js";
import type { CredentialContext } from "./context.js";
import {
  materializeCredentialHeaders,
  normalizeCredentialRequestHeaders,
  prepareCredentialHttpRequest,
  sendCredentialHttpRequest,
  type CredentialHttpAnswer,
  type CredentialHttpInput,
} from "./http-operation.js";
import { credentialOwnerAlive } from "./owner.js";
import { assertCredentialPolicy } from "./policy.js";
import { resolvePublicAddress } from "./public-https.js";
import {
  publicRecord,
  type CredentialRows,
  type CredentialRunCleanup,
  type StoredGrant,
  type StoredOperation,
} from "./records.js";
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

function refundUse(rows: CredentialRows, grantId: string): void {
  const grant = rows.grant(grantId);
  if (grant && grant.uses > 0) rows.putGrant({ ...grant, uses: grant.uses - 1 });
}

function findReplay(
  operations: readonly StoredOperation[],
  caller: CredentialCaller,
  grantId: string,
  key: string,
): StoredOperation | undefined {
  return operations.find(
    (operation) =>
      operation.tabId === caller.tabId &&
      operation.grantId === grantId &&
      operation.internal.idempotencyKey === key,
  );
}

export class CredentialOperations {
  private readonly running = new Map<string, { cancel(options?: { hard?: boolean }): void }>();
  private stopped = false;
  private recovery: Promise<void> | undefined;
  private cleanupCursor = 0;
  private readonly results = new Map<string, Partial<CredentialOperationView>>();

  constructor(
    private readonly context: CredentialContext,
    private readonly access: CredentialAccess,
    private readonly connections: CredentialConnections,
  ) {}

  /**
   * Every check a use must pass, in order: the grant belongs to this
   * environment and project and is live; the environment still has the
   * runtime the grant was bound to; a connection still has the value it
   * pinned and still allows the project and hosts; the calling session's
   * execution policy allows this kind of use. Any tab of the environment may
   * use a grant. A binding failure ends the grant: nothing later can make it
   * valid again.
   */
  private async authorize(
    caller: CredentialCaller,
    grantId: string,
    kind: CredentialUse,
    reservation?: StoredOperation,
  ): Promise<{ grant: StoredGrant; agent: string | null }> {
    this.assertAcceptingWork();
    const grant = this.context.records.getGrant(grantId);
    if (
      !grant ||
      grant.environmentId !== caller.environmentId ||
      grant.projectId !== caller.projectId
    ) {
      throw new CredentialError("GRANT_NOT_FOUND", "No such grant in this environment.");
    }
    const unusable = grantUnusableReason(this.context, grant, reservation !== undefined);
    if (unusable && !reservation) throw unusable;
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
    if (!runtime || runtime.identity !== grant.internal.runtimeIdentity) {
      this.invalidateBinding(
        grant,
        "The environment's runtime changed (rebuilt, moved or stopped); request access again.",
        reservation,
      );
    }
    if (unusable) throw unusable;
    if (grant.source.kind === "connection") {
      const connection = this.context.records.getConnection(grant.source.connectionId);
      // The value version is pinned; the policy is checked as it is now (a
      // policy change also ends grants when it is saved). A rename changes
      // neither.
      if (!connection || connection.valueVersion !== grant.internal.valueVersion) {
        this.invalidateBinding(
          grant,
          "The saved connection's value changed or was removed; request access again.",
        );
      }
      if (!connectionAllowsProject(connection, grant.projectId)) {
        this.invalidateBinding(
          grant,
          "The saved connection is no longer available to this project.",
        );
      }
      if (
        grant.http &&
        (normalizeCredentialHosts(grant.http.hosts) ?? grant.http.hosts).some(
          (host) => !normalizeCredentialHosts(connection.httpHosts)?.includes(host),
        )
      ) {
        this.invalidateBinding(grant, "The saved connection no longer allows these hosts.");
      }
    }
    assertCredentialPolicy(kind, session, runtime, grant.command);
    if (kind === "command" && grant.binding) {
      const problem = credentialBindingNameProblem(grant.binding.name, {
        containerEnvironment: runtime.runtime.kind === "container" && grant.binding.kind === "env",
      });
      if (problem) throw new CredentialError("INVALID_INPUT", problem);
    }
    return { grant, agent: session?.agent ?? null };
  }

  private async authorizeNewUse(
    caller: CredentialCaller,
    input: { grantId: string; idempotencyKey?: string; waitMs?: number },
    kind: CredentialUse,
    print: string,
  ): Promise<{ grant: StoredGrant } | { replay: CredentialOperationView }> {
    const { grantId, idempotencyKey, waitMs } = input;
    const previous = await this.replay(caller, grantId, idempotencyKey, print, waitMs);
    if (previous) return { replay: previous };
    try {
      return await this.authorize(caller, grantId, kind);
    } catch (error) {
      // The other backend may have used the last admission during the first lookup.
      const raced = await this.replay(caller, grantId, idempotencyKey, print, waitMs);
      if (raced) return { replay: raced };
      throw error;
    }
  }

  private invalidateBinding(
    grant: StoredGrant,
    reason: string,
    reservation?: StoredOperation,
  ): never {
    if (reservation) this.cancelBeforeStart(reservation, `SCOPE_MISMATCH: ${reason}`);
    this.access.endGrants(
      (candidate) => candidate.id === grant.id,
      "invalidated",
      reason,
      grant.environmentId,
    );
    throw new CredentialError("SCOPE_MISMATCH", reason);
  }

  private assertAcceptingWork(): void {
    if (this.stopped)
      throw new CredentialError("POLICY_DENIED", "The credential service is stopping.");
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
    this.assertAcceptingWork();
    return this.context.records.transaction((rows) => {
      const grant = rows.grant(grantId);
      if (!grant) throw new CredentialError("GRANT_NOT_FOUND", "No such grant for this tab.");
      const operations = rows.operations(caller.environmentId);
      if (idempotencyKey) {
        const existing = findReplay(operations, caller, grantId, idempotencyKey);
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
      if (
        kind === "command" &&
        rows.countRunCleanup(caller.environmentId) >= CREDENTIAL_LIMITS.maxRecordsPerEnvironment
      ) {
        throw new CredentialError("REQUEST_LIMIT", "Credential command cleanup is pending.");
      }
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
      if (
        operations.length >= CREDENTIAL_LIMITS.maxRecordsPerEnvironment &&
        !operations.some((operation) => rows.operationCanBePruned(operation))
      ) {
        throw new CredentialError(
          "REQUEST_LIMIT",
          "Credential operation history is full. End unused grants or wait for them to expire.",
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
          scope: { projectId: grant.projectId, providerSessionId: null },
          bootId: this.context.bootId,
          owner: this.context.owner,
        },
      };
      rows.putOperation(operation);
      return { operation, existing: false };
    });
  }

  /** Claims the reserved operation and rechecks the grant in the same write. */
  private dispatch(operation: StoredOperation, agent: string | null): void {
    try {
      this.claimDispatch(operation, agent);
    } catch (error) {
      if (error instanceof CredentialError && error.code === "SCOPE_MISMATCH") {
        const grant = this.context.records.getGrant(operation.grantId);
        if (grant) this.invalidateBinding(grant, error.message, operation);
      }
      throw error;
    }
  }

  private claimDispatch(operation: StoredOperation, agent: string | null): void {
    this.assertAcceptingWork();
    const started = this.context.records.transaction((rows) => {
      const current = rows.operation(operation.id);
      if (current?.state !== "reserved") return false;
      const grant = rows.grant(operation.grantId);
      if (!grant) throw new CredentialError("ACCESS_EXPIRED", "The grant ended.");
      const unusable = grantUnusableReason(this.context, grant, true);
      if (unusable) throw unusable;
      // The calling tab's session decides the policy; the runtime must be
      // the one the grant was issued for.
      const binding = this.context.host.dispatchBinding?.(
        grant.environmentId,
        current.tabId,
        agent,
      );
      if (binding) {
        const { session, runtime } = binding;
        if (!runtime || runtime.identity !== grant.internal.runtimeIdentity) {
          throw new CredentialError("SCOPE_MISMATCH", "The runtime changed before dispatch.");
        }
        assertCredentialPolicy(grant.use, session, runtime, grant.command);
      }
      rows.putOperation({ ...current, state: "running", startedAt: this.context.now() });
      return true;
    });
    if (!started)
      throw new CredentialError("ACCESS_EXPIRED", "The operation was cancelled before dispatch.");
    this.context.announce(operation.environmentId);
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
  private cancelBeforeStart(
    operation: StoredOperation,
    error: string,
    cleanup: StoredOperation["cleanup"] = "none",
    spawnFailed = false,
  ): StoredOperation {
    const next = this.context.records.transaction((rows) => {
      const current = rows.operation(operation.id);
      if (
        !current ||
        (current.state !== "reserved" && !(spawnFailed && current.state === "running"))
      ) {
        return current;
      }
      refundUse(rows, operation.grantId);
      const updated: StoredOperation = {
        ...current,
        state: "cancelled_before_start",
        cleanup: cleanup === "none" && rows.runCleanup(operation.id) ? "unconfirmed" : cleanup,
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
          : await this.connections.readValue(grant.source.connectionId, grant.internal.entryId);
      return value !== null && credentialValueProblem(value) === null ? value : null;
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
      view.note = operation.internal.cancelRequested
        ? "Cancellation requested. Call get_credential_operation to check the outcome before repeating it."
        : "Still running. Call get_credential_operation with this operationId to wait for the result; do not start it again.";
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
    const admission = await this.authorizeNewUse(caller, input, "command", print);
    if ("replay" in admission) return admission.replay;
    const { grant } = admission;
    if (grant.command !== undefined && grant.command !== input.command) {
      throw new CredentialError(
        "SCOPE_MISMATCH",
        "This grant allows only the exact command that was approved.",
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
    if (!existing) {
      this.context.announce(operation.environmentId);
      await this.startCommand(caller, operation, grant, input.command, timeoutMs);
    }
    return this.wait(caller, operation.id, boundedWait(input.waitMs));
  }

  private async startCommand(
    caller: CredentialCaller,
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
    if (this.context.records.getOperation(operation.id)?.state !== "reserved") return;
    let launch;
    let handle;
    let stagingRecorded = false;
    try {
      await this.authorize(caller, grant.id, "command", operation);
      if (this.context.records.getOperation(operation.id)?.state !== "reserved") return;
      launch = await this.context.host.launch(grant.environmentId, operation.tabId);
      const { agent } = await this.authorize(caller, grant.id, "command", operation);
      const identity =
        launch.target === "container"
          ? `container:${launch.containerId}`
          : `worktree:${launch.cwd}`;
      if (identity !== grant.internal.runtimeIdentity) {
        this.invalidateBinding(
          grant,
          "The environment's runtime changed before launch.",
          operation,
        );
      }
      if (this.context.records.getOperation(operation.id)?.state !== "reserved") {
        launch.release?.();
        return;
      }
      if (!grant.binding) throw new CredentialError("SCOPE_MISMATCH", "The grant has no binding.");
      const cleanup: CredentialRunCleanup = {
        id: operation.id,
        environmentId: operation.environmentId,
        owner: this.context.owner,
        ...(launch.target === "container" && launch.containerId
          ? { containerId: launch.containerId }
          : {}),
      };
      const staged = this.context.records.transaction((rows) => {
        if (rows.operation(operation.id)?.state !== "reserved") return false;
        rows.putRunCleanup(cleanup);
        return true;
      });
      if (!staged) {
        launch.release?.();
        return;
      }
      stagingRecorded = true;
      handle = startCredentialRun({
        id: operation.id,
        launch,
        command,
        bindings: [{ binding: grant.binding, value }],
        redaction: this.redaction(grant, value),
        timeoutMs,
        runRoot: this.context.runRoot,
        beforeSpawn: () => this.authorize(caller, grant.id, "command", operation),
        onDispatch: () => this.dispatch(operation, agent),
        ...(this.context.spawnProcess ? { spawnProcess: this.context.spawnProcess } : {}),
      });
    } catch (error) {
      launch?.release?.();
      if (stagingRecorded) this.recordRunCleanup(operation.id, "confirmed");
      this.cancelBeforeStart(
        operation,
        error instanceof CredentialError ? error.message : "The command could not be prepared.",
      );
      if (
        error instanceof CredentialError &&
        (error.code === "SCOPE_MISMATCH" ||
          error.code === "UNSUPPORTED_RUNTIME" ||
          (error.code === "POLICY_DENIED" && !this.stopped))
      )
        throw error;
      return;
    }
    this.running.set(operation.id, { cancel: handle.cancel });
    void handle.started
      .then((started) => {
        if (started && grant.source.kind === "connection")
          this.connections.noteUsed(grant.source.connectionId);
      })
      .catch(() => undefined);
    void handle.result
      .then((result) => this.finishCommand(operation, result))
      .catch((error: unknown) => {
        log.warn("run.failed", { error: formatLogError(error) });
        this.recordRunCleanup(operation.id, "unconfirmed");
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
      })
      .catch(() => undefined);
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
    const existing = findReplay(
      this.context.records.listOperations(caller.environmentId),
      caller,
      grantId,
      idempotencyKey,
    );
    if (!existing) return null;
    await this.owned(caller, existing.id);
    if (existing.internal.fingerprint !== print) {
      throw new CredentialError(
        "IDEMPOTENCY_CONFLICT",
        "That idempotency key was used for a different request on this grant.",
      );
    }
    return this.wait(caller, existing.id, boundedWait(waitMs));
  }

  private recordRunCleanup(id: string, cleanup: StoredOperation["cleanup"]): void {
    this.context.records.transaction((rows) => {
      const pending = rows.runCleanup(id);
      if (!pending) return;
      if (cleanup === "confirmed") rows.confirmRunCleanup(id);
      else rows.putRunCleanup({ ...pending, retryable: true });
    });
  }

  private finishCommand(operation: StoredOperation, result: CredentialRunResult): void {
    this.recordRunCleanup(operation.id, result.cleanup);
    const current = this.context.records.getOperation(operation.id);
    if (!current) return;
    if (current.state === "cancelled_before_start") {
      this.update(operation.id, { cleanup: result.cleanup });
      return;
    }
    if (current.state !== "running" && current.state !== "reserved") return;
    if (result.spawnError) {
      this.cancelBeforeStart(
        current,
        `The command could not start (${result.spawnError}).`,
        result.cleanup,
        true,
      );
      return;
    }
    const state: CredentialOperationState =
      result.timedOut || result.cancelled || result.exitCode === null
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
      ...(result.cancelled
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
    const headers = normalizeCredentialRequestHeaders(input.headers);
    const print = fingerprint({
      kind: "http",
      method: String(input.method).toUpperCase(),
      url: String(input.url),
      headers: Object.entries(headers).sort(),
      body: input.body === undefined ? null : fingerprint(input.body),
    });
    const admission = await this.authorizeNewUse(caller, input, "http", print);
    if ("replay" in admission) return admission.replay;
    const { grant } = admission;
    if (!grant.http) throw new CredentialError("SCOPE_MISMATCH", "This grant has no HTTP policy.");
    const prepared = prepareCredentialHttpRequest(input, grant.http, headers);
    const { operation, existing } = this.reserve(
      caller,
      grant.id,
      "http",
      input.idempotencyKey,
      print,
      prepared.summary,
    );
    if (existing) return this.wait(caller, operation.id, CREDENTIAL_TIMING.waitDefaultMs);
    this.context.announce(operation.environmentId);
    const value = await this.resolveValue(grant);
    if (value === null) {
      return this.view(this.cancelBeforeStart(operation, "The credential value is unavailable."));
    }
    if (this.context.records.getOperation(operation.id)?.state !== "reserved") {
      return this.wait(caller, operation.id, 0);
    }
    const controller = new AbortController();
    let release: (() => void) | undefined;
    let dispatched = false;
    try {
      await this.authorize(caller, grant.id, "http", operation);
      if (this.context.records.getOperation(operation.id)?.state !== "reserved") {
        return this.wait(caller, operation.id, 0);
      }
      const headers = materializeCredentialHeaders(prepared, grant.http, value);
      const address = await resolvePublicAddress(
        prepared.url.hostname,
        this.context.resolveHttpAddress,
      );
      if (!address) {
        throw new CredentialError(
          "POLICY_DENIED",
          "The approved hostname does not resolve exclusively to public addresses.",
        );
      }
      release = await this.context.host.beginUse?.(grant.environmentId, operation.tabId);
      const { agent } = await this.authorize(caller, grant.id, "http", operation);
      this.dispatch(operation, agent);
      dispatched = true;
      this.running.set(operation.id, { cancel: () => controller.abort() });
      const outcome = await sendCredentialHttpRequest(
        prepared,
        headers,
        this.redaction(grant, value),
        { fetch: this.context.fetch, address, signal: controller.signal },
      );
      if (grant.source.kind === "connection" && outcome.kind !== "not-sent") {
        this.connections.noteUsed(grant.source.connectionId);
      }
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
          state: "outcome_unknown",
          finishedAt: this.context.now(),
          error: `No answer arrived (${outcome.reason}).`,
        });
      }
    } catch (error) {
      if (dispatched) {
        this.update(operation.id, {
          state: "outcome_unknown",
          finishedAt: this.context.now(),
          error: "The request failed unexpectedly.",
        });
      } else {
        this.cancelBeforeStart(
          operation,
          error instanceof CredentialError ? error.message : "The request could not be prepared.",
        );
        if (
          error instanceof CredentialError &&
          (error.code === "SCOPE_MISMATCH" ||
            error.code === "INVALID_INPUT" ||
            error.code === "POLICY_DENIED") &&
          !this.stopped
        )
          throw error;
      }
    } finally {
      release?.();
      this.running.delete(operation.id);
      this.context.notify(operation.id);
      this.settleUsedUp(grant.id);
    }
    return this.wait(caller, operation.id, 0);
  }

  // --- Reading, waiting, cancelling ---------------------------------------------

  private async owned(caller: CredentialCaller, operationId: string): Promise<StoredOperation> {
    const operation = this.context.records.getOperation(operationId);
    if (!operation || operation.environmentId !== caller.environmentId) {
      throw new CredentialError(
        "REQUEST_NOT_FOUND",
        "No such credential operation in this environment.",
      );
    }
    const grant = operation.internal.scope
      ? null
      : this.context.records.getGrant(operation.grantId);
    const projectId = operation.internal.scope?.projectId ?? grant?.projectId;
    if (projectId !== caller.projectId) {
      throw new CredentialError("SCOPE_MISMATCH", "This operation belongs to another project.");
    }
    return operation;
  }

  async wait(
    caller: CredentialCaller,
    operationId: string,
    waitMs: number,
  ): Promise<CredentialOperationView> {
    await this.owned(caller, operationId);
    await this.context.waitFor(operationId, waitMs, () => {
      const current = this.context.records.getOperation(operationId);
      return !current || (FINAL_STATES.has(current.state) && !this.running.has(operationId));
    });
    return this.view(await this.owned(caller, operationId));
  }

  async cancel(caller: CredentialCaller, operationId: string): Promise<CredentialOperationView> {
    const operation = await this.owned(caller, operationId);
    return this.view(this.cancelOperation(operation, "Cancelled before dispatch."));
  }

  private cancelOperation(operation: StoredOperation, reason: string): StoredOperation {
    const current =
      operation.state === "reserved" ? this.cancelBeforeStart(operation, reason) : operation;
    if (current.state === "running") {
      this.context.records.transaction((rows) => {
        const running = rows.operation(current.id);
        if (running?.state === "running" && !running.internal.cancelRequested) {
          rows.putOperation({
            ...running,
            internal: { ...running.internal, cancelRequested: true },
          });
        }
      });
    }
    this.running.get(operation.id)?.cancel();
    return this.context.records.getOperation(operation.id) ?? current;
  }

  /** Stops pending and running work of ended grants. */
  cancelForGrants(grantIds: readonly string[]): void {
    const ids = new Set(grantIds);
    for (const operation of this.context.records.listOperations()) {
      if (ids.has(operation.grantId))
        this.cancelOperation(operation, "The grant ended before dispatch.");
    }
  }

  /** Another backend can revoke a grant or cancel its reservation in the shared database. */
  reconcileRunning(): void {
    for (const [id, entry] of this.running) {
      const operation = this.context.records.getOperation(id);
      const grant = operation && this.context.records.getGrant(operation.grantId);
      if (
        !grant ||
        grantUnusableReason(this.context, grant, true) ||
        operation?.internal.cancelRequested ||
        operation?.state === "cancelled_before_start"
      )
        entry.cancel();
    }
  }

  cancelEnvironment(environmentId: string): void {
    for (const operation of this.context.records.listOperations(environmentId)) {
      this.cancelOperation(operation, "The environment ended before dispatch.");
    }
  }

  /** Settle dead owners' work and recover materializations independently of outcomes. */
  async reconcileStartup(): Promise<void> {
    const changed = this.context.records.transaction((rows) => {
      const environments = new Set<string>();
      for (const operation of rows.operations()) {
        if (
          operation.internal.bootId === this.context.bootId ||
          credentialOwnerAlive(operation.internal.owner)
        )
          continue;
        // Older builds tracked staged container runs only on the operation.
        // Include cancelled reservations, which could already have staged a file.
        if (
          !operation.internal.owner &&
          operation.kind === "command" &&
          operation.cleanup !== "confirmed" &&
          (operation.state === "reserved" ||
            operation.state === "running" ||
            operation.state === "cancelled_before_start" ||
            operation.cleanup === "unconfirmed") &&
          !rows.runCleanup(operation.id)
        ) {
          rows.putRunCleanup({
            id: operation.id,
            environmentId: operation.environmentId,
            ...(operation.internal.containerId
              ? { containerId: operation.internal.containerId }
              : {}),
          });
        }
        const reserved = operation.state === "reserved";
        if (!reserved && operation.state !== "running") continue;
        if (reserved) refundUse(rows, operation.grantId);
        rows.putOperation({
          ...operation,
          state: reserved ? "cancelled_before_start" : "outcome_unknown",
          finishedAt: this.context.now(),
          cleanup: rows.runCleanup(operation.id) ? "unconfirmed" : operation.cleanup,
          error: reserved
            ? "The owning backend stopped before dispatch."
            : "The owning backend stopped while it ran.",
        });
        environments.add(operation.environmentId);
        this.context.notify(operation.id);
      }
      return [...environments];
    });
    for (const environmentId of changed) this.context.announce(environmentId);
    await this.cleanMaterializations();
  }

  cleanMaterializations(): Promise<void> {
    this.recovery ??= this.recoverMaterializations().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  private async recoverMaterializations(): Promise<void> {
    const runs = this.context.records.listRunCleanup();
    if (!runs.length) return;
    const count = Math.min(runs.length, 8);
    const start = this.cleanupCursor % runs.length;
    this.cleanupCursor = start + count;
    for (let offset = 0; offset < count; offset++) {
      if (this.stopped) return;
      const run = runs[(start + offset) % runs.length]!;
      if (this.running.has(run.id) || (!run.retryable && credentialOwnerAlive(run.owner))) continue;
      if (!/^[a-f0-9-]{36}$/u.test(run.id)) continue;
      const cleaned = run.containerId
        ? (await cleanupContainerRun({
            containerId: run.containerId,
            id: run.id,
            env: process.env,
            ...(this.context.spawnProcess ? { spawnProcess: this.context.spawnProcess } : {}),
          })) === "confirmed"
        : await fs
            .rm(path.join(this.context.runRoot, run.id), { recursive: true, force: true })
            .then(
              () => true,
              () => false,
            );
      if (this.stopped) return;
      if (cleaned) {
        this.context.records.transaction((rows) => {
          rows.confirmRunCleanup(run.id);
          const operation = rows.operation(run.id);
          if (operation) rows.putOperation({ ...operation, cleanup: "confirmed" });
        });
        this.context.announce(run.environmentId);
      }
    }
  }

  /** Shutdown: running commands are killed at once, not after a grace period. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.running.values()) entry.cancel({ hard: true });
    for (const operation of this.context.records.listOperations()) {
      if (operation.state === "reserved" && operation.internal.bootId === this.context.bootId) {
        this.cancelBeforeStart(operation, "The credential service stopped before dispatch.");
      }
    }
  }

  overview(limit = 50): CredentialOperationRecord[] {
    return this.context.records
      .listOperations()
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map((operation) => publicRecord(operation));
  }
}
