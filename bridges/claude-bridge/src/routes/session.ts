// Session management routes
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  createOrRecoverSession,
  getSession,
  listSessions,
  getSessionMessages,
  sendPrompt,
  abortSession,
  answerQuestion,
  dismissQuestion,
  getPendingQuestions,
  getSessionActivity,
  getSessionInitData,
  claimPromptDispatch,
  getPromptDispatchState,
  respondToPlanApproval,
  getPendingPlanApprovals,
  reconcilePersistedSessions,
  ensurePersistedSession,
  hydratePersistedSessionMessages,
  deleteSessionDurably,
  renameSessionDurably,
  forkPersistedSession,
  rewindSessionFiles,
  stopBackgroundTask,
  setSessionPreferences,
  clearPromptSuggestion,
} from "../services/session-manager.js";
import {
  AGENT_INTERACTION_LIMITS,
  serializeClaudeQuestionAnswer,
} from "@orkestrator/protocol/agent-interactions";
import type {
  CreateSessionResponse,
  SessionListResponse,
  MessagesResponse,
} from "../types/index.js";
import { isJsonSchema } from "@orkestrator/protocol/structured-output";
import {
  boundTranscriptResponse,
  type TranscriptWindowMetadata,
} from "@orkestrator/protocol/transcript-window";

const session = new Hono();
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
// Leave room for the small `{ "answers": ... }` JSON envelope while keeping
// the body consumed by Hono bounded before `c.req.json()` allocates a parsed
// object. The semantic answer payload is still capped separately below.
const MAX_QUESTION_ANSWER_REQUEST_BYTES =
  AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes + 1_024;
export const MAX_CLAUDE_TRANSCRIPT_RESPONSE_BYTES = 16 * 1024 * 1024;

export function boundClaudeTranscriptResponse(
  messages: MessagesResponse["messages"],
): MessagesResponse & { messageWindow: TranscriptWindowMetadata } {
  const { messages: bounded, messageWindow } = boundTranscriptResponse(
    messages,
    MAX_CLAUDE_TRANSCRIPT_RESPONSE_BYTES,
  );
  return { messages: bounded, messageWindow };
}

const questionAnswerBodyLimit = bodyLimit({
  maxSize: MAX_QUESTION_ANSWER_REQUEST_BYTES,
  onError: (c) => c.json({ error: "Question answer request is too large" }, 413),
});

/**
 * Map a session-manager refusal onto a status code.
 *
 * Reads a plain `code` property rather than testing `instanceof`: this module
 * reaches the session manager through an import boundary that tests replace
 * wholesale, so class identity is not stable across it but a string is. An
 * error with no code is a genuine fault and stays a 500.
 */
function sessionErrorStatus(error: unknown): 400 | 404 | 409 | 500 {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "not_found") return 404;
  if (code === "conflict") return 409;
  if (code === "invalid") return 400;
  return 500;
}

/**
 * The prompt existed but its window has closed — answered, dismissed, expired,
 * or the turn that raised it ended.
 *
 * 409, not 404: 404 says "no such session", which the client must surface as a
 * failure the user can retry. A closed window is neither a failure nor
 * retryable; the UI should quietly drop the card. Matches the Codex bridge's
 * approval contract so both agents speak one vocabulary.
 */
const STALE_PROMPT_STATUS = 409;

function stalePrompt(message: string): { error: string; status: "stale" } {
  return { error: message, status: "stale" };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isValidImageDataUrl(value: string): boolean {
  const match = /^data:image\/(?:jpeg|png|gif|webp);base64,([\s\S]+)$/.exec(value);
  if (!match) return false;
  const data = match[1].replace(/\s+/g, "");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decodedBytes = data.length % 4 === 0
    ? (data.length / 4) * 3 - padding
    : Number.POSITIVE_INFINITY;
  return (
    data.length > 0
    && data.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(data)
    && decodedBytes <= MAX_IMAGE_ATTACHMENT_BYTES
  );
}

function isBoundedClaudeQuestionAnswers(
  value: unknown,
  questionCount: number,
): value is string[][] {
  if (!Array.isArray(value) || value.length !== questionCount) return false;
  if (value.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest) return false;
  if (Buffer.byteLength(JSON.stringify(value), "utf8")
    > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes) {
    return false;
  }
  return value.every((answers) =>
    Array.isArray(answers)
    && answers.length > 0
    && answers.length <= AGENT_INTERACTION_LIMITS.maxAnswerCount
    && answers.every((answer) =>
      typeof answer === "string"
      && Buffer.byteLength(answer, "utf8")
        <= AGENT_INTERACTION_LIMITS.maxFreeTextBytes));
}

// Create a new session
session.post("/create", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const title = body.title as string | undefined;
    const clientSessionKey = body.clientSessionKey as string | undefined;

    const newSession = await createOrRecoverSession(title, clientSessionKey);
    console.debug("[session] Created session", { sessionId: newSession.id, title: newSession.title });

    const response: CreateSessionResponse = {
      sessionId: newSession.id,
      title: newSession.title,
    };

    return c.json(response, 201);
  } catch (error) {
    console.error("[session] Error creating session:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to create session" },
      500
    );
  }
});

// List all sessions
session.get("/list", async (c) => {
  // Best effort. Adopting on-disk sessions is an enrichment; a failing SDK or
  // an unreadable Claude home must not turn a previously infallible listing
  // into a 500 that also hides the in-memory sessions the user is working in.
  try {
    await reconcilePersistedSessions();
  } catch (error) {
    console.error("[session] Failed to reconcile persisted sessions:", error);
  }
  const sessions = listSessions();

  const response: SessionListResponse = {
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
      // Lets the shared resume picker say how much conversation a session
      // holds without reading any of it. A session reconciled from disk may
      // not have hydrated its transcript yet, which is "unknown", not zero.
      ...(Array.isArray(s.messages) ? { messageCount: s.messages.length } : {}),
    })),
  };

  return c.json(response);
});

/**
 * Materialize a session, turning a session-manager refusal into the same
 * structured body every other route returns.
 *
 * Without this the route fell through to Hono's default 500 — an empty body the
 * client cannot distinguish from a crash, for what is usually a conflict or a
 * missing rollout.
 */
async function resolveSession(
  id: string,
  failureMessage: string,
): Promise<
  | { ok: true; session: Awaited<ReturnType<typeof ensurePersistedSession>> }
  | { ok: false; body: { error: string }; status: 400 | 404 | 409 | 500 }
> {
  try {
    return { ok: true, session: getSession(id) ?? await ensurePersistedSession(id) };
  } catch (error) {
    console.error(`[session] ${failureMessage}:`, error);
    return {
      ok: false,
      body: { error: errorMessage(error, failureMessage) },
      status: sessionErrorStatus(error),
    };
  }
}

// Get session details
session.get("/:id", async (c) => {
  const id = c.req.param("id");
  const resolved = await resolveSession(id, "Failed to load session");
  if (!resolved.ok) return c.json(resolved.body, resolved.status);
  const sessionData = resolved.session;

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Background-task bookends live in the persisted transcript. A metadata-only
  // session materialized after bridge restart has not reduced them yet, so
  // serving it immediately would make this authoritative endpoint claim the
  // task set is empty. Hydrate before serializing the first snapshot.
  if (sessionData.persistedMessagesLoaded === false) {
    try {
      await hydratePersistedSessionMessages(id);
    } catch (error) {
      console.error("[session] Failed to hydrate session task state:", error);
      return c.json(
        { error: errorMessage(error, "Failed to hydrate session task state") },
        sessionErrorStatus(error),
      );
    }
  }

  return c.json({
    id: sessionData.id,
    title: sessionData.title,
    status: sessionData.status,
    turnStartedAt: sessionData.turnStartedAt,
    createdAt: sessionData.createdAt.toISOString(),
    lastActivity: sessionData.lastActivity.toISOString(),
    error: sessionData.error,
    structuredOutputRequestId: sessionData.structuredOutputRequestId,
    structuredOutput: sessionData.structuredOutput,
    contextUsage: sessionData.usage,
    // Authoritative even before the first turn completes: rate-limit events
    // arrive mid-turn, long before there is a usage snapshot to carry them.
    rateLimits: sessionData.rateLimits,
    promptSuggestion: sessionData.promptSuggestion,
    planMode: sessionData.planMode,
    backgroundTasks: sessionData.backgroundTasks ?? {},
    completionBlockedByBackgroundTasks:
      sessionData.completionBlockedByBackgroundTasks === true,
    rewindInProgress: sessionData.rewindInProgress === true,
  });
});

session.put("/:id/preferences", async (c) => {
  const id = c.req.param("id");
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }
    if (
      body === null
      || typeof body !== "object"
      || Array.isArray(body)
      || Object.getPrototypeOf(body) !== Object.prototype
    ) {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const record = body as Record<string, unknown>;
    const unexpectedField = Object.keys(record).find(
      (key) => key !== "planMode",
    );
    if (unexpectedField) {
      return c.json(
        { error: `Unexpected session preference field: ${unexpectedField}` },
        400,
      );
    }
    if (!Object.hasOwn(record, "planMode")) {
      return c.json({ error: "planMode is required" }, 400);
    }
    if (
      Object.hasOwn(record, "planMode")
      && typeof record.planMode !== "boolean"
    ) {
      return c.json({ error: "planMode must be a boolean" }, 400);
    }
    const updated = await setSessionPreferences(id, {
      ...(typeof record.planMode === "boolean" ? { planMode: record.planMode } : {}),
    });
    return c.json({ planMode: updated.planMode ?? false });
  } catch (error) {
    return c.json(
      { error: errorMessage(error, "Failed to update session preferences") },
      sessionErrorStatus(error),
    );
  }
});

session.delete("/:id/prompt-suggestion", (c) => {
  const id = c.req.param("id");
  if (!clearPromptSuggestion(id)) {
    return c.json({ error: "Session not found" }, 404);
  }
  return c.body(null, 204);
});

// Get the authoritative result of the latest (or requested) structured turn.
session.get("/:id/structured-output", (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id);
  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }
  const requestId = c.req.query("requestId")?.trim();
  if (
    requestId
    && sessionData.structuredOutputRequestId
    && requestId !== sessionData.structuredOutputRequestId
  ) {
    return c.json({ structuredOutput: null, requestId });
  }
  return c.json({
    structuredOutput: sessionData.structuredOutput ?? null,
    requestId: sessionData.structuredOutputRequestId,
  });
});

// Get the authoritative task list for a session.
//
// The bridge owns this state, so a tab that was unmounted while tasks changed
// rehydrates from here rather than replaying the transcript and hoping the last
// task tool part is still present.
session.get("/:id/tasks", async (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id) ?? await ensurePersistedSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  if (sessionData.persistedMessagesLoaded === false) {
    await hydratePersistedSessionMessages(id);
  }

  // A session that has never run a task tool has an empty, and complete, list.
  return c.json(sessionData.taskRegistry?.snapshot() ?? { items: [], complete: true });
});

// Get session messages
session.get("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const resolved = await resolveSession(id, "Failed to load session messages");
  if (!resolved.ok) return c.json(resolved.body, resolved.status);
  const sessionData = resolved.session;

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  const messages =
    sessionData.persistedMessagesLoaded === false
      ? await hydratePersistedSessionMessages(id)
      : getSessionMessages(id);
  return c.json(boundClaudeTranscriptResponse(messages));
});

// Send a prompt to a session
session.post("/:id/prompt", async (c) => {
  const id = c.req.param("id");
  const resolved = await resolveSession(id, "Failed to send prompt");
  if (!resolved.ok) return c.json(resolved.body, resolved.status);
  const sessionData = resolved.session;

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  try {
    const body = await c.req.json();
    const prompt = body.prompt;
    const model = body.model as string | undefined;
    const rawEffort = body.effort as string | undefined;
    const effort = rawEffort && ["low", "medium", "high", "xhigh", "max"].includes(rawEffort)
      ? (rawEffort as "low" | "medium" | "high" | "xhigh" | "max")
      : undefined;
    const rawPermissionMode = body.permissionMode as string | undefined;
    const permissionMode = rawPermissionMode && ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(rawPermissionMode)
      ? (rawPermissionMode as "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto")
      : undefined;
    const attachments = body.attachments as
      | Array<{
          type: "file" | "image";
          path: string;
          dataUrl?: string;
          filename?: string;
        }>
      | undefined;
    const fastMode = typeof body.fastMode === "boolean" ? body.fastMode : undefined;
    const agent =
      typeof body.agent === "string" && body.agent.trim()
        ? body.agent.trim()
        : undefined;
    const includeLocalSettings =
      typeof body.includeLocalSettings === "boolean"
        ? body.includeLocalSettings
        : undefined;
    const promptSuggestions =
      typeof body.promptSuggestions === "boolean"
        ? body.promptSuggestions
        : undefined;
    const outputSchema = body.outputSchema;
    // Every prompt is deduplicated on this id, not just structured ones: a plain
    // prompt retried after a lost HTTP response would otherwise run its shell
    // commands and file edits twice. Clients always send one; the fallback keeps
    // structured turns addressable for callers that predate that.
    const requestId = typeof body.requestId === "string" && body.requestId.trim().length > 0
      ? body.requestId.trim()
      : outputSchema === undefined
        ? undefined
        : crypto.randomUUID();

    if (outputSchema !== undefined && !isJsonSchema(outputSchema)) {
      return c.json({ error: "outputSchema must be a JSON Schema object" }, 400);
    }
    if (requestId && requestId.length > 200) {
      return c.json({ error: "requestId must be at most 200 characters" }, 400);
    }

    const attachmentsAreValid = attachments === undefined || (
      Array.isArray(attachments)
      && attachments.every((attachment) =>
        attachment
        && (attachment.type === "file" || attachment.type === "image")
        && typeof attachment.path === "string"
        && (attachment.dataUrl === undefined || typeof attachment.dataUrl === "string")
        && (attachment.filename === undefined || typeof attachment.filename === "string")
        && (attachment.type === "image" || attachment.dataUrl === undefined)
        && (
          attachment.dataUrl === undefined
          || isValidImageDataUrl(attachment.dataUrl)
        )
        && (
          attachment.path.trim().length > 0
          || (attachment.type === "image" && attachment.dataUrl !== undefined)
        )
      )
    );
    if (!attachmentsAreValid) {
      return c.json({
        error: "Attachments are invalid; inline images must be valid base64 and no larger than 8MB",
      }, 400);
    }

    if (
      typeof prompt !== "string"
      || (prompt.trim().length === 0 && (!attachments || attachments.length === 0))
    ) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    // Answered before the `running` conflict below on purpose: a retry of the
    // request that *is* the running turn must be told its own outcome, not
    // refused as if it collided with somebody else's prompt.
    if (requestId) {
      const dispatchState = getPromptDispatchState(id, requestId);
      if (dispatchState === "processing") {
        return c.json({
          status: "processing",
          requestId,
          duplicate: true,
          turnStartedAt: sessionData.turnStartedAt,
        }, 202);
      }
      if (dispatchState === "already-processed") {
        return c.json({ status: "already-processed", requestId, duplicate: true });
      }
    }
    if (requestId && outputSchema === undefined) {
      const dispatchState = await claimPromptDispatch(id, requestId, () => {
        let resolveStarted: (() => void) | undefined;
        let rejectStarted: ((error: unknown) => void) | undefined;
        const started = new Promise<void>((resolve, reject) => {
          resolveStarted = resolve;
          rejectStarted = reject;
        });
        const completion = sendPrompt(
          id,
          prompt,
          {
            model,
            attachments,
            effort,
            permissionMode,
            fastMode,
            agent,
            includeLocalSettings,
            promptSuggestions,
            requestId,
          },
          {
            onQueryStarted: () => resolveStarted?.(),
          },
        );
        void completion.catch((error) => {
          rejectStarted?.(error);
          console.error("[session] Error processing prompt:", error);
        });
        return { started, completion };
      });
      if (dispatchState === "not-found") {
        return c.json({ error: "Session not found" }, 404);
      }
      if (dispatchState === "duplicate") {
        return c.json({
          status: "already-processed",
          requestId,
          duplicate: true,
        });
      }
      console.debug("[session] Prompt accepted", { sessionId: id });
      return c.json({
        status: "processing",
        requestId,
        turnStartedAt: sessionData.turnStartedAt,
      }, 202);
    }
    if (sessionData.status === "running") {
      return c.json({ error: "Session is already processing a prompt" }, 409);
    }
    if (sessionData.rewindInProgress === true) {
      return c.json({ error: "Session is restoring files from a checkpoint" }, 409);
    }

    console.debug("[session] Prompt received", {
      sessionId: id,
      promptLength: prompt.length,
      model,
      effort,
      permissionMode,
      fastMode,
      agent,
      includeLocalSettings,
      attachmentsCount: attachments?.length ?? 0,
    });

    // Start processing in background (don't await)
    sendPrompt(id, prompt, {
      model,
      attachments,
      effort,
      permissionMode,
      fastMode,
      agent,
      includeLocalSettings,
      promptSuggestions,
      outputSchema,
      requestId,
    }).catch((error) => {
      console.error("[session] Error processing prompt:", error);
    });

    console.debug("[session] Prompt accepted", { sessionId: id });
    return c.json({
      status: "processing",
      requestId,
      turnStartedAt: sessionData.turnStartedAt,
    }, 202);
  } catch (error) {
    console.error("[session] Error sending prompt:", error);
    return c.json(
      { error: errorMessage(error, "Failed to send prompt") },
      sessionErrorStatus(error),
    );
  }
});

// Dismiss a pending question
session.delete("/:id/questions/:questionId", (c) => {
  const sessionId = c.req.param("id");
  const questionId = c.req.param("questionId");

  if (!getSession(sessionId)) {
    return c.json({ error: "Session not found" }, 404);
  }

  const pendingQuestion = getPendingQuestions(sessionId).find((question) => question.id === questionId);
  if (!pendingQuestion || !dismissQuestion(questionId)) {
    return c.json(
      stalePrompt("Question is no longer pending"),
      STALE_PROMPT_STATUS,
    );
  }

  return c.json({ status: "dismissed" });
});

// Abort a running session
session.post("/:id/abort", (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  const aborted = abortSession(id);

  if (aborted) {
    return c.json({ status: "aborted" });
  } else {
    return c.json({ status: "not_running" });
  }
});

// Delete a session
session.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const deleted = await deleteSessionDurably(id);
    if (deleted) {
      return c.json({ status: "deleted" });
    }
    return c.json({ error: "Session not found" }, 404);
  } catch (error) {
    console.error("[session] Failed to delete session:", error);
    return c.json(
      { error: errorMessage(error, "Failed to delete session") },
      sessionErrorStatus(error),
    );
  }
});

session.post("/:id/rename", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return c.json({ error: "Title is required" }, 400);
  try {
    const renamed = await renameSessionDurably(id, title);
    return renamed
      ? c.json({ status: "renamed", title })
      : c.json({ error: "Session not found" }, 404);
  } catch (error) {
    console.error("[session] Failed to rename session:", error);
    return c.json(
      { error: errorMessage(error, "Failed to rename session") },
      sessionErrorStatus(error),
    );
  }
});

session.post("/:id/fork", async (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id) ?? await ensurePersistedSession(id);
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const upToMessageId =
    typeof body.upToMessageId === "string" && body.upToMessageId.trim()
      ? body.upToMessageId.trim()
      : undefined;
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : undefined;
  try {
    const forked = await forkPersistedSession(id, { upToMessageId, title });
    return c.json({
      sessionId: forked.id,
      title: forked.title,
    }, 201);
  } catch (error) {
    console.error("[session] Failed to fork session:", error);
    return c.json(
      { error: errorMessage(error, "Failed to fork session") },
      sessionErrorStatus(error),
    );
  }
});

session.post("/:id/compact", async (c) => {
  const id = c.req.param("id");
  const resolved = await resolveSession(id, "Failed to compact session");
  if (!resolved.ok) return c.json(resolved.body, resolved.status);
  const sessionData = resolved.session;
  if (!sessionData) return c.json({ error: "Session not found" }, 404);
  if (sessionData.status === "running") {
    return c.json({ error: "Session is already processing a prompt" }, 409);
  }
  if (sessionData.rewindInProgress === true) {
    return c.json({ error: "Session is restoring files from a checkpoint" }, 409);
  }
  void sendPrompt(id, "/compact").catch((error) => {
    console.error("[session] Claude compaction failed:", error);
  });
  return c.json({ status: "processing" }, 202);
});

session.post("/:id/rewind", async (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id) ?? await ensurePersistedSession(id);
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const messageId =
    typeof body.messageId === "string" ? body.messageId.trim() : "";
  if (!messageId) return c.json({ error: "messageId is required" }, 400);
  const dryRun = body.dryRun === true;
  try {
    const result = await rewindSessionFiles(id, messageId, dryRun);
    return c.json({ status: dryRun ? "previewed" : "rewound", result });
  } catch (error) {
    console.error("[session] Failed to rewind session files:", error);
    return c.json(
      { error: errorMessage(error, "Failed to rewind session files") },
      sessionErrorStatus(error),
    );
  }
});

session.post("/:id/tasks/:taskId/stop", async (c) => {
  try {
    const stopped = await stopBackgroundTask(
      c.req.param("id"),
      c.req.param("taskId"),
    );
    if (stopped.ok) return c.json({ status: "stopped" });
    // "No control channel" is a conflict, not a 404: the task exists and the
    // user can see it — nothing live can currently reach it.
    return c.json(
      { error: stopped.message },
      stopped.reason === "no_control_channel" ? 409 : 404,
    );
  } catch (error) {
    console.error("[session] Failed to stop background task:", error);
    return c.json(
      { error: errorMessage(error, "Failed to stop background task") },
      sessionErrorStatus(error),
    );
  }
});

/**
 * Coarse activity state for the backend's per-session sweep.
 *
 * Deliberately not `GET /:id`: that route resolves the session (touching its
 * idle clock) and hydrates the persisted transcript, so a two-second poll
 * across every session pulled every transcript into memory and then pinned it
 * there — idle transcript eviction could never fire again. `getSessionActivity`
 * reads only what is already resident and materializes nothing, so this route
 * must not route through `resolveSession` / `ensurePersistedSession` either.
 *
 * Always 200, never 404 — including for an id this bridge has never heard of.
 * The backend reads a 404 from this path as "the bridge predates this route"
 * and fails the whole environment, whereas `{ activity: "missing" }` is the
 * in-band signal that one specific session is gone, on which it deletes that
 * session's persisted mapping. Answering 404 for an unknown session makes the
 * two indistinguishable and risks unmapping a session that is still live.
 *
 * Registered as a two-segment path, so the `/:id` route above cannot shadow it.
 */
session.get("/:id/activity", async (c) => {
  const activity = await getSessionActivity(c.req.param("id"));
  return c.json({ activity });
});

// Get pending questions for a session
session.get("/:id/questions", (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  const questions = getPendingQuestions(id);
  return c.json({ questions });
});

// Get session initialization data (MCP servers, plugins, slash commands)
session.get("/:id/init", (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  const initData = getSessionInitData(id);
  return c.json({
    initData: initData || {
      mcpServers: [],
      plugins: [],
      slashCommands: [],
    },
  });
});

// Answer a question
session.post("/:id/questions/:questionId/answer", questionAnswerBodyLimit, async (c) => {
  const sessionId = c.req.param("id");
  const questionId = c.req.param("questionId");

  const sessionData = getSession(sessionId);
  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  try {
    const body = await c.req.json();
    const answersArray: unknown = body.answers;

    if (!answersArray || !Array.isArray(answersArray)) {
      return c.json({ error: "Answers array is required" }, 400);
    }

    // Get the pending question to access the question text for mapping
    const pendingQuestions = getPendingQuestions(sessionId);
    const pendingQuestion = pendingQuestions.find((q) => q.id === questionId);

    if (!pendingQuestion) {
      console.log("[session] Pending question not found:", questionId);
      return c.json(
        stalePrompt("Question is no longer pending"),
        STALE_PROMPT_STATUS,
      );
    }

    if (!isBoundedClaudeQuestionAnswers(
      answersArray,
      pendingQuestion.questions.length,
    )) {
      return c.json({ error: "Answers must be a bounded string array for every question" }, 400);
    }

    // Convert string[][] to Record<string, string>
    // Map each question's text to its answer(s) joined as a string
    const answersRecord: Record<string, string> = {};
    pendingQuestion.questions.forEach((q, index) => {
      const questionAnswers = answersArray[index] || [];
      answersRecord[q.question] = serializeClaudeQuestionAnswer(
        questionAnswers,
        q.multiSelect === true,
      );
    });

    console.debug("[session] Prepared question answers", {
      questionId,
      questionCount: pendingQuestion.questions.length,
      answerCount: answersArray.reduce((count, answers) => count + answers.length, 0),
    });

    const answered = answerQuestion(questionId, answersRecord);

    if (answered) {
      return c.json({ status: "answered" });
    } else {
      // Raced between the lookup above and the answer: it was resolved by
      // something else in between, which is stale rather than missing.
      return c.json(
        stalePrompt("Question is no longer pending"),
        STALE_PROMPT_STATUS,
      );
    }
  } catch (error) {
    console.error("[session] Error answering question:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to answer question" },
      500
    );
  }
});

// Get pending plan approvals for a session
session.get("/:id/plan-approvals", (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  const approvals = getPendingPlanApprovals(id);
  return c.json({ approvals });
});

// Respond to a plan approval request (approve or reject)
session.post("/:id/plan-approvals/:approvalId/respond", async (c) => {
  const sessionId = c.req.param("id");
  const approvalId = c.req.param("approvalId");

  const sessionData = getSession(sessionId);
  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  try {
    const body = await c.req.json();
    const approved = body.approved as boolean;
    const feedback = body.feedback as string | undefined;

    if (typeof approved !== "boolean") {
      return c.json({ error: "'approved' boolean is required" }, 400);
    }

    const pendingApproval = getPendingPlanApprovals(sessionId)
      .find((approval) => approval.id === approvalId);
    if (!pendingApproval) {
      return c.json(
        stalePrompt("Plan approval is no longer pending"),
        STALE_PROMPT_STATUS,
      );
    }

    console.log("[session] Plan approval response received", {
      sessionId,
      approvalId,
      approved,
      hasFeedback: typeof feedback === "string" && feedback.length > 0,
    });

    const responded = respondToPlanApproval(approvalId, approved, feedback);

    if (responded) {
      return c.json({ status: approved ? "approved" : "rejected" });
    } else {
      return c.json(
        stalePrompt("Plan approval is no longer pending"),
        STALE_PROMPT_STATUS,
      );
    }
  } catch (error) {
    console.error("[session] Error responding to plan approval:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to respond to plan approval" },
      500
    );
  }
});

export default session;
