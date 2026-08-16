import { type OpencodeClient } from "@opencode-ai/sdk/v2/client";

import {
  INTERACTION_RECONCILIATION_TIMEOUT_MS,
  normalizePermissionRequest,
  normalizeQuestionRequest,
  openCodeResponseError,
  type OpenCodeInteractionResponseResult,
  type OpenCodeSession,
  type PermissionReply,
  type PermissionRequest,
  type QuestionAnswer,
  type QuestionInfo,
  type QuestionRequest,
} from "./opencode-types";

export interface OpenCodeEvent {
  type: "message.updated" | "session.updated" | "session.error" | "file.edited" | "file.watcher.updated" | "permission.asked" | "permission.replied" | "question.asked" | "question.replied" | "question.rejected" | string;
  properties?: {
    sessionID?: string;
    info?: {
      id?: string;
      role?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    };
    error?: string;
    /** For question.asked events - the question request */
    id?: string;
    questions?: QuestionInfo[];
    tool?: {
      messageID: string;
      callID: string;
    };
    /** For permission.asked events */
    permission?: string;
    patterns?: string[];
    metadata?: Record<string, unknown>;
    always?: string[];
    /** For permission.replied events */
    reply?: PermissionReply;
    /** For question.replied events */
    requestID?: string;
    answers?: QuestionAnswer[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
}

/**
 * Subscribe to events from the server
 * Returns an async iterator for SSE events
 */
export async function subscribeToEvents(client: OpencodeClient): Promise<AsyncIterable<OpenCodeEvent> | null> {
  try {
    // event.subscribe() returns { stream: AsyncGenerator }
    const response = await client.event.subscribe();

    // The response has a stream property that is the async generator
    if (response && "stream" in response) {
      return response.stream as AsyncIterable<OpenCodeEvent>;
    }

    // Fallback - try to iterate the response directly
    if (response && Symbol.asyncIterator in Object(response)) {
      return response as unknown as AsyncIterable<OpenCodeEvent>;
    }

    return null;
  } catch (error) {
    console.error("[opencode-client] Failed to subscribe to events:", error);
    return null;
  }
}

/**
 * Get list of existing sessions
 */
/**
 * Normalize the SDK's timestamps, which may arrive as epoch millis or as an
 * ISO string depending on server version.
 */
function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export async function listSessions(client: OpencodeClient): Promise<OpenCodeSession[]> {
  try {
    const response = await client.session.list();
    if (!response.data) return [];

    return response.data.map((session): OpenCodeSession => {
      const createdAt = toIsoTimestamp(session.time?.created)
        ?? new Date().toISOString();

      return {
        id: session.id,
        title: session.title,
        createdAt,
        updatedAt: toIsoTimestamp(session.time?.updated) ?? createdAt,
      };
    });
  } catch (error) {
    console.error("[opencode-client] Failed to list sessions:", error);
    throw error instanceof Error
      ? error
      : new Error("Failed to list OpenCode sessions");
  }
}

/**
 * Delete a session
 */
export async function deleteSession(client: OpencodeClient, sessionId: string): Promise<boolean> {
  try {
    const response = await client.session.delete(
      { sessionID: sessionId },
      { throwOnError: false },
    );
    if (response?.error) {
      console.error("[opencode-client] Failed to delete session:", response.error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to delete session:", error);
    return false;
  }
}

/**
 * Abort a running session/prompt.
 *
 * The SDK only throws on a non-2xx response or a transport failure when the
 * caller passes `throwOnError`; otherwise both are handed back as
 * `response.error`. Returning `true` on the strength of "it did not throw"
 * would report a failed abort as a successful one, and the caller writes a
 * "stopped" marker and promotes the queued prompt on that answer.
 */
export async function abortSession(client: OpencodeClient, sessionId: string): Promise<boolean> {
  try {
    const response = await client.session.abort(
      { sessionID: sessionId },
      { throwOnError: false },
    );
    if (response?.error) {
      console.error("[opencode-client] Failed to abort session:", response.error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to abort session:", error);
    return false;
  }
}

/**
 * Get pending question requests
 */
export async function getPendingQuestions(
  client: OpencodeClient,
  options: { throwOnError?: boolean; signal?: AbortSignal } = {},
): Promise<QuestionRequest[]> {
  try {
    const response = await client.question.list(undefined, {
      throwOnError: options.throwOnError,
      signal: options.signal,
    });
    if (!response.data) {
      if (options.throwOnError) {
        throw openCodeResponseError(
          "Failed to get pending OpenCode questions",
          response.error,
        );
      }
      return [];
    }
    return response.data.map(normalizeQuestionRequest);
  } catch (error) {
    console.error("[opencode-client] Failed to get pending questions:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get pending OpenCode questions");
    }
    return [];
  }
}

/**
 * Get pending permission requests
 */
export async function getPendingPermissions(
  client: OpencodeClient,
  options: { throwOnError?: boolean; signal?: AbortSignal } = {},
): Promise<PermissionRequest[]> {
  try {
    const response = await client.permission.list(undefined, {
      throwOnError: options.throwOnError,
      signal: options.signal,
    });
    if (!response.data) {
      if (options.throwOnError) {
        throw openCodeResponseError(
          "Failed to get pending OpenCode permissions",
          response.error,
        );
      }
      return [];
    }
    return response.data.map(normalizePermissionRequest);
  } catch (error) {
    console.error("[opencode-client] Failed to get pending permissions:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get pending OpenCode permissions");
    }
    return [];
  }
}

async function reconcileInteractionResponse(
  requestId: string,
  loadPending: (signal: AbortSignal) => Promise<Array<{ id: string }>>,
): Promise<Exclude<OpenCodeInteractionResponseResult, "applied">> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("OpenCode interaction reconciliation timed out"));
    }, INTERACTION_RECONCILIATION_TIMEOUT_MS);
  });

  try {
    const pending = await Promise.race([
      loadPending(controller.signal),
      timeout,
    ]);
    return pending.some((request) => request.id === requestId) ? "pending" : "gone";
  } catch (error) {
    console.error("[opencode-client] Failed to reconcile interaction response:", error);
    return "unknown";
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Reply to a question request
 * @param client The SDK client
 * @param requestId The question request ID
 * @param answers Array of answers (each answer is an array of selected option labels or typed text)
 */
export async function replyToQuestion(
  client: OpencodeClient,
  requestId: string,
  answers: QuestionAnswer[]
): Promise<OpenCodeInteractionResponseResult> {
  try {
    await client.question.reply(
      {
        requestID: requestId,
        answers,
      },
      { throwOnError: true },
    );
    return "applied";
  } catch (error) {
    console.error("[opencode-client] Failed to reply to question:", error);
    return reconcileInteractionResponse(
      requestId,
      (signal) => getPendingQuestions(client, { throwOnError: true, signal }),
    );
  }
}

/**
 * Reply to a permission request
 */
export async function replyToPermission(
  client: OpencodeClient,
  requestId: string,
  reply: PermissionReply,
  message?: string
): Promise<OpenCodeInteractionResponseResult> {
  try {
    await client.permission.reply(
      {
        requestID: requestId,
        reply,
        message,
      },
      { throwOnError: true },
    );
    return "applied";
  } catch (error) {
    console.error("[opencode-client] Failed to reply to permission:", error);
    return reconcileInteractionResponse(
      requestId,
      (signal) => getPendingPermissions(client, { throwOnError: true, signal }),
    );
  }
}

/**
 * Reject/dismiss a question request
 */
export async function rejectQuestion(
  client: OpencodeClient,
  requestId: string
): Promise<OpenCodeInteractionResponseResult> {
  try {
    await client.question.reject(
      { requestID: requestId },
      { throwOnError: true },
    );
    return "applied";
  } catch (error) {
    console.error("[opencode-client] Failed to reject question:", error);
    return reconcileInteractionResponse(
      requestId,
      (signal) => getPendingQuestions(client, { throwOnError: true, signal }),
    );
  }
}

