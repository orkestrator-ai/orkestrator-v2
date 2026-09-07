// Session management routes
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { emptyRuntimeHealth } from "@orkestrator/protocol/runtime-health";
import {
  createOrRecoverSession,
  getSession,
  peekSession,
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
  readSessionCommands,
  readSessionMcpServers,
  performSessionMcpAction,
  steerClaudeSession,
  readClaudeSteerDispatch,
  configureClaudeSession,
  gracefulInterruptClaudeSession,
  refreshClaudeContextUsage,
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
import { isNativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { effectiveExecutionPolicy } from "../services/read-only-policy.js";

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
  const decodedBytes =
    data.length % 4 === 0 ? (data.length / 4) * 3 - padding : Number.POSITIVE_INFINITY;
  return (
    data.length > 0 &&
    data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(data) &&
    decodedBytes <= MAX_IMAGE_ATTACHMENT_BYTES
  );
}

function isBoundedClaudeQuestionAnswers(
  value: unknown,
  questionCount: number,
): value is string[][] {
  if (!Array.isArray(value) || value.length !== questionCount) return false;
  if (value.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest) return false;
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
  ) {
    return false;
  }
  return value.every(
    (answers) =>
      Array.isArray(answers) &&
      answers.length > 0 &&
      answers.length <= AGENT_INTERACTION_LIMITS.maxAnswerCount &&
      answers.every(
        (answer) =>
          typeof answer === "string" &&
          Buffer.byteLength(answer, "utf8") <= AGENT_INTERACTION_LIMITS.maxFreeTextBytes,
      ),
  );
}

// Create a new session
session.post("/create", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const title = body.title as string | undefined;
    const clientSessionKey = body.clientSessionKey as string | undefined;
    // Process authority wins. A coordinator bridge is launched for exactly
    // one conversation, so a request body cannot widen what it runs under.
    const policy = effectiveExecutionPolicy(
      isNativeAgentExecutionPolicy(body.policy) ? body.policy : undefined,
    );

    const newSession = policy
      ? await createOrRecoverSession(title, clientSessionKey, policy)
      : await createOrRecoverSession(title, clientSessionKey);
    console.debug("[session] Created session", {
      sessionId: newSession.id,
      title: newSession.title,
    });

    const response: CreateSessionResponse = {
      sessionId: newSession.id,
      title: newSession.title,
    };

    return c.json(response, 201);
  } catch (error) {
    console.error("[session] Error creating session:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to create session" },
      500,
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
    return { ok: true, session: getSession(id) ?? (await ensurePersistedSession(id)) };
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
    contextUsage: sessionData.inProgressUsage ?? sessionData.usage,
    policy: sessionData.executionPolicy,
    // Authoritative even before the first turn completes: rate-limit events
    // arrive mid-turn, long before there is a usage snapshot to carry them.
    rateLimits: sessionData.rateLimits,
    promptSuggestion: sessionData.promptSuggestion,
    planMode: sessionData.planMode,
    turnId:
      sessionData.status === "running" && sessionData.latestTurnGeneration !== undefined
        ? String(sessionData.latestTurnGeneration)
        : undefined,
    backgroundTasks: sessionData.backgroundTasks ?? {},
    completionBlockedByBackgroundTasks: sessionData.completionBlockedByBackgroundTasks === true,
    rewindInProgress: sessionData.rewindInProgress === true,
  });
});

/** Full context counting is reserved for an explicit usage-panel read. */
session.get("/:id/usage", async (c) => {
  const id = c.req.param("id");
  const resolved = await resolveSession(id, "Failed to load session usage");
  if (!resolved.ok) return c.json(resolved.body, resolved.status);
  if (!resolved.session) return c.json({ error: "Session not found" }, 404);
  try {
    const contextUsage = await refreshClaudeContextUsage(resolved.session);
    return c.json({ contextUsage });
  } catch (error) {
    console.warn(
      "[session] Detailed context usage request failed:",
      error instanceof Error ? error.message : error,
    );
    return c.json({ error: "Context usage is temporarily unavailable" }, 503);
  }
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
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.getPrototypeOf(body) !== Object.prototype
    ) {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const record = body as Record<string, unknown>;
    const unexpectedField = Object.keys(record).find((key) => key !== "planMode");
    if (unexpectedField) {
      return c.json({ error: `Unexpected session preference field: ${unexpectedField}` }, 400);
    }
    if (!Object.hasOwn(record, "planMode")) {
      return c.json({ error: "planMode is required" }, 400);
    }
    if (Object.hasOwn(record, "planMode") && typeof record.planMode !== "boolean") {
      return c.json({ error: "planMode must be a boolean" }, 400);
    }
    const updated = await setSessionPreferences(
      id,
      typeof record.planMode === "boolean" ? { planMode: record.planMode } : {},
    );
    return c.json({ planMode: updated.planMode ?? false });
  } catch (error) {
    return c.json(
      { error: errorMessage(error, "Failed to update session preferences") },
      sessionErrorStatus(error),
    );
  }
});

session.post("/:id/config", async (c) => {
  const sessionData = getSession(c.req.param("id"));
  if (!sessionData) return c.json({ error: "Session not found" }, 404);
  if (sessionData.status === "running") return c.json({ error: "Session is running" }, 409);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (Object.hasOwn(body, "policy") && !isNativeAgentExecutionPolicy(body.policy)) {
    return c.json({ error: "Invalid execution policy" }, 400);
  }
  const parameterValues =
    body.parameterValues &&
    typeof body.parameterValues === "object" &&
    !Array.isArray(body.parameterValues)
      ? (body.parameterValues as Record<string, string | boolean>)
      : undefined;
  const rawPermissionMode = parameterValues?.permissionMode;
  const permissionMode =
    typeof rawPermissionMode === "string" &&
    ["acceptEdits", "bypassPermissions", "plan"].includes(rawPermissionMode)
      ? (rawPermissionMode as "acceptEdits" | "bypassPermissions" | "plan")
      : body.mode === "plan"
        ? "plan"
        : body.mode === "build"
          ? "bypassPermissions"
          : undefined;
  await configureClaudeSession(sessionData, {
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.reasoningId === "string" ? { effort: body.reasoningId } : {}),
    ...(typeof body.fastMode === "boolean" ? { fastMode: body.fastMode } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(parameterValues ? { parameterValues } : {}),
  });
  const nextPolicy = effectiveExecutionPolicy(
    isNativeAgentExecutionPolicy(body.policy) ? body.policy : undefined,
  );
  if (nextPolicy) {
    sessionData.executionPolicy = structuredClone(nextPolicy);
  }
  if (permissionMode === "plan" || permissionMode === "bypassPermissions") {
    await setSessionPreferences(sessionData.id, { planMode: permissionMode === "plan" });
  }
  return c.json({ ok: true, policy: sessionData.executionPolicy });
});

session.get("/:id/commands", async (c) => {
  return c.json({ commands: await readSessionCommands(c.req.param("id")) });
});

session.get("/:id/mcp", async (c) => {
  return c.json({ servers: await readSessionMcpServers(c.req.param("id")) });
});

session.post("/:id/mcp/:serverId/:action", async (c) => {
  const action = c.req.param("action");
  if (!(["reconnect", "enable", "disable", "sign-in"] as string[]).includes(action)) {
    return c.json({ error: "Unsupported MCP action" }, 400);
  }
  try {
    return c.json(
      await performSessionMcpAction(
        c.req.param("id"),
        c.req.param("serverId"),
        action as "reconnect" | "enable" | "disable" | "sign-in",
      ),
    );
  } catch (error) {
    return c.json({ error: errorMessage(error, "MCP action failed") }, 409);
  }
});

session.get("/:id/steer/dispatch", (c) => {
  const requestId = c.req.query("requestId")?.trim();
  return c.json({
    dispatch: requestId ? readClaudeSteerDispatch(c.req.param("id"), requestId) : "unknown",
  });
});

session.post("/:id/steer", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = typeof body.input === "string" ? body.input.trim() : "";
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const expectedRunId = typeof body.expectedRunId === "string" ? body.expectedRunId.trim() : "";
  if (!text || !requestId || !expectedRunId) {
    return c.json({ error: "input, requestId, and expectedRunId are required" }, 400);
  }
  const outcome = steerClaudeSession(c.req.param("id"), text, requestId, expectedRunId);
  return c.json({ outcome }, outcome === "unknown" ? 503 : 200);
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
    requestId &&
    sessionData.structuredOutputRequestId &&
    requestId !== sessionData.structuredOutputRequestId
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
  const sessionData = getSession(id) ?? (await ensurePersistedSession(id));

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
    const effort =
      rawEffort && ["low", "medium", "high", "xhigh", "max"].includes(rawEffort)
        ? (rawEffort as "low" | "medium" | "high" | "xhigh" | "max")
        : undefined;
    const rawPermissionMode = body.permissionMode as string | undefined;
    const permissionMode =
      rawPermissionMode &&
      ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(
        rawPermissionMode,
      )
        ? (rawPermissionMode as
            | "default"
            | "acceptEdits"
            | "bypassPermissions"
            | "plan"
            | "dontAsk"
            | "auto")
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
      typeof body.agent === "string" && body.agent.trim() ? body.agent.trim() : undefined;
    const includeLocalSettings =
      typeof body.includeLocalSettings === "boolean" ? body.includeLocalSettings : undefined;
    const promptSuggestions =
      typeof body.promptSuggestions === "boolean" ? body.promptSuggestions : undefined;
    const parameterValues =
      body.parameterValues &&
      typeof body.parameterValues === "object" &&
      !Array.isArray(body.parameterValues)
        ? (body.parameterValues as Record<string, string | boolean>)
        : undefined;
    const outputSchema = body.outputSchema;
    const agentMcpRecord =
      body.agentMcp && typeof body.agentMcp === "object" && !Array.isArray(body.agentMcp)
        ? (body.agentMcp as Record<string, unknown>)
        : undefined;
    const agentMcp =
      typeof agentMcpRecord?.url === "string" && typeof agentMcpRecord.token === "string"
        ? { url: agentMcpRecord.url, token: agentMcpRecord.token }
        : undefined;
    // Every prompt is deduplicated on this id, not just structured ones: a plain
    // prompt retried after a lost HTTP response would otherwise run its shell
    // commands and file edits twice. Clients always send one; the fallback keeps
    // structured turns addressable for callers that predate that.
    const requestId =
      typeof body.requestId === "string" && body.requestId.trim().length > 0
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

    const attachmentsAreValid =
      attachments === undefined ||
      (Array.isArray(attachments) &&
        attachments.every(
          (attachment) =>
            attachment &&
            (attachment.type === "file" || attachment.type === "image") &&
            typeof attachment.path === "string" &&
            (attachment.dataUrl === undefined || typeof attachment.dataUrl === "string") &&
            (attachment.filename === undefined || typeof attachment.filename === "string") &&
            (attachment.type === "image" || attachment.dataUrl === undefined) &&
            (attachment.dataUrl === undefined || isValidImageDataUrl(attachment.dataUrl)) &&
            (attachment.path.trim().length > 0 ||
              (attachment.type === "image" && attachment.dataUrl !== undefined)),
        ));
    if (!attachmentsAreValid) {
      return c.json(
        {
          error:
            "Attachments are invalid; inline images must be valid base64 and no larger than 8MB",
        },
        400,
      );
    }

    if (
      typeof prompt !== "string" ||
      (prompt.trim().length === 0 && (!attachments || attachments.length === 0))
    ) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    // Answered before the `running` conflict below on purpose: a retry of the
    // request that *is* the running turn must be told its own outcome, not
    // refused as if it collided with somebody else's prompt.
    if (requestId) {
      const dispatchState = getPromptDispatchState(id, requestId);
      if (dispatchState === "processing") {
        return c.json(
          {
            status: "processing",
            requestId,
            duplicate: true,
            turnStartedAt: sessionData.turnStartedAt,
          },
          202,
        );
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
            parameterValues,
            ...(agentMcp ? { agentMcp } : {}),
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
      return c.json(
        {
          status: "processing",
          requestId,
          turnStartedAt: sessionData.turnStartedAt,
        },
        202,
      );
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
      parameterValues,
      ...(agentMcp ? { agentMcp } : {}),
      outputSchema,
      requestId,
    }).catch((error) => {
      console.error("[session] Error processing prompt:", error);
    });

    console.debug("[session] Prompt accepted", { sessionId: id });
    return c.json(
      {
        status: "processing",
        requestId,
        turnStartedAt: sessionData.turnStartedAt,
      },
      202,
    );
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

  const pendingQuestion = getPendingQuestions(sessionId).find(
    (question) => question.id === questionId,
  );
  if (!pendingQuestion || !dismissQuestion(questionId)) {
    return c.json(stalePrompt("Question is no longer pending"), STALE_PROMPT_STATUS);
  }

  return c.json({ status: "dismissed" });
});

// Abort a running session
session.post("/:id/abort", async (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  const interrupted = await gracefulInterruptClaudeSession(id);

  if (interrupted.interrupted) {
    return c.json({ status: "interrupt-requested", stillQueued: interrupted.stillQueued });
  } else {
    return c.json({ status: "not_running" });
  }
});

session.post("/:id/hard-abort", (c) => {
  const id = c.req.param("id");
  if (!getSession(id)) return c.json({ error: "Session not found" }, 404);
  return c.json({ status: abortSession(id) ? "aborted" : "not_running" });
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

// Neutral provider surface; `/rename` remains as the compatibility alias.
session.post("/:id/title", async (c) => {
  const title = String(
    ((await c.req.json().catch(() => ({}))) as { title?: unknown }).title ?? "",
  ).trim();
  if (!title) return c.json({ error: "Title is required" }, 400);
  try {
    return (await renameSessionDurably(c.req.param("id"), title))
      ? c.json({ status: "renamed", title })
      : c.json({ error: "Session not found" }, 404);
  } catch (error) {
    return c.json(
      { error: errorMessage(error, "Failed to rename session") },
      sessionErrorStatus(error),
    );
  }
});

session.post("/:id/fork", async (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id) ?? (await ensurePersistedSession(id));
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const upToMessageId =
    typeof body.upToMessageId === "string" && body.upToMessageId.trim()
      ? body.upToMessageId.trim()
      : undefined;
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
  try {
    const forked = await forkPersistedSession(id, { upToMessageId, title });
    return c.json(
      {
        sessionId: forked.id,
        title: forked.title,
      },
      201,
    );
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
  const sessionData = getSession(id) ?? (await ensurePersistedSession(id));
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
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
    const stopped = await stopBackgroundTask(c.req.param("id"), c.req.param("taskId"));
    if (stopped.ok) return c.json({ status: "stopped" });
    // "No control channel" is a conflict, not a 404: the task exists and the
    // user can see it — nothing live can currently reach it.
    return c.json({ error: stopped.message }, stopped.reason === "no_control_channel" ? 409 : 404);
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

/**
 * Bounded inventory, drift and provider diagnostics for one session.
 *
 * Read-only in exactly the sense `/activity` is: it must not resolve the
 * session, touch its idle clock, or hydrate its transcript, because the backend
 * sweeps every persisted session every couple of seconds and doing any of those
 * here would pin every transcript in memory forever.
 *
 * Always 200, never 404, for the same reason as `/activity`: a 404 on a shared
 * route reads as "this bridge predates the route" and fails the environment.
 * A session this bridge has never heard of has no drift to report, which is
 * exactly what an empty answer says.
 *
 * Registered as a two-segment path so the `/:id` route above cannot shadow it.
 */
session.get("/:id/runtime-health", (c) => {
  const sessionData = peekSession(c.req.param("id"));
  if (!sessionData?.health) return c.json(emptyRuntimeHealth());
  const { drift, notices } = sessionData.health.snapshot();
  return c.json({ summary: drift ? { drift } : {}, notices });
});

/**
 * Did this bridge ever take this request id?
 *
 * The backend asks after a prompt request whose acknowledgement was lost, so it
 * can settle the dispatch from this process's own dispatch state instead of
 * parking it for the user to resolve by hand.
 *
 * `dispatched` is only ever an explicit positive: a turn this process is
 * running, or one it has finished. `new` and `not-found` both answer `unknown`,
 * because neither distinguishes "never sent" from "sent to a bridge process
 * that has since restarted" — and reporting the second as never-sent would have
 * the caller dispatch the same turn twice.
 *
 * Registered before `/:id/...` catch-alls for the same reason as `/activity`.
 */
session.get("/:id/dispatch", (c) => {
  const requestId = c.req.query("requestId")?.trim();
  if (!requestId) return c.json({ dispatch: "unknown" });
  const state = getPromptDispatchState(c.req.param("id"), requestId);
  const dispatched = state === "processing" || state === "already-processed";
  return c.json({ dispatch: dispatched ? "dispatched" : "unknown" });
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
      return c.json(stalePrompt("Question is no longer pending"), STALE_PROMPT_STATUS);
    }

    if (!isBoundedClaudeQuestionAnswers(answersArray, pendingQuestion.questions.length)) {
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
      return c.json(stalePrompt("Question is no longer pending"), STALE_PROMPT_STATUS);
    }
  } catch (error) {
    console.error("[session] Error answering question:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to answer question" },
      500,
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

    const pendingApproval = getPendingPlanApprovals(sessionId).find(
      (approval) => approval.id === approvalId,
    );
    if (!pendingApproval) {
      return c.json(stalePrompt("Plan approval is no longer pending"), STALE_PROMPT_STATUS);
    }
    if (
      approved &&
      (typeof pendingApproval.plan !== "string" ||
        pendingApproval.plan.trim().length === 0 ||
        pendingApproval.planTruncated === true)
    ) {
      return c.json(
        { error: "A complete plan is required before approval", status: "rejected" },
        409,
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
      return c.json(stalePrompt("Plan approval is no longer pending"), STALE_PROMPT_STATUS);
    }
  } catch (error) {
    console.error("[session] Error responding to plan approval:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to respond to plan approval" },
      500,
    );
  }
});

export default session;
