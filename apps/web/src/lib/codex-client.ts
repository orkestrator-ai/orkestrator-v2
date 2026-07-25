import type { NativeMessage, NativeMessagePart } from "./chat/native-message-types";
import { resolveGatewayLoopbackBaseUrl } from "./gateway-url";

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
  requestId?: string;
  engineGeneration?: number;
}

export interface CodexClient {
  baseUrl: string;
}

export interface CodexMessage {
  id: string;
  role: NativeMessage["role"];
  content: string;
  parts: NativeMessagePart[];
  createdAt: string;
  planReview?: boolean;
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
  /** The prompt request id this turn is executing, for reconnect reconciliation. */
  requestId?: string;
  engineGeneration?: number;
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
    | "session.updated"
    | "session.idle"
    | "session.error"
    | "session.title-updated"
    | "message.updated"
    | "session.approval-requested"
    | "session.approval-resolved"
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
  supportsApproveForSession: boolean;
}

/**
 * Outcome of answering an approval.
 *
 * `stale` is expected, not exceptional: the five-minute window can close while the
 * user is deciding, and a restart withdraws the request outright.
 */
export type CodexApprovalResponseResult = "applied" | "stale" | "forbidden" | "error";

function parseApproval(value: unknown): CodexApproval | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const kind = entry.kind;
  if (
    typeof entry.approvalId !== "string"
    || (kind !== "command" && kind !== "file-change" && kind !== "permissions")
    || typeof entry.method !== "string"
    || (entry.threadId !== null && typeof entry.threadId !== "string")
    || (entry.turnId !== null && typeof entry.turnId !== "string")
    || (entry.itemId !== null && typeof entry.itemId !== "string")
    || typeof entry.requestedAt !== "number"
    || !Number.isFinite(entry.requestedAt)
    || typeof entry.expiresAt !== "number"
    || !Number.isFinite(entry.expiresAt)
    || typeof entry.supportsApproveForSession !== "boolean"
  ) {
    return null;
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

export function createClient(baseUrl: string): CodexClient {
  return { baseUrl: resolveGatewayLoopbackBaseUrl(baseUrl) };
}

export async function checkHealth(client: CodexClient): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${client.baseUrl}/global/health`);
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
    const response = await fetchWithTimeout(`${client.baseUrl}/global/health`);
    if (!response.ok) return null;
    return (await response.json()) as CodexBridgeHealth;
  } catch {
    return null;
  }
}

export async function getModels(client: CodexClient): Promise<CodexModelsResponse> {
  try {
    const response = await fetchWithTimeout(`${client.baseUrl}/global/models`);
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
    const response = await fetchWithTimeout(`${client.baseUrl}/global/slash-commands`);
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
  },
): Promise<CodexSession> {
  const response = await fetchWithTimeout(`${client.baseUrl}/session/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: options?.title,
      model: options?.model,
      modelReasoningEffort: options?.modelReasoningEffort,
      mode: options?.mode,
      fastMode: options?.fastMode,
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
    const response = await fetchWithTimeout(`${client.baseUrl}/session/list`);
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
    const response = await fetchWithTimeout(`${client.baseUrl}/session/resume`, {
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
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/config`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      },
    );
    return response.ok;
  } catch (error) {
    console.error("[codex-client] Failed to update session config:", error);
    return false;
  }
}

export async function getSessionMessages(
  client: CodexClient,
  sessionId: string,
  options: { throwOnError?: boolean } = {},
): Promise<CodexMessage[]> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/messages`,
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

export async function lookupSessionStatus(
  client: CodexClient,
  sessionId: string,
): Promise<CodexSessionStatusLookupResult> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/status`,
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
        ...(typeof data.requestId === "string" ? { requestId: data.requestId } : {}),
        ...(typeof data.engineGeneration === "number"
          ? { engineGeneration: data.engineGeneration }
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
  duplicate?: boolean;
}

/**
 * Sends a prompt.
 *
 * Returns the acceptance details, or `null` on failure. Callers that only need a
 * success check can keep treating the result as a boolean — an object is truthy
 * and `null` is falsy.
 */
export async function sendPrompt(
  client: CodexClient,
  sessionId: string,
  prompt: string,
  options?: {
    attachments?: CodexPromptAttachment[];
    requestId?: string;
  },
): Promise<CodexPromptAcceptedResponse | null> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          attachments: options?.attachments,
          requestId: options?.requestId,
        }),
      },
    );
    if (!response.ok) return null;

    const data = (await response.json().catch(() => ({}))) as Partial<CodexPromptAcceptedResponse>;
    return {
      status: data.status === "already-processed" ? "already-processed" : "processing",
      requestId: typeof data.requestId === "string" ? data.requestId : options?.requestId,
      threadId: typeof data.threadId === "string" ? data.threadId : null,
      turnId: typeof data.turnId === "string" ? data.turnId : undefined,
      duplicate: data.duplicate === true,
    };
  } catch (error) {
    console.error("[codex-client] Failed to send prompt:", error);
    return null;
  }
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
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/abort`,
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
  const response = await fetchWithTimeout(
    `${client.baseUrl}/session/${sessionId}/approvals`,
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
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/approvals/${encodeURIComponent(approvalId)}`,
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
    return "error";
  }
}

export async function deleteSession(
  client: CodexClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}`,
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
 */
export function subscribeToEvents(
  client: CodexClient,
  signal?: AbortSignal,
  since?: number,
): AsyncIterable<CodexEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<CodexEvent> {
      let eventSource: EventSource | null = null;
      let resolver: ((value: IteratorResult<CodexEvent>) => void) | null = null;
      let rejecter: ((error: Error) => void) | null = null;
      const eventQueue: CodexEvent[] = [];
      let done = false;

      const handleEvent = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          // `lastEventId` is the SSE `id:` field. Parsed here so consumers get a
          // number and never have to know the wire format.
          const revision = Number.parseInt(event.lastEventId ?? "", 10);
          const codexEvent: CodexEvent = {
            type: event.type as CodexEvent["type"],
            sessionId: data.sessionId,
            data,
            ...(Number.isSafeInteger(revision) && revision >= 0 ? { revision } : {}),
          };

          if (resolver) {
            resolver({ value: codexEvent, done: false });
            resolver = null;
            rejecter = null;
          } else {
            eventQueue.push(codexEvent);
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

        eventSource = new EventSource(url.toString());
        for (const eventType of [
          "connected",
          "keepalive",
          "session.updated",
          "session.idle",
          "session.error",
          "session.title-updated",
          "message.updated",
          "session.approval-requested",
          "session.approval-resolved",
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
            return Promise.resolve({ value: eventQueue.shift()!, done: false });
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
