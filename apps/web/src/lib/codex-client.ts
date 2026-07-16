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

interface CodexModelsResponse {
  models: CodexModel[];
  source: "cache" | "fallback";
}

interface CodexSlashCommandsResponse {
  commands: CodexSlashCommand[];
}

interface CodexSessionListResponse {
  sessions: CodexStoredSession[];
}

interface CodexSessionStatusResponse {
  status: "idle" | "running" | "error";
  title?: string;
  error?: string;
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
  title?: string;
  error?: string;
}

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
    | "message.updated";
  sessionId?: string;
  data?: Record<string, unknown>;
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
      source: data.source === "cache" ? "cache" : "fallback",
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
): Promise<CodexMessage[]> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/messages`,
    );
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (error) {
    console.error("[codex-client] Failed to get session messages:", error);
    return [];
  }
}

export async function getSessionStatus(
  client: CodexClient,
  sessionId: string,
  options: { throwOnError?: boolean } = {},
): Promise<CodexSessionStatus | null> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/status`,
    );
    if (response.status === 404) return null;
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
    return {
      status: data.status,
      title: typeof data.title === "string" ? data.title : undefined,
      error: typeof data.error === "string" ? data.error : undefined,
    };
  } catch (error) {
    console.error("[codex-client] Failed to get session status:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get Codex session status");
    }
    return null;
  }
}

export async function sendPrompt(
  client: CodexClient,
  sessionId: string,
  prompt: string,
  options?: {
    attachments?: CodexPromptAttachment[];
  },
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          attachments: options?.attachments,
        }),
      },
    );
    return response.ok;
  } catch (error) {
    console.error("[codex-client] Failed to send prompt:", error);
    return false;
  }
}

export async function abortSession(
  client: CodexClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${client.baseUrl}/session/${sessionId}/abort`,
      { method: "POST" },
    );
    return response.ok;
  } catch (error) {
    console.error("[codex-client] Failed to abort session:", error);
    return false;
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

export function subscribeToEvents(
  client: CodexClient,
  signal?: AbortSignal,
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
          const codexEvent: CodexEvent = {
            type: event.type as CodexEvent["type"],
            sessionId: data.sessionId,
            data,
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
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (resolver) {
          resolver({ value: undefined as unknown as CodexEvent, done: true });
        }
      };

      signal?.addEventListener("abort", cleanup);

      eventSource = new EventSource(`${client.baseUrl}/event/subscribe`);
      for (const eventType of [
        "connected",
        "keepalive",
        "session.updated",
        "session.idle",
        "session.error",
        "session.title-updated",
        "message.updated",
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
