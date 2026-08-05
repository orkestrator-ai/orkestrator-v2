import type { NativeMessage, NativeMessagePart } from "./chat/native-message-types";
import type { ContextUsageSnapshot } from "./context-usage";
import { resolveGatewayLoopbackBaseUrl } from "./gateway-url";
import { parseBackendTurnStartedAt } from "./session-timer";
import {
  isStructuredOutputResult,
  structuredOutputFailure,
  type JsonSchema,
  type StructuredOutputResult,
  StructuredOutputReadUnavailableError,
} from "@orkestrator/protocol/structured-output";

export interface CodexReasoningOption {
  effort: CodexReasoningEffort;
  label: string;
  description?: string;
}

export interface CodexModel {
  id: string;
  name: string;
  description?: string;
  reasoningEfforts?: CodexReasoningEffort[];
  reasoningOptions?: CodexReasoningOption[];
  defaultReasoningEffort?: CodexReasoningEffort;
}

export interface CodexSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  source: "prompt" | "builtin";
}

export const CODEX_MODELS: CodexModel[] = [
  {
    id: "gpt-5.4",
    name: "gpt-5.4",
    description: "Latest frontier agentic coding model.",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4-Mini",
    description: "Smaller frontier agentic coding model.",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
];

export const DEFAULT_CODEX_MODEL = CODEX_MODELS[0]!.id;
export type CodexReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
export type CodexConversationMode = "build" | "plan";

/**
 * Where the catalog came from. `app-server` is authoritative (`model/list` on the
 * live binary); `cache` is the bridge's persisted copy; `fallback` is the
 * hardcoded catalog used when the engine cannot answer at all.
 */
export type CodexModelSource = "app-server" | "cache" | "fallback";

interface CodexModelsResponse {
  models: CodexModel[];
  source: CodexModelSource;
}

interface CodexSlashCommandsResponse {
  commands: CodexSlashCommand[];
}

interface CodexSessionListResponse {
  sessions: CodexStoredSession[];
}

/**
 * Detailed lifecycle phase, available on the app-server engine.
 *
 * `status` stays the three-state contract every existing caller reads.
 * `cancelling` and `recovering` both report `status: "running"` on purpose: a turn
 * in either phase may still be executing, so treating them as idle would let the
 * build pipeline advance a phase or a tab start an overlapping prompt.
 */
export type CodexSessionPhase =
  | "starting"
  | "running"
  | "cancelling"
  | "recovering"
  | "idle"
  | "failed";

const CODEX_SESSION_PHASES = new Set<CodexSessionPhase>([
  "starting",
  "running",
  "cancelling",
  "recovering",
  "idle",
  "failed",
]);

export function isCodexSessionPhase(value: unknown): value is CodexSessionPhase {
  return typeof value === "string" && CODEX_SESSION_PHASES.has(value as CodexSessionPhase);
}

interface CodexSessionStatusResponse {
  status: "idle" | "running" | "error";
  phase?: CodexSessionPhase;
  title?: string;
  error?: string;
  threadId?: string | null;
  turnId?: string;
  turnStartedAt?: string;
  requestId?: string;
  engineGeneration?: number;
  messageRevision?: number;
  structuredOutputRequestId?: string;
  structuredOutput?: StructuredOutputResult;
  contextUsage?: ContextUsageSnapshot;
  unconfirmedDispatch?: { requestId: string; retryable: boolean };
}

export interface CodexClient {
  baseUrl: string;
  authToken?: string;
}

export interface CodexMessage {
  id: string;
  role: NativeMessage["role"];
  content: string;
  parts: NativeMessagePart[];
  createdAt: string;
  /** Model confirmed by the Codex app-server/rollout for this turn. */
  modelId?: string;
  planReview?: boolean;
  turnId?: string;
  /** Monotonic per-message revision for sparse streaming patches. */
  revision?: number;
}

export interface CodexMessagePatch {
  messageId: string;
  partCount: number;
  changedParts: { index: number; part: NativeMessagePart }[];
  content: string;
  createdAt: string;
  turnId?: string;
  revision: number;
}

export type CodexMessagePatchResult =
  | { outcome: "applied"; message: CodexMessage }
  | { outcome: "stale" }
  | { outcome: "needs-reconcile" };

/**
 * Classifies a sparse patch without conflating an already-applied replay with a
 * real revision gap. Callers may safely ignore `stale`; only
 * `needs-reconcile` requires an authoritative transcript read.
 */
export function classifyCodexMessagePatch(
  message: CodexMessage,
  patch: CodexMessagePatch,
): CodexMessagePatchResult {
  if (!patch || typeof patch !== "object" || !Array.isArray(patch.changedParts)) {
    return { outcome: "needs-reconcile" };
  }
  if (
    patch.messageId !== message.id
    || !Number.isInteger(patch.partCount)
    || patch.partCount < 0
    || !Number.isInteger(patch.revision)
  ) {
    return { outcome: "needs-reconcile" };
  }
  const baseRevision = message.revision;
  if (!Number.isInteger(baseRevision)) return { outcome: "needs-reconcile" };
  if (patch.revision <= (baseRevision as number)) return { outcome: "stale" };
  if (patch.revision !== (baseRevision as number) + 1) {
    return { outcome: "needs-reconcile" };
  }

  const parts = message.parts.slice();
  for (const change of patch.changedParts) {
    if (
      !change
      || !Number.isInteger(change.index)
      || change.index < 0
      || change.index >= patch.partCount
      || !change.part
      || typeof change.part !== "object"
    ) {
      return { outcome: "needs-reconcile" };
    }
    parts[change.index] = change.part;
  }
  parts.length = patch.partCount;
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index]) return { outcome: "needs-reconcile" };
  }
  return {
    outcome: "applied",
    message: {
      ...message,
      parts,
      content: typeof patch.content === "string" ? patch.content : message.content,
      createdAt: typeof patch.createdAt === "string" && patch.createdAt
        ? patch.createdAt
        : message.createdAt,
      turnId: typeof patch.turnId === "string" ? patch.turnId : message.turnId,
      revision: patch.revision,
    },
  };
}

export function applyCodexMessagePatch(
  message: CodexMessage,
  patch: CodexMessagePatch,
): CodexMessage | null {
  const result = classifyCodexMessagePatch(message, patch);
  return result.outcome === "applied" ? result.message : null;
}

/**
 * Keeps the locally-held copy of a message when it is strictly newer.
 *
 * A transcript read that deliberately does not block the event stream can land
 * *after* live frames have already advanced a message. Applying the snapshot
 * verbatim would roll those frames back, so the higher revision wins per
 * message and the snapshot supplies everything else. Messages absent from the
 * snapshot are deliberately not resurrected: the snapshot is authoritative
 * about which messages exist, and a compaction or fork must be able to remove
 * one.
 */
export function preferNewerCodexRevisions(
  incoming: CodexMessage[],
  local: readonly CodexMessage[] | undefined,
): CodexMessage[] {
  if (!local?.length) return incoming;
  const localById = new Map(local.map((message) => [message.id, message]));
  let replaced = false;
  const merged = incoming.map((message) => {
    const current = localById.get(message.id);
    if (
      !current
      || !Number.isInteger(current.revision)
      || !Number.isInteger(message.revision)
      || (current.revision as number) <= (message.revision as number)
    ) {
      return message;
    }
    replaced = true;
    return current;
  });
  return replaced ? merged : incoming;
}

export interface CodexSession {
  sessionId: string;
  title?: string;
}

export interface CodexStoredSession {
  id: string;
  title?: string;
  updatedAt: string;
}

export interface CodexSessionStatus {
  status: "idle" | "running" | "error";
  /** Absent on older bridges that do not report a phase. */
  phase?: CodexSessionPhase;
  title?: string;
  error?: string;
  threadId?: string | null;
  turnId?: string;
  /** Backend-authoritative epoch milliseconds for the active turn. */
  turnStartedAt?: number;
  /** The prompt request id this turn is executing, for reconnect reconciliation. */
  requestId?: string;
  engineGeneration?: number;
  /** Monotonic transcript revision used to avoid unchanged full-message reads. */
  messageRevision?: number;
  structuredOutputRequestId?: string;
  structuredOutput?: StructuredOutputResult;
  contextUsage?: ContextUsageSnapshot;
  unconfirmedDispatch?: { requestId: string; retryable: boolean };
}

export type CodexSessionStatusLookupResult =
  | { kind: "found"; session: CodexSessionStatus }
  | { kind: "missing" }
  | { kind: "unavailable"; error: Error };

export interface CodexPromptAttachment {
  type: "image";
  path: string;
  dataUrl?: string;
  filename?: string;
}

export interface CodexEvent {
  type:
    | "connected"
    | "keepalive"
    | "bridge.cursor"
    | "session.updated"
    | "session.idle"
    | "session.error"
    | "session.warning"
    | "session.title-updated"
    | "session.structured-output"
    | "message.updated"
    | "message.patched"
    | "session.approval-requested"
    | "session.approval-resolved"
    | "session.interaction-requested"
    | "session.interaction-resolved"
    /** The bridge could not replay our gap; refetch state from scratch. */
    | "session.reconcile-required";
  sessionId?: string;
  data?: Record<string, unknown>;
  /**
   * Monotonic bridge revision from the SSE `id:` field.
   *
   * Echoed back as `?since=` on reconnect so the bridge can replay only what we
   * missed instead of us refetching the whole transcript.
   */
  revision?: number;
}

/** What Codex is asking permission for. */
export type CodexApprovalKind = "command" | "file-change" | "permissions";

export type CodexApprovalDecision = "approve" | "approve-for-session" | "deny" | "cancel";

export interface CodexApprovalFileChange {
  path: string;
  kind: "add" | "delete" | "update";
}

/**
 * A pending approval, as sent by the bridge.
 *
 * Mirrors `ApprovalRequest` in `bridges/codex-bridge/src/app-server/approvals.ts`.
 * Most fields are optional because the underlying protocol methods disagree about
 * which they populate — the v2 file-change approval, for instance, carries no
 * changes at all.
 */
export interface CodexApproval {
  approvalId: string;
  kind: CodexApprovalKind;
  method: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  requestedAt: number;
  /** Auto-denies at this time, so the card can show a countdown. */
  expiresAt: number;
  command?: string;
  cwd?: string;
  changes?: CodexApprovalFileChange[];
  permissions?: { network: boolean; fileSystem: boolean };
  reason?: string;
  grantRoot?: string;
  networkHost?: string;
  /**
   * Whether the bridge could resolve enough action details for informed
   * approval. The UI must fail closed when this is false.
   */
  actionable: boolean;
  supportsApproveForSession: boolean;
}

/**
 * Outcome of answering an approval.
 *
 * `stale` is expected, not exceptional: the five-minute window can close while the
 * user is deciding, and a restart withdraws the request outright.
 */
export type CodexApprovalResponseResult =
  | "applied"
  | "stale"
  | "forbidden"
  | "error"
  /** No HTTP response arrived, so the provider may already have applied it. */
  | "unknown";

export interface CodexInteractionOption {
  label: string;
  description?: string;
}

export interface CodexInteractionQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: CodexInteractionOption[];
}

export interface CodexInteraction {
  interactionId: string;
  kind: "question" | "mcp-form" | "mcp-url";
  method: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  requestedAt: number;
  expiresAt: number;
  autoResolutionMs?: number;
  questions?: CodexInteractionQuestion[];
  serverName?: string;
  message?: string;
  schema?: unknown;
  url?: string;
  elicitationId?: string;
}

export type CodexInteractionAnswer =
  | { action: "accept"; answers?: Record<string, string[]>; content?: unknown }
  | { action: "decline" | "cancel" };

function parseInteractionQuestion(value: unknown): CodexInteractionQuestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string"
    || typeof raw.question !== "string"
    || typeof raw.header !== "string"
  ) {
    return null;
  }
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((option) => {
        if (!option || typeof option !== "object" || Array.isArray(option)) return [];
        const parsed = option as Record<string, unknown>;
        return typeof parsed.label === "string"
          ? [{
              label: parsed.label,
              ...(typeof parsed.description === "string"
                ? { description: parsed.description }
                : {}),
            }]
          : [];
      })
    : undefined;
  return {
    id: raw.id,
    header: raw.header,
    question: raw.question,
    isOther: raw.isOther === true,
    isSecret: raw.isSecret === true,
    ...(options && options.length > 0 ? { options } : {}),
  };
}

export function parseInteraction(value: unknown): CodexInteraction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    // An empty id cannot be routed back to the bridge — it would POST to
    // `/session/:id/interactions/`, which matches no route — so the card would
    // render but never be answerable and the turn would stay blocked.
    typeof raw.interactionId !== "string"
    || raw.interactionId.length === 0
    || (raw.kind !== "question" && raw.kind !== "mcp-form" && raw.kind !== "mcp-url")
    || typeof raw.method !== "string"
    || typeof raw.threadId !== "string"
    || typeof raw.requestedAt !== "number"
    || !Number.isFinite(raw.requestedAt)
    || typeof raw.expiresAt !== "number"
    || !Number.isFinite(raw.expiresAt)
  ) {
    return null;
  }
  const questions = Array.isArray(raw.questions)
    ? raw.questions
        .map(parseInteractionQuestion)
        .filter((question): question is CodexInteractionQuestion => question !== null)
    : undefined;
  if (raw.kind === "question" && !questions?.length) return null;
  return {
    interactionId: raw.interactionId,
    kind: raw.kind,
    method: raw.method,
    threadId: raw.threadId,
    turnId: typeof raw.turnId === "string" ? raw.turnId : null,
    itemId: typeof raw.itemId === "string" ? raw.itemId : null,
    requestedAt: raw.requestedAt,
    expiresAt: raw.expiresAt,
    ...(typeof raw.autoResolutionMs === "number"
      ? { autoResolutionMs: raw.autoResolutionMs }
      : {}),
    ...(questions ? { questions } : {}),
    ...(typeof raw.serverName === "string" ? { serverName: raw.serverName } : {}),
    ...(typeof raw.message === "string" ? { message: raw.message } : {}),
    ...("schema" in raw ? { schema: raw.schema } : {}),
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    ...(typeof raw.elicitationId === "string"
      ? { elicitationId: raw.elicitationId }
      : {}),
  };
}

/**
 * Reports an approval we refuse to render, and drops it.
 *
 * Never silent: the turn is *blocked* on this request, so an approval we cannot
 * show is one nobody can answer, and it will hang until the bridge's five-minute
 * auto-deny. Only the id and the offending field are logged — never the command,
 * the cwd or any file content, which is exactly what the user has not yet agreed
 * to expose.
 */
function rejectApproval(value: unknown, field: string): null {
  const approvalId =
    value
    && typeof value === "object"
    && typeof (value as Record<string, unknown>).approvalId === "string"
      ? ((value as Record<string, string>).approvalId)
      : undefined;
  console.warn(
    `[codex-client] Ignoring unrecognised Codex approval (invalid ${field})`,
    { approvalId },
  );
  return null;
}

/**
 * Validates one approval descriptor from the bridge.
 *
 * Exported so the SSE frame and the `/approvals` snapshot agree on what a usable
 * approval is: the two paths deliver the same descriptor, and a card the user
 * cannot act on is worse than no card at all.
 */
export function parseApproval(value: unknown): CodexApproval | null {
  if (!value || typeof value !== "object") return rejectApproval(value, "payload");
  const entry = value as Record<string, unknown>;
  const kind = entry.kind;
  // An empty id cannot be routed back to the bridge, so it is not answerable.
  if (typeof entry.approvalId !== "string" || entry.approvalId.length === 0) {
    return rejectApproval(entry, "approvalId");
  }
  if (kind !== "command" && kind !== "file-change" && kind !== "permissions") {
    return rejectApproval(entry, "kind");
  }
  if (typeof entry.method !== "string") return rejectApproval(entry, "method");
  if (entry.threadId !== null && typeof entry.threadId !== "string") {
    return rejectApproval(entry, "threadId");
  }
  if (entry.turnId !== null && typeof entry.turnId !== "string") {
    return rejectApproval(entry, "turnId");
  }
  if (entry.itemId !== null && typeof entry.itemId !== "string") {
    return rejectApproval(entry, "itemId");
  }
  if (typeof entry.requestedAt !== "number" || !Number.isFinite(entry.requestedAt)) {
    return rejectApproval(entry, "requestedAt");
  }
  if (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt)) {
    return rejectApproval(entry, "expiresAt");
  }
  if (typeof entry.actionable !== "boolean") {
    return rejectApproval(entry, "actionable");
  }
  if (typeof entry.supportsApproveForSession !== "boolean") {
    return rejectApproval(entry, "supportsApproveForSession");
  }

  const changes = Array.isArray(entry.changes)
    ? entry.changes.filter((change): change is CodexApprovalFileChange => {
        if (!change || typeof change !== "object") return false;
        const candidate = change as Record<string, unknown>;
        return typeof candidate.path === "string"
          && (
            candidate.kind === "add"
            || candidate.kind === "delete"
            || candidate.kind === "update"
          );
      })
    : undefined;
  const permissions =
    entry.permissions
    && typeof entry.permissions === "object"
    && typeof (entry.permissions as Record<string, unknown>).network === "boolean"
    && typeof (entry.permissions as Record<string, unknown>).fileSystem === "boolean"
      ? {
          network: (entry.permissions as { network: boolean }).network,
          fileSystem: (entry.permissions as { fileSystem: boolean }).fileSystem,
        }
      : undefined;
  const optionalString = (key: string) =>
    typeof entry[key] === "string" ? entry[key] as string : undefined;

  return {
    approvalId: entry.approvalId,
    kind,
    method: entry.method,
    threadId: entry.threadId,
    turnId: entry.turnId,
    itemId: entry.itemId,
    requestedAt: entry.requestedAt,
    expiresAt: entry.expiresAt,
    actionable: entry.actionable,
    supportsApproveForSession: entry.supportsApproveForSession,
    ...(optionalString("command") ? { command: optionalString("command") } : {}),
    ...(optionalString("cwd") ? { cwd: optionalString("cwd") } : {}),
    ...(changes ? { changes } : {}),
    ...(permissions ? { permissions } : {}),
    ...(optionalString("reason") ? { reason: optionalString("reason") } : {}),
    ...(optionalString("grantRoot") ? { grantRoot: optionalString("grantRoot") } : {}),
    ...(optionalString("networkHost") ? { networkHost: optionalString("networkHost") } : {}),
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function fetchCodex(
  client: CodexClient,
  path: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const headers = new Headers(options.headers);
  // The desktop gateway consumes its own Authorization header before proxying.
  // Keep bridge authentication in a dedicated header so it survives that hop.
  if (client.authToken) headers.set("X-Orkestrator-Codex-Token", client.authToken);
  return fetchWithTimeout(
    `${client.baseUrl}${path}`,
    { ...options, headers },
    timeoutMs,
  );
}

export function createClient(baseUrl: string, authToken?: string): CodexClient {
  return {
    baseUrl: resolveGatewayLoopbackBaseUrl(baseUrl),
    ...(authToken ? { authToken } : {}),
  };
}

export async function checkHealth(client: CodexClient): Promise<boolean> {
  try {
    const response = await fetchCodex(client, "/global/auth-check");
    return response.ok;
  } catch {
    return false;
  }
}

/** Engine and app-server detail from /global/health. */
export interface CodexBridgeHealth {
  status: "ok" | "error";
  bridgeVersion?: string;
  engine?: "app-server";
  appServer?: {
    state?: string;
    generation?: number;
    pid?: number | null;
    codexVersion?: string;
    restartCount?: number;
    circuitOpen?: boolean;
    lastError?: string;
  };
  activeThreads?: number;
  activeTurns?: number;
}

/**
 * Full health payload. Returns null when unreachable *or* when the engine has
 * failed terminally (the bridge answers 503), so callers cannot mistake a dead
 * app-server for a healthy bridge.
 */
export async function getBridgeHealth(client: CodexClient): Promise<CodexBridgeHealth | null> {
  try {
    const response = await fetchCodex(client, "/global/health");
    if (!response.ok) return null;
    return (await response.json()) as CodexBridgeHealth;
  } catch {
    return null;
  }
}

export async function getModels(client: CodexClient): Promise<CodexModelsResponse> {
  try {
    const response = await fetchCodex(client, "/global/models");
    if (!response.ok) {
      return { models: CODEX_MODELS, source: "fallback" };
    }

    const data = (await response.json()) as Partial<CodexModelsResponse>;
    const models = Array.isArray(data.models) && data.models.length > 0
      ? data.models
      : CODEX_MODELS;

    return {
      models,
      source:
        data.source === "app-server" || data.source === "cache" ? data.source : "fallback",
    };
  } catch (error) {
    console.error("[codex-client] Failed to get models:", error);
    return { models: CODEX_MODELS, source: "fallback" };
  }
}

export async function getSlashCommands(client: CodexClient): Promise<CodexSlashCommand[]> {
  try {
    const response = await fetchCodex(client, "/global/slash-commands");
    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as Partial<CodexSlashCommandsResponse>;
    return Array.isArray(data.commands) ? data.commands : [];
  } catch (error) {
    console.error("[codex-client] Failed to get slash commands:", error);
    return [];
  }
}

export async function createSession(
  client: CodexClient,
  options?: {
    title?: string;
    model?: string;
    modelReasoningEffort?: CodexReasoningEffort;
    mode?: CodexConversationMode;
    fastMode?: boolean;
    /**
     * Stable logical tab key. The bridge hashes this into an idempotent session
     * id so concurrent React mounts cannot create two Codex threads.
     */
    clientSessionKey?: string;
  },
): Promise<CodexSession> {
  const response = await fetchCodex(client, "/session/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: options?.title,
      model: options?.model,
      modelReasoningEffort: options?.modelReasoningEffort,
      mode: options?.mode,
      fastMode: options?.fastMode,
      clientSessionKey: options?.clientSessionKey,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Codex bridge returned ${response.status}: ${body}`);
  }
  const data = await response.json();
  return {
    sessionId: data.sessionId,
    title: data.title,
  };
}

export async function listSessions(client: CodexClient): Promise<CodexStoredSession[]> {
  try {
    const response = await fetchCodex(client, "/session/list");
    if (!response.ok) return [];
    const data = (await response.json()) as Partial<CodexSessionListResponse>;
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch (error) {
    console.error("[codex-client] Failed to list sessions:", error);
    return [];
  }
}

export async function resumeSession(
  client: CodexClient,
  options: {
    threadId: string;
    model?: string;
    modelReasoningEffort?: CodexReasoningEffort;
    mode?: CodexConversationMode;
    fastMode?: boolean;
  },
): Promise<{ session: CodexSession; messages: CodexMessage[] } | null> {
  try {
    const response = await fetchCodex(client, "/session/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      session: {
        sessionId: data.sessionId,
        title: data.title,
      },
      messages: Array.isArray(data.messages) ? data.messages : [],
    };
  } catch (error) {
    console.error("[codex-client] Failed to resume session:", error);
    return null;
  }
}

export async function updateSessionConfig(
  client: CodexClient,
  sessionId: string,
  options: {
    model?: string;
    modelReasoningEffort?: CodexReasoningEffort;
    mode?: CodexConversationMode;
    fastMode?: boolean;
  },
): Promise<CodexSessionConfigUpdateOutcome> {
  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}/config`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      },
    );
    if (!response.ok) {
      return { outcome: "rejected", httpStatus: response.status };
    }

    const body = (await response.json().catch(() => ({}))) as {
      durable?: unknown;
    };
    return {
      outcome: "applied",
      // Older bridges did not report durability. Preserve compatibility while
      // surfacing an explicit memory-only update from the app-server bridge.
      durable: body.durable !== false,
    };
  } catch (error) {
    console.error("[codex-client] Failed to update session config:", error);
    // A timeout or reset after the bridge handled the request is ambiguous.
    // Re-read the authoritative bridge config before asking the UI to roll back.
    try {
      const reconciliation = await fetchCodex(
        client,
        `/session/${sessionId}/config`,
      );
      if (reconciliation.ok) {
        const current = (await reconciliation.json()) as {
          model?: unknown;
          modelReasoningEffort?: unknown;
          mode?: unknown;
          fastMode?: unknown;
          durable?: unknown;
        };
        const matches =
          (options.model === undefined || current.model === options.model)
          && (
            options.modelReasoningEffort === undefined
            || current.modelReasoningEffort === options.modelReasoningEffort
          )
          && (options.mode === undefined || current.mode === options.mode)
          && (options.fastMode === undefined || current.fastMode === options.fastMode);
        if (matches) {
          return {
            outcome: "applied",
            durable: current.durable === true,
          };
        }
      }
    } catch {
      // Still ambiguous; the caller keeps the warning/recovery state.
    }
    return { outcome: "unknown" };
  }
}

export type CodexSessionConfigUpdateOutcome =
  | { outcome: "applied"; durable: boolean }
  | { outcome: "rejected"; httpStatus: number }
  | { outcome: "unknown" };

export async function getSessionMessages(
  client: CodexClient,
  sessionId: string,
  options: { throwOnError?: boolean } = {},
): Promise<CodexMessage[]> {
  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}/messages`,
    );
    if (!response.ok) {
      throw new Error(`Failed to get Codex session messages: HTTP ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (error) {
    console.error("[codex-client] Failed to get session messages:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get Codex session messages");
    }
    return [];
  }
}

const CONTEXT_USAGE_SOURCES: ReadonlySet<string> = new Set([
  "claude",
  "opencode",
  "codex",
  "heuristic",
  "provider",
]);

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Copies `keys` across only where the source holds a finite number. */
function pickFiniteNumbers(
  raw: Record<string, unknown>,
  keys: readonly (keyof ContextUsageSnapshot)[],
): Partial<ContextUsageSnapshot> {
  const picked: Record<string, number> = {};
  for (const key of keys) {
    const value = finiteNumber(raw[key as string]);
    if (value !== undefined) picked[key as string] = value;
  }
  return picked as Partial<ContextUsageSnapshot>;
}

const OPTIONAL_USAGE_NUMBERS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "lastTurnTokens",
  "sessionTokens",
  "costUsd",
  "durationMs",
  "apiDurationMs",
  "permissionDenials",
  "linesAdded",
  "linesRemoved",
] as const satisfies readonly (keyof ContextUsageSnapshot)[];

/**
 * Validates a context-usage snapshot arriving from the bridge.
 *
 * Exported so the SSE frame and the `/status` snapshot agree on what a usable
 * reading is. The UI formats `percentUsed` with `toFixed`, so a frame carrying a
 * string (or nothing at all) where a number belongs throws inside render — the
 * whole tab, not just the meter. Anything that fails the numeric triple is
 * dropped; every optional field is kept only when it is the right shape, so one
 * malformed extra never costs the reading itself.
 */
export function parseContextUsage(value: unknown): ContextUsageSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const usedTokens = finiteNumber(raw.usedTokens);
  const totalTokens = finiteNumber(raw.totalTokens);
  const percentUsed = finiteNumber(raw.percentUsed);
  if (
    usedTokens === undefined
    || totalTokens === undefined
    || percentUsed === undefined
  ) {
    return null;
  }

  const rateLimits = Array.isArray(raw.rateLimits)
    ? raw.rateLimits.flatMap((window) => {
        if (!window || typeof window !== "object" || Array.isArray(window)) return [];
        const entry = window as Record<string, unknown>;
        const label = nonEmptyString(entry.label);
        if (label === undefined) return [];
        return [{
          label,
          ...(finiteNumber(entry.usedPercent) !== undefined
            ? { usedPercent: finiteNumber(entry.usedPercent) }
            : {}),
          ...(nonEmptyString(entry.resetsAt) !== undefined
            ? { resetsAt: entry.resetsAt as string }
            : {}),
          ...(finiteNumber(entry.windowMinutes) !== undefined
            ? { windowMinutes: finiteNumber(entry.windowMinutes) }
            : {}),
        }];
      })
    : undefined;

  const contextCategories = Array.isArray(raw.contextCategories)
    ? raw.contextCategories.flatMap((category) => {
        if (!category || typeof category !== "object" || Array.isArray(category)) return [];
        const entry = category as Record<string, unknown>;
        const name = nonEmptyString(entry.name);
        const tokens = finiteNumber(entry.tokens);
        if (name === undefined || tokens === undefined) return [];
        return [{
          name,
          tokens,
          ...(nonEmptyString(entry.color) !== undefined
            ? { color: entry.color as string }
            : {}),
        }];
      })
    : undefined;

  const rawCredits =
    raw.credits && typeof raw.credits === "object" && !Array.isArray(raw.credits)
      ? (raw.credits as Record<string, unknown>)
      : undefined;
  const credits = rawCredits
    ? {
        ...(typeof rawCredits.hasCredits === "boolean"
          ? { hasCredits: rawCredits.hasCredits }
          : {}),
        ...(typeof rawCredits.unlimited === "boolean"
          ? { unlimited: rawCredits.unlimited }
          : {}),
        ...(nonEmptyString(rawCredits.balance) !== undefined
          ? { balance: rawCredits.balance as string }
          : {}),
      }
    : undefined;

  return {
    usedTokens,
    totalTokens,
    percentUsed,
    ...pickFiniteNumbers(raw, OPTIONAL_USAGE_NUMBERS),
    ...(nonEmptyString(raw.modelId) !== undefined
      ? { modelId: raw.modelId as string }
      : {}),
    ...(nonEmptyString(raw.updatedAt) !== undefined
      ? { updatedAt: raw.updatedAt as string }
      : {}),
    ...(typeof raw.estimated === "boolean" ? { estimated: raw.estimated } : {}),
    ...(typeof raw.source === "string" && CONTEXT_USAGE_SOURCES.has(raw.source)
      ? { source: raw.source as ContextUsageSnapshot["source"] }
      : {}),
    ...(rateLimits && rateLimits.length > 0 ? { rateLimits } : {}),
    ...(contextCategories && contextCategories.length > 0
      ? { contextCategories }
      : {}),
    ...(credits && Object.keys(credits).length > 0 ? { credits } : {}),
  };
}

export async function lookupSessionStatus(
  client: CodexClient,
  sessionId: string,
): Promise<CodexSessionStatusLookupResult> {
  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}/status`,
    );
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok) {
      throw new Error(`Failed to get Codex session status: HTTP ${response.status}`);
    }
    const data = (await response.json()) as Partial<CodexSessionStatusResponse>;
    if (
      data.status !== "idle"
      && data.status !== "running"
      && data.status !== "error"
    ) {
      throw new Error("Codex session status response was malformed");
    }
    const contextUsage = parseContextUsage(data.contextUsage);
    const turnStartedAt = parseCodexTurnStartedAt(data.turnStartedAt);
    // Spread in only when present, so the response shape is unchanged for a
    // bridge that does not report them.
    return {
      kind: "found",
      session: {
        status: data.status,
        title: typeof data.title === "string" ? data.title : undefined,
        error: typeof data.error === "string" ? data.error : undefined,
        ...(isCodexSessionPhase(data.phase) ? { phase: data.phase } : {}),
        ...(typeof data.threadId === "string" ? { threadId: data.threadId } : {}),
        ...(typeof data.turnId === "string" ? { turnId: data.turnId } : {}),
        ...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
        ...(typeof data.requestId === "string" ? { requestId: data.requestId } : {}),
        ...(typeof data.engineGeneration === "number"
          ? { engineGeneration: data.engineGeneration }
          : {}),
        ...(typeof data.messageRevision === "number"
          && Number.isSafeInteger(data.messageRevision)
          && data.messageRevision >= 0
          ? { messageRevision: data.messageRevision }
          : {}),
        ...(typeof data.structuredOutputRequestId === "string"
          ? { structuredOutputRequestId: data.structuredOutputRequestId }
          : {}),
        ...(isStructuredOutputResult(data.structuredOutput)
          ? { structuredOutput: data.structuredOutput }
          : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(data.unconfirmedDispatch
          && typeof data.unconfirmedDispatch.requestId === "string"
          && data.unconfirmedDispatch.requestId.trim().length > 0
          && data.unconfirmedDispatch.retryable === true
          ? { unconfirmedDispatch: data.unconfirmedDispatch }
          : {}),
      },
    };
  } catch (error) {
    console.error("[codex-client] Failed to get session status:", error);
    return {
      kind: "unavailable",
      error: error instanceof Error
        ? error
        : new Error("Failed to get Codex session status"),
    };
  }
}

export type CodexSessionActivityLookupResult =
  | { kind: "found"; activity: "idle" | "working" | "waiting" }
  | { kind: "missing" }
  | { kind: "unsupported" }
  | { kind: "unavailable"; error: Error };

/** Cheap, non-touching probe used by background reconciliation. */
export async function lookupSessionActivity(
  client: CodexClient,
  sessionId: string,
): Promise<CodexSessionActivityLookupResult> {
  try {
    const response = await fetchCodex(client, `/session/${sessionId}/activity`);
    // Older bridges predate this non-touching route. A 404 cannot mean the
    // session is missing because current bridges report that in-band; let the
    // caller fall back to the legacy status endpoint instead.
    if (response.status === 404) return { kind: "unsupported" };
    if (!response.ok) throw new Error(`Failed to get Codex session activity: HTTP ${response.status}`);
    const body = await response.json() as { activity?: unknown };
    if (body.activity === "missing") return { kind: "missing" };
    if (body.activity === "idle" || body.activity === "working" || body.activity === "waiting") {
      return { kind: "found", activity: body.activity };
    }
    throw new Error("Codex session activity response was malformed");
  } catch (error) {
    return {
      kind: "unavailable",
      error: error instanceof Error ? error : new Error("Failed to get Codex session activity"),
    };
  }
}

export async function getSessionStatus(
  client: CodexClient,
  sessionId: string,
  options: { throwOnError?: boolean } = {},
): Promise<CodexSessionStatus | null> {
  const result = await lookupSessionStatus(client, sessionId);
  if (result.kind === "found") return result.session;
  if (result.kind === "unavailable" && options.throwOnError) {
    throw result.error;
  }
  return null;
}

/**
 * What the bridge returns when it accepts a prompt.
 *
 * `already-processed` means the bridge recognised the request id as one it has
 * already run to completion — the guarantee that a retried dispatch cannot
 * execute a turn twice. `turnId`/`threadId` let a reconnecting client reconcile
 * against the turn actually running rather than guessing from prompt text.
 */
export interface CodexPromptAcceptedResponse {
  status: "processing" | "already-processed";
  requestId?: string;
  threadId?: string | null;
  turnId?: string;
  /** Backend-authoritative epoch milliseconds for the active turn. */
  turnStartedAt?: number;
  duplicate?: boolean;
}

export function parseCodexTurnStartedAt(value: unknown): number | undefined {
  return parseBackendTurnStartedAt(value);
}

export type CodexPromptSendOutcome =
  | ({ outcome: "accepted" } & CodexPromptAcceptedResponse)
  | { outcome: "rejected"; httpStatus: number }
  | { outcome: "unknown"; requestId: string };

/**
 * Classifies whatever a caller received from `sendPrompt`.
 *
 * Component tests still stub this client with its historical boolean/nullable
 * contract, so the shapes are normalized in one shared place rather than in each
 * caller. `unknown` is deliberately *not* folded into either definite answer:
 * the bridge may already be executing the turn, so a caller must reconcile
 * against authoritative state before unlocking, advancing or resending.
 */
export function classifyCodexPromptOutcome(
  result: unknown,
): "accepted" | "rejected" | "unknown" {
  if (result === true) return "accepted";
  if (result === false || result === null || result === undefined) return "rejected";
  if (typeof result === "object") {
    const outcome = (result as { outcome?: unknown }).outcome;
    if (outcome === "accepted" || outcome === "rejected" || outcome === "unknown") {
      return outcome;
    }
    // A bare acceptance payload from an older client stub.
    const status = (result as { status?: unknown }).status;
    if (status === "processing" || status === "already-processed") return "accepted";
  }
  return "rejected";
}

/**
 * Sends a prompt.
 *
 * A non-2xx response proves the bridge rejected the request. A transport failure
 * is different: the bridge may have accepted the prompt before the response was
 * lost, so callers must reconcile authoritative session state rather than
 * unlocking the composer or blindly retrying.
 */
export async function sendPrompt(
  client: CodexClient,
  sessionId: string,
  prompt: string,
  options?: {
    attachments?: CodexPromptAttachment[];
    requestId?: string;
    outputSchema?: JsonSchema;
  },
): Promise<CodexPromptSendOutcome> {
  const requestId = options?.requestId ?? crypto.randomUUID();
  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}/prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          attachments: options?.attachments,
          requestId,
          outputSchema: options?.outputSchema,
        }),
      },
    );
    if (!response.ok) {
      return { outcome: "rejected", httpStatus: response.status };
    }

    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const turnStartedAt = parseCodexTurnStartedAt(data.turnStartedAt);
    return {
      outcome: "accepted",
      status: data.status === "already-processed" ? "already-processed" : "processing",
      requestId: typeof data.requestId === "string" ? data.requestId : requestId,
      threadId: typeof data.threadId === "string" ? data.threadId : null,
      turnId: typeof data.turnId === "string" ? data.turnId : undefined,
      ...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
      duplicate: data.duplicate === true,
    };
  } catch (error) {
    console.error("[codex-client] Failed to send prompt:", error);
    return { outcome: "unknown", requestId };
  }
}

/**
 * Read a completed constrained turn from bridge-owned state. `null` means the
 * requested turn is still running (or has not been dispatched).
 */
export async function getStructuredOutput<T = unknown>(
  client: CodexClient,
  sessionId: string,
  requestId?: string,
): Promise<StructuredOutputResult<T> | null> {
  let response: Response;
  try {
    const query = requestId ? `?requestId=${encodeURIComponent(requestId)}` : "";
    response = await fetchCodex(
      client,
      `/session/${sessionId}/structured-output${query}`,
    );
  } catch (error) {
    throw new StructuredOutputReadUnavailableError(
      "codex",
      error instanceof Error
        ? error.message
        : "Failed to read Codex structured output.",
      { requestId, cause: error },
    );
  }
  if (!response.ok) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return structuredOutputFailure(
      "codex",
      "malformed_output",
      "Codex bridge returned malformed JSON for structured output.",
      { requestId },
    );
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return structuredOutputFailure(
      "codex",
      "malformed_output",
      "Codex bridge returned a malformed structured-output envelope.",
      { requestId },
    );
  }
  const structuredOutput = (body as Record<string, unknown>).structuredOutput;
  if (structuredOutput === null || structuredOutput === undefined) {
    return null;
  }
  if (isStructuredOutputResult(structuredOutput)) {
    return structuredOutput as StructuredOutputResult<T>;
  }
  return structuredOutputFailure(
    "codex",
    "malformed_output",
    "Codex bridge returned a malformed structured-output envelope.",
    { requestId },
  );
}

export type CodexAbortOutcome =
  | { status: "accepted" }
  | { status: "rejected"; httpStatus: number }
  | { status: "unknown" };

export async function abortSession(
  client: CodexClient,
  sessionId: string,
): Promise<CodexAbortOutcome> {
  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}/abort`,
      { method: "POST" },
    );
    return response.ok
      ? { status: "accepted" }
      : { status: "rejected", httpStatus: response.status };
  } catch (error) {
    console.error("[codex-client] Failed to abort session:", error);
    // A timeout or connection reset does not prove the bridge missed the
    // request. The caller must reconcile authoritative status before unlocking
    // the composer or allowing another turn to start.
    return { status: "unknown" };
  }
}

/**
 * Fetches approvals still awaiting a decision.
 *
 * This is the rehydration path required by the background-reliability rules: a tab
 * that was unmounted while Codex asked for approval never saw the SSE frame, so it
 * must be able to ask on mount rather than trusting live events.
 */
export async function fetchPendingApprovals(
  client: CodexClient,
  sessionId: string,
): Promise<CodexApproval[]> {
  const response = await fetchCodex(
    client,
    `/session/${sessionId}/approvals`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch pending Codex approvals: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { approvals?: unknown };
  if (!Array.isArray(body.approvals)) {
    throw new Error("Pending Codex approvals response was malformed");
  }
  return body.approvals
    .map(parseApproval)
    .filter((approval): approval is CodexApproval => approval !== null);
}

/**
 * Sends the user's decision.
 *
 * Distinguishes `stale` (409 — the window closed) from `error` (anything else),
 * because the two need different UI: drop the card versus let the user retry.
 */
export async function respondToApproval(
  client: CodexClient,
  sessionId: string,
  approvalId: string,
  decision: CodexApprovalDecision,
): Promise<CodexApprovalResponseResult> {
  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      },
    );
    if (response.ok) return "applied";
    if (response.status === 409) return "stale";
    if (response.status === 403) return "forbidden";
    return "error";
  } catch (error) {
    console.error("[codex-client] Failed to respond to approval:", error);
    return "unknown";
  }
}

export async function fetchPendingInteractions(
  client: CodexClient,
  sessionId: string,
): Promise<CodexInteraction[]> {
  const response = await fetchCodex(
    client,
    `/session/${sessionId}/interactions`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch pending Codex interactions: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { interactions?: unknown };
  if (!Array.isArray(body.interactions)) {
    throw new Error("Pending Codex interactions response was malformed");
  }
  return body.interactions
    .map(parseInteraction)
    .filter((interaction): interaction is CodexInteraction => interaction !== null);
}

export async function respondToInteraction(
  client: CodexClient,
  sessionId: string,
  interactionId: string,
  answer: CodexInteractionAnswer,
): Promise<CodexApprovalResponseResult> {
  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}/interactions/${encodeURIComponent(interactionId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(answer),
      },
    );
    if (response.ok) return "applied";
    if (response.status === 409) return "stale";
    if (response.status === 403) return "forbidden";
    return "error";
  } catch (error) {
    console.error("[codex-client] Failed to respond to interaction:", error);
    return "unknown";
  }
}

/**
 * A fork request the bridge refused, carrying the HTTP status it answered with.
 *
 * The fork route reports four differentiated failures (404 not found, 409
 * running, 422 not a usable fork point, 503 engine unavailable), each with its
 * own `error` body. Collapsing them to null made the UI blame a running turn
 * that was not there, so every non-OK answer now surfaces as this error.
 * `status` is 0 when the request itself failed in transport, i.e. no HTTP
 * answer was received at all.
 */
export class CodexForkError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CodexForkError";
    this.status = status;
  }
}

/** Fallbacks mirroring the bridge's own reasons, for bodies without `error`. */
const CODEX_FORK_ERROR_FALLBACKS: Record<number, string> = {
  404: "Codex session or fork point was not found",
  409: "Codex session cannot be forked while it is running",
  422: "That message is not a usable fork point",
  503: "Codex did not return a forked thread",
};

export async function forkCodexSession(
  client: CodexClient,
  sessionId: string,
  lastMessageId?: string,
): Promise<CodexSession> {
  let response: Response;
  try {
    response = await fetchCodex(
      client,
      `/session/${sessionId}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastMessageId }),
      },
    );
  } catch (error) {
    throw new CodexForkError(
      0,
      error instanceof Error ? error.message : "Codex fork request failed",
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: unknown }
      | null;
    const message =
      body && typeof body.error === "string" && body.error.length > 0
        ? body.error
        : CODEX_FORK_ERROR_FALLBACKS[response.status]
          ?? `Codex fork failed: HTTP ${response.status}`;
    throw new CodexForkError(response.status, message);
  }
  const body = (await response.json().catch(() => ({}))) as {
    sessionId?: unknown;
    title?: unknown;
  };
  // A `200 {}` would otherwise bind the new tab to `sessionId: undefined`,
  // which every subsequent request then addresses as the literal "undefined".
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
    throw new CodexForkError(
      response.status,
      "Codex fork response did not include a session id",
    );
  }
  return {
    sessionId: body.sessionId,
    ...(typeof body.title === "string" ? { title: body.title } : {}),
  };
}

export async function compactCodexSession(
  client: CodexClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}/compact`,
      { method: "POST" },
    );
    return response.ok;
  } catch (error) {
    console.error("[codex-client] Failed to compact session:", error);
    return false;
  }
}

export type CodexSteerOutcome =
  | { outcome: "accepted" }
  | { outcome: "idle" }
  | { outcome: "mismatch" }
  | { outcome: "not-found" }
  | { outcome: "rejected"; httpStatus: number }
  | { outcome: "unknown"; requestId: string };

export function describeCodexSteerFailure(outcome: CodexSteerOutcome): string | null {
  switch (outcome.outcome) {
    case "accepted":
      return null;
    case "idle":
      return "There is no active Codex turn to steer. Start a turn, then use /steer while it is running.";
    case "mismatch":
      return "The active turn changed; your steering message was not sent.";
    case "not-found":
      return "The Codex session is no longer available.";
    case "rejected":
      return `Codex rejected the steering message (HTTP ${outcome.httpStatus}).`;
    case "unknown":
      return "Could not confirm whether Codex received your steering message. Retry the unchanged steering message to check safely.";
  }
}

export async function steerCodexSession(
  client: CodexClient,
  sessionId: string,
  input: string,
  requestId: string,
): Promise<CodexSteerOutcome> {
  // Steering must be bound to the turn the user meant to redirect. Reading the
  // bridge-owned status first gives us an authoritative turn id; the bridge
  // rejects the POST if that turn finishes or is replaced before it arrives.
  const status = await lookupSessionStatus(client, sessionId);
  if (status.kind === "missing") return { outcome: "not-found" };
  if (status.kind === "unavailable") return { outcome: "unknown", requestId };
  if (status.session.status !== "running") return { outcome: "idle" };
  // A running status without a turn id cannot be bound safely. This can happen
  // with an older bridge; it is not evidence that the active turn is idle.
  if (!status.session.turnId) return { outcome: "unknown", requestId };

  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}/steer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input,
          requestId,
          expectedTurnId: status.session.turnId,
        }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      outcome?: unknown;
    };
    if (body.outcome === "unknown") return { outcome: "unknown", requestId };
    if (response.ok) return { outcome: "accepted" };
    if (response.status === 404) return { outcome: "not-found" };
    if (response.status === 409) {
      if (body.outcome === "idle" || body.error === "There is no active turn") {
        return { outcome: "idle" };
      }
      return { outcome: "mismatch" };
    }
    return { outcome: "rejected", httpStatus: response.status };
  } catch (error) {
    console.error("[codex-client] Failed to steer session:", error);
    // A timeout or reset after the bridge accepted `turn/steer` is ambiguous.
    // Do not tell the user the text definitely failed or silently retry it.
    return { outcome: "unknown", requestId };
  }
}

export async function startCodexNativeReview(
  client: CodexClient,
  sessionId: string,
  target:
    | { type: "uncommittedChanges" }
    | { type: "baseBranch"; branch: string }
    | { type: "commit"; sha: string; title?: string }
    | { type: "custom"; instructions: string } = { type: "uncommittedChanges" },
): Promise<boolean> {
  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      },
    );
    return response.ok;
  } catch (error) {
    console.error("[codex-client] Failed to start native review:", error);
    return false;
  }
}

export async function getCodexRuntimeHealth(
  client: CodexClient,
  sessionId: string,
): Promise<unknown> {
  const response = await fetchCodex(
    client,
    `/session/${sessionId}/runtime-health`,
  );
  if (!response.ok) throw new Error(`Codex runtime health failed: HTTP ${response.status}`);
  return response.json();
}

export async function deleteSession(
  client: CodexClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const response = await fetchCodex(
      client,
      `/session/${sessionId}`,
      { method: "DELETE" },
    );
    return response.ok;
  } catch (error) {
    console.error("[codex-client] Failed to delete session:", error);
    return false;
  }
}

/**
 * Subscribes to the bridge event stream.
 *
 * `since` is the last revision this client processed. Passing it lets the bridge
 * replay the gap instead of the client refetching everything; if the gap is longer
 * than the bridge retained, it answers with `session.reconcile-required` and the
 * caller must resync. Omit it for a fresh subscription.
 *
 * `sessionId` asks the bridge to replace other sessions' large payloads with
 * lightweight cursor-only frames. The cursor remains bridge-wide, so replay
 * semantics are unchanged.
 */
export const MAX_CODEX_EVENT_QUEUE_COUNT = 256;
export const MAX_CODEX_EVENT_QUEUE_BYTES = 2 * 1024 * 1024;

export function subscribeToEvents(
  client: CodexClient,
  signal?: AbortSignal,
  since?: number,
  sessionId?: string,
): AsyncIterable<CodexEvent> {
  const maxQueuedEvents = MAX_CODEX_EVENT_QUEUE_COUNT;
  const maxQueuedBytes = MAX_CODEX_EVENT_QUEUE_BYTES;
  return {
    [Symbol.asyncIterator](): AsyncIterator<CodexEvent> {
      let eventSource: EventSource | null = null;
      let resolver: ((value: IteratorResult<CodexEvent>) => void) | null = null;
      let rejecter: ((error: Error) => void) | null = null;
      const eventQueue: Array<{ event: CodexEvent; bytes: number }> = [];
      let queuedBytes = 0;
      let endAfterQueue = false;
      let done = false;
      /**
       * Highest revision this connection has seen, including frames that were
       * handed straight to a waiting consumer.
       *
       * The overflow frame needs a cursor even when the frame that tripped the
       * bound carried no `id:`. Without one the caller's cursor would not
       * advance and the reconnect would replay from before the drop.
       */
      let lastSeenRevision: number | undefined = since;

      const handleEvent = (event: MessageEvent) => {
        if (done || endAfterQueue) return;
        try {
          const data = JSON.parse(event.data);
          // `lastEventId` is the SSE `id:` field. Parsed here so consumers get a
          // number and never have to know the wire format.
          const revision = Number.parseInt(event.lastEventId ?? "", 10);
          let codexEvent: CodexEvent = {
            type: event.type as CodexEvent["type"],
            sessionId: data.sessionId,
            data,
            ...(Number.isSafeInteger(revision) && revision >= 0 ? { revision } : {}),
          };
          if (
            codexEvent.revision !== undefined
            && lastSeenRevision !== undefined
            && codexEvent.revision > lastSeenRevision + 1
          ) {
            // Filtered streams still carry a bridge.cursor frame for every
            // other session, so a jump is always a missed frame. Heartbeats
            // intentionally expose this condition while a turn is active.
            codexEvent = {
              type: "session.reconcile-required",
              sessionId: sessionId ?? codexEvent.sessionId,
              data: { reason: "revision-gap" },
              revision: codexEvent.revision,
            };
          }
          if (codexEvent.revision !== undefined) lastSeenRevision = codexEvent.revision;

          if (resolver) {
            resolver({ value: codexEvent, done: false });
            resolver = null;
            rejecter = null;
          } else {
            // Conservatively charge UTF-16 storage plus object/list overhead;
            // the parsed payload, not the raw string, is what the queue retains.
            const bytes = event.data.length * 2 + event.type.length * 2 + 64;
            /**
             * The byte bound describes a *backlog*, so it is only consulted once
             * something is already queued.
             *
             * A single frame arriving into an empty queue is admitted however
             * large it is. Codex messages legitimately reach the bridge's
             * `VERY_LARGE_MESSAGE_CHARS` budget, and rejecting one would close
             * the stream and force a full transcript resync to fetch the very
             * payload that had just been delivered. Retention stays bounded:
             * one oversized frame can sit in the queue, and the next frame trips
             * the bound and reconciles.
             */
            if (
              eventQueue.length + 1 > maxQueuedEvents
              || (eventQueue.length > 0 && queuedBytes + bytes > maxQueuedBytes)
            ) {
              // A slow consumer cannot retain an unbounded transcript/event
              // backlog. Close this connection and hand the caller one explicit
              // recovery frame. Its revision becomes the reconnect cursor after
              // the authoritative snapshot has been applied.
              eventQueue.length = 0;
              queuedBytes = 0;
              const reconcile: CodexEvent = {
                type: "session.reconcile-required",
                sessionId: sessionId ?? codexEvent.sessionId,
                data: { reason: "client-event-queue-overflow" },
                ...(lastSeenRevision === undefined
                  ? {}
                  : { revision: lastSeenRevision }),
              };
              eventQueue.push({ event: reconcile, bytes: 0 });
              endAfterQueue = true;
              eventSource?.close();
              eventSource = null;
            } else {
              eventQueue.push({ event: codexEvent, bytes });
              queuedBytes += bytes;
            }
          }
        } catch (error) {
          console.error("[codex-client] Failed to parse SSE event:", error);
        }
      };

      const cleanup = () => {
        done = true;
        signal?.removeEventListener("abort", cleanup);
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (resolver) {
          resolver({ value: undefined as unknown as CodexEvent, done: true });
        }
      };

      if (signal?.aborted) {
        done = true;
      } else {
        signal?.addEventListener("abort", cleanup, { once: true });

        const url = new URL(`${client.baseUrl}/event/subscribe`);
        // Only sent when we actually have a cursor; a fresh subscription must not
        // ask for a replay from revision 0 and receive the whole ring.
        if (since !== undefined && Number.isSafeInteger(since) && since >= 0) {
          url.searchParams.set("since", String(since));
        }
        if (sessionId) {
          url.searchParams.set("sessionId", sessionId);
        }
        // Native EventSource cannot set Authorization headers. The bridge
        // accepts its per-process bearer token only on this SSE query path.
        if (client.authToken) {
          url.searchParams.set("token", client.authToken);
        }

        eventSource = new EventSource(url.toString());
        for (const eventType of [
          "connected",
          "keepalive",
          "bridge.cursor",
          "session.updated",
          "session.idle",
          "session.error",
          "session.warning",
          "session.title-updated",
          "session.structured-output",
          "message.updated",
          "message.patched",
          "session.approval-requested",
          "session.approval-resolved",
          // Named SSE events are only delivered to an explicit listener, so a
          // missing entry here silently drops every interaction frame the bridge
          // emits — the card never appears and the turn blocks until auto-deny.
          "session.interaction-requested",
          "session.interaction-resolved",
          "session.reconcile-required",
        ]) {
          eventSource.addEventListener(eventType, handleEvent);
        }

        eventSource.onerror = () => {
          if (rejecter && !done) {
            rejecter(new Error("SSE connection error"));
            resolver = null;
            rejecter = null;
          }
          cleanup();
        };
      }

      return {
        next(): Promise<IteratorResult<CodexEvent>> {
          if (done) {
            return Promise.resolve({
              value: undefined as unknown as CodexEvent,
              done: true,
            });
          }

          if (eventQueue.length > 0) {
            const queued = eventQueue.shift()!;
            queuedBytes -= queued.bytes;
            return Promise.resolve({ value: queued.event, done: false });
          }

          if (endAfterQueue) {
            done = true;
            return Promise.resolve({
              value: undefined as unknown as CodexEvent,
              done: true,
            });
          }

          return new Promise((resolve, reject) => {
            resolver = resolve;
            rejecter = reject;
          });
        },

        return(): Promise<IteratorResult<CodexEvent>> {
          cleanup();
          return Promise.resolve({
            value: undefined as unknown as CodexEvent,
            done: true,
          });
        },

        throw(error: Error): Promise<IteratorResult<CodexEvent>> {
          cleanup();
          return Promise.reject(error);
        },
      };
    },
  };
}
