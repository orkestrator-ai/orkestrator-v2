import { assertCredentialPolicy } from "./policy.js";
import { randomUUID } from "node:crypto";
import {
  CREDENTIAL_HTTP_METHODS,
  CREDENTIAL_ANY_TAB,
  CREDENTIAL_LIMITS,
  CREDENTIAL_TIMING,
  CredentialError,
  clampCredentialGrantLifetime,
  credentialBindingNameProblem,
  credentialHeaderNameProblem,
  credentialValueProblem,
  normalizeCredentialHosts,
  sanitizeCredentialText,
  type CredentialApprovalSource,
  type CredentialBinding,
  type CredentialGrantRecord,
  type CredentialHttpAuth,
  type CredentialHttpMethod,
  type CredentialHttpPolicy,
  type CredentialRequestRecord,
  type CredentialUse,
} from "@orkestrator/protocol/agent-credentials";
import { connectionAllowsProject, type CredentialConnections } from "./connections.js";
import type { CredentialContext, CredentialRuntimeInfo, CredentialSessionInfo } from "./context.js";
import {
  publicRecord,
  type CredentialRows,
  type StoredGrant,
  type StoredRequest,
} from "./records.js";
import { newCredentialEntryId } from "./vault.js";

/**
 * Requests and grants (docs/architecture/agent-credentials.md, "Requests and
 * grants"). An agent proposes; a person decides; the backend computes what is
 * actually granted from the request, the person's choices and the
 * connection's policy, and binds it to the tab, its conversation and its
 * runtime. Nothing the agent says can widen that.
 */

/** The authenticated agent caller: from its tool credential, never its arguments. */
/**
 * The authenticated agent caller: from its tool credential, never its
 * arguments. `tabId` is the calling tab, or `CREDENTIAL_ANY_TAB` for an
 * environment-wide connection (OpenCode). Grants belong to the environment,
 * so the tab only picks the session whose execution policy applies and the
 * tab that shows a request.
 */
export interface CredentialCaller {
  environmentId: string;
  projectId: string;
  tabId: string;
}

export interface CredentialRequestInput {
  label: unknown;
  purpose: unknown;
  use: unknown;
  /** `command`: environment variable name (or file-path variable for `file`). */
  bindingName?: unknown;
  bindingKind?: unknown;
  command?: unknown;
  /** `http`: hosts, auth scheme and its parameter. */
  hosts?: unknown;
  authScheme?: unknown;
  authHeader?: unknown;
  authUsername?: unknown;
  methods?: unknown;
  suggestedConnection?: unknown;
  /** Environment-wide callers only: the tab to show the request on. */
  tabHint?: unknown;
}

export interface CredentialApprovalInput {
  requestId: string;
  revision: number;
  source: unknown;
  lifetimeMs?: unknown;
  maxUses?: unknown;
  /** `http`: the hosts the person confirmed. */
  hosts?: unknown;
}

function text(value: unknown, max: number, field: string): string {
  const cleaned = typeof value === "string" ? sanitizeCredentialText(value, max) : "";
  if (!cleaned) throw new CredentialError("INVALID_INPUT", `${field} is required.`);
  return cleaned;
}

function binding(kind: unknown, name: unknown): CredentialBinding {
  if (typeof name !== "string") {
    throw new CredentialError(
      "INVALID_INPUT",
      "A command credential needs envVar: the environment variable that receives it.",
    );
  }
  const problem = credentialBindingNameProblem(name);
  if (problem) throw new CredentialError("INVALID_INPUT", problem);
  if (kind !== undefined && kind !== "env" && kind !== "file") {
    throw new CredentialError("INVALID_INPUT", "delivery is env or file.");
  }
  return { kind: kind === "file" ? "file" : "env", name };
}

function httpAuth(scheme: unknown, header: unknown, username: unknown): CredentialHttpAuth {
  if (scheme === undefined || scheme === "bearer") return { scheme: "bearer" };
  if (scheme === "header") {
    const problem =
      typeof header === "string"
        ? credentialHeaderNameProblem(header)
        : "A header name is required.";
    if (problem) throw new CredentialError("INVALID_INPUT", problem);
    return { scheme: "header", header: header as string };
  }
  if (scheme === "basic") {
    if (
      typeof username !== "string" ||
      !username ||
      username.length > CREDENTIAL_LIMITS.usernameMaxChars ||
      /[:\r\n\0]/u.test(username)
    ) {
      throw new CredentialError(
        "INVALID_INPUT",
        "Basic authentication needs a user name without ':'.",
      );
    }
    return { scheme: "basic", username };
  }
  throw new CredentialError("INVALID_INPUT", "auth is bearer, header or basic.");
}

function hosts(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const normalized = list.every((host) => typeof host === "string")
    ? normalizeCredentialHosts(list as string[])
    : null;
  if (!normalized || normalized.length === 0) {
    throw new CredentialError(
      "INVALID_INPUT",
      "An http credential needs hosts: public host names such as api.example.com, at most 16.",
    );
  }
  return normalized;
}

function methods(value: unknown): CredentialHttpMethod[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new CredentialError("INVALID_INPUT", 'methods is a list such as ["GET"].');
  }
  const result = new Set<CredentialHttpMethod>();
  for (const method of value) {
    const upper = typeof method === "string" ? method.toUpperCase() : "";
    if (!(CREDENTIAL_HTTP_METHODS as readonly string[]).includes(upper)) {
      throw new CredentialError("INVALID_INPUT", `Method ${String(method)} is not supported.`);
    }
    result.add(upper as CredentialHttpMethod);
  }
  return [...result];
}

/** Why a grant cannot be used right now, or null. Wall and monotonic clocks both count. */
export function grantUnusableReason(
  context: CredentialContext,
  grant: StoredGrant,
  reserved = false,
): CredentialError | null {
  if (grant.state === "revoked")
    return new CredentialError("ACCESS_REVOKED", "This grant was revoked.");
  if (grant.state !== "active") {
    return new CredentialError("ACCESS_EXPIRED", grant.endReason ?? "This grant has ended.");
  }
  const now = context.now();
  const sameBoot = grant.internal.bootId === context.bootId;
  const elapsed = sameBoot ? context.monotonic() - grant.internal.issuedMonotonicMs : 0;
  if (now >= grant.expiresAt || (sameBoot && elapsed >= grant.internal.lifetimeMs)) {
    return new CredentialError("ACCESS_EXPIRED", "This grant has expired. Request access again.");
  }
  if (!reserved && grant.maxUses !== null && grant.uses >= grant.maxUses) {
    return new CredentialError("USE_LIMIT", "This grant has no uses left. Request access again.");
  }
  if (grant.source.kind === "temporary" && !sameBoot) {
    return new CredentialError(
      "VALUE_UNAVAILABLE",
      "This temporary value was lost when Orkestrator restarted. Request access again.",
    );
  }
  return null;
}

export class CredentialAccess {
  constructor(
    private readonly context: CredentialContext,
    private readonly connections: CredentialConnections,
  ) {}

  /** Set by the facade: cancels running work of grants that ended. */
  onGrantsEnded: (grantIds: string[]) => void = () => undefined;

  private async bindingContext(caller: CredentialCaller): Promise<{
    session: CredentialSessionInfo | null;
    runtime: CredentialRuntimeInfo;
  }> {
    const [session, runtime] = await Promise.all([
      this.context.host.session(caller.environmentId, caller.tabId),
      this.context.host.runtime(caller.environmentId),
    ]);
    if (!runtime) {
      throw new CredentialError(
        "UNSUPPORTED_RUNTIME",
        "This environment has no runtime that can use credentials right now.",
      );
    }
    return { session, runtime };
  }

  // --- Agent side -------------------------------------------------------------

  async createRequest(
    caller: CredentialCaller,
    input: CredentialRequestInput,
  ): Promise<CredentialRequestRecord> {
    if (this.context.isStopped)
      throw new CredentialError("POLICY_DENIED", "The credential service is stopping.");
    const label = text(input.label, CREDENTIAL_LIMITS.labelMaxChars, "label");
    const purpose = text(input.purpose, CREDENTIAL_LIMITS.purposeMaxChars, "purpose");
    if (input.use !== "command" && input.use !== "http") {
      throw new CredentialError("INVALID_INPUT", "use is command or http.");
    }
    const use: CredentialUse = input.use;
    const { session, runtime } = await this.bindingContext(caller);
    let requestBinding: CredentialBinding | undefined;
    let command: string | undefined;
    let http: CredentialHttpPolicy | undefined;
    if (use === "command") {
      requestBinding = binding(input.bindingKind, input.bindingName);
      if (input.command !== undefined) {
        if (typeof input.command !== "string" || !input.command.trim()) {
          throw new CredentialError("INVALID_INPUT", "command must be the exact command text.");
        }
        if (input.command.length > CREDENTIAL_LIMITS.commandMaxChars) {
          throw new CredentialError("INVALID_INPUT", "The command is too long.");
        }
        command = input.command;
      }
      assertCredentialPolicy(use, session, runtime, command);
    } else {
      assertCredentialPolicy(use, session, runtime);
      const requested = methods(input.methods);
      http = {
        auth: httpAuth(input.authScheme, input.authHeader, input.authUsername),
        hosts: hosts(input.hosts),
        ...(requested ? { methods: requested } : {}),
      };
    }
    const suggested =
      typeof input.suggestedConnection === "string"
        ? sanitizeCredentialText(input.suggestedConnection, CREDENTIAL_LIMITS.nameMaxChars)
        : "";
    const now = this.context.now();
    if (this.context.isStopped)
      throw new CredentialError("POLICY_DENIED", "The credential service is stopping.");
    const record: StoredRequest = {
      id: randomUUID(),
      revision: 1,
      environmentId: caller.environmentId,
      projectId: caller.projectId,
      tabId: placementTab(caller, input.tabHint),
      label,
      purpose,
      use,
      ...(requestBinding ? { binding: requestBinding } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(http ? { http } : {}),
      ...(suggested ? { suggestedConnection: suggested } : {}),
      state: "pending",
      createdAt: now,
      expiresAt: now + CREDENTIAL_TIMING.requestWaitMs,
      internal: {
        agent: session?.agent ?? null,
        logicalSessionKey: session?.logicalSessionKey ?? "",
        // Only so a pending request is cancelled when the conversation that
        // asked ends; a grant is not tied to any conversation.
        providerSessionId: session?.providerSessionId ?? null,
        runtimeIdentity: runtime.identity,
      },
    };
    this.context.records.transaction((rows) => {
      const pending = rows
        .requests(caller.environmentId)
        .filter((request) => request.tabId === record.tabId && request.state === "pending");
      if (pending.length >= CREDENTIAL_LIMITS.maxPendingRequestsPerTab) {
        throw new CredentialError(
          "REQUEST_LIMIT",
          "Four credential requests are already waiting for a person here.",
        );
      }
      rows.putRequest(record);
    });
    this.context.announce(caller.environmentId);
    return publicRecord(record);
  }

  /** A request of the caller's environment, optionally waiting for a decision. */
  async getRequest(
    caller: CredentialCaller,
    requestId: string,
    waitMs: number,
  ): Promise<{ request: CredentialRequestRecord; grant: CredentialGrantRecord | null }> {
    const read = () => {
      const request = this.context.records.getRequest(requestId);
      if (
        !request ||
        request.environmentId !== caller.environmentId ||
        request.projectId !== caller.projectId
      ) {
        throw new CredentialError("REQUEST_NOT_FOUND", "No such request in this environment.");
      }
      return request;
    };
    let request = read();
    if (request.state === "pending" && waitMs > 0) {
      await this.context.waitFor(requestId, waitMs, () => {
        const current = this.context.records.getRequest(requestId);
        return !current || current.state !== "pending" || current.expiresAt <= this.context.now();
      });
      this.sweep();
      request = read();
    }
    const grant = request.grantId ? this.context.records.getGrant(request.grantId) : null;
    return { request: publicRecord(request), grant: grant ? publicRecord(grant) : null };
  }

  /** The caller environment's grants that are still active. */
  listCallerGrants(caller: CredentialCaller): CredentialGrantRecord[] {
    return this.context.records
      .listGrants(caller.environmentId)
      .filter(
        (grant) =>
          grant.projectId === caller.projectId && grantUnusableReason(this.context, grant) === null,
      )
      .map((grant) => publicRecord(grant));
  }

  // --- Person side ---------------------------------------------------------------

  /**
   * Approves one request revision. The value is stored (connection) or held
   * in memory (temporary) before the grant exists, and the grant and the
   * request's `granted` state commit together, so the agent never sees a
   * grant whose value is not there.
   */
  async approve(input: CredentialApprovalInput): Promise<{
    request: CredentialRequestRecord;
    grant: CredentialGrantRecord;
  }> {
    const request = this.context.records.getRequest(input.requestId);
    if (!request) throw new CredentialError("REQUEST_NOT_FOUND", "That request no longer exists.");
    this.assertPendingRevision(request, input.revision);
    const source = parseSource(input.source);
    const lifetimeMs = clampCredentialGrantLifetime(input.lifetimeMs);
    const maxUses = parseMaxUses(input.maxUses);

    // The environment must still have the runtime the request was made in.
    const { session, runtime } = await this.bindingContext(request);
    if (runtime.identity !== request.internal.runtimeIdentity) {
      this.cancelRequest(request.id, "The environment changed since the request.");
      throw new CredentialError(
        "REQUEST_STALE",
        "The environment was rebuilt, moved or stopped since the agent asked; the request was cancelled.",
      );
    }

    assertCredentialPolicy(request.use, session, runtime, request.command);

    let http: CredentialHttpPolicy | undefined;
    if (request.use === "http" && request.http) {
      const confirmed = hosts(input.hosts ?? request.http.hosts);
      http = { ...request.http, hosts: confirmed };
    }

    // Resolve where the value comes from before anything is committed.
    let grantSource: StoredGrant["source"];
    let entryId: string;
    let connectionPin: { revision: number; valueVersion: number } | undefined;
    let temporaryEntry: string | null = null;
    let savedConnectionId: string | null = null;
    if (source.kind === "connection") {
      const connection = this.context.records.getConnection(source.connectionId);
      if (!connection)
        throw new CredentialError("REQUEST_NOT_FOUND", "That connection no longer exists.");
      if (!connectionAllowsProject(connection, request.projectId)) {
        throw new CredentialError(
          "SCOPE_MISMATCH",
          "That connection is not available to this project.",
        );
      }
      if (http) {
        const outside = http.hosts.filter(
          (host) => !normalizeCredentialHosts(connection.httpHosts)?.includes(host),
        );
        if (outside.length) {
          throw new CredentialError(
            "SCOPE_MISMATCH",
            `${connection.name} may not be sent to ${outside.join(", ")}. Add the host to the connection in Settings first.`,
          );
        }
      }
      grantSource = {
        kind: "connection",
        connectionId: connection.id,
        connectionName: connection.name,
      };
      entryId = connection.internal.entryId;
      connectionPin = { revision: connection.revision, valueVersion: connection.valueVersion };
    } else if (source.saveAs) {
      const created = await this.connections.create({
        name: source.saveAs.name,
        ...(source.saveAs.description ? { description: source.saveAs.description } : {}),
        projectIds: [request.projectId],
        ...(http ? { httpHosts: http.hosts } : {}),
        value: source.value,
      });
      savedConnectionId = created.id;
      const stored = this.context.records.getConnection(created.id)!;
      grantSource = { kind: "connection", connectionId: created.id, connectionName: created.name };
      entryId = stored.internal.entryId;
      connectionPin = { revision: stored.revision, valueVersion: stored.valueVersion };
    } else {
      temporaryEntry = newCredentialEntryId();
      await this.context.temporary.put(temporaryEntry, source.value);
      grantSource = { kind: "temporary" };
      entryId = temporaryEntry;
    }

    const now = this.context.now();
    const grant: StoredGrant = {
      id: randomUUID(),
      requestId: request.id,
      environmentId: request.environmentId,
      projectId: request.projectId,
      tabId: request.tabId,
      label: request.label,
      source: grantSource,
      use: request.use,
      ...(request.binding ? { binding: request.binding } : {}),
      ...(request.command !== undefined ? { command: request.command } : {}),
      ...(http ? { http } : {}),
      runtime: runtime.runtime,
      issuedAt: now,
      expiresAt: now + lifetimeMs,
      maxUses,
      uses: 0,
      state: "active",
      internal: {
        // Grants belong to the environment, not to a conversation.
        logicalSessionKey: "",
        providerSessionId: null,
        runtimeIdentity: runtime.identity,
        ...(connectionPin
          ? { connectionRevision: connectionPin.revision, valueVersion: connectionPin.valueVersion }
          : {}),
        entryId,
        bootId: this.context.bootId,
        issuedMonotonicMs: this.context.monotonic(),
        lifetimeMs,
      },
    };
    let granted: StoredRequest;
    try {
      granted = this.context.records.transaction((rows) => {
        const current = rows.request(request.id);
        if (!current)
          throw new CredentialError("REQUEST_NOT_FOUND", "That request no longer exists.");
        this.assertPendingRevision(current, input.revision);
        const next: StoredRequest = {
          ...current,
          revision: current.revision + 1,
          state: "granted",
          decidedAt: now,
          grantId: grant.id,
        };
        rows.putGrant(grant);
        rows.putRequest(next);
        return next;
      });
    } catch (error) {
      // A lost race leaves no orphaned temporary value behind.
      if (temporaryEntry) await this.context.temporary.delete(temporaryEntry);
      // Nor a connection saved for an approval that did not happen.
      if (savedConnectionId)
        await this.connections.delete(savedConnectionId).catch(() => undefined);
      throw error;
    }
    this.context.notify(request.id);
    this.context.announce(request.environmentId);
    return { request: publicRecord(granted), grant: publicRecord(grant) };
  }

  decline(input: { requestId: string; revision: number }): CredentialRequestRecord {
    const declined = this.context.records.transaction((rows) => {
      const current = rows.request(input.requestId);
      if (!current)
        throw new CredentialError("REQUEST_NOT_FOUND", "That request no longer exists.");
      this.assertPendingRevision(current, input.revision);
      const next: StoredRequest = {
        ...current,
        revision: current.revision + 1,
        state: "declined",
        decidedAt: this.context.now(),
      };
      rows.putRequest(next);
      return next;
    });
    this.context.notify(declined.id);
    this.context.announce(declined.environmentId);
    return publicRecord(declined);
  }

  private assertPendingRevision(request: StoredRequest, revision: number): void {
    if (request.state !== "pending") {
      throw new CredentialError("REQUEST_STALE", `This request is already ${request.state}.`);
    }
    if (request.expiresAt <= this.context.now()) {
      throw new CredentialError("REQUEST_STALE", "This request has expired.");
    }
    if (request.revision !== revision) {
      throw new CredentialError("REQUEST_STALE", "This request changed; review it again.");
    }
  }

  cancelRequest(requestId: string, reason: string): void {
    const environmentId = this.context.records.transaction((rows) => {
      const current = rows.request(requestId);
      if (!current || current.state !== "pending") return null;
      rows.putRequest({
        ...current,
        revision: current.revision + 1,
        state: "cancelled",
        decidedAt: this.context.now(),
        reason,
      });
      return current.environmentId;
    });
    if (!environmentId) return;
    this.context.notify(requestId);
    this.context.announce(environmentId);
  }

  /** Ends one grant at once; queued and running work stops. */
  revoke(grantId: string): CredentialGrantRecord | null {
    this.endGrants((grant) => grant.id === grantId, "revoked", "Revoked by a person.");
    const grant = this.context.records.getGrant(grantId);
    return grant ? publicRecord(grant) : null;
  }

  /**
   * Ends every matching active grant in one transaction and releases what
   * they held. Returns the ended grants.
   */
  endGrants(
    match: (grant: StoredGrant) => boolean,
    state: "revoked" | "expired" | "invalidated",
    reason: string,
    environmentId?: string,
  ): StoredGrant[] {
    const ended = this.context.records.transaction((rows: CredentialRows) => {
      const changed: StoredGrant[] = [];
      for (const grant of rows.grants(environmentId)) {
        if (grant.state !== "active" || !match(grant)) continue;
        const next: StoredGrant = {
          ...grant,
          state,
          endedAt: this.context.now(),
          endReason: reason,
        };
        rows.putGrant(next);
        changed.push(next);
      }
      return changed;
    });
    this.released(ended);
    return ended;
  }

  /** After grants end: drop temporary values, stop their work, tell clients. */
  released(grants: readonly StoredGrant[]): void {
    if (grants.length === 0) return;
    for (const grant of grants) {
      if (grant.source.kind === "temporary")
        void this.context.temporary.delete(grant.internal.entryId);
    }
    this.onGrantsEnded(grants.map((grant) => grant.id));
    for (const environmentId of new Set(grants.map((grant) => grant.environmentId))) {
      this.context.announce(environmentId);
    }
  }

  /**
   * Expires pending requests and grants whose time has passed. Every use
   * checks expiry itself; this only tidies records and frees memory.
   */
  sweep(): void {
    const now = this.context.now();
    const expiredRequests = this.context.records.transaction((rows) => {
      const changed: StoredRequest[] = [];
      for (const environmentId of this.context.records.environments()) {
        for (const request of rows.requests(environmentId)) {
          if (request.state !== "pending" || request.expiresAt > now) continue;
          const next: StoredRequest = {
            ...request,
            revision: request.revision + 1,
            state: "expired",
            decidedAt: now,
          };
          rows.putRequest(next);
          changed.push(next);
        }
      }
      return changed;
    });
    for (const request of expiredRequests) {
      this.context.notify(request.id);
      this.context.announce(request.environmentId);
    }
    // Only time ends a grant here. A temporary grant of another process is
    // unusable in this one but may be live in its own; startup
    // reconciliation (the registry writer's) ends those.
    this.endGrants(
      (grant) => grantUnusableReason(this.context, grant)?.code === "ACCESS_EXPIRED",
      "expired",
      "The grant's time ran out.",
    );
  }

  /** Startup: temporary values from an earlier process are gone. */
  invalidateEarlierTemporaryGrants(): void {
    this.endGrants(
      (grant) => grant.source.kind === "temporary" && grant.internal.bootId !== this.context.bootId,
      "invalidated",
      "Orkestrator restarted, and temporary values are not kept across restarts.",
    );
  }

  conversationRetired(
    environmentId: string,
    tabId: string,
    retiredProviderSessionId: string,
  ): void {
    for (const request of this.context.records.listRequests(environmentId)) {
      if (
        request.tabId === tabId &&
        request.state === "pending" &&
        request.internal.providerSessionId === retiredProviderSessionId
      ) {
        this.cancelRequest(request.id, "The tab started a new conversation.");
      }
    }
    // Grants are the environment's: they outlive the conversation.
  }

  /**
   * A tab closed: its pending requests are cancelled (the agent that asked is
   * gone). Grants belong to the environment and stay.
   */
  tabClosed(environmentId: string, tabId: string): void {
    for (const request of this.context.records.listRequests(environmentId)) {
      if (request.tabId === tabId && request.state === "pending") {
        this.cancelRequest(request.id, "The tab was closed.");
      }
    }
  }

  /** Everything an environment had ends; its records are removed. */
  environmentDeleted(environmentId: string): void {
    this.endGrants(() => true, "invalidated", "The environment was deleted.", environmentId);
    for (const request of this.context.records.listRequests(environmentId)) {
      this.context.notify(request.id);
    }
  }
}

/**
 * Which tab shows a request: the caller's own tab, or, for an
 * environment-wide caller, the tab id the agent was told in its turn
 * instructions (a placement hint only: it grants nothing), else every tab.
 */
function placementTab(caller: CredentialCaller, hint: unknown): string {
  if (caller.tabId !== CREDENTIAL_ANY_TAB) return caller.tabId;
  return typeof hint === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(hint)
    ? hint
    : CREDENTIAL_ANY_TAB;
}

function parseMaxUses(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > CREDENTIAL_LIMITS.maxUses
  ) {
    throw new CredentialError("INVALID_INPUT", "maxUses is a whole number from 1 to 10000.");
  }
  return value;
}

/**
 * Reads the approval's source. The value is checked here, never echoed: a
 * failure names the problem, not the input.
 */
function parseSource(value: unknown): CredentialApprovalSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialError("INVALID_INPUT", "Choose a saved connection or enter a value.");
  }
  const source = value as Record<string, unknown>;
  if (source.kind === "connection") {
    if (typeof source.connectionId !== "string" || !source.connectionId) {
      throw new CredentialError("INVALID_INPUT", "Choose a saved connection.");
    }
    return { kind: "connection", connectionId: source.connectionId };
  }
  if (source.kind === "value") {
    const problem = credentialValueProblem(source.value);
    if (problem) throw new CredentialError("INVALID_INPUT", problem);
    let saveAs: { name: string; description?: string } | undefined;
    if (source.saveAs !== undefined && source.saveAs !== null) {
      const save = source.saveAs as Record<string, unknown>;
      if (typeof save !== "object" || typeof save.name !== "string" || !save.name.trim()) {
        throw new CredentialError("INVALID_INPUT", "A saved connection needs a name.");
      }
      saveAs = {
        name: save.name,
        ...(typeof save.description === "string" ? { description: save.description } : {}),
      };
    }
    return { kind: "value", value: source.value as string, ...(saveAs ? { saveAs } : {}) };
  }
  throw new CredentialError("INVALID_INPUT", "Choose a saved connection or enter a value.");
}
