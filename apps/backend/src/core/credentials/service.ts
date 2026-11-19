import { CREDENTIAL_ANY_TAB } from "@orkestrator/protocol/agent-credentials";
import type {
  CredentialConnection,
  CredentialGrantRecord,
  CredentialOverview,
  CredentialRequestRecord,
  CredentialTabSnapshot,
  CredentialVaultStatus,
} from "@orkestrator/protocol/agent-credentials";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  CredentialAccess,
  grantUnusableReason,
  type CredentialApprovalInput,
  type CredentialCaller,
  type CredentialRequestInput,
} from "./access.js";
import { CredentialConnections, type ConnectionInput } from "./connections.js";
import { CredentialContext, type CredentialServiceOptions } from "./context.js";
import {
  CredentialOperations,
  type CredentialHttpRunInput,
  type CredentialOperationView,
  type CredentialRunInput,
} from "./operations.js";
import { publicRecord } from "./records.js";

const log = createLogger("credentials");

/** Default expiry sweep period. Every use checks expiry itself. */
const SWEEP_INTERVAL_MS = 5_000;
/** Settled requests a tab snapshot still shows (declined, expired, …). */
const RECENT_SETTLED_MS = 10 * 60_000;

/**
 * Agent credentials: the one authority for saved connections, access
 * requests, grants and their uses (docs/architecture/agent-credentials.md).
 *
 * The service is split by responsibility: `CredentialConnections` (saved
 * values and their policy), `CredentialAccess` (requests, approval, grants,
 * lifecycle) and `CredentialOperations` (authorizing and running each use).
 * This facade wires them together and owns the expiry sweep.
 */
export class CredentialService {
  private readonly context: CredentialContext;
  readonly connections: CredentialConnections;
  readonly access: CredentialAccess;
  readonly operations: CredentialOperations;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sweepIntervalMs: number;
  private stopped = false;

  constructor(options: CredentialServiceOptions) {
    this.context = new CredentialContext(options);
    this.connections = new CredentialConnections(this.context);
    this.access = new CredentialAccess(this.context, this.connections);
    this.operations = new CredentialOperations(this.context, this.access, this.connections);
    const cancel = (grantIds: string[]) => this.operations.cancelForGrants(grantIds);
    this.connections.onGrantsEnded = (grantIds) => {
      // A connection change ended these grants: release their temporary
      // holdings too (none for connections) and stop their work.
      cancel(grantIds);
    };
    this.access.onGrantsEnded = cancel;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  }

  get vaultStatus(): CredentialVaultStatus {
    return this.context.vaultStatus;
  }

  /** Starts the periodic expiry sweep. */
  start(): void {
    this.sweep();
    if (this.sweepIntervalMs > 0 && !this.stopped && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  /**
   * Settles what a previous process left: its temporary values are gone, so
   * its temporary grants end; its open operations cannot be resumed. Only the
   * data directory's registry writer runs this, so a second backend on the
   * same directory never ends the first one's grants.
   */
  async reconcileStartup(): Promise<void> {
    this.access.invalidateEarlierTemporaryGrants();
    await this.operations.reconcileStartup();
  }

  /** The explicit stop (invariant 15): timers, waiters and running work. */
  stop(): void {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.context.wakeAll();
    this.operations.stop();
  }

  sweep(): void {
    if (this.stopped) return;
    try {
      this.access.sweep();
      this.operations.reconcileRunning();
      void this.connections.cleanRetiredEntries().catch((error: unknown) => {
        log.warn("sweep.failed", { error: formatLogError(error) });
      });
    } catch (error) {
      log.warn("sweep.failed", { error: formatLogError(error) });
    }
  }

  // --- Agent side ---------------------------------------------------------------

  requestAccess(
    caller: CredentialCaller,
    input: CredentialRequestInput,
  ): Promise<CredentialRequestRecord> {
    return this.access.createRequest(caller, input);
  }

  getRequest(caller: CredentialCaller, requestId: string, waitMs: number) {
    return this.access.getRequest(caller, requestId, waitMs);
  }

  listCallerGrants(caller: CredentialCaller): CredentialGrantRecord[] {
    return this.access.listCallerGrants(caller);
  }

  runCommand(
    caller: CredentialCaller,
    input: CredentialRunInput,
  ): Promise<CredentialOperationView> {
    return this.operations.runCommand(caller, input);
  }

  httpRequest(
    caller: CredentialCaller,
    input: CredentialHttpRunInput,
  ): Promise<CredentialOperationView> {
    return this.operations.httpRequest(caller, input);
  }

  getOperation(caller: CredentialCaller, operationId: string, waitMs: number) {
    return this.operations.wait(caller, operationId, waitMs);
  }

  cancelOperation(caller: CredentialCaller, operationId: string) {
    return this.operations.cancel(caller, operationId);
  }

  // --- Person side ---------------------------------------------------------------

  /** One environment's (or tab's) requests and grants, for the in-task card. */
  tabSnapshot(input: {
    environmentId: string;
    tabId?: string;
    projectId?: string;
  }): CredentialTabSnapshot {
    const now = this.context.now();
    const requests = this.context.records
      .listRequests(input.environmentId)
      .filter(
        (request) =>
          (!input.tabId || request.tabId === input.tabId || request.tabId === CREDENTIAL_ANY_TAB) &&
          (request.state === "pending" ||
            (request.decidedAt ?? request.createdAt) > now - RECENT_SETTLED_MS),
      )
      .map((request) => {
        const view = publicRecord(request);
        return view.state === "pending" && view.expiresAt <= now
          ? { ...view, state: "expired" as const }
          : view;
      });
    const grants = this.context.records
      .listGrants(input.environmentId)
      .filter((grant) => grantUnusableReason(this.context, grant) === null)
      .map((grant) => publicRecord(grant));
    const projectId = input.projectId ?? requests[0]?.projectId ?? grants[0]?.projectId ?? null;
    return {
      requests,
      grants,
      connections: projectId ? this.connections.listForProject(projectId) : [],
      vault: this.context.vaultStatus,
    };
  }

  overview(): CredentialOverview {
    const busy = new Set(
      this.context.records
        .listOperations()
        .filter((operation) => operation.state === "reserved" || operation.state === "running")
        .map((operation) => operation.grantId),
    );
    return {
      vault: this.context.vaultStatus,
      connections: this.connections.list(),
      grants: this.context.records
        .listGrants()
        .filter((grant) => {
          const open = busy.has(grant.id);
          const reason = grantUnusableReason(this.context, grant, open);
          return reason === null || (open && reason.code === "VALUE_UNAVAILABLE");
        })
        .sort((left, right) => right.issuedAt - left.issuedAt)
        .map((grant) => publicRecord(grant)),
      operations: this.operations.overview(),
    };
  }

  approve(input: CredentialApprovalInput) {
    return this.access.approve(input);
  }

  decline(input: { requestId: string; revision: number }) {
    return this.access.decline(input);
  }

  revokeGrant(grantId: string) {
    return this.access.revoke(grantId);
  }

  createConnection(input: ConnectionInput & { value: unknown }): Promise<CredentialConnection> {
    return this.connections.create(input);
  }

  updateConnection(input: { id: string; revision: number } & Partial<ConnectionInput>) {
    return this.connections.update(input);
  }

  replaceConnectionValue(input: { id: string; value: unknown }) {
    return this.connections.replaceValue(input);
  }

  deleteConnection(id: string) {
    return this.connections.delete(id);
  }

  // --- Lifecycle ------------------------------------------------------------------

  conversationRetired(
    environmentId: string,
    logicalSessionKey: string,
    providerSessionId: string,
  ): void {
    const prefix = `env-${environmentId}:`;
    if (!this.stopped && logicalSessionKey.startsWith(prefix)) {
      this.access.conversationRetired(
        environmentId,
        logicalSessionKey.slice(prefix.length),
        providerSessionId,
      );
    }
  }

  tabClosed(environmentId: string, tabId: string): void {
    this.access.tabClosed(environmentId, tabId);
  }

  environmentDeleted(environmentId: string): void {
    this.operations.cancelEnvironment(environmentId);
    this.access.environmentDeleted(environmentId);
    this.context.records.deleteEnvironment(environmentId);
    this.context.announce(environmentId);
  }
}
