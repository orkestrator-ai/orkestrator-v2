// Claude Bridge Server client wrapper
// Provides typed functions for interacting with the Claude bridge server

import { resolveGatewayLoopbackBaseUrl } from "./gateway-url";
import { isRendererDebugLoggingEnabled, rendererDebugLog } from "./debug-log";
import type {
  ClaudeModelCatalogEntry,
  ClaudeModelCatalogSnapshot,
} from "@/types";
import {
  isStructuredOutputResult,
  structuredOutputFailure,
  type JsonSchema,
  type StructuredOutputResult,
  StructuredOutputReadUnavailableError,
} from "@orkestrator/protocol/structured-output";
import type { TaskListSnapshot } from "@orkestrator/protocol/task-list";

export type { ClaudeModelCatalogSnapshot };
export type {
  TaskListSnapshot,
  TaskSnapshotItem,
  TaskSnapshotStatus,
} from "@orkestrator/protocol/task-list";

/**
 * Session key used as the Map key in the Zustand store.
 * Format: "env-{environmentId}:{tabId}" (e.g., "env-a33f9026...:default")
 * This is NOT the Claude SDK session ID - it's our internal key for organizing sessions.
 */
export type ClaudeSessionKey = string;

/**
 * Claude SDK session ID returned by the bridge server.
 * Format: "session-{uuid}" (e.g., "session-e4abc3ee-b0a9-4328-9bf3-28376ddb7b3d")
 * This is the actual session identifier used by the Claude Agent SDK.
 */
export type ClaudeSdkSessionId = string;

/** Diff metadata for edit tool operations */
export interface ToolDiffMetadata {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

/** Part types for Claude messages */
export interface ClaudeMessagePart {
  type: "text" | "thinking" | "tool-invocation" | "tool-result" | "file";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
  /** Count surfaced by provider UI/transcript metadata when child tool records are unavailable. */
  toolUseCount?: number;
  /** Numeric token count surfaced by provider UI/transcript metadata. */
  tokenCount?: number;
  /** Display text for compact provider token counts, e.g. "20.4k tokens". */
  tokenCountText?: string;
  /** Renderer hint for agent rows when provider metadata is token-only. */
  agentUsageDisplay?: "token-only";
  /** Tool use ID for this tool invocation */
  toolUseId?: string;
  /** Parent Task tool use ID - used to group child tools under their parent Task */
  parentTaskUseId?: string;
  /** Internal: Message UUID for tracking thinking parts (can be ignored by renderers) */
  _messageUuid?: string;
  /** Whether this tool is from an MCP server */
  isMcpTool?: boolean;
  /** The MCP server name if this is an MCP tool */
  mcpServerName?: string;
  /**
   * State of the whole task list immediately after this tool call, for task
   * tools. Always supplied by a backend that saw the call — the bridge in
   * Native Mode, the tmux session's transcript reader in tmux mode — never
   * derived here. Absent for TodoWrite, for output the registry could not
   * parse, and for messages recorded before this was tracked.
   */
  taskSnapshot?: TaskListSnapshot;
}

/** MCP server info from the bridge server */
export interface McpServerInfo {
  name: string;
  type: "http" | "stdio";
  url?: string;
  command?: string;
  source: "global" | "project";
}

/** Plugin info from the bridge server */
export interface PluginInfo {
  name: string;
  path: string;
  description?: string;
  source: "global" | "project" | "cli";
  enabled: boolean;
}

/** MCP server runtime status from session init */
export interface McpServerRuntimeStatus {
  name: string;
  status: "connected" | "failed";
  error?: string;
  tools?: string[];
}

/** Plugin runtime status from session init */
export interface PluginRuntimeStatus {
  name: string;
  path?: string;
  status: "loaded" | "failed";
  error?: string;
}

/** Session initialization data */
export interface SessionInitData {
  mcpServers: McpServerRuntimeStatus[];
  plugins: PluginRuntimeStatus[];
  slashCommands?: string[];
}

export interface ClaudeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: ClaudeMessagePart[];
  timestamp: string;
  /**
   * Frames the bridge has published for this message, starting at 1. Present
   * only on assistant messages from a streaming turn — both over SSE and in
   * the REST transcript, which is what lets a client that recovered by
   * refetching rejoin the patch stream. See `applyClaudeMessagePatch`.
   */
  revision?: number;
}

/**
 * Payload of a `message.patched` event: the parts of an assistant message that
 * changed since the previous frame, addressed by index.
 *
 * The bridge sends a message in full once, then patches it for the rest of the
 * turn — a streaming turn publishes ~10 frames a second, and re-sending every
 * tool output and written file on each of them is O(turn size) per frame.
 *
 * A recipient holding no message with `messageId`, or holding one that is not
 * at `revision - 1`, cannot apply the patch and must refetch the transcript
 * instead; live events are never the only source of truth.
 */
export interface ClaudeMessagePatch {
  messageId: string;
  /** Final length of the parts array after applying this patch. */
  partCount: number;
  changedParts: { index: number; part: ClaudeMessagePart }[];
  timestamp: string;
  /** Revision this patch produces; valid only against a copy at `revision - 1`. */
  revision: number;
}

/**
 * Rebuild a message's flat text from its parts.
 *
 * Mirrors the bridge's own rule (`getMessageTextFromParts`) so a patched
 * message ends up with exactly the `content` a full frame would have carried,
 * without every patch having to re-send the whole thing.
 */
export function contentFromParts(parts: ClaudeMessagePart[]): string {
  let content = "";
  for (const part of parts) {
    if (part.type === "text") content += part.content || "";
  }
  return content;
}

/**
 * Whether `patch` is well-formed and is the immediate successor of `message`.
 *
 * This is a trust boundary: the payload arrives as JSON from a subprocess, and
 * an unchecked `changedParts` or `partCount` would throw out of the SSE loop
 * and tear down the whole environment's event subscription. Every rejection
 * here is recoverable — the caller refetches the authoritative transcript.
 */
function isApplicablePatch(message: ClaudeMessage, patch: ClaudeMessagePatch): boolean {
  if (!patch || typeof patch !== "object") return false;
  if (!Array.isArray(patch.changedParts)) return false;
  if (!Number.isInteger(patch.partCount) || patch.partCount < 0) return false;

  // Revision continuity. A patch that is not the next revision means frames
  // were missed — the subscription reconnected mid-turn, or a refetch landed
  // out of order — and applying it by index would corrupt the transcript with
  // parts that will never be re-sent.
  const base = message.revision;
  if (!Number.isInteger(base) || patch.revision !== (base as number) + 1) return false;

  for (const change of patch.changedParts) {
    if (!change || typeof change !== "object") return false;
    if (!Number.isInteger(change.index)) return false;
    if (change.index < 0 || change.index >= patch.partCount) return false;
    if (!change.part || typeof change.part !== "object") return false;
  }

  return true;
}

/**
 * Apply a patch to a message, returning a new message — or null when the patch
 * cannot be applied and the caller must refetch instead.
 *
 * Indices beyond the current array are appends; `partCount` then truncates,
 * which is what makes a finalized message replacing streamed blocks
 * representable.
 */
export function applyClaudeMessagePatch(
  message: ClaudeMessage,
  patch: ClaudeMessagePatch,
): ClaudeMessage | null {
  if (!isApplicablePatch(message, patch)) return null;

  const parts = message.parts.slice();
  for (const { index, part } of patch.changedParts) {
    parts[index] = part;
  }
  parts.length = patch.partCount;

  // A hole means this copy was missing parts the patch grew past. Revision
  // continuity should already have caught that, so treat it as a second line
  // of defence: reject rather than paper over it with blank blocks, which is
  // indistinguishable from real empty output once rendered.
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index]) return null;
  }

  return {
    ...message,
    parts,
    content: contentFromParts(parts),
    timestamp: patch.timestamp || message.timestamp,
    revision: patch.revision,
  };
}

export interface ClaudeSession {
  id: string;
  title?: string;
  status: "idle" | "running" | "error";
  createdAt: string;
  lastActivity: string;
  error?: string;
}

export type ClaudeSessionLookupResult =
  | { kind: "found"; session: ClaudeSession }
  | { kind: "missing" }
  | { kind: "unavailable"; error: Error };

/** Effort level for controlling Claude's thinking depth */
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeModel extends ClaudeModelCatalogEntry {
  supportedEffortLevels?: ClaudeEffortLevel[];
}

/** Question option for AskUserQuestion tool */
export interface QuestionOption {
  label: string;
  description?: string;
  value?: string;
}

/** Question info structure */
export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** Question request from Claude */
export interface ClaudeQuestionRequest {
  id: string;
  sessionId: string;
  questions: QuestionInfo[];
  toolUseId?: string;
}

/** Plan approval request from Claude (when ExitPlanMode is called) */
export interface ClaudePlanApprovalRequest {
  id: string;
  sessionId: string;
  toolUseId?: string;
}

/** Event data for plan.approval-requested events */
export interface PlanApprovalRequestedEventData {
  id: string;
  sessionId?: string;
  toolUseId?: string;
}

/** Event data for plan.approval-responded events */
export interface PlanApprovalRespondedEventData {
  requestId: string;
  approved: boolean;
  feedback?: string;
}

/** Data payload for system.compact event */
export interface SystemCompactEventData {
  preTokens?: number;
  postTokens?: number;
  trigger?: string;
}

/** Data payload for system.message event */
export interface SystemMessageEventData {
  subtype: string;
  message?: unknown;
}

/** SSE event from Claude bridge server */
export interface ClaudeEvent {
  type:
    | "connected"
    | "keepalive"
    | "session.updated"
    | "session.idle"
    | "session.error"
    | "session.init"
    | "session.title-updated"
    | "session.structured-output"
    | "message.updated"
    | "message.patched"
    | "question.asked"
    | "question.answered"
    | "plan.enter-requested"
    | "plan.exit-requested"
    | "plan.approval-requested"
    | "plan.approval-responded"
    | "system.compact"
    | "system.message";
  sessionId?: string;
  data?: unknown;
}

/**
 * Event types never worth scanning for a context-usage snapshot.
 *
 * `extractContextUsage` walks a payload breadth-first. These are the
 * highest-frequency frames and also the largest, and none of them carries
 * usage — transcript frames describe message content, keepalives and
 * handshakes carry nothing. Every other event type is still scanned, so an
 * event that starts carrying usage keeps working without being listed here.
 */
export const USAGE_SCAN_EXEMPT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message.updated",
  "message.patched",
  "keepalive",
  "connected",
]);

/** Attachment for prompts */
export interface ClaudeAttachment {
  type: "file" | "image";
  path: string;
  dataUrl?: string;
  filename?: string;
}

/** Prefix for client-side error message IDs */
export const ERROR_MESSAGE_PREFIX = "error-";

/** Prefix for client-side system message IDs (e.g., compact notifications) */
export const SYSTEM_MESSAGE_PREFIX = "system-";

/** Claude Bridge Client */
export interface ClaudeClient {
  baseUrl: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a Claude bridge client
 */
export function createClient(baseUrl: string): ClaudeClient {
  return { baseUrl: resolveGatewayLoopbackBaseUrl(baseUrl) };
}

/**
 * Check server health
 */
export async function checkHealth(client: ClaudeClient): Promise<boolean> {
  try {
    const response = await fetch(`${client.baseUrl}/global/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get available models
 */
export async function getModels(client: ClaudeClient): Promise<ClaudeModel[]> {
  try {
    const response = await fetchWithTimeout(`${client.baseUrl}/config/models`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.models || [];
  } catch (error) {
    console.error("[claude-client] Failed to get models:", error);
    return [];
  }
}

/**
 * Create a new session
 */
export async function createSession(
  client: ClaudeClient,
  title?: string
): Promise<{ sessionId: string; title?: string } | null> {
  try {
    const response = await fetchWithTimeout(`${client.baseUrl}/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[claude-client] Failed to create session:", error);
    return null;
  }
}

/**
 * List all sessions
 */
export async function listSessions(
  client: ClaudeClient
): Promise<
  Array<{
    id: string;
    title?: string;
    status: "idle" | "running" | "error";
    createdAt: string;
    lastActivity: string;
  }>
> {
  try {
    const response = await fetch(`${client.baseUrl}/session/list`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.sessions || [];
  } catch (error) {
    console.error("[claude-client] Failed to list sessions:", error);
    return [];
  }
}

/**
 * Look up session details without conflating an absent session with an
 * unavailable bridge.
 */
export async function lookupSession(
  client: ClaudeClient,
  sessionId: string,
): Promise<ClaudeSessionLookupResult> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}`,
    );
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok) {
      return {
        kind: "unavailable",
        error: new Error(`Failed to get Claude session: HTTP ${response.status}`),
      };
    }
    const session = (await response.json()) as Partial<ClaudeSession>;
    if (
      typeof session.id !== "string"
      || (
        session.status !== "idle"
        && session.status !== "running"
        && session.status !== "error"
      )
      || typeof session.createdAt !== "string"
      || typeof session.lastActivity !== "string"
    ) {
      return {
        kind: "unavailable",
        error: new Error("Claude session response was malformed"),
      };
    }
    return {
      kind: "found",
      session: session as ClaudeSession,
    };
  } catch (error) {
    return {
      kind: "unavailable",
      error: error instanceof Error
        ? error
        : new Error("Failed to get Claude session"),
    };
  }
}

/**
 * Get session details. Retains the legacy null-on-missing-or-unavailable
 * contract; reconciliation callers should use lookupSession.
 */
export async function getSession(
  client: ClaudeClient,
  sessionId: string,
): Promise<ClaudeSession | null> {
  const result = await lookupSession(client, sessionId);
  if (result.kind === "found") return result.session;
  if (result.kind === "unavailable") {
    console.error("[claude-client] Failed to get session:", result.error);
  }
  return null;
}

/** Error thrown when a session is not found on the server */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

/**
 * Get messages for a session
 * @throws {SessionNotFoundError} if the session does not exist on the server
 */
export async function getSessionMessages(
  client: ClaudeClient,
  sessionId: string,
  options: { throwOnError?: boolean } = {},
): Promise<ClaudeMessage[]> {
  rendererDebugLog("[claude-client] Fetching messages for session:", sessionId);
  const response = await fetch(`${client.baseUrl}/session/${sessionId}/messages`);
  if (response.status === 404) {
    throw new SessionNotFoundError(sessionId);
  }
  if (!response.ok) {
    console.debug("[claude-client] Failed to fetch messages, status:", response.status);
    if (options.throwOnError) {
      throw new Error(`Failed to get Claude session messages: HTTP ${response.status}`);
    }
    return [];
  }
  const data = await response.json();
  // `rawData` is the entire transcript. A tab that refetches on every frame
  // (BuildChatTab does) would otherwise pin a copy of the whole conversation
  // in the console several times a second.
  if (isRendererDebugLoggingEnabled) {
    rendererDebugLog("[claude-client] Received messages response:", {
      sessionId,
      messageCount: data.messages?.length || 0,
      rawData: data,
    });
  }
  return data.messages || [];
}

/** Permission mode for Claude Agent SDK */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

/**
 * Send a prompt to a session (async - returns immediately, results via SSE)
 */
export async function sendPrompt(
  client: ClaudeClient,
  sessionId: string,
  prompt: string,
  options?: {
    model?: string;
    attachments?: ClaudeAttachment[];
    effort?: ClaudeEffortLevel;
    permissionMode?: PermissionMode;
    fastMode?: boolean;
    outputSchema?: JsonSchema;
    requestId?: string;
  }
): Promise<boolean> {
  try {
    console.debug("[claude-client] Sending prompt", {
      sessionId,
      promptLength: prompt.length,
      model: options?.model,
      attachmentsCount: options?.attachments?.length ?? 0,
      effort: options?.effort,
      permissionMode: options?.permissionMode,
      fastMode: options?.fastMode,
      structured: options?.outputSchema !== undefined,
    });
    const response = await fetch(`${client.baseUrl}/session/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        model: options?.model,
        attachments: options?.attachments,
        effort: options?.effort,
        permissionMode: options?.permissionMode,
        fastMode: options?.fastMode,
        outputSchema: options?.outputSchema,
        requestId: options?.requestId,
      }),
    });
    console.debug("[claude-client] Prompt response", {
      sessionId,
      status: response.status,
      ok: response.ok,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[claude-client] Prompt failed", { sessionId, status: response.status, text });
    }
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to send prompt:", error);
    return false;
  }
}

export interface ClaudeStructuredPromptAccepted {
  status: "processing" | "already-processed";
  requestId: string;
  duplicate?: boolean;
}

/** Dispatch a schema-constrained turn while retaining Claude's normal tool set. */
export async function sendStructuredPrompt(
  client: ClaudeClient,
  sessionId: string,
  prompt: string,
  outputSchema: JsonSchema,
  options: {
    model?: string;
    attachments?: ClaudeAttachment[];
    effort?: ClaudeEffortLevel;
    permissionMode?: PermissionMode;
    fastMode?: boolean;
    requestId?: string;
  } = {},
): Promise<ClaudeStructuredPromptAccepted | null> {
  const requestId = options.requestId ?? crypto.randomUUID();
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...options, prompt, outputSchema, requestId }),
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => ({}))) as {
      requestId?: unknown;
      status?: unknown;
      duplicate?: unknown;
    };
    return {
      status: body.status === "already-processed" ? "already-processed" : "processing",
      requestId: typeof body.requestId === "string" ? body.requestId : requestId,
      duplicate: body.duplicate === true,
    };
  } catch (error) {
    console.error("[claude-client] Failed to send structured prompt:", error);
    return null;
  }
}

/**
 * Rehydrate a completed structured turn from bridge-owned session state.
 * `null` means the requested turn is still pending or no such turn is known.
 */
export async function getStructuredOutput<T = unknown>(
  client: ClaudeClient,
  sessionId: string,
  requestId?: string,
): Promise<StructuredOutputResult<T> | null> {
  let response: Response;
  try {
    const query = requestId ? `?requestId=${encodeURIComponent(requestId)}` : "";
    response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/structured-output${query}`,
    );
  } catch (error) {
    throw new StructuredOutputReadUnavailableError(
      "claude",
      error instanceof Error
        ? error.message
        : "Failed to read Claude structured output.",
      { requestId, cause: error },
    );
  }
  if (!response.ok) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return structuredOutputFailure(
      "claude",
      "malformed_output",
      "Claude bridge returned malformed JSON for structured output.",
      { requestId },
    );
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return structuredOutputFailure(
      "claude",
      "malformed_output",
      "Claude bridge returned a malformed structured-output envelope.",
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
    "claude",
    "malformed_output",
    "Claude bridge returned a malformed structured-output envelope.",
    { requestId },
  );
}

/**
 * Abort a running session
 */
export async function abortSession(
  client: ClaudeClient,
  sessionId: string
): Promise<boolean> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}/abort`, {
      method: "POST",
    });
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to abort session:", error);
    return false;
  }
}

/**
 * Delete a session
 */
export async function deleteSession(
  client: ClaudeClient,
  sessionId: string
): Promise<boolean> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to delete session:", error);
    return false;
  }
}

/**
 * Get pending questions for a session
 */
export async function getPendingQuestions(
  client: ClaudeClient,
  sessionId: string,
  options: { throwOnError?: boolean } = {},
): Promise<ClaudeQuestionRequest[]> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}/questions`);
    if (!response.ok) {
      throw new Error(`Failed to get pending Claude questions: HTTP ${response.status}`);
    }
    const data = await response.json();
    return data.questions || [];
  } catch (error) {
    console.error("[claude-client] Failed to get pending questions:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get pending Claude questions");
    }
    return [];
  }
}

/**
 * Get pending plan approval requests for a session.
 */
export async function getPendingPlanApprovals(
  client: ClaudeClient,
  sessionId: string,
  options: { throwOnError?: boolean } = {},
): Promise<ClaudePlanApprovalRequest[]> {
  try {
    const response = await fetch(
      `${client.baseUrl}/session/${sessionId}/plan-approvals`,
    );
    if (!response.ok) {
      throw new Error(
        `Failed to get pending Claude plan approvals: HTTP ${response.status}`,
      );
    }
    const data = await response.json();
    return data.approvals || [];
  } catch (error) {
    console.error("[claude-client] Failed to get pending plan approvals:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get pending Claude plan approvals");
    }
    return [];
  }
}

/**
 * Answer a question
 */
export async function answerQuestion(
  client: ClaudeClient,
  sessionId: string,
  questionId: string,
  answers: string[][]
): Promise<boolean> {
  try {
    const response = await fetch(
      `${client.baseUrl}/session/${sessionId}/questions/${questionId}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      }
    );
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to answer question:", error);
    return false;
  }
}

/**
 * Dismiss a question and release the bridge-side SDK callback.
 */
export async function dismissQuestion(
  client: ClaudeClient,
  sessionId: string,
  questionId: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${client.baseUrl}/session/${sessionId}/questions/${questionId}`,
      { method: "DELETE" },
    );
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to dismiss question:", error);
    return false;
  }
}

/**
 * Respond to a plan approval request (approve or reject)
 */
export async function respondToPlanApproval(
  client: ClaudeClient,
  sessionId: string,
  approvalId: string,
  approved: boolean,
  feedback?: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `${client.baseUrl}/session/${sessionId}/plan-approvals/${approvalId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, feedback }),
      }
    );
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to respond to plan approval:", error);
    return false;
  }
}

/**
 * Get configured MCP servers
 */
export async function getMcpServers(
  client: ClaudeClient
): Promise<{ servers: McpServerInfo[]; cwd: string }> {
  try {
    const response = await fetchWithTimeout(`${client.baseUrl}/mcp/servers`);
    if (!response.ok) return { servers: [], cwd: "" };
    return await response.json();
  } catch (error) {
    console.error("[claude-client] Failed to get MCP servers:", error);
    return { servers: [], cwd: "" };
  }
}

/**
 * Get configured plugins
 */
export async function getPlugins(
  client: ClaudeClient
): Promise<{ plugins: PluginInfo[]; cwd: string }> {
  try {
    const response = await fetchWithTimeout(`${client.baseUrl}/plugins`);
    if (!response.ok) return { plugins: [], cwd: "" };
    return await response.json();
  } catch (error) {
    console.error("[claude-client] Failed to get plugins:", error);
    return { plugins: [], cwd: "" };
  }
}

/**
 * Get session initialization data (MCP servers, plugins, slash commands status)
 */
export async function getSessionInitData(
  client: ClaudeClient,
  sessionId: string
): Promise<SessionInitData | null> {
  try {
    const response = await fetchWithTimeout(`${client.baseUrl}/session/${sessionId}/init`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.initData || null;
  } catch (error) {
    console.error("[claude-client] Failed to get session init data:", error);
    return null;
  }
}

/**
 * Get discovered slash commands from plugins and project .claude/commands/.
 * This can be called before any session query, unlike getSessionInitData which
 * only has slash commands after the first SDK query.
 */
export async function getSlashCommands(
  client: ClaudeClient,
  signal?: AbortSignal
): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/plugins/commands`,
      signal ? { signal } : {}
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.commands || [];
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return [];
    console.debug("[claude-client] Failed to get slash commands:", error);
    return [];
  }
}

/**
 * Subscribe to SSE events from the server
 * Returns an async iterator for events
 */
export function subscribeToEvents(
  client: ClaudeClient,
  signal?: AbortSignal
): AsyncIterable<ClaudeEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<ClaudeEvent> {
      let eventSource: EventSource | null = null;
      let resolver: ((value: IteratorResult<ClaudeEvent>) => void) | null = null;
      let rejecter: ((error: Error) => void) | null = null;
      const eventQueue: ClaudeEvent[] = [];
      let done = false;

      const handleEvent = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          // Guarded rather than passed through `rendererDebugLog`: this runs on
          // every frame of every running turn, so the object literal would be
          // allocated per frame only to be dropped.
          if (isRendererDebugLoggingEnabled) {
            rendererDebugLog("[claude-client] SSE event received", {
              type: event.type,
              sessionId: data.sessionId,
            });
          }
          const claudeEvent: ClaudeEvent = {
            type: event.type as ClaudeEvent["type"],
            sessionId: data.sessionId,
            data,
          };

          if (resolver) {
            resolver({ value: claudeEvent, done: false });
            resolver = null;
            rejecter = null;
          } else {
            eventQueue.push(claudeEvent);
          }
        } catch (error) {
          console.error("[claude-client] Failed to parse SSE event:", error);
        }
      };

      const cleanup = () => {
        done = true;
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (resolver) {
          resolver({ value: undefined as unknown as ClaudeEvent, done: true });
        }
      };

      // Handle abort signal
      signal?.addEventListener("abort", cleanup);

      // Create EventSource
      eventSource = new EventSource(`${client.baseUrl}/event/subscribe`);
      eventSource.onopen = () => {
        console.debug("[claude-client] SSE connection opened");
      };

      // Listen for different event types
      const eventTypes = [
        "connected",
        "keepalive",
        "session.updated",
        "session.idle",
        "session.error",
        "session.init",
        "session.title-updated",
        "session.structured-output",
        "message.updated",
        "message.patched",
        "question.asked",
        "question.answered",
        "plan.enter-requested",
        "plan.exit-requested",
        "plan.approval-requested",
        "plan.approval-responded",
        "system.compact",
        "system.message",
      ];

      for (const eventType of eventTypes) {
        eventSource.addEventListener(eventType, handleEvent);
      }

      eventSource.onerror = () => {
        console.error("[claude-client] SSE connection error", {
          readyState: eventSource?.readyState,
        });
        if (rejecter && !done) {
          rejecter(new Error("SSE connection error"));
          resolver = null;
          rejecter = null;
        }
        cleanup();
      };

      return {
        next(): Promise<IteratorResult<ClaudeEvent>> {
          if (done) {
            return Promise.resolve({ value: undefined as unknown as ClaudeEvent, done: true });
          }

          // If we have queued events, return one
          if (eventQueue.length > 0) {
            return Promise.resolve({ value: eventQueue.shift()!, done: false });
          }

          // Wait for next event
          return new Promise((resolve, reject) => {
            resolver = resolve;
            rejecter = reject;
          });
        },

        return(): Promise<IteratorResult<ClaudeEvent>> {
          cleanup();
          return Promise.resolve({ value: undefined as unknown as ClaudeEvent, done: true });
        },

        throw(error: Error): Promise<IteratorResult<ClaudeEvent>> {
          cleanup();
          return Promise.reject(error);
        },
      };
    },
  };
}
