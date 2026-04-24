// Session management routes
import { Hono } from "hono";
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  getSessionMessages,
  sendPrompt,
  abortSession,
  answerQuestion,
  getPendingQuestions,
  getSessionInitData,
  respondToPlanApproval,
  getPendingPlanApprovals,
} from "../services/session-manager.js";
import type {
  CreateSessionResponse,
  SessionListResponse,
  MessagesResponse,
} from "../types/index.js";

const session = new Hono();

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
session.get("/list", (c) => {
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
session.get("/:id", (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id);

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
  });
});

// Get session messages
session.get("/:id/messages", (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  const messages = getSessionMessages(id);
  const response: MessagesResponse = { messages };

  return c.json(response);
});

// Send a prompt to a session
session.post("/:id/prompt", async (c) => {
  const id = c.req.param("id");
  const sessionData = getSession(id);

  if (!sessionData) {
    return c.json({ error: "Session not found" }, 404);
  }

  try {
    const body = await c.req.json();
    const prompt = body.prompt as string;
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

    if (!prompt) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    console.debug("[session] Prompt received", {
      sessionId: id,
      promptLength: prompt.length,
      model,
      effort,
      permissionMode,
      fastMode,
      attachmentsCount: attachments?.length ?? 0,
    });

    // Start processing in background (don't await)
    sendPrompt(id, prompt, { model, attachments, effort, permissionMode, fastMode }).catch((error) => {
      console.error("[session] Error processing prompt:", error);
    });

    console.debug("[session] Prompt accepted", { sessionId: id });
    return c.json({ status: "processing" }, 202);
  } catch (error) {
    console.error("[session] Error sending prompt:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to send prompt" },
      500
    );
  }
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
session.delete("/:id", (c) => {
  const id = c.req.param("id");

  const deleted = deleteSession(id);

  if (deleted) {
    return c.json({ status: "deleted" });
  } else {
    return c.json({ error: "Session not found" }, 404);
  }
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
