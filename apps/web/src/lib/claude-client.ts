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
import type { ContextUsageSnapshot } from "@/lib/context-usage";

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
  /** When this content block first arrived from the Claude bridge. */
  timestamp?: string;
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
  agents?: ClaudeAgentProfile[];
}

export interface ClaudeAgentProfile {
  name: string;
  description?: string;
  model?: string;
  color?: string;
}

export interface ClaudeBackgroundTask {
  id: string;
  description?: string;
  status: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
  isBackgrounded?: boolean;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

const CLAUDE_BACKGROUND_TASK_STATUSES = new Set<ClaudeBackgroundTask["status"]>([
  "pending",
  "running",
  "completed",
  "failed",
  "killed",
  "paused",
]);

const CONTEXT_USAGE_SOURCES = new Set<NonNullable<ContextUsageSnapshot["source"]>>([
  "claude",
  "opencode",
  "codex",
  "heuristic",
  "provider",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalNonNegativeNumber(value: unknown): value is number | undefined {
  return isOptionalFiniteNumber(value) && (value === undefined || value >= 0);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

const OPTIONAL_USAGE_NUMBER_KEYS = [
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
 * Validate exact provider usage snapshots before they cross the REST/SSE trust
 * boundary into Zustand. UI formatters assume finite numeric fields.
 *
 * Same policy as the sibling `parseContextUsage` in codex-client.ts: rejection
 * is reserved for the required numeric triple, and every optional decoration is
 * kept only when it is the right shape — one malformed extra (a rate-limit
 * window the bridge forwarded unclamped, a stray string where a count belongs)
 * never costs the reading itself. Dropped optional fields are reported by name
 * through `droppedFields` so callers can surface them the way they surface a
 * rejected snapshot (`invalidMetadataFields`).
 */
export function parseClaudeContextUsage(
  value: unknown,
  droppedFields?: string[],
): ContextUsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const { usedTokens, totalTokens, percentUsed } = value;

  // The required triple: anything wrong here means there is no usable reading.
  if (
    typeof usedTokens !== "number"
    || !Number.isFinite(usedTokens)
    || usedTokens < 0
    || typeof totalTokens !== "number"
    || !Number.isFinite(totalTokens)
    || totalTokens <= 0
    || usedTokens > totalTokens
    || typeof percentUsed !== "number"
    || !Number.isFinite(percentUsed)
    || percentUsed < 0
    || percentUsed > 100
  ) {
    return undefined;
  }

  const drop = (field: string) => {
    if (droppedFields && !droppedFields.includes(field)) droppedFields.push(field);
  };
  const result: ContextUsageSnapshot = { usedTokens, totalTokens, percentUsed };
  const extras = result as unknown as Record<string, unknown>;

  for (const key of OPTIONAL_USAGE_NUMBER_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (isOptionalNonNegativeNumber(candidate)) extras[key] = candidate;
    else drop(key);
  }

  for (const key of ["modelId", "updatedAt"] as const) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate === "string") extras[key] = candidate;
    else drop(key);
  }

  if (value.estimated !== undefined) {
    if (typeof value.estimated === "boolean") result.estimated = value.estimated;
    else drop("estimated");
  }

  if (value.source !== undefined) {
    if (
      typeof value.source === "string"
      && CONTEXT_USAGE_SOURCES.has(value.source as NonNullable<ContextUsageSnapshot["source"]>)
    ) {
      result.source = value.source as ContextUsageSnapshot["source"];
    } else {
      drop("source");
    }
  }

  if (value.rateLimits !== undefined) {
    if (Array.isArray(value.rateLimits)) {
      const windows = value.rateLimits.flatMap((entry) => {
        if (
          isRecord(entry)
          && typeof entry.label === "string"
          && isOptionalNonNegativeNumber(entry.usedPercent)
          && (entry.usedPercent === undefined || entry.usedPercent <= 100)
          && isOptionalString(entry.resetsAt)
          && isOptionalNonNegativeNumber(entry.windowMinutes)
        ) {
          return [{
            label: entry.label,
            ...(entry.usedPercent !== undefined ? { usedPercent: entry.usedPercent } : {}),
            ...(entry.resetsAt !== undefined ? { resetsAt: entry.resetsAt } : {}),
            ...(entry.windowMinutes !== undefined
              ? { windowMinutes: entry.windowMinutes }
              : {}),
          }];
        }
        // e.g. `usedPercent > 100`: the bridge forwards utilization unclamped,
        // so an overdrawn window is dropped rather than costing the reading.
        drop("rateLimits");
        return [];
      });
      if (windows.length > 0) result.rateLimits = windows;
    } else {
      drop("rateLimits");
    }
  }

  if (value.credits !== undefined) {
    const credits = value.credits;
    if (
      isRecord(credits)
      && (credits.hasCredits === undefined || typeof credits.hasCredits === "boolean")
      && (credits.unlimited === undefined || typeof credits.unlimited === "boolean")
      && isOptionalString(credits.balance)
    ) {
      result.credits = {
        ...(credits.hasCredits !== undefined ? { hasCredits: credits.hasCredits } : {}),
        ...(credits.unlimited !== undefined ? { unlimited: credits.unlimited } : {}),
        ...(credits.balance !== undefined ? { balance: credits.balance } : {}),
      };
    } else {
      drop("credits");
    }
  }

  if (value.contextCategories !== undefined) {
    if (Array.isArray(value.contextCategories)) {
      const categories = value.contextCategories.flatMap((entry) => {
        if (
          isRecord(entry)
          && typeof entry.name === "string"
          && typeof entry.tokens === "number"
          && Number.isFinite(entry.tokens)
          && entry.tokens >= 0
          && isOptionalString(entry.color)
        ) {
          return [{
            name: entry.name,
            tokens: entry.tokens,
            ...(entry.color !== undefined ? { color: entry.color } : {}),
          }];
        }
        drop("contextCategories");
        return [];
      });
      if (categories.length > 0) result.contextCategories = categories;
    } else {
      drop("contextCategories");
    }
  }

  return result;
}

/**
 * Validate the background-task record with the same drop-not-reject policy:
 * one malformed task loses that task, not the whole record. Only a value that
 * is not a record at all is rejected outright. Dropped task ids are reported
 * through `droppedTasks`.
 */
export function parseClaudeBackgroundTasks(
  value: unknown,
  droppedTasks?: string[],
): Record<string, ClaudeBackgroundTask> | undefined {
  if (!isRecord(value)) return undefined;
  const parsed: Record<string, ClaudeBackgroundTask> = {};
  for (const [taskId, taskValue] of Object.entries(value)) {
    if (!isRecord(taskValue)) {
      droppedTasks?.push(taskId);
      continue;
    }
    const {
      id,
      description,
      status,
      isBackgrounded,
      startedAt,
      endedAt,
      error,
    } = taskValue;
    if (
      typeof id !== "string"
      || id.length === 0
      || id !== taskId
      || typeof status !== "string"
      || !CLAUDE_BACKGROUND_TASK_STATUSES.has(status as ClaudeBackgroundTask["status"])
      || !isOptionalString(description)
      || (isBackgrounded !== undefined && typeof isBackgrounded !== "boolean")
      || !isOptionalFiniteNumber(startedAt)
      || !isOptionalFiniteNumber(endedAt)
      || !isOptionalString(error)
    ) {
      droppedTasks?.push(taskId);
      continue;
    }
    parsed[taskId] = taskValue as unknown as ClaudeBackgroundTask;
  }
  return parsed;
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
  contextUsage?: ContextUsageSnapshot;
  promptSuggestion?: string;
  backgroundTasks?: Record<string, ClaudeBackgroundTask>;
  /**
   * Optional fields omitted because their wire values failed validation.
   *
   * A whole-field rejection is reported as the bare field name
   * (`"contextUsage"`, `"promptSuggestion"`, `"backgroundTasks"`); a dropped
   * optional decoration or task inside an otherwise-valid field is reported as
   * a dotted path (`"contextUsage.rateLimits"`, `"backgroundTasks.<taskId>"`).
   */
  invalidMetadataFields?: string[];
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
    | "replay.required"
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
  "replay.required",
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
    const session = (await response.json()) as Record<string, unknown>;
    if (
      typeof session.id !== "string"
      || (
        session.status !== "idle"
        && session.status !== "running"
        && session.status !== "error"
      )
      || typeof session.createdAt !== "string"
      || typeof session.lastActivity !== "string"
      || !isOptionalString(session.title)
      || !isOptionalString(session.error)
    ) {
      return {
        kind: "unavailable",
        error: new Error("Claude session response was malformed"),
      };
    }
    const droppedUsageFields: string[] = [];
    const contextUsage = parseClaudeContextUsage(
      session.contextUsage,
      droppedUsageFields,
    );
    const droppedTaskIds: string[] = [];
    const backgroundTasks = parseClaudeBackgroundTasks(
      session.backgroundTasks,
      droppedTaskIds,
    );
    const invalidMetadataFields: string[] = [];
    if (session.contextUsage !== undefined && contextUsage === undefined) {
      invalidMetadataFields.push("contextUsage");
    } else {
      for (const field of droppedUsageFields) {
        invalidMetadataFields.push(`contextUsage.${field}`);
      }
    }
    if (
      session.promptSuggestion !== undefined
      && typeof session.promptSuggestion !== "string"
    ) {
      invalidMetadataFields.push("promptSuggestion");
    }
    if (session.backgroundTasks !== undefined && backgroundTasks === undefined) {
      invalidMetadataFields.push("backgroundTasks");
    } else {
      for (const taskId of droppedTaskIds) {
        invalidMetadataFields.push(`backgroundTasks.${taskId}`);
      }
    }

    return {
      kind: "found",
      session: {
        id: session.id,
        title: session.title as string | undefined,
        status: session.status,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        error: session.error as string | undefined,
        contextUsage,
        promptSuggestion:
          typeof session.promptSuggestion === "string"
            ? session.promptSuggestion
            : undefined,
        backgroundTasks,
        ...(invalidMetadataFields.length > 0 ? { invalidMetadataFields } : {}),
      },
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
    agent?: string;
    includeLocalSettings?: boolean;
    promptSuggestions?: boolean;
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
        agent: options?.agent,
        includeLocalSettings: options?.includeLocalSettings,
        promptSuggestions: options?.promptSuggestions,
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

export async function forkClaudeSession(
  client: ClaudeClient,
  sessionId: string,
  options: { upToMessageId?: string; title?: string } = {},
): Promise<{ sessionId: string; title?: string }> {
  const response = await fetch(`${client.baseUrl}/session/${sessionId}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    throw new Error(`Failed to fork Claude session: HTTP ${response.status}`);
  }
  // A `200 {}` would otherwise bind the new tab to `sessionId: undefined`, which
  // every subsequent request then addresses as the literal string "undefined".
  const body = (await response.json().catch(() => ({}))) as {
    sessionId?: unknown;
    title?: unknown;
  };
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
    throw new Error("Claude fork response did not include a session id");
  }
  return {
    sessionId: body.sessionId,
    ...(typeof body.title === "string" ? { title: body.title } : {}),
  };
}

export async function compactClaudeSession(
  client: ClaudeClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}/compact`, {
      method: "POST",
    });
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to compact session:", error);
    return false;
  }
}

export async function rewindClaudeFiles(
  client: ClaudeClient,
  sessionId: string,
  messageId: string,
  dryRun = false,
): Promise<unknown> {
  const response = await fetch(`${client.baseUrl}/session/${sessionId}/rewind`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId, dryRun }),
  });
  if (!response.ok) {
    throw new Error(`Failed to rewind Claude files: HTTP ${response.status}`);
  }
  return response.json();
}

export async function stopClaudeBackgroundTask(
  client: ClaudeClient,
  sessionId: string,
  taskId: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${client.baseUrl}/session/${sessionId}/tasks/${encodeURIComponent(taskId)}/stop`,
      { method: "POST" },
    );
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to stop background task:", error);
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
export type ClaudePlanApprovalResponseResult =
  | "applied"
  | "expired"
  | "failed";

export async function respondToPlanApproval(
  client: ClaudeClient,
  sessionId: string,
  approvalId: string,
  approved: boolean,
  feedback?: string
): Promise<ClaudePlanApprovalResponseResult> {
  try {
    const response = await fetch(
      `${client.baseUrl}/session/${sessionId}/plan-approvals/${approvalId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, feedback }),
      }
    );
    if (response.ok) return "applied";
    if (response.status === 404) return "expired";
    return "failed";
  } catch (error) {
    console.error("[claude-client] Failed to respond to plan approval:", error);
    return "failed";
  }
}

/**
 * Get discovered slash commands from plugins and project .claude/commands/.
 * Effective MCP server and plugin configuration is read from the backend
 * instead — see `getEnvironmentExtensions` in `@/lib/backend` — so that it does
 * not depend on a running bridge.
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
const claudeEventCursorByBaseUrl = new Map<string, string>();

// Cursors are opaque bridge-issued identifiers. Keep the accepted character
// set deliberately narrow before reflecting one into a query parameter.
const VALID_CLAUDE_EVENT_CURSOR = /^[A-Za-z0-9._~-]+(?::[A-Za-z0-9._~-]+)*$/;

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
          const cursor = event.lastEventId;
          if (cursor && VALID_CLAUDE_EVENT_CURSOR.test(cursor)) {
            claudeEventCursorByBaseUrl.set(client.baseUrl, cursor);
          }
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
        // Detach from the (often long-lived) AbortSignal so a closed
        // subscription does not keep leaking listeners onto it. `once` below
        // covers the abort-triggered path; this covers every other exit.
        signal?.removeEventListener("abort", cleanup);
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (resolver) {
          resolver({ value: undefined as unknown as ClaudeEvent, done: true });
        }
      };

      // Handle abort signal. An already-aborted signal never fires the
      // listener, so short-circuit instead of opening a doomed EventSource.
      if (signal?.aborted) {
        done = true;
        return {
          next: () =>
            Promise.resolve({
              value: undefined as unknown as ClaudeEvent,
              done: true,
            }),
          return: () =>
            Promise.resolve({
              value: undefined as unknown as ClaudeEvent,
              done: true,
            }),
          throw: (error: Error) => Promise.reject(error),
        };
      }
      signal?.addEventListener("abort", cleanup, { once: true });

      // Create EventSource
      const cursor = claudeEventCursorByBaseUrl.get(client.baseUrl);
      const eventUrl = `${client.baseUrl}/event/subscribe${
        cursor === undefined ? "" : `?since=${encodeURIComponent(cursor)}`
      }`;
      eventSource = new EventSource(eventUrl);
      eventSource.onopen = () => {
        console.debug("[claude-client] SSE connection opened");
      };

      // Listen for different event types
      const eventTypes = [
        "connected",
        "keepalive",
        "replay.required",
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
