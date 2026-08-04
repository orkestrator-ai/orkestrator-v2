import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  BuildPipelineAgent,
  PipelineSessionPhase,
  TaskSnapshotImage,
} from "@orkestrator/protocol/build-pipeline";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  AGENT_ACTIVITY_STATES,
  type AgentActivityState,
} from "@orkestrator/protocol/agent-activity";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_LIMITS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  isAgentInteractionResolution,
  isAgentInteractionSnapshot,
  type AgentInteractionApplyOutcome,
  type AgentInteractionKind,
  type AgentInteractionOrigin,
  type AgentInteractionPolicy,
  type AgentInteractionQuestion,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import {
  mimeTypeForFilename,
  promptAttachmentUrl,
  type PromptAttachment,
} from "./prompt-attachments.js";

export type ProviderStatus = "running" | "blocked" | "idle" | "error" | "missing";
export type ProviderActivityState = AgentActivityState | "missing";
export type ProviderExecutionMode = "plan" | "build";

export interface ProviderSessionRegistration {
  origin: AgentInteractionOrigin;
  interactionPolicy: AgentInteractionPolicy;
  /** Content-free workflow phase used by passive observations. */
  phase?: string;
  /** Stable workflow ownership and generation fence for unattended adoption. */
  workflowId?: string;
  provider?: BuildPipelineAgent;
  fence?: string | number;
}

/** Content-free lifecycle signal emitted before a provider-owned auto-response. */
export interface ProviderInteractionObservationEvent {
  sessionId: string;
  interactionId: string;
  kind: AgentInteractionKind;
  registration: ProviderSessionRegistration;
  state: "detected" | "withdrawn";
  providerState?: "running" | "error";
}

/**
 * Provider-neutral blocking-interaction capability.
 *
 * Exact provider payloads and answer mappers remain private to each adapter;
 * callers receive only the bounded coordination contract.
 */
export interface AgentInteractionProviderCapability {
  listPendingInteractions(sessionId: string): Promise<AgentInteractionSnapshot>;
  resolveInteraction(
    sessionId: string,
    interactionId: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome>;
  watchInteractions?(
    sessionId: string,
    onRevision: (revision: number) => void,
  ): () => void;
}

const PROVIDER_ACTIVITY_STATES: readonly ProviderActivityState[] = [
  ...AGENT_ACTIVITY_STATES,
  "missing",
];

/**
 * Validate a bridge-supplied activity token before it can reach the durable
 * projection. An unrecognized value must fail loudly: coercing it to `idle`
 * would silently retire a spinner for a turn that is still running.
 */
function isProviderActivityState(
  value: unknown,
): value is ProviderActivityState {
  return PROVIDER_ACTIVITY_STATES.includes(value as ProviderActivityState);
}

export class PromptRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptRejectedError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined
      ? undefined
      : { cause: options.cause });
    this.name = "ProviderUnavailableError";
  }
}

/**
 * A prompt transport failed without proving whether the provider accepted it.
 *
 * Callers retain the durable request id and reconcile provider status before
 * retrying this error. Preflight and explicit HTTP failures must use
 * ProviderUnavailableError instead so bounded reconnect handling can run.
 */
export class AmbiguousPromptDispatchError extends ProviderUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AmbiguousPromptDispatchError";
  }
}

/**
 * OpenCode's optional caller-supplied message ID is both a MessageID and a
 * durable idempotency key. Our request IDs are provider-neutral, so encode every
 * one into a reserved namespace instead of inferring that an ID beginning with
 * `msg` is already native. Fixed-width UTF-16 hex keeps the mapping injective
 * for every JavaScript string while satisfying OpenCode's `msg` prefix schema.
 */
function openCodeMessageId(requestId: string): string {
  if (requestId.trim().length === 0) {
    throw new TypeError("OpenCode request ID must be a non-empty string");
  }
  let encoded = "";
  for (let index = 0; index < requestId.length; index += 1) {
    encoded += requestId.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return `msg_ork_${encoded}`;
}

export interface ProviderCreateSessionOptions {
  /** Second layer of idempotency: bridges derive a stable session id from it. */
  clientSessionKey?: string;
  /**
   * Execution mode for the session, overriding what the phase implies.
   *
   * Several distinct phases collapse onto `review`, which would otherwise create
   * a read-only Codex session for a phase that has to commit changes. The caller
   * knows which; the phase alone does not.
   */
  mode?: ProviderExecutionMode;
  /**
   * Per-session model and effort.
   *
   * Passed per call rather than baked into the connection so one provider can
   * serve every session in an environment. Caching a provider per model would
   * accumulate one instance — and for OpenCode one event stream — per variant a
   * user ever selects.
   */
  model?: string;
  effort?: string;
  /** Durable interaction metadata supplied by the owning workflow. */
  interaction?: ProviderSessionRegistration;
}

export interface ProviderSendOptions {
  requestId: string;
  /**
   * Attachments that already exist in the workspace.
   *
   * Preferred over {@link ProviderSendOptions.images}: both bridges require a
   * `path`, so only a staged attachment can actually be delivered.
   */
  attachments?: PromptAttachment[];
  /**
   * Base64 images with no workspace path yet.
   *
   * Staged by the provider's `stageImages` dependency when one is configured.
   * Without it there is nothing that can be sent, so the images are refused
   * rather than silently dropped by the bridge.
   */
  images?: TaskSnapshotImage[];
  schema?: JsonSchema;
  mode?: ProviderExecutionMode;
  fastMode?: boolean;
  /** Claude sub-agent selected for this prompt. */
  subAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
  /** Overrides the connection default for this prompt only. */
  model?: string;
  effort?: string;
}

export interface BuildPipelineProvider {
  readonly agent: BuildPipelineAgent;
  /**
   * Register a session restored from durable pipeline state. Providers that
   * monitor environment-wide event streams must ignore requests for every
   * session not registered here or created through createSession().
   */
  registerSession?(
    sessionId: string,
    interaction?: ProviderSessionRegistration,
  ): void;
  createSession(
    phase: PipelineSessionPhase,
    label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string>;
  send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void>;
  status(sessionId: string): Promise<ProviderStatus>;
  /**
   * Authoritative activity including input parked at the provider. Optional so
   * narrow test providers and non-interactive integrations can fall back to
   * the coarser status contract.
   */
  activity?(sessionId: string): Promise<ProviderActivityState>;
  /**
   * Read authoritative activity for several sessions from one provider
   * snapshot. Providers whose upstream API is session-scoped may omit this and
   * let callers fall back to activity()/status() per session.
   */
  activityBatch?(
    sessionIds: readonly string[],
  ): Promise<Map<string, ProviderActivityState>>;
  readonly interactions?: AgentInteractionProviderCapability;
  messages(sessionId: string): Promise<unknown[]>;
  structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null>;
  abort(sessionId: string): Promise<void>;
  dispose?(): Promise<void> | void;
}

type BridgeConnection = {
  agent: BuildPipelineAgent;
  baseUrl: string;
  authToken: string;
  directory?: string;
  model?: string;
  effort?: string;
  requestTimeoutMs?: number;
};

export type ProviderDependencies = {
  fetch?: typeof fetch;
  openCodeClient?: OpencodeClient;
  /** Injectable factory for testing the production OpenCode client wiring. */
  openCodeClientFactory?: typeof createOpencodeClient;
  monitorRetryMs?: number;
  /** Injectable clock and cache lifetime for deterministic lifecycle tests. */
  now?: () => number;
  openCodeExistenceCacheTtlMs?: number;
  /**
   * Stage base64 images into the workspace so they can be attached by path.
   *
   * Supplied by whichever service owns a command invoker; without it a
   * base64-only image cannot be delivered to any bridge.
   */
  stageImages?: (
    images: readonly TaskSnapshotImage[],
  ) => Promise<PromptAttachment[]>;
  /**
   * Legacy test-only OpenCode event responder. Disabled unless explicitly
   * requested; production workflows use the persisted common resolver.
   */
  autoAnswerRequests?: boolean;
  /**
   * Preserve observe-only evidence when this provider must answer before a
   * separate polling adapter can see the request. The callback receives no
   * prompt, command, path, answer, or other provider content.
   */
  onInteractionObservation?: (
    event: ProviderInteractionObservationEvent,
  ) => void | Promise<void>;
};

const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MONITOR_RETRY_MS = 1_000;

const DEFAULT_SESSION_REGISTRATION: ProviderSessionRegistration = Object.freeze({
  origin: "interactive-native",
  interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
});
const MAX_TRACKED_INTERACTION_SESSIONS = 1_024;
const MAX_TRACKED_PROVIDER_INTERACTIONS = 4_096;
// This page is only a bounded positive-existence cache seed. Absence from it
// never proves deletion; only a per-session 404 may manufacture `missing`.
const MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS =
  MAX_TRACKED_INTERACTION_SESSIONS + 1;
const MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const DEFAULT_OPENCODE_EXISTENCE_CACHE_TTL_MS = 10_000;
const OPENCODE_EXISTENCE_PROBE_CONCURRENCY = 8;
const MCP_FORM_CONTENT_QUESTION_ID = "mcp-form-content";
const MAX_RENDERED_FILE_CHANGES = 48;
const MAX_RENDERED_FILE_CHANGE_TEXT_LENGTH = 256;

function setBoundedMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maximumSize: number,
): void {
  if (!map.has(key) && map.size >= maximumSize) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function setBoundedSetEntry<T>(set: Set<T>, value: T, maximumSize: number): void {
  if (!set.has(value) && set.size >= maximumSize) {
    const oldest = set.values().next().value as T | undefined;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedText(
  value: unknown,
  fallback: string,
  maximumLength: number = AGENT_INTERACTION_LIMITS.maxTextLength,
): string {
  const text = nonEmptyString(value) ?? fallback;
  if (text.length > maximumLength) {
    throw new ProviderUnavailableError("Provider interaction snapshot is oversized");
  }
  return text;
}

function truncatedText(
  value: unknown,
  fallback: string,
  maximumLength: number = AGENT_INTERACTION_LIMITS.maxTextLength,
): string {
  const text = nonEmptyString(value) ?? fallback;
  if (text.length <= maximumLength) return text;
  return `${text.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function boundedJoinedText(lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  return boundedText(lines.join("\n"), "Interaction details");
}

function truncatedJoinedText(lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  return truncatedText(lines.join("\n"), "Interaction details");
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError(`Provider returned malformed ${label}`);
  }
  if (value.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion) {
    throw new ProviderUnavailableError(`Provider returned too many ${label}`);
  }
  return value.map((entry) => {
    const text = nonEmptyString(entry);
    if (!text) {
      throw new ProviderUnavailableError(`Provider returned malformed ${label}`);
    }
    return boundedText(text, label);
  });
}

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedOwnedOpenCodeCollection(
  value: unknown,
  ownedSessionIds: ReadonlySet<string>,
  operation: string,
): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError(`${operation} is malformed`);
  }
  const owned: unknown[] = [];
  for (const entry of value) {
    const request = asRecord(entry);
    const sessionId = nonEmptyString(request?.sessionID)
      ?? nonEmptyString(request?.sessionId);
    if (!sessionId || !ownedSessionIds.has(sessionId)) continue;
    const id = nonEmptyString(request?.id);
    if (
      !request
      || !id
      || id.length > AGENT_INTERACTION_LIMITS.maxIdLength
      || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
    ) {
      throw new ProviderUnavailableError(`${operation} contains a malformed identity`);
    }
    if (owned.length >= MAX_TRACKED_PROVIDER_INTERACTIONS) {
      throw new ProviderUnavailableError(`${operation} returned too many interactions`);
    }
    owned.push(entry);
  }
  return owned;
}

type OpenCodeSessionLifecycleState =
  | "running"
  | "idle"
  | "unknown"
  | "missing";

type OpenCodeExistenceSnapshot = ReturnType<
  typeof boundedOpenCodeExistenceSnapshot
>;

type OpenCodeExistenceProbe = {
  state: "exists" | "missing" | "unknown";
  error?: unknown;
};

function boundedOpenCodeStatusSnapshot(
  value: unknown,
  requestedSessionIds: ReadonlySet<string>,
): Record<string, Record<string, unknown>> {
  const snapshot = asRecord(value);
  if (!snapshot) {
    throw new ProviderUnavailableError("OpenCode status read is malformed");
  }
  const entries = Object.entries(snapshot);
  if (
    entries.length > MAX_TRACKED_PROVIDER_INTERACTIONS
    || serializedByteLength(value) > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
  ) {
    throw new ProviderUnavailableError("OpenCode status read is oversized");
  }
  const validated: Record<string, Record<string, unknown>> = Object.create(null);
  for (const sessionId of requestedSessionIds) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, sessionId)) continue;
    const rawStatus = snapshot[sessionId];
    const status = asRecord(rawStatus);
    if (
      sessionId.length === 0
      || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
      || !status
      || typeof status.type !== "string"
    ) {
      throw new ProviderUnavailableError(
        "OpenCode status read contains a malformed entry",
      );
    }
    validated[sessionId] = status;
  }
  return validated;
}

function boundedOpenCodeExistenceSnapshot(value: unknown): {
  sessionIds: Set<string>;
} {
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError("OpenCode session list is malformed");
  }
  if (
    value.length > MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS
    || serializedByteLength(value) > MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES
  ) {
    throw new ProviderUnavailableError("OpenCode session list is oversized");
  }
  const sessionIds = new Set<string>();
  for (const entry of value) {
    const sessionId = nonEmptyString(asRecord(entry)?.id);
    // The list is directory-wide and may contain sessions Orkestrator has
    // never owned. A malformed foreign entry cannot prove that a valid target
    // exists or is absent, so ignore it instead of stalling every tracked
    // session in the environment.
    if (
      !sessionId
      || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
    ) continue;
    sessionIds.add(sessionId);
  }
  return { sessionIds };
}

function opaqueOptionId(questionIndex: number, optionIndex: number): string {
  return `q${questionIndex}:o${optionIndex}`;
}

function requestCreatedAt(expiresAt: number | undefined, now: number): number {
  return expiresAt === undefined
    ? now
    : Math.max(0, expiresAt - AGENT_INTERACTION_DEFAULT_TIMEOUT_MS);
}

class InteractionSnapshotTracker {
  private readonly registrations = new Map<string, ProviderSessionRegistration>();
  /**
   * Sessions whose registration came from a caller rather than from the
   * implicit default.
   *
   * {@link snapshot} registers an unknown session so it can be tracked at all,
   * and that placeholder says `interactive-native`. Without this distinction,
   * first-write-wins would let one early read permanently pin an unattended
   * build-pipeline session to the interactive policy — it would simply stop
   * auto-resolving, with nothing to show for it.
   */
  private readonly explicitRegistrations = new Set<string>();
  private readonly fingerprints = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly firstSeenAt = new Map<string, number>();
  private readonly interactionSessions = new Map<string, string>();

  register(sessionId: string, interaction?: ProviderSessionRegistration): void {
    if (
      !this.registrations.has(sessionId)
      && this.registrations.size >= MAX_TRACKED_INTERACTION_SESSIONS
    ) {
      const oldest = this.registrations.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.registrations.delete(oldest);
        this.explicitRegistrations.delete(oldest);
        this.fingerprints.delete(oldest);
        this.revisions.delete(oldest);
        for (const [interactionId, ownerSessionId] of this.interactionSessions) {
          if (ownerSessionId !== oldest) continue;
          this.interactionSessions.delete(interactionId);
          this.firstSeenAt.delete(interactionId);
        }
      }
    }
    const existing = this.registrations.get(sessionId);
    if (existing === undefined) {
      this.registrations.set(sessionId, interaction ?? DEFAULT_SESSION_REGISTRATION);
      if (interaction) this.explicitRegistrations.add(sessionId);
      return;
    }
    if (!interaction) return;
    // The placeholder written by an early read is not a decision, so the first
    // real registration replaces it outright.
    if (!this.explicitRegistrations.has(sessionId)) {
      this.registrations.set(sessionId, interaction);
      this.explicitRegistrations.add(sessionId);
      return;
    }
    // Policy is fixed before the first request. Re-registering a restored or
    // cached provider may reassert the same metadata, but must never switch a
    // live session between interactive and unattended while a request exists.
    if (
      interaction.origin !== existing.origin
      || interaction.interactionPolicy.mode !== existing.interactionPolicy.mode
    ) return;
    // Same identity, so fill in metadata the first caller did not have —
    // callers differ in what they know (the activity sweep has no `phase`, the
    // reconciler does) and whichever ran first should not cost the others their
    // fields. Values already recorded are never overwritten: the fence in
    // particular identifies the generation that owns any live request.
    this.registrations.set(sessionId, {
      ...existing,
      phase: existing.phase ?? interaction.phase,
      workflowId: existing.workflowId ?? interaction.workflowId,
      provider: existing.provider ?? interaction.provider,
      fence: existing.fence ?? interaction.fence,
    });
  }

  registration(sessionId: string): ProviderSessionRegistration {
    return this.registrations.get(sessionId) ?? DEFAULT_SESSION_REGISTRATION;
  }

  firstSeen(interactionId: string, fallback = Date.now()): number {
    const existing = this.firstSeenAt.get(interactionId);
    if (existing !== undefined) return existing;
    setBoundedMapEntry(
      this.firstSeenAt,
      interactionId,
      fallback,
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    return fallback;
  }

  sessionFor(interactionId: string): string | undefined {
    return this.interactionSessions.get(interactionId);
  }

  snapshot(sessionId: string, requests: AgentInteractionRequest[]): AgentInteractionSnapshot {
    if (requests.length > AGENT_INTERACTION_LIMITS.maxPendingRequests) {
      throw new ProviderUnavailableError("Provider returned too many pending interactions");
    }
    const fingerprint = JSON.stringify(requests);
    const previous = this.fingerprints.get(sessionId);
    const revision = previous === fingerprint
      ? this.revisions.get(sessionId) ?? 0
      : (this.revisions.get(sessionId) ?? 0) + 1;
    const normalized = requests.map((request) => ({ ...request, revision }));
    const snapshot: AgentInteractionSnapshot = {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      revision,
      requests: normalized,
    };
    // Validation must precede every tracker mutation. Otherwise a rejected
    // snapshot can still retain its fingerprint and poison revision/identity
    // state for later authoritative reads.
    if (!isAgentInteractionSnapshot(snapshot)) {
      throw new ProviderUnavailableError("Provider returned a malformed interaction snapshot");
    }
    if (!this.registrations.has(sessionId)) this.register(sessionId);
    this.fingerprints.set(sessionId, fingerprint);
    this.revisions.set(sessionId, revision);
    const currentIds = new Set(normalized.map((request) => request.id));
    for (const [interactionId, ownerSessionId] of this.interactionSessions) {
      if (ownerSessionId !== sessionId || currentIds.has(interactionId)) continue;
      this.interactionSessions.delete(interactionId);
      this.firstSeenAt.delete(interactionId);
    }
    for (const request of normalized) {
      setBoundedMapEntry(
        this.interactionSessions,
        request.id,
        sessionId,
        MAX_TRACKED_PROVIDER_INTERACTIONS,
      );
    }
    return snapshot;
  }
}

function outcome(
  result: AgentInteractionApplyOutcome["result"],
  sessionId: string,
  interactionId: string,
  revision: number,
): AgentInteractionApplyOutcome {
  return { result, sessionId, interactionId, revision };
}

async function boundedJson(
  response: Response,
  operation: string,
  budget = { remaining: AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes },
): Promise<unknown> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderUnavailableError(`${operation} is oversized`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderUnavailableError(`${operation} is malformed`);
  }
}

function authHeaders(connection: BridgeConnection): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (connection.agent === "claude") {
    headers.set("X-Orkestrator-Claude-Token", connection.authToken);
  } else if (connection.agent === "codex") {
    headers.set("X-Orkestrator-Codex-Token", connection.authToken);
  }
  return headers;
}

async function bridgeFetch(
  connection: BridgeConnection,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = authHeaders(connection);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const timeoutMs = Math.max(
    1,
    connection.requestTimeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS,
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetchImpl(`${connection.baseUrl}${path}`, {
      ...init,
      headers,
      signal,
    });
  } catch (error) {
    throw new ProviderUnavailableError(
      `${connection.agent} bridge is unavailable`,
      { cause: error },
    );
  }
}

function assertOk(response: Response, operation: string): void {
  if (!response.ok) {
    if (isTransientHttpStatus(response.status)) {
      throw new ProviderUnavailableError(
        `${operation} is temporarily unavailable (HTTP ${response.status})`,
      );
    }
    throw new Error(`${operation} failed (HTTP ${response.status})`);
  }
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

/**
 * Produce the attachment list a bridge will accept.
 *
 * Base64-only images have no `path`, which every bridge validator requires, so
 * they must be staged first. Refusing them outright when no stager is wired is
 * deliberate: the alternative is a prompt that references an image the agent was
 * never given.
 */
async function resolvePromptAttachments(
  options: ProviderSendOptions,
  stageImages: ProviderDependencies["stageImages"],
): Promise<PromptAttachment[] | undefined> {
  const attachments = options.attachments ? [...options.attachments] : [];
  const images = options.images ?? [];
  if (images.length > 0) {
    if (!stageImages) {
      throw new PromptRejectedError(
        "Prompt images require workspace staging before they can be attached",
      );
    }
    attachments.push(...await stageImages(images));
  }
  return attachments.length > 0 ? attachments : undefined;
}

class HttpBridgeProvider implements BuildPipelineProvider {
  readonly agent: "claude" | "codex";
  private readonly stageImages?: ProviderDependencies["stageImages"];
  private readonly interactionTracker = new InteractionSnapshotTracker();
  private readonly providerInteractionIds = new Map<
    string,
    { providerRequestId: string; sessionId: string; actionable?: boolean }
  >();
  private readonly resolvingInteractions = new Set<string>();
  readonly interactions: AgentInteractionProviderCapability = {
    listPendingInteractions: (sessionId) => this.listPendingInteractions(sessionId),
    resolveInteraction: (sessionId, interactionId, resolution) =>
      this.resolveInteraction(sessionId, interactionId, resolution),
  };
  /**
   * The Codex mode each session was last known to be in.
   *
   * Codex binds its mode to the session rather than the prompt, so re-asserting
   * the mode a session was just created with costs a config round trip and
   * changes nothing. A session this provider did not create — one restored
   * through {@link registerSession} after a restart — is absent here, and those
   * do have to be reconciled against the bridge.
   */
  private readonly codexModes = new Map<string, ProviderExecutionMode>();

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
    stageImages?: ProviderDependencies["stageImages"],
  ) {
    this.agent = connection.agent as "claude" | "codex";
    this.stageImages = stageImages;
  }

  registerSession(
    sessionId: string,
    interaction?: ProviderSessionRegistration,
  ): void {
    this.interactionTracker.register(sessionId, interaction);
  }

  async createSession(
    phase: PipelineSessionPhase,
    label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    const clientSessionKey = options.clientSessionKey;
    const mode = options.mode
      ?? (phase === "review" || phase === "verify" ? "plan" : "build");
    const response = await bridgeFetch(
      this.connection,
      "/session/create",
      {
        method: "POST",
        body: JSON.stringify(this.agent === "codex"
          ? {
              title: label,
              model: options.model ?? this.connection.model,
              modelReasoningEffort: options.effort ?? this.connection.effort,
              mode,
              clientSessionKey,
            }
          : { title: label, clientSessionKey }),
      },
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} session creation`);
    const body = await response.json() as { sessionId?: unknown };
    if (typeof body.sessionId !== "string") {
      throw new Error(`${this.agent} returned a malformed session`);
    }
    this.registerSession(body.sessionId, options.interaction);
    if (this.agent === "codex") this.codexModes.set(body.sessionId, mode);
    return body.sessionId;
  }

  async send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void> {
    if (
      this.agent === "codex"
      && options.mode
      && this.codexModes.get(sessionId) !== options.mode
    ) {
      await this.ensureCodexMode(sessionId, options.mode);
      this.codexModes.set(sessionId, options.mode);
    }
    const attachments = await resolvePromptAttachments(options, this.stageImages);
    let response: Response;
    try {
      response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({
            prompt,
            requestId: options.requestId,
            attachments,
            outputSchema: options.schema,
            ...(this.agent === "claude"
              ? {
                  model: options.model ?? this.connection.model,
                  effort: options.effort ?? this.connection.effort,
                  fastMode: options.fastMode,
                  agent: options.subAgent,
                  includeLocalSettings: options.includeLocalSettings,
                  promptSuggestions: options.promptSuggestions,
                  permissionMode:
                    options.mode === "plan" ? "plan" : "bypassPermissions",
                }
              : { fastMode: options.fastMode }),
          }),
        },
        this.fetchImpl,
      );
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        throw new AmbiguousPromptDispatchError(
          `${this.agent} prompt dispatch outcome is unknown`,
          { cause: error },
        );
      }
      throw error;
    }
    // A session can briefly disappear while a bridge reconciles a restarted
    // provider, and an idle status read can race with another client starting a
    // turn. Both are retryable dispatch races, not validation rejections that
    // should park the user's prompt indefinitely.
    if (
      response.status === 404
      || response.status === 409
      || isTransientHttpStatus(response.status)
    ) {
      throw new ProviderUnavailableError(
        `${this.agent} prompt dispatch is temporarily unavailable (HTTP ${response.status})`,
      );
    }
    if (!response.ok) {
      throw new PromptRejectedError(
        `${this.agent} rejected the prompt (HTTP ${response.status})`,
      );
    }
  }

  /**
   * Codex stores execution mode on the session rather than accepting it on the
   * prompt route. A review's addressing turn deliberately stays in the same
   * thread for context, so switch that idle thread from read-only plan mode to
   * build mode before dispatching the fixes.
   */
  private async ensureCodexMode(
    sessionId: string,
    mode: ProviderExecutionMode,
  ): Promise<void> {
    const path = `/session/${encodeURIComponent(sessionId)}/config`;
    const currentResponse = await bridgeFetch(
      this.connection,
      path,
      {},
      this.fetchImpl,
    );
    if (
      currentResponse.status === 404
      || currentResponse.status === 409
      || isTransientHttpStatus(currentResponse.status)
    ) {
      throw new ProviderUnavailableError(
        `Codex mode reconciliation is temporarily unavailable (HTTP ${currentResponse.status})`,
      );
    }
    assertOk(currentResponse, "Codex config read");
    const current = await currentResponse.json() as {
      model?: unknown;
      modelReasoningEffort?: unknown;
      mode?: unknown;
      fastMode?: unknown;
      durable?: unknown;
    };
    if (
      (current.mode !== "plan" && current.mode !== "build")
      || (current.model !== undefined && typeof current.model !== "string")
      || (
        current.modelReasoningEffort !== undefined
        && typeof current.modelReasoningEffort !== "string"
      )
      || typeof current.fastMode !== "boolean"
      || typeof current.durable !== "boolean"
    ) {
      throw new Error("Codex returned a malformed session config");
    }
    if (current.mode === mode && current.durable) return;

    const updateResponse = await bridgeFetch(
      this.connection,
      path,
      {
        method: "POST",
        body: JSON.stringify({
          model: current.model,
          modelReasoningEffort: current.modelReasoningEffort,
          mode,
          fastMode: current.fastMode,
        }),
      },
      this.fetchImpl,
    );
    if (
      updateResponse.status === 404
      || updateResponse.status === 409
      || isTransientHttpStatus(updateResponse.status)
    ) {
      throw new ProviderUnavailableError(
        `Codex mode update is temporarily unavailable (HTTP ${updateResponse.status})`,
      );
    }
    assertOk(updateResponse, "Codex config update");
    const update = await updateResponse.json() as { durable?: unknown };
    if (update.durable !== true) {
      throw new ProviderUnavailableError(
        "Codex mode update was not durably persisted",
      );
    }
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    const path = this.agent === "claude"
      ? `/session/${encodeURIComponent(sessionId)}`
      : `/session/${encodeURIComponent(sessionId)}/status`;
    const response = await bridgeFetch(
      this.connection,
      path,
      {},
      this.fetchImpl,
    );
    if (response.status === 404) return "missing";
    assertOk(response, `${this.agent} status read`);
    const body = await response.json() as { status?: unknown };
    return body.status === "running" || body.status === "idle" || body.status === "error"
      ? body.status
      : "error";
  }

  /**
   * Read activity from the bridge's dedicated observation route.
   *
   * This deliberately does not reuse `status()` plus the pending-input routes.
   * Those are the routes a *tab* reads, so each one is a liveness touch: the
   * codex bridge refreshes `lastAccessed` (blocking idle thread detaching) and
   * the claude bridge additionally hydrates the persisted transcript. This
   * method is polled every couple of seconds for every session in every
   * environment, so it must have no side effect at all — `/activity` exists
   * only to answer it.
   *
   * The route reports an unknown session in-band as `missing` and never 404s.
   * A 404 here therefore means the route itself is absent — an older bridge —
   * and must surface as a failure rather than as "this session is gone", which
   * the caller would act on by deleting the user's session mapping.
   */
  async activity(sessionId: string): Promise<ProviderActivityState> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/activity`,
      {},
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} activity read`);
    const body = await response.json() as { activity?: unknown };
    if (!isProviderActivityState(body.activity)) {
      throw new ProviderUnavailableError(
        `${this.agent} returned a malformed activity snapshot`,
      );
    }
    return body.activity;
  }

  private normalizedId(
    sessionId: string,
    providerRequestId: string,
    category: string,
  ): string {
    if (
      sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
      || providerRequestId.length > AGENT_INTERACTION_LIMITS.maxIdLength
    ) {
      throw new ProviderUnavailableError(
        `${this.agent} returned an oversized interaction identity`,
      );
    }
    const id = `${this.agent}:${category}:${encodeURIComponent(sessionId)}:${providerRequestId}`;
    if (id.length > AGENT_INTERACTION_LIMITS.maxIdLength) {
      throw new ProviderUnavailableError(
        `${this.agent} returned an oversized interaction identity`,
      );
    }
    return id;
  }

  private interactionRequest(
    sessionId: string,
    providerRequestId: string,
    category: string,
    input: Omit<
      AgentInteractionRequest,
      "version" | "id" | "provider" | "origin" | "sessionId" | "state" | "revision"
    >,
  ): AgentInteractionRequest {
    const id = this.normalizedId(sessionId, providerRequestId, category);
    setBoundedMapEntry(
      this.providerInteractionIds,
      id,
      { providerRequestId, sessionId },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id,
      provider: this.agent,
      origin: this.interactionTracker.registration(sessionId).origin,
      sessionId,
      state: "pending",
      revision: 0,
      ...input,
    };
  }

  private mapClaudeQuestion(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const questions = request?.questions;
    const expiresAt = request?.expiresAt;
    if (
      !request
      || !providerRequestId
      || !Array.isArray(questions)
      || questions.length === 0
      || questions.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest
      || (expiresAt !== undefined && !Number.isSafeInteger(expiresAt))
    ) {
      throw new ProviderUnavailableError("Claude returned a malformed question request");
    }
    const mapped: AgentInteractionQuestion[] = questions.map((entry, questionIndex) => {
      const question = asRecord(entry);
      const options = question?.options;
      const prompt = nonEmptyString(question?.question);
      if (
        !question
        || !prompt
        || !Array.isArray(options)
        || options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
      ) {
        throw new ProviderUnavailableError("Claude returned a malformed question request");
      }
      return {
        id: `q${questionIndex}`,
        prompt: boundedText(prompt, prompt),
        description: question.header === undefined
          ? undefined
          : truncatedText(question.header, "Question"),
        required: true,
        multiple: question.multiSelect === true,
        secret: false,
        allowFreeText: true,
        options: options.map((entry, optionIndex) => {
          const option = asRecord(entry);
          const label = nonEmptyString(option?.label);
          const rawProviderValue = option && "value" in option
            ? nonEmptyString(option.value)
            : label;
          if (!option || !label || !rawProviderValue) {
            throw new ProviderUnavailableError(
              "Claude returned a malformed question option",
            );
          }
          const providerValue = boundedText(
            rawProviderValue,
            rawProviderValue,
            AGENT_INTERACTION_LIMITS.maxProviderValueLength,
          );
          return {
            id: opaqueOptionId(questionIndex, optionIndex),
            label: boundedText(label, label),
            providerValue,
            description: option?.description === undefined
              ? undefined
              : truncatedText(option.description, "Option"),
          };
        }),
      };
    });
    const id = this.normalizedId(sessionId, providerRequestId, "question");
    const createdAt = Number.isSafeInteger(expiresAt)
      ? requestCreatedAt(expiresAt as number, Date.now())
      : this.interactionTracker.firstSeen(id);
    const expiry = Number.isSafeInteger(expiresAt)
      ? expiresAt as number
      : createdAt + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
    return this.interactionRequest(sessionId, providerRequestId, "question", {
      kind: "question",
      presentation: { title: "Claude needs input", questions: mapped },
      createdAt,
      updatedAt: createdAt,
      expiresAt: expiry,
    });
  }

  private mapClaudeApproval(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const expiresAt = request?.expiresAt;
    if (
      !providerRequestId
      || (expiresAt !== undefined && !Number.isSafeInteger(expiresAt))
    ) {
      throw new ProviderUnavailableError("Claude returned a malformed plan approval");
    }
    const id = this.normalizedId(sessionId, providerRequestId, "plan");
    const createdAt = Number.isSafeInteger(expiresAt)
      ? requestCreatedAt(expiresAt as number, Date.now())
      : this.interactionTracker.firstSeen(id);
    const expiry = Number.isSafeInteger(expiresAt)
      ? expiresAt as number
      : createdAt + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
    return this.interactionRequest(sessionId, providerRequestId, "plan", {
      kind: "plan-approval",
      presentation: {
        title: "Approve Claude's plan",
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
      },
      createdAt,
      updatedAt: createdAt,
      expiresAt: expiry,
    });
  }

  private mapCodexApproval(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.approvalId);
    const requestedAt = request?.requestedAt;
    const expiresAt = request?.expiresAt;
    if (
      !request
      || !providerRequestId
      || !Number.isSafeInteger(requestedAt)
      || !Number.isSafeInteger(expiresAt)
    ) {
      throw new ProviderUnavailableError("Codex returned a malformed approval request");
    }
    const providerKind = request?.kind;
    const kind = providerKind === "command"
      ? "command-approval"
      : providerKind === "file-change"
        ? "file-approval"
        : providerKind === "permissions"
          ? "permission"
          : null;
    if (!kind) throw new ProviderUnavailableError("Codex returned an unknown approval kind");
    const command = nonEmptyString(request.command);
    const cwd = nonEmptyString(request.cwd);
    const reason = nonEmptyString(request.reason);
    const grantRoot = nonEmptyString(request.grantRoot);
    const networkHost = nonEmptyString(request.networkHost);
    const rawChanges = Array.isArray(request.changes) ? request.changes : [];
    const changes = rawChanges
      .slice(0, MAX_RENDERED_FILE_CHANGES)
      .map((rawChange) => {
          const change = asRecord(rawChange);
          const path = nonEmptyString(change?.path);
          if (!change || !path) {
            throw new ProviderUnavailableError(
              "Codex returned a malformed file change",
            );
          }
          const changeKind = nonEmptyString(change.kind) ?? "update";
          return truncatedText(
            `${changeKind}: ${path}`,
            "File change",
            MAX_RENDERED_FILE_CHANGE_TEXT_LENGTH,
          );
        });
    const hiddenChangeCount = rawChanges.length - changes.length;
    const permissions = asRecord(request.permissions);
    const requestedPermissions = permissions
      ? [
          permissions.network === true ? "network" : null,
          permissions.fileSystem === true ? "file system" : null,
        ].filter((entry): entry is string => entry !== null)
      : [];
    const inferredActionable = kind === "command-approval"
      ? command !== null
      : kind === "file-approval"
        ? rawChanges.length > 0
        : requestedPermissions.length > 0;
    const actionable = inferredActionable && request.actionable !== false;
    const body = truncatedJoinedText([
      ...(reason ? [`Reason: ${boundedText(reason, "Reason")}`] : []),
      ...(command ? [`Command: ${boundedText(command, "Command")}`] : []),
      ...(cwd ? [`Working directory: ${boundedText(cwd, "Working directory")}`] : []),
      ...changes.map((change) => `Change: ${change}`),
      ...(hiddenChangeCount > 0
        ? [`… and ${hiddenChangeCount} more files`]
        : []),
      ...(requestedPermissions.length > 0
        ? [`Permissions: ${requestedPermissions.join(", ")}`]
        : []),
      ...(grantRoot ? [`Grant root: ${boundedText(grantRoot, "Grant root")}`] : []),
      ...(networkHost ? [`Network host: ${boundedText(networkHost, "Network host")}`] : []),
      ...(!actionable ? ["Approval is missing actionable operation details."] : []),
    ]);
    const mapped = this.interactionRequest(sessionId, providerRequestId, "approval", {
      kind,
      presentation: {
        title: kind === "command-approval"
          ? "Approve command"
          : kind === "file-approval" ? "Approve file changes" : "Approve permissions",
        body: body === undefined ? undefined : boundedText(body, "Approval requested"),
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
      },
      createdAt: requestedAt as number,
      updatedAt: requestedAt as number,
      expiresAt: expiresAt as number,
    });
    const identity = this.providerInteractionIds.get(mapped.id);
    if (identity) identity.actionable = actionable;
    return mapped;
  }

  private mapCodexInteraction(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.interactionId);
    const requestedAt = request?.requestedAt;
    const expiresAt = request?.expiresAt;
    const kind = request?.kind;
    if (
      !request
      || !providerRequestId
      || !Number.isSafeInteger(requestedAt)
      || !Number.isSafeInteger(expiresAt)
      || (kind !== "question" && kind !== "mcp-form" && kind !== "mcp-url")
    ) {
      throw new ProviderUnavailableError("Codex returned a malformed interaction request");
    }
    const questions: AgentInteractionQuestion[] = kind === "question"
      ? this.mapCodexQuestions(request.questions)
      : kind === "mcp-form"
        ? [this.mapCodexMcpForm(request.schema)]
        : [];
    const url = kind === "mcp-url" ? nonEmptyString(request.url) : null;
    if (kind === "mcp-url" && !url) {
      throw new ProviderUnavailableError("Codex returned a malformed URL elicitation");
    }
    return this.interactionRequest(sessionId, providerRequestId, "interaction", {
      kind,
      presentation: {
        title: kind === "question"
          ? "Codex needs input"
          : kind === "mcp-form" ? "MCP server needs input" : "MCP authorization",
        body: request.message === undefined
          ? undefined
          : truncatedText(request.message, "MCP request"),
        questions,
        url: url === null ? undefined : boundedText(url, "MCP URL"),
        confirmLabel: "Continue",
        declineLabel: "Decline",
      },
      createdAt: requestedAt as number,
      updatedAt: requestedAt as number,
      expiresAt: expiresAt as number,
    });
  }

  private mapCodexMcpForm(schemaValue: unknown): AgentInteractionQuestion {
    const schema = asRecord(schemaValue) ?? {};
    const serializedSchema = JSON.stringify(schema);
    if (
      !serializedSchema
      || new TextEncoder().encode(serializedSchema).byteLength
        > AGENT_INTERACTION_LIMITS.maxTextLength
    ) {
      throw new ProviderUnavailableError("Codex returned an oversized MCP form schema");
    }
    return {
      id: MCP_FORM_CONTENT_QUESTION_ID,
      prompt: "Enter a JSON object matching the MCP form schema",
      description: serializedSchema,
      required: true,
      multiple: false,
      secret: false,
      allowFreeText: true,
      options: [],
    };
  }

  private mapCodexQuestions(value: unknown): AgentInteractionQuestion[] {
    if (
      !Array.isArray(value)
      || value.length === 0
      || value.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest
    ) {
      throw new ProviderUnavailableError("Codex returned malformed questions");
    }
    return value.map((entry, questionIndex) => {
      const question = asRecord(entry);
      const providerQuestionId = nonEmptyString(question?.id);
      const prompt = nonEmptyString(question?.question);
      const options = question?.options ?? [];
      if (
        !providerQuestionId
        || !prompt
        || providerQuestionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
        || !Array.isArray(options)
        || options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
      ) {
        throw new ProviderUnavailableError("Codex returned malformed questions");
      }
      return {
        id: providerQuestionId,
        prompt: boundedText(prompt, prompt),
        description: question?.header === undefined
          ? undefined
          : truncatedText(question.header, "Question"),
        required: true,
        multiple: true,
        secret: question?.isSecret === true,
        allowFreeText: question?.isOther === true || options.length === 0,
        options: options.map((entry, optionIndex) => {
          const option = asRecord(entry);
          const label = nonEmptyString(option?.label);
          if (!option || !label) {
            throw new ProviderUnavailableError(
              "Codex returned a malformed question option",
            );
          }
          return {
            id: opaqueOptionId(questionIndex, optionIndex),
            label: boundedText(label, label),
            providerValue: boundedText(
              label,
              label,
              AGENT_INTERACTION_LIMITS.maxProviderValueLength,
            ),
            description: option?.description === undefined
              ? undefined
              : truncatedText(option.description, "Option"),
          };
        }),
      };
    });
  }

  private async listPendingInteractions(
    sessionId: string,
  ): Promise<AgentInteractionSnapshot> {
    const paths = this.agent === "claude"
      ? ["questions", "plan-approvals"] as const
      : ["approvals", "interactions"] as const;
    const responses = await Promise.all(paths.map((path) => bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/${path}`,
      {},
      this.fetchImpl,
    )));
    if (responses.every((response) => response.status === 404)) {
      return this.interactionTracker.snapshot(sessionId, []);
    }
    for (const response of responses) assertOk(response, `${this.agent} interaction snapshot`);
    const snapshotBudget = {
      remaining: AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes,
    };
    const payloads = await Promise.all(responses.map((response) =>
      boundedJson(response, `${this.agent} interaction snapshot`, snapshotBudget)
    ));
    const first = asRecord(payloads[0]);
    const second = asRecord(payloads[1]);
    const firstRequests = first?.[this.agent === "claude" ? "questions" : "approvals"];
    const secondRequests = second?.[this.agent === "claude" ? "approvals" : "interactions"];
    if (!Array.isArray(firstRequests) || !Array.isArray(secondRequests)) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed interaction snapshot`);
    }
    const requests: AgentInteractionRequest[] = [];
    let droppedRequests = 0;
    const mapRequest = (
      raw: unknown,
      mapper: (request: unknown) => AgentInteractionRequest,
    ): void => {
      if (requests.length >= AGENT_INTERACTION_LIMITS.maxPendingRequests) {
        droppedRequests += 1;
        return;
      }
      try {
        requests.push(mapper(raw));
      } catch (error) {
        if (!(error instanceof ProviderUnavailableError)) throw error;
        droppedRequests += 1;
      }
    };
    if (this.agent === "claude") {
      for (const request of firstRequests) {
        mapRequest(request, (raw) => this.mapClaudeQuestion(sessionId, raw));
      }
      for (const request of secondRequests) {
        mapRequest(request, (raw) => this.mapClaudeApproval(sessionId, raw));
      }
    } else {
      for (const request of firstRequests) {
        mapRequest(request, (raw) => this.mapCodexApproval(sessionId, raw));
      }
      for (const request of secondRequests) {
        mapRequest(request, (raw) => this.mapCodexInteraction(sessionId, raw));
      }
    }
    if (droppedRequests > 0) {
      console.warn(
        `[build-pipeline] Dropped ${droppedRequests} unmappable ${this.agent} interaction request(s)`,
      );
      if (requests.length === 0) {
        throw new ProviderUnavailableError(
          `${this.agent} returned no mappable interaction requests`,
        );
      }
    }
    const snapshot = this.interactionTracker.snapshot(sessionId, requests);
    const currentIds = new Set(snapshot.requests.map((request) => request.id));
    for (const [interactionId, identity] of this.providerInteractionIds) {
      if (identity.sessionId === sessionId && !currentIds.has(interactionId)) {
        this.providerInteractionIds.delete(interactionId);
      }
    }
    return snapshot;
  }

  private async resolveInteraction(
    sessionId: string,
    interactionId: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome> {
    const knownSession = this.interactionTracker.sessionFor(interactionId);
    if (knownSession !== undefined && knownSession !== sessionId) {
      return outcome("rejected", sessionId, interactionId, 0);
    }
    const snapshot = await this.listPendingInteractions(sessionId);
    const request = snapshot.requests.find((candidate) => candidate.id === interactionId);
    if (!request) return outcome("stale", sessionId, interactionId, snapshot.revision);
    if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) {
      return outcome("stale", sessionId, interactionId, snapshot.revision);
    }
    if (!isAgentInteractionResolution(resolution, request)) {
      return outcome("rejected", sessionId, interactionId, snapshot.revision);
    }
    if (this.resolvingInteractions.has(interactionId)) {
      return outcome("already-resolved", sessionId, interactionId, snapshot.revision);
    }
    const identity = this.providerInteractionIds.get(interactionId);
    if (!identity) {
      return outcome("stale", sessionId, interactionId, snapshot.revision);
    }
    if (resolution.action === "answer" && identity.actionable === false) {
      return outcome("rejected", sessionId, interactionId, snapshot.revision);
    }
    this.resolvingInteractions.add(interactionId);
    try {
      let target: { path: string; method: "POST" | "DELETE"; body?: string };
      try {
        target = await this.httpResolutionTarget(
          sessionId,
          identity.providerRequestId,
          request,
          resolution,
        );
      } catch {
        return outcome("rejected", sessionId, interactionId, snapshot.revision);
      }
      let response: Response;
      try {
        response = await bridgeFetch(
          this.connection,
          target.path,
          { method: target.method, body: target.body },
          this.fetchImpl,
        );
      } catch (error) {
        const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
        if (reconciled && !reconciled.requests.some((item) => item.id === interactionId)) {
          return outcome("applied", sessionId, interactionId, reconciled.revision);
        }
        return outcome("provider-unavailable", sessionId, interactionId, snapshot.revision);
      }
      if (response.status === 409 || response.status === 404) {
        const reconciled = await this.listPendingInteractions(sessionId).catch(() => snapshot);
        return outcome("stale", sessionId, interactionId, reconciled.revision);
      }
      if (!response.ok) {
        return outcome(
          isTransientHttpStatus(response.status) ? "provider-unavailable" : "rejected",
          sessionId,
          interactionId,
          snapshot.revision,
        );
      }
      const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
      if (!reconciled) {
        return outcome(
          "provider-unavailable",
          sessionId,
          interactionId,
          snapshot.revision,
        );
      }
      return outcome(
        reconciled.requests.some((item) => item.id === interactionId)
          ? "provider-unavailable"
          : "applied",
        sessionId,
        interactionId,
        reconciled.revision,
      );
    } finally {
      this.resolvingInteractions.delete(interactionId);
    }
  }

  private async httpResolutionTarget(
    sessionId: string,
    providerRequestId: string,
    request: AgentInteractionRequest,
    resolution: AgentInteractionResolution,
  ): Promise<{ path: string; method: "POST" | "DELETE"; body?: string }> {
    const base = `/session/${encodeURIComponent(sessionId)}`;
    if (this.agent === "claude") {
      if (request.kind === "question") {
        if (resolution.action !== "answer") {
          return {
            path: `${base}/questions/${encodeURIComponent(providerRequestId)}`,
            method: "DELETE",
          };
        }
        const byQuestion = new Map(
          resolution.answer?.answers.map((answer) => [answer.questionId, answer]),
        );
        const answers = request.presentation.questions.map((question) => {
          const answer = byQuestion.get(question.id)!;
          const options = new Map(question.options.map((option) => [option.id, option.providerValue]));
          return [
            ...(answer.optionIds ?? []).map((id) => options.get(id)!),
            ...(answer.freeText === undefined ? [] : [answer.freeText]),
          ];
        });
        return {
          path: `${base}/questions/${encodeURIComponent(providerRequestId)}/answer`,
          method: "POST",
          body: JSON.stringify({ answers }),
        };
      }
      return {
        path: `${base}/plan-approvals/${encodeURIComponent(providerRequestId)}/respond`,
        method: "POST",
        body: JSON.stringify({ approved: resolution.action === "answer" }),
      };
    }

    if (
      request.kind === "command-approval"
      || request.kind === "file-approval"
      || request.kind === "permission"
    ) {
      return {
        path: `${base}/approvals/${encodeURIComponent(providerRequestId)}`,
        method: "POST",
        body: JSON.stringify({
          decision: resolution.action === "answer"
            ? "approve"
            : resolution.action === "cancel" ? "cancel" : "deny",
        }),
      };
    }
    const answerBody: Record<string, unknown> = {
      action: resolution.action === "answer"
        ? "accept"
        : resolution.action === "cancel" ? "cancel" : "decline",
    };
    if (resolution.action === "answer" && request.kind === "mcp-form") {
      const rawContent = resolution.answer!.answers.find(
        (answer) => answer.questionId === MCP_FORM_CONTENT_QUESTION_ID,
      )?.freeText;
      let content: unknown;
      try {
        content = rawContent === undefined ? null : JSON.parse(rawContent);
      } catch {
        throw new ProviderUnavailableError("MCP form content must be valid JSON");
      }
      if (!asRecord(content)) {
        throw new ProviderUnavailableError("MCP form content must be a JSON object");
      }
      answerBody.content = content;
    } else if (resolution.action === "answer" && request.kind === "question") {
      answerBody.answers = Object.fromEntries(
        request.presentation.questions.map((question) => {
          const answer = resolution.answer!.answers.find(
            (candidate) => candidate.questionId === question.id,
          )!;
          const options = new Map(question.options.map((option) => [option.id, option.providerValue]));
          return [question.id, [
            ...(answer.optionIds ?? []).map((id) => options.get(id)!),
            ...(answer.freeText === undefined ? [] : [answer.freeText]),
          ]];
        }),
      );
    }
    return {
      path: `${base}/interactions/${encodeURIComponent(providerRequestId)}`,
      method: "POST",
      body: JSON.stringify(answerBody),
    };
  }

  async messages(sessionId: string): Promise<unknown[]> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/messages`,
      {},
      this.fetchImpl,
    );
    if (response.status === 404) return [];
    assertOk(response, `${this.agent} transcript read`);
    const body = await response.json() as { messages?: unknown };
    return Array.isArray(body.messages) ? body.messages : [];
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/structured-output?requestId=${encodeURIComponent(requestId)}`,
      {},
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} structured-output read`);
    const body = await response.json() as { structuredOutput?: unknown };
    return (body.structuredOutput ?? null) as StructuredOutputResult<T> | null;
  }

  async abort(sessionId: string): Promise<void> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/abort`,
      { method: "POST" },
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} abort`);
  }
}

class OpenCodeProvider implements BuildPipelineProvider {
  readonly agent = "opencode" as const;
  private readonly client: OpencodeClient;
  private readonly interactionTracker = new InteractionSnapshotTracker();
  private readonly providerInteractionIds = new Map<
    string,
    { providerRequestId: string; sessionId: string; actionable?: boolean }
  >();
  private readonly resolvingInteractions = new Set<string>();
  readonly interactions: AgentInteractionProviderCapability = {
    listPendingInteractions: (sessionId) => this.listPendingInteractions(sessionId),
    resolveInteraction: (sessionId, interactionId, resolution) =>
      this.resolveInteraction(sessionId, interactionId, resolution),
  };
  private readonly ownedSessions = new Set<string>();
  private readonly blockedSessions = new Set<string>();
  private readonly failedQuestionSessions = new Set<string>();
  private readonly monitorController = new AbortController();
  private readonly monitorRetryMs: number;
  private readonly now: () => number;
  private readonly existenceCacheTtlMs: number;
  private readonly sessionExistenceCache = new Map<string, number>();
  private readonly sessionExistenceRetryAt = new Map<string, number>();
  private sessionListCache: {
    snapshot: OpenCodeExistenceSnapshot;
    expiresAt: number;
  } | null = null;
  private sessionListFailure: { error: unknown; expiresAt: number } | null = null;
  private sessionListRead: Promise<OpenCodeExistenceSnapshot> | null = null;
  private existenceProbeCursor = 0;
  private readonly answeringRequestIds = new Set<string>();
  private readonly requestTasks = new Set<Promise<void>>();
  private activeStreamController: AbortController | null = null;
  private reconciliation: Promise<void> | null = null;
  private monitorPromise: Promise<void>;
  private disposed = false;
  private readonly autoAnswerRequests: boolean;
  private readonly onInteractionObservation?: (
    event: ProviderInteractionObservationEvent,
  ) => void | Promise<void>;

  constructor(
    private readonly connection: BridgeConnection,
    dependencies: ProviderDependencies,
  ) {
    const basic = Buffer.from(`opencode:${connection.authToken}`).toString("base64");
    const createClient = dependencies.openCodeClientFactory ?? createOpencodeClient;
    this.client = dependencies.openCodeClient ?? createClient({
      baseUrl: connection.baseUrl,
      directory: connection.directory,
      headers: {
        Authorization: `Basic ${basic}`,
        "X-Orkestrator-OpenCode-Token": connection.authToken,
      },
    });
    this.monitorRetryMs = Math.max(
      1,
      dependencies.monitorRetryMs ?? DEFAULT_MONITOR_RETRY_MS,
    );
    this.now = dependencies.now ?? Date.now;
    this.existenceCacheTtlMs = Math.max(
      1,
      dependencies.openCodeExistenceCacheTtlMs
        ?? DEFAULT_OPENCODE_EXISTENCE_CACHE_TTL_MS,
    );
    this.autoAnswerRequests = dependencies.autoAnswerRequests === true;
    this.onInteractionObservation = dependencies.onInteractionObservation;
    // An interactive provider has nothing to monitor: every request belongs to a
    // tab that will answer it. Subscribing anyway would open a permanent event
    // stream per provider for no consumer.
    this.monitorPromise = this.autoAnswerRequests
      ? this.monitorRequests()
      : Promise.resolve();
  }

  registerSession(
    sessionId: string,
    interaction?: ProviderSessionRegistration,
  ): void {
    this.ownedSessions.add(sessionId);
    this.interactionTracker.register(sessionId, interaction);
    if (!this.autoAnswerRequests) return;
    const activeReconciliation = this.reconciliation;
    const reconciliation = activeReconciliation
      ? activeReconciliation
          .catch(() => undefined)
          .then(() => this.reconcilePendingRequests())
      : this.reconcilePendingRequests();
    void reconciliation.catch(() => {
      // The reconnect loop will try again. Registration must stay synchronous
      // so restoring a pipeline does not block on an external service.
    });
  }

  private async monitorRequests(): Promise<void> {
    while (!this.disposed) {
      try {
        await this.reconcilePendingRequests();
        const streamController = new AbortController();
        this.activeStreamController = streamController;
        const response = await this.client.event.subscribe(
          { directory: this.connection.directory },
          {
            signal: AbortSignal.any([
              this.monitorController.signal,
              streamController.signal,
            ]),
          },
        );
        if (!response || !("stream" in response)) {
          throw new Error("OpenCode returned no event stream");
        }
        for await (const raw of response.stream as AsyncIterable<unknown>) {
          if (this.disposed) return;
          this.dispatchRequest(raw);
        }
        if (this.activeStreamController === streamController) {
          this.activeStreamController = null;
        }
      } catch (error) {
        if (this.disposed || this.monitorController.signal.aborted) return;
        console.warn(
          "[build-pipeline] OpenCode request monitor reconnecting:",
          error instanceof Error ? error.name : "unknown error",
        );
        this.activeStreamController?.abort();
      }
      try {
        await waitForRetry(this.monitorRetryMs, this.monitorController.signal);
      } catch {
        return;
      }
    }
  }

  private dispatchRequest(raw: unknown): void {
    if (this.requestTasks.size >= MAX_TRACKED_PROVIDER_INTERACTIONS) {
      // Force snapshot reconciliation instead of silently dropping an
      // authoritative request event when the bounded worker set is full.
      console.warn("[build-pipeline] OpenCode request worker limit reached");
      this.activeStreamController?.abort();
      return;
    }
    const task = this.handleRequest(raw)
      .catch((error) => {
        if (this.disposed || this.monitorController.signal.aborted) return;
        console.warn(
          "[build-pipeline] OpenCode request handling failed:",
          error instanceof Error ? error.name : "unknown error",
        );
        this.activeStreamController?.abort();
      })
      .finally(() => {
        this.requestTasks.delete(task);
      });
    this.requestTasks.add(task);
  }

  private async handleRequest(raw: unknown): Promise<void> {
    const event = raw && typeof raw === "object"
      ? raw as { type?: unknown; properties?: Record<string, unknown> }
      : {};
    const properties = event.properties ?? {};
    const requestId = typeof properties.id === "string"
      ? properties.id
      : undefined;
    const sessionId = typeof properties.sessionID === "string"
      ? properties.sessionID
      : undefined;
    if (!sessionId || !this.ownedSessions.has(sessionId)) return;
    if (requestId && requestId.length > AGENT_INTERACTION_LIMITS.maxIdLength) return;

    const observedKind: AgentInteractionKind | null = event.type === "permission.asked"
      ? "permission"
      : event.type === "question.asked"
        ? "question"
        : null;

    const observe = async (
      state: ProviderInteractionObservationEvent["state"],
      providerState?: ProviderInteractionObservationEvent["providerState"],
    ): Promise<void> => {
      if (!requestId || !observedKind) return;
      await this.onInteractionObservation?.({
        sessionId,
        interactionId: requestId,
        kind: observedKind,
        registration: this.interactionTracker.registration(sessionId),
        state,
        providerState,
      });
    };

    // An answered question releases the session. A rejected question is no
    // longer pending/user-resolvable, so it is terminal for an unattended
    // pipeline rather than a permanent `blocked` state that the supervisor
    // would park forever.
    if (event.type === "question.replied") {
      this.blockedSessions.delete(sessionId);
      this.failedQuestionSessions.delete(sessionId);
      return;
    }
    if (event.type === "question.rejected") {
      this.blockedSessions.delete(sessionId);
      setBoundedSetEntry(
        this.failedQuestionSessions,
        sessionId,
        MAX_TRACKED_INTERACTION_SESSIONS,
      );
      return;
    }
    if (!this.autoAnswerRequests) return;
    if (!requestId || this.answeringRequestIds.has(requestId)) return;

    this.answeringRequestIds.add(requestId);
    try {
      if (event.type === "permission.asked") {
        await observe("detected").catch(() => undefined);
        const response = await this.client.permission.reply({
          requestID: requestId,
          directory: this.connection.directory,
          reply: "reject",
        }, this.requestOptions());
        assertSdkResponse(response, "OpenCode permission response");
        await observe("withdrawn", "error").catch(() => undefined);
      } else if (event.type === "question.asked") {
        // The owner persists the fail-closed terminal outcome before the
        // upstream question is removed. If persistence fails, leave the
        // request pending so a restart cannot silently advance the workflow.
        this.blockedSessions.add(sessionId);
        await observe("detected");
        try {
          const response = await this.client.question.reject({
            requestID: requestId,
            directory: this.connection.directory,
          }, this.requestOptions());
          assertSdkResponse(response, "OpenCode question rejection");
          this.blockedSessions.delete(sessionId);
          setBoundedSetEntry(
            this.failedQuestionSessions,
            sessionId,
            MAX_TRACKED_INTERACTION_SESSIONS,
          );
          await observe("withdrawn", "error").catch(() => undefined);
        } catch (error) {
          // The request may still be live and user-resolvable. Keep it blocked;
          // the reconnect/reconciliation loop will retry the fail-closed reject.
          throw error;
        }
      }
    } finally {
      this.answeringRequestIds.delete(requestId);
    }
  }

  private async reconcilePendingRequests(): Promise<void> {
    if (!this.reconciliation) {
      this.reconciliation = this.reconcilePendingRequestsNow()
        .finally(() => {
          this.reconciliation = null;
        });
    }
    return this.reconciliation;
  }

  private async reconcilePendingRequestsNow(): Promise<void> {
    if (this.disposed || this.ownedSessions.size === 0) return;
    const [permissions, questions] = await Promise.all([
      this.client.permission.list(
        { directory: this.connection.directory },
        this.requestOptions(),
      ),
      this.client.question.list(
        { directory: this.connection.directory },
        this.requestOptions(),
      ),
    ]);
    assertSdkResponse(permissions, "OpenCode pending permission read");
    assertSdkResponse(questions, "OpenCode pending question read");
    const pendingPermissions = boundedOwnedOpenCodeCollection(
      permissions.data,
      this.ownedSessions,
      "OpenCode pending permission read",
    );
    const pendingQuestions = boundedOwnedOpenCodeCollection(
      questions.data,
      this.ownedSessions,
      "OpenCode pending question read",
    );
    if (
      serializedByteLength([pendingPermissions, pendingQuestions])
        > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
    ) {
      throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
    }
    for (const request of pendingPermissions) {
      await this.handleRequest({ type: "permission.asked", properties: request });
    }
    for (const request of pendingQuestions) {
      await this.handleRequest({ type: "question.asked", properties: request });
    }
  }

  async createSession(
    _phase: PipelineSessionPhase,
    label: string,
    _options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    try {
      const response = await this.client.session.create(
        { title: label },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode session creation");
      if (!response.data?.id) throw new Error("OpenCode returned an empty session");
      this.rememberExistingSession(response.data.id);
      this.registerSession(response.data.id, _options.interaction);
      return response.data.id;
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode session creation is unavailable", {
        cause: error,
      });
    }
  }

  async send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void> {
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    // OpenCode accepts inline data, so its images need no staging. Attachments
    // that arrive already staged are referenced by path instead.
    for (const image of options.images ?? []) {
      parts.push({
        type: "file",
        mime: mimeTypeForFilename(image.filename),
        filename: image.filename,
        url: `data:${mimeTypeForFilename(image.filename)};base64,${image.data}`,
      });
    }
    for (const attachment of options.attachments ?? []) {
      parts.push({
        type: "file",
        mime: mimeTypeForFilename(attachment.filename ?? attachment.path),
        filename: attachment.filename,
        url: promptAttachmentUrl(attachment),
      });
    }
    const modelParts = (options.model ?? this.connection.model)?.split("/");
    // Validate and encode before entering the ambiguous-dispatch catch. A local
    // validation failure is definitive and must not be retried as though the
    // prompt might have reached OpenCode.
    const messageID = openCodeMessageId(options.requestId);
    let response;
    try {
      response = await this.client.session.promptAsync({
        sessionID: sessionId,
        directory: this.connection.directory,
        messageID,
        parts: parts as never,
        model: modelParts && modelParts.length > 1
          ? { providerID: modelParts[0]!, modelID: modelParts.slice(1).join("/") }
          : undefined,
        agent: options.mode ?? "build",
        variant: options.effort ?? this.connection.effort,
        format: options.schema
          ? { type: "json_schema", schema: options.schema, retryCount: 2 }
          : undefined,
      }, this.requestOptions());
    } catch (error) {
      // The request may have reached OpenCode before the response was lost.
      // The durable message ID lets the supervisor reconcile and safely retry.
      throw new AmbiguousPromptDispatchError(
        "OpenCode prompt dispatch outcome is unknown",
        { cause: error },
      );
    }
    if ("error" in response && response.error) {
      const status = response.response?.status;
      if (
        status === 404
        || status === 409
        || (status !== undefined && isTransientHttpStatus(status))
      ) {
        throw new ProviderUnavailableError(
          `OpenCode prompt dispatch is temporarily unavailable (HTTP ${status})`,
        );
      }
      throw new PromptRejectedError("OpenCode rejected the prompt");
    }
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    if (this.blockedSessions.has(sessionId)) return "blocked";
    if (this.failedQuestionSessions.has(sessionId)) return "error";
    try {
      const lifecycle = (
        await this.readSessionLifecycle([sessionId], false, true)
      ).get(sessionId);
      if (!lifecycle) {
        throw new Error(`OpenCode lifecycle snapshot omitted ${sessionId}`);
      }
      if (lifecycle === "running") return "running";
      if (lifecycle === "idle" || lifecycle === "missing") return lifecycle;
      return "error";
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode status is unavailable", {
        cause: error,
      });
    }
  }

  async activity(sessionId: string): Promise<ProviderActivityState> {
    const activity = await this.activityBatch([sessionId]);
    const state = activity.get(sessionId);
    // `activityBatch` answers for every id it is given, so a gap is a broken
    // provider rather than a missing session. Defaulting to `missing` here
    // would turn that bug into a deleted session mapping.
    if (!state) {
      throw new ProviderUnavailableError(
        `OpenCode activity snapshot omitted ${sessionId}`,
      );
    }
    return state;
  }

  async activityBatch(
    sessionIds: readonly string[],
  ): Promise<Map<string, ProviderActivityState>> {
    try {
      const activity = new Map<string, ProviderActivityState>();
      const sessionIdsToRead = [...new Set(sessionIds)].filter((sessionId) => {
        if (!this.blockedSessions.has(sessionId)) return true;
        // A blocked session asked a question this provider will not answer, so
        // it is parked on a human. `status()` calls that `error` because a
        // pipeline must stop advancing on it; for the sidebar the honest
        // answer is `waiting`. `idle` is the one answer that is certainly
        // wrong — it retires the indicator on a turn nobody has resolved.
        activity.set(sessionId, "waiting");
        return false;
      });
      if (sessionIdsToRead.length === 0) return activity;

      const lifecycle = await this.readSessionLifecycle(sessionIdsToRead, true);

      const runningSessionIds = new Set<string>();
      for (const sessionId of sessionIdsToRead) {
        const state = lifecycle.get(sessionId);
        if (state === "missing") {
          activity.set(sessionId, "missing");
        } else if (state === "running") {
          runningSessionIds.add(sessionId);
        } else if (state) {
          activity.set(sessionId, "idle");
        } else {
          throw new ProviderUnavailableError(
            `OpenCode lifecycle snapshot omitted ${sessionId}`,
          );
        }
      }
      if (runningSessionIds.size === 0) return activity;

      const [questions, permissions] = await Promise.all([
        this.client.question.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
        this.client.permission.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
      ]);
      assertSdkResponse(questions, "OpenCode pending question read");
      assertSdkResponse(permissions, "OpenCode pending permission read");
      const pendingQuestions = boundedOwnedOpenCodeCollection(
        questions.data,
        runningSessionIds,
        "OpenCode pending question read",
      );
      const pendingPermissions = boundedOwnedOpenCodeCollection(
        permissions.data,
        runningSessionIds,
        "OpenCode pending permission read",
      );
      if (
        serializedByteLength([pendingQuestions, pendingPermissions])
          > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
      ) {
        throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
      }
      const waitingSessionIds = new Set<string>();
      for (const request of [
        ...pendingQuestions,
        ...pendingPermissions,
      ]) {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          continue;
        }
        const sessionId = (request as { sessionID?: unknown }).sessionID;
        if (typeof sessionId === "string" && runningSessionIds.has(sessionId)) {
          waitingSessionIds.add(sessionId);
        }
      }
      for (const sessionId of runningSessionIds) {
        activity.set(
          sessionId,
          waitingSessionIds.has(sessionId) ? "waiting" : "working",
        );
      }
      return activity;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError("OpenCode activity is unavailable", {
        cause: error,
      });
    }
  }

  /**
   * Combine OpenCode's incremental activity map with bounded, authoritative
   * existence reads for entries the activity map omits.
   *
   * A short-lived session-list snapshot is the cheap common path. OpenCode's
   * `start` query is a timestamp lower bound, not an offset, so a full page
   * cannot be paginated. Targets unresolved by that page are probed directly
   * with session.get instead; only a direct 404 may manufacture `missing`.
   */
  private async readSessionLifecycle(
    sessionIds: readonly string[],
    tolerateExistenceFailure = false,
    strongExistenceRead = false,
  ): Promise<Map<string, OpenCodeSessionLifecycleState>> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    for (const sessionId of uniqueSessionIds) {
      if (
        sessionId.length === 0
        || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
      ) {
        throw new ProviderUnavailableError(
          "OpenCode lifecycle read contains a malformed identity",
        );
      }
    }
    const lifecycle = new Map<string, OpenCodeSessionLifecycleState>();
    if (uniqueSessionIds.length === 0) return lifecycle;

    const statusResponse = await this.client.session.status(
      { directory: this.connection.directory },
      this.requestOptions(),
    );
    assertSdkResponse(statusResponse, "OpenCode status read");
    const statusSnapshot = boundedOpenCodeStatusSnapshot(
      statusResponse.data,
      new Set(uniqueSessionIds),
    );
    const omittedSessionIds: string[] = [];
    for (const sessionId of uniqueSessionIds) {
      const status = statusSnapshot[sessionId];
      if (!status) {
        omittedSessionIds.push(sessionId);
      } else if (status.type === "busy" || status.type === "retry") {
        lifecycle.set(sessionId, "running");
      } else if (status.type === "idle") {
        lifecycle.set(sessionId, "idle");
      } else {
        lifecycle.set(sessionId, "unknown");
      }
    }
    if (omittedSessionIds.length === 0) return lifecycle;

    const existence = await this.resolveSessionExistence(
      omittedSessionIds,
      strongExistenceRead,
    );
    for (const sessionId of omittedSessionIds) {
      const probe = existence.get(sessionId);
      if (probe?.state === "exists") {
        lifecycle.set(sessionId, "idle");
      } else if (probe?.state === "missing") {
        lifecycle.set(sessionId, "missing");
      } else if (tolerateExistenceFailure) {
        // An omitted status-map entry is not running. When existence cannot be
        // confirmed, retaining the durable mapping as idle is safer than
        // dropping it or withholding already-resolved busy sessions.
        lifecycle.set(sessionId, "unknown");
      } else {
        throw new ProviderUnavailableError(
          `OpenCode session existence is unavailable for ${sessionId}`,
          { cause: probe?.error },
        );
      }
    }
    return lifecycle;
  }

  private async resolveSessionExistence(
    sessionIds: readonly string[],
    strong: boolean,
  ): Promise<Map<string, OpenCodeExistenceProbe>> {
    const result = new Map<string, OpenCodeExistenceProbe>();
    const unresolved: string[] = [];
    const now = this.now();
    for (const sessionId of sessionIds) {
      if (strong) {
        unresolved.push(sessionId);
        continue;
      }
      const cached = this.sessionExistenceCache.get(sessionId);
      if (cached !== undefined && cached > now) {
        result.set(sessionId, { state: "exists" });
      } else if ((this.sessionExistenceRetryAt.get(sessionId) ?? 0) > now) {
        result.set(sessionId, { state: "unknown" });
      } else {
        if (cached !== undefined) this.sessionExistenceCache.delete(sessionId);
        this.sessionExistenceRetryAt.delete(sessionId);
        unresolved.push(sessionId);
      }
    }
    if (unresolved.length === 0) return result;

    let directlyProbed = unresolved;
    if (!strong) {
      try {
        const snapshot = await this.readCachedSessionList();
        directlyProbed = [];
        for (const sessionId of unresolved) {
          if (snapshot.sessionIds.has(sessionId)) {
            this.rememberExistingSession(sessionId);
            result.set(sessionId, { state: "exists" });
          } else {
            directlyProbed.push(sessionId);
          }
        }
      } catch {
        // A directory-wide optimization failing says nothing about any one
        // target. Exact reads below remain authoritative and isolated.
      }
    }

    const probeCount = strong
      ? directlyProbed.length
      : Math.min(OPENCODE_EXISTENCE_PROBE_CONCURRENCY, directlyProbed.length);
    const probeStart = directlyProbed.length === 0
      ? 0
      : this.existenceProbeCursor % directlyProbed.length;
    const scheduledProbes = Array.from(
      { length: probeCount },
      (_, index) => directlyProbed[(probeStart + index) % directlyProbed.length]!,
    );
    if (!strong && directlyProbed.length > 0) {
      this.existenceProbeCursor = (probeStart + probeCount) % directlyProbed.length;
      const scheduled = new Set(scheduledProbes);
      for (const sessionId of directlyProbed) {
        if (!scheduled.has(sessionId)) result.set(sessionId, { state: "unknown" });
      }
    }

    let nextSession = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const sessionId = scheduledProbes[nextSession++];
        if (!sessionId) return;
        const probe = await this.probeSessionExistence(sessionId);
        if (!strong && probe.state === "unknown") {
          setBoundedMapEntry(
            this.sessionExistenceRetryAt,
            sessionId,
            this.now() + this.existenceCacheTtlMs,
            MAX_TRACKED_PROVIDER_INTERACTIONS,
          );
        }
        result.set(sessionId, probe);
      }
    };
    await Promise.all(Array.from(
      {
        length: Math.min(
          OPENCODE_EXISTENCE_PROBE_CONCURRENCY,
          scheduledProbes.length,
        ),
      },
      () => worker(),
    ));
    return result;
  }

  private async readCachedSessionList(): Promise<OpenCodeExistenceSnapshot> {
    const now = this.now();
    if (this.sessionListCache && this.sessionListCache.expiresAt > now) {
      return this.sessionListCache.snapshot;
    }
    if (this.sessionListFailure && this.sessionListFailure.expiresAt > now) {
      throw this.sessionListFailure.error;
    }
    if (this.sessionListRead) return this.sessionListRead;

    const read = (async () => {
      try {
        const response = await this.client.session.list(
          {
            directory: this.connection.directory,
            limit: MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS,
          },
          this.requestOptions(),
        );
        assertSdkResponse(response, "OpenCode session list");
        const snapshot = boundedOpenCodeExistenceSnapshot(response.data);
        this.sessionListCache = {
          snapshot,
          expiresAt: this.now() + this.existenceCacheTtlMs,
        };
        this.sessionListFailure = null;
        return snapshot;
      } catch (error) {
        this.sessionListFailure = {
          error,
          expiresAt: this.now() + this.existenceCacheTtlMs,
        };
        throw error;
      }
    })().finally(() => {
      if (this.sessionListRead === read) this.sessionListRead = null;
    });
    this.sessionListRead = read;
    return read;
  }

  private async probeSessionExistence(
    sessionId: string,
  ): Promise<OpenCodeExistenceProbe> {
    try {
      const response = await this.client.session.get(
        { sessionID: sessionId, directory: this.connection.directory },
        this.requestOptions(),
      );
      if (response.error) {
        if (response.response?.status === 404) {
          this.sessionExistenceCache.delete(sessionId);
          this.sessionExistenceRetryAt.delete(sessionId);
          this.sessionListCache?.snapshot.sessionIds.delete(sessionId);
          return { state: "missing" };
        }
        assertSdkResponse(response, "OpenCode session existence read");
      }
      const session = asRecord(response.data);
      if (
        nonEmptyString(session?.id) !== sessionId
        || (
          this.connection.directory !== undefined
          && nonEmptyString(session?.directory) !== this.connection.directory
        )
        || serializedByteLength(response.data) > MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES
      ) {
        throw new ProviderUnavailableError(
          "OpenCode session existence read is malformed or oversized",
        );
      }
      this.rememberExistingSession(sessionId);
      return { state: "exists" };
    } catch (error) {
      return { state: "unknown", error };
    }
  }

  private rememberExistingSession(sessionId: string): void {
    setBoundedMapEntry(
      this.sessionExistenceCache,
      sessionId,
      this.now() + this.existenceCacheTtlMs,
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    this.sessionExistenceRetryAt.delete(sessionId);
  }

  private openCodeInteractionId(
    sessionId: string,
    category: "question" | "permission",
    id: string,
  ): string {
    const interactionId = `opencode:${category}:${encodeURIComponent(sessionId)}:${id}`;
    if (interactionId.length > AGENT_INTERACTION_LIMITS.maxIdLength) {
      throw new ProviderUnavailableError(
        "OpenCode returned an oversized interaction identity",
      );
    }
    return interactionId;
  }

  private mapOpenCodeQuestion(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const rawSessionId = nonEmptyString(request?.sessionID)
      ?? nonEmptyString(request?.sessionId);
    const questions = request?.questions;
    if (
      !providerRequestId
      || rawSessionId !== sessionId
      || !Array.isArray(questions)
      || questions.length === 0
      || questions.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest
    ) {
      throw new ProviderUnavailableError("OpenCode returned a malformed question request");
    }
    const presentationQuestions: AgentInteractionQuestion[] = questions.map(
      (entry, questionIndex) => {
        const question = asRecord(entry);
        const options = question?.options;
        const prompt = nonEmptyString(question?.question);
        if (
          !question
          || !prompt
          || !Array.isArray(options)
          || options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
        ) {
          throw new ProviderUnavailableError("OpenCode returned a malformed question request");
        }
        return {
          id: `q${questionIndex}`,
          prompt: boundedText(prompt, prompt),
          description: nonEmptyString(question.header) ?? undefined,
          required: true,
          multiple: question.multiple === true,
          secret: false,
          allowFreeText: question.custom !== false,
          options: options.map((entry, optionIndex) => {
            const option = asRecord(entry);
            const label = nonEmptyString(option?.label);
            if (!option || !label) {
              throw new ProviderUnavailableError(
                "OpenCode returned a malformed question option",
              );
            }
            return {
              id: opaqueOptionId(questionIndex, optionIndex),
              label: boundedText(label, label),
              providerValue: boundedText(
                label,
                label,
                AGENT_INTERACTION_LIMITS.maxProviderValueLength,
              ),
              description: nonEmptyString(option?.description) ?? undefined,
            };
          }),
        };
      },
    );
    const id = this.openCodeInteractionId(sessionId, "question", providerRequestId);
    setBoundedMapEntry(
      this.providerInteractionIds,
      id,
      { providerRequestId, sessionId, actionable: true },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    const createdAt = this.interactionTracker.firstSeen(id);
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id,
      provider: "opencode",
      kind: "question",
      origin: this.interactionTracker.registration(sessionId).origin,
      sessionId,
      state: "pending",
      revision: 0,
      presentation: { title: "OpenCode needs input", questions: presentationQuestions },
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapOpenCodePermission(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const rawSessionId = nonEmptyString(request?.sessionID)
      ?? nonEmptyString(request?.sessionId);
    const permission = nonEmptyString(request?.permission)
      ?? nonEmptyString(request?.action);
    const patterns = boundedStringArray(request?.patterns, "permission patterns");
    if (!providerRequestId || rawSessionId !== sessionId || !permission) {
      throw new ProviderUnavailableError("OpenCode returned a malformed permission request");
    }
    const actionable = patterns.length > 0;
    const id = this.openCodeInteractionId(sessionId, "permission", providerRequestId);
    setBoundedMapEntry(
      this.providerInteractionIds,
      id,
      { providerRequestId, sessionId, actionable },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    const createdAt = this.interactionTracker.firstSeen(id);
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id,
      provider: "opencode",
      kind: "permission",
      origin: this.interactionTracker.registration(sessionId).origin,
      sessionId,
      state: "pending",
      revision: 0,
      presentation: {
        title: "Approve OpenCode permission",
        body: boundedJoinedText([
          `Permission: ${boundedText(permission, "Permission requested")}`,
          ...patterns.map((pattern) => `Resource: ${pattern}`),
          ...(!actionable ? ["Permission is missing its resource scope."] : []),
        ]),
        questions: [],
        confirmLabel: "Approve once",
        declineLabel: "Deny",
      },
      createdAt,
      updatedAt: createdAt,
    };
  }

  private async listPendingInteractions(
    sessionId: string,
  ): Promise<AgentInteractionSnapshot> {
    try {
      const [questionsResponse, permissionsResponse] = await Promise.all([
        this.client.question.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
        this.client.permission.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
      ]);
      assertSdkResponse(questionsResponse, "OpenCode pending question read");
      assertSdkResponse(permissionsResponse, "OpenCode pending permission read");
      const ownedSessionIds = new Set([sessionId]);
      const questions = boundedOwnedOpenCodeCollection(
        questionsResponse.data,
        ownedSessionIds,
        "OpenCode pending question read",
      );
      const permissions = boundedOwnedOpenCodeCollection(
        permissionsResponse.data,
        ownedSessionIds,
        "OpenCode pending permission read",
      );
      if (
        serializedByteLength([questions, permissions])
          > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
      ) {
        throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
      }
      if (questions.length + permissions.length
        > AGENT_INTERACTION_LIMITS.maxPendingRequests) {
        throw new ProviderUnavailableError("OpenCode returned too many interactions");
      }
      const snapshot = this.interactionTracker.snapshot(sessionId, [
        ...questions.map((request) => this.mapOpenCodeQuestion(sessionId, request)),
        ...permissions.map((request) => this.mapOpenCodePermission(sessionId, request)),
      ]);
      const currentIds = new Set(snapshot.requests.map((request) => request.id));
      for (const [interactionId, identity] of this.providerInteractionIds) {
        if (identity.sessionId === sessionId && !currentIds.has(interactionId)) {
          this.providerInteractionIds.delete(interactionId);
        }
      }
      return snapshot;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError("OpenCode interactions are unavailable", {
        cause: error,
      });
    }
  }

  private async resolveInteraction(
    sessionId: string,
    interactionId: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome> {
    const knownSession = this.interactionTracker.sessionFor(interactionId);
    if (knownSession !== undefined && knownSession !== sessionId) {
      return outcome("rejected", sessionId, interactionId, 0);
    }
    const snapshot = await this.listPendingInteractions(sessionId);
    const request = snapshot.requests.find((candidate) => candidate.id === interactionId);
    if (!request) return outcome("stale", sessionId, interactionId, snapshot.revision);
    if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) {
      return outcome("stale", sessionId, interactionId, snapshot.revision);
    }
    if (!isAgentInteractionResolution(resolution, request)) {
      return outcome("rejected", sessionId, interactionId, snapshot.revision);
    }
    if (this.resolvingInteractions.has(interactionId)) {
      return outcome("already-resolved", sessionId, interactionId, snapshot.revision);
    }
    const identity = this.providerInteractionIds.get(interactionId);
    if (!identity) {
      return outcome("stale", sessionId, interactionId, snapshot.revision);
    }
    if (resolution.action === "answer" && identity.actionable === false) {
      return outcome("rejected", sessionId, interactionId, snapshot.revision);
    }
    const providerRequestId = identity.providerRequestId;
    this.resolvingInteractions.add(interactionId);
    try {
      let response: { error?: unknown };
      try {
        if (request.kind === "question") {
          if (resolution.action === "answer") {
            const byQuestion = new Map(
              resolution.answer!.answers.map((answer) => [answer.questionId, answer]),
            );
            const answers = request.presentation.questions.map((question) => {
              const answer = byQuestion.get(question.id)!;
              const optionValues = new Map(
                question.options.map((option) => [option.id, option.providerValue]),
              );
              return [
                ...(answer.optionIds ?? []).map((id) => optionValues.get(id)!),
                ...(answer.freeText === undefined ? [] : [answer.freeText]),
              ];
            });
            response = await this.client.question.reply({
              requestID: providerRequestId,
              directory: this.connection.directory,
              answers,
            }, this.requestOptions());
          } else {
            response = await this.client.question.reject({
              requestID: providerRequestId,
              directory: this.connection.directory,
            }, this.requestOptions());
          }
        } else {
          response = await this.client.permission.reply({
            requestID: providerRequestId,
            directory: this.connection.directory,
            reply: resolution.action === "answer" ? "once" : "reject",
          }, this.requestOptions());
        }
        assertSdkResponse(response, "OpenCode interaction response");
      } catch {
        const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
        if (reconciled && !reconciled.requests.some((item) => item.id === interactionId)) {
          return outcome("applied", sessionId, interactionId, reconciled.revision);
        }
        return outcome("provider-unavailable", sessionId, interactionId, snapshot.revision);
      }
      const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
      if (!reconciled) {
        return outcome(
          "provider-unavailable",
          sessionId,
          interactionId,
          snapshot.revision,
        );
      }
      return outcome(
        reconciled.requests.some((item) => item.id === interactionId)
          ? "provider-unavailable"
          : "applied",
        sessionId,
        interactionId,
        reconciled.revision,
      );
    } finally {
      this.resolvingInteractions.delete(interactionId);
    }
  }

  async messages(sessionId: string): Promise<unknown[]> {
    try {
      const response = await this.client.session.messages(
        { sessionID: sessionId },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode transcript read");
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode transcript is unavailable", {
        cause: error,
      });
    }
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    const providerMessageId = openCodeMessageId(requestId);
    let response;
    try {
      response = await this.client.session.messages(
        { sessionID: sessionId },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode structured-output read");
    } catch (error) {
      throw new ProviderUnavailableError(
        "OpenCode structured output is unavailable",
        { cause: error },
      );
    }
    if (!Array.isArray(response.data)) return null;
    const assistant = [...response.data].reverse().find((entry) => {
      const info = entry.info as { role?: unknown; parentID?: unknown };
      return info.role === "assistant" && info.parentID === providerMessageId;
    });
    if (!assistant) return null;
    const info = assistant.info as {
      error?: unknown;
      structured?: unknown;
      time?: { completed?: unknown };
    };
    if (!info.time?.completed) return null;
    if (info.error || info.structured === undefined) {
      return {
        ok: false,
        provider: "opencode",
        requestId,
        error: {
          code: "provider_error",
          message: "OpenCode did not produce a structured result",
          provider: "opencode",
          retryable: true,
        },
      };
    }
    return {
      ok: true,
      provider: "opencode",
      requestId,
      value: info.structured as T,
    };
  }

  async abort(sessionId: string): Promise<void> {
    try {
      const response = await this.client.session.abort(
        { sessionID: sessionId },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode abort");
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode abort is unavailable", {
        cause: error,
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.monitorController.abort();
    this.activeStreamController?.abort();
    await this.monitorPromise;
    await Promise.allSettled([...this.requestTasks]);
    this.ownedSessions.clear();
    this.blockedSessions.clear();
    this.failedQuestionSessions.clear();
    this.answeringRequestIds.clear();
    this.requestTasks.clear();
    this.sessionExistenceCache.clear();
    this.sessionExistenceRetryAt.clear();
    this.sessionListCache = null;
    this.sessionListFailure = null;
  }

  private requestOptions(): { signal: AbortSignal } {
    const timeoutMs = Math.max(
      1,
      this.connection.requestTimeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS,
    );
    return {
      signal: AbortSignal.any([
        this.monitorController.signal,
        AbortSignal.timeout(timeoutMs),
      ]),
    };
  }
}

function assertSdkResponse(
  response: { error?: unknown },
  operation: string,
): void {
  if (response.error) {
    throw new Error(`${operation} failed`);
  }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createBuildPipelineProvider(
  connection: BridgeConnection,
  dependencies: ProviderDependencies = {},
): BuildPipelineProvider {
  return connection.agent === "opencode"
    ? new OpenCodeProvider(connection, dependencies)
    : new HttpBridgeProvider(
        connection,
        dependencies.fetch ?? fetch,
        dependencies.stageImages,
      );
}

export type { BridgeConnection };
