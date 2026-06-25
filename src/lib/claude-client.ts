// Claude Bridge Server client wrapper
// Provides typed functions for interacting with the Claude bridge server

import { resolveGatewayLoopbackBaseUrl } from "./gateway-url";

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
}


/** Effort level for controlling Claude's thinking depth */
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeModel {
  id: string;
  name: string;
  description?: string;
  supportsFastMode?: boolean;
  supportsEffort?: boolean;
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
    | "message.updated"
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
 * Get session details
 */
export async function getSession(
  client: ClaudeClient,
  sessionId: string
): Promise<{
  id: string;
  title?: string;
  status: "idle" | "running" | "error";
  createdAt: string;
  lastActivity: string;
  error?: string;
} | null> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[claude-client] Failed to get session:", error);
    return null;
  }
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
  sessionId: string
): Promise<ClaudeMessage[]> {
  console.debug("[claude-client] Fetching messages for session:", sessionId);
  const response = await fetch(`${client.baseUrl}/session/${sessionId}/messages`);
  if (response.status === 404) {
    throw new SessionNotFoundError(sessionId);
  }
  if (!response.ok) {
    console.debug("[claude-client] Failed to fetch messages, status:", response.status);
    return [];
  }
  const data = await response.json();
  console.debug("[claude-client] Received messages response:", {
    sessionId,
    messageCount: data.messages?.length || 0,
    rawData: data,
  });
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
  sessionId: string
): Promise<ClaudeQuestionRequest[]> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}/questions`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.questions || [];
  } catch (error) {
    console.error("[claude-client] Failed to get pending questions:", error);
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
          console.debug("[claude-client] SSE event received", {
            type: event.type,
            sessionId: data.sessionId,
          });
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
        "message.updated",
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
