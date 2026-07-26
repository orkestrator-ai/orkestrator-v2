// Session management routes
import { Hono } from "hono";
import {
  createSession,
  getSession,
  listSessions,
  getSessionMessages,
  sendPrompt,
  abortSession,
  answerQuestion,
  dismissQuestion,
  getPendingQuestions,
  getSessionInitData,
  getStructuredPromptDispatchState,
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
} from "../services/session-manager.js";
import type {
  CreateSessionResponse,
  SessionListResponse,
  MessagesResponse,
} from "../types/index.js";
import { isJsonSchema } from "@orkestrator/protocol/structured-output";

const session = new Hono();
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

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

// Create a new session
session.post("/create", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const title = body.title as string | undefined;

    const newSession = createSession(title);
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
  await reconcilePersistedSessions();
  const sessions = listSessions();

  const response: SessionListResponse = {
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
    })),
  };

  return c.json(response);
});

// Get session details
session.get("/:id", async (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id) ?? await ensurePersistedSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({
    id: sessionData.id,
    title: sessionData.title,
    status: sessionData.status,
    createdAt: sessionData.createdAt.toISOString(),
    lastActivity: sessionData.lastActivity.toISOString(),
    error: sessionData.error,
    structuredOutputRequestId: sessionData.structuredOutputRequestId,
    structuredOutput: sessionData.structuredOutput,
    contextUsage: sessionData.usage,
    promptSuggestion: sessionData.promptSuggestion,
    backgroundTasks: sessionData.backgroundTasks ?? {},
  });
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
session.get("/:id/tasks", (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  // A session that has never run a task tool has an empty, and complete, list.
  return c.json(sessionData.taskRegistry?.snapshot() ?? { items: [], complete: true });
});

// Get session messages
session.get("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id) ?? await ensurePersistedSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  const messages =
    sessionData.persistedMessagesLoaded === false
      ? await hydratePersistedSessionMessages(id)
      : getSessionMessages(id);
  const response: MessagesResponse = { messages };

  return c.json(response);
});

// Send a prompt to a session
session.post("/:id/prompt", async (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id) ?? await ensurePersistedSession(id);

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

    if (outputSchema && requestId) {
      const dispatchState = getStructuredPromptDispatchState(id, requestId);
      if (dispatchState === "processing") {
        return c.json({ status: "processing", requestId, duplicate: true }, 202);
      }
      if (dispatchState === "already-processed") {
        return c.json({ status: "already-processed", requestId, duplicate: true });
      }
    }
    if (sessionData.status === "running") {
      return c.json({ error: "Session is already processing a prompt" }, 409);
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
    return c.json({ status: "processing", requestId }, 202);
  } catch (error) {
    console.error("[session] Error sending prompt:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to send prompt" },
      500
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
    return c.json({ error: "Question not found or already resolved" }, 404);
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

  const deleted = await deleteSessionDurably(id);

  if (deleted) {
    return c.json({ status: "deleted" });
  } else {
    return c.json({ error: "Session not found" }, 404);
  }
});

session.post("/:id/rename", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return c.json({ error: "Title is required" }, 400);
  const renamed = await renameSessionDurably(id, title);
  return renamed
    ? c.json({ status: "renamed", title })
    : c.json({ error: "Session not found" }, 404);
});

session.post("/:id/fork", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const upToMessageId =
    typeof body.upToMessageId === "string" && body.upToMessageId.trim()
      ? body.upToMessageId.trim()
      : undefined;
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : undefined;
  const forked = await forkPersistedSession(id, { upToMessageId, title });
  return c.json({
    sessionId: forked.id,
    title: forked.title,
  }, 201);
});

session.post("/:id/compact", async (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id) ?? await ensurePersistedSession(id);
  if (!sessionData) return c.json({ error: "Session not found" }, 404);
  if (sessionData.status === "running") {
    return c.json({ error: "Session is already processing a prompt" }, 409);
  }
  void sendPrompt(id, "/compact").catch((error) => {
    console.error("[session] Claude compaction failed:", error);
  });
  return c.json({ status: "processing" }, 202);
});

session.post("/:id/rewind", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const messageId =
    typeof body.messageId === "string" ? body.messageId.trim() : "";
  if (!messageId) return c.json({ error: "messageId is required" }, 400);
  const result = await rewindSessionFiles(id, messageId, body.dryRun === true);
  return c.json({ status: body.dryRun === true ? "previewed" : "rewound", result });
});

session.post("/:id/tasks/:taskId/stop", async (c) => {
  const stopped = await stopBackgroundTask(
    c.req.param("id"),
    c.req.param("taskId"),
  );
  return stopped
    ? c.json({ status: "stopped" })
    : c.json({ error: "Task is not running" }, 404);
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
session.post("/:id/questions/:questionId/answer", async (c) => {
  const sessionId = c.req.param("id");
  const questionId = c.req.param("questionId");

  const sessionData = getSession(sessionId);
  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  try {
    const body = await c.req.json();
    const answersArray = body.answers as string[][];

    if (!answersArray || !Array.isArray(answersArray)) {
      return c.json({ error: "Answers array is required" }, 400);
    }

    // Get the pending question to access the question text for mapping
    const pendingQuestions = getPendingQuestions(sessionId);
    const pendingQuestion = pendingQuestions.find((q) => q.id === questionId);

    if (!pendingQuestion) {
      console.log("[session] Pending question not found:", questionId);
      return c.json({ error: "Question not found" }, 404);
    }

    // Convert string[][] to Record<string, string>
    // Map each question's text to its answer(s) joined as a string
    const answersRecord: Record<string, string> = {};
    pendingQuestion.questions.forEach((q, index) => {
      const questionAnswers = answersArray[index] || [];
      // Join multiple answers with commas, or use first answer if single
      answersRecord[q.question] = questionAnswers.join(", ");
    });

    console.log("[session] Converted answers from array to record:", answersRecord);

    const answered = answerQuestion(questionId, answersRecord);

    if (answered) {
      return c.json({ status: "answered" });
    } else {
      return c.json({ error: "Question not found or already answered" }, 404);
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
      return c.json({ error: "Plan approval not found or already responded" }, 404);
    }

    console.log("[session] Plan approval response received", {
      sessionId,
      approvalId,
      approved,
      feedback,
    });

    const responded = respondToPlanApproval(approvalId, approved, feedback);

    if (responded) {
      return c.json({ status: approved ? "approved" : "rejected" });
    } else {
      return c.json({ error: "Plan approval not found or already responded" }, 404);
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
