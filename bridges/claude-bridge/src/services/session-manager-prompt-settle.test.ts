import { describe, expect, spyOn, test } from "bun:test";
import { structuredOutputFailure } from "@orkestrator/protocol/structured-output";
import type { PromptOptions } from "../types/index.js";
import {
  captureEvents,
  createPromptTurnForTesting,
  createSession,
  releaseWithBackgroundWork,
  track,
} from "./session-manager-test-harness.js";
import { finalizeTurn, settleFailedTurn, settleTurnEnd } from "./session-manager-prompt-settle.js";
import { captureTurnStartup } from "./session-manager-prompt-turn.js";

function preparedTurn(options?: PromptOptions) {
  const session = createSession("settle");
  track(session.id);
  return createPromptTurnForTesting(session, options).turn;
}

describe("settleFailedTurn", () => {
  test("failed startup hands foreground back to a live runtime and removes only its prompt row", async () => {
    const { session, call, firstPrompt } = await releaseWithBackgroundWork("settle rollback");
    const before = captureTurnStartup(session);
    const messages = Array.from(session.messages);
    const { turn } = createPromptTurnForTesting(session, { requestId: "startup-failure" });
    const revision = session.transcriptRevision;
    const error = new Error("Join failed before submission");
    const { events, stop } = captureEvents();
    try {
      expect(() => settleFailedTurn(turn, error)).toThrow(error);
      expect(captureTurnStartup(session)).toEqual(before);
      expect(session.messages).toEqual(messages);
      expect(session.messages).not.toContain(turn.userMessage);
      expect(session.transcriptRevision).toBeGreaterThan(revision!);
      expect(session.claudeRuntime?.state).toBe("open");
      expect(session.claudeRuntime?.abortController.signal.aborted).toBe(false);
      expect(events.some((event) => event.type === "session.error")).toBe(false);
    } finally {
      stop();
      finalizeTurn(turn);
      call.finish();
      await firstPrompt;
    }
  });

  test("abort resolves the failure and records interrupted structured output once", () => {
    const turn = preparedTurn({ requestId: "aborted", outputSchema: { type: "object" } });
    turn.queryStarted = true;
    turn.abortController.abort();
    const { events, stop } = captureEvents();
    try {
      expect(() => settleFailedTurn(turn, new Error("Transport closed"))).not.toThrow();
      expect(turn.session.structuredOutput).toEqual(
        structuredOutputFailure(
          "claude",
          "interrupted",
          "Claude structured-output turn was interrupted.",
          {
            requestId: "aborted",
            retryable: true,
          },
        ),
      );
      settleFailedTurn(turn, new Error("Repeated failure"));
      expect(events.filter((event) => event.type === "session.structured-output")).toHaveLength(1);
      expect(events.some((event) => event.type === "session.error")).toBe(false);
    } finally {
      stop();
      finalizeTurn(turn);
    }
  });

  test("an aborted old turn cannot overwrite a newer structured request", () => {
    const turn = preparedTurn({ requestId: "old", outputSchema: { type: "object" } });
    turn.session.structuredOutputRequestId = "new";
    turn.abortController.abort();
    try {
      settleFailedTurn(turn, new Error("Old transport closed"));
      expect(turn.session.structuredOutputRequestId).toBe("new");
      expect(turn.session.structuredOutput).toBeUndefined();
    } finally {
      finalizeTurn(turn);
    }
  });

  test("flushes pending output before recording provider failure and emitting session.error", () => {
    const turn = preparedTurn({ requestId: "failed", outputSchema: { type: "object" } });
    turn.queryStarted = true;
    turn.session.completionBlockedByBackgroundTasks = true;
    const { events, stop } = captureEvents();
    const flush = spyOn(turn.stream, "flushStreamedAssistantMessage").mockImplementation(() => {
      expect(turn.session.status).toBe("running");
      expect(events).toHaveLength(0);
    });
    const log = spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Provider failed");
    try {
      expect(() => settleFailedTurn(turn, error)).toThrow(error);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(turn.session.status).toBe("error");
      expect(turn.session.error).toBe(error.message);
      expect(turn.session.abortController).toBeUndefined();
      expect(turn.session.turnStartedAt).toBeUndefined();
      expect(turn.session.completionBlockedByBackgroundTasks).toBe(false);
      expect(turn.session.structuredOutput).toEqual(
        structuredOutputFailure("claude", "provider_error", error.message, { requestId: "failed" }),
      );
      expect(events.map((event) => event.type)).toEqual([
        "session.structured-output",
        "session.error",
      ]);
      expect(events[1]?.data).toEqual({ error: "Provider failed" });
      expect(log).toHaveBeenCalledWith("[session-manager] Error processing prompt", {
        errorClass: "Error",
      });
    } finally {
      stop();
      flush.mockRestore();
      log.mockRestore();
      finalizeTurn(turn);
    }
  });

  test("an old failure rethrows without setting the new foreground to error", () => {
    const turn = preparedTurn();
    turn.queryStarted = true;
    const nextAbort = new AbortController();
    turn.session.abortController = nextAbort;
    turn.session.latestTurnGeneration = turn.turnGeneration + 1;
    const { events, stop } = captureEvents();
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => settleFailedTurn(turn, "old failure")).toThrow("old failure");
      expect(turn.session.status).toBe("running");
      expect(turn.session.abortController).toBe(nextAbort);
      expect(turn.session.error).toBeUndefined();
      expect(events.some((event) => event.type === "session.error")).toBe(false);
    } finally {
      stop();
      log.mockRestore();
      finalizeTurn(turn);
    }
  });
});

describe("settleTurnEnd plan rejection", () => {
  test("hands back foreground and returns one plan follow-up with the original settings", () => {
    const turn = preparedTurn({
      model: "claude-sonnet-test",
      effort: "high",
      fastMode: true,
      approvalMode: "default",
      readOnly: false,
      parameterValues: { thinking: "adaptive" },
      attachments: [{ type: "file", path: "/tmp/already-seen.txt", filename: "already-seen.txt" }],
      requestId: "original",
      outputSchema: { type: "object" },
    });
    turn.pendingPlanRejectionFeedback = "Revise the plan";
    try {
      const followUp = settleTurnEnd(turn);
      expect(followUp?.prompt).toBe("Revise the plan");
      expect(followUp?.options).toEqual({
        model: "claude-sonnet-test",
        effort: "high",
        fastMode: true,
        approvalMode: "default",
        readOnly: false,
        parameterValues: { thinking: "adaptive" },
        permissionMode: "plan",
        _isReprompt: true,
      });
      expect(turn.pendingPlanRejectionFeedback).toBeNull();
      expect(turn.session.status).toBe("idle");
      expect(turn.session.abortController).toBeUndefined();
      expect(settleTurnEnd(turn)).toBeUndefined();
    } finally {
      finalizeTurn(turn);
    }
  });

  test.each(["reprompt", "aborted", "superseded"])("does not follow up a %s turn", (reason) => {
    const turn = preparedTurn(reason === "reprompt" ? { _isReprompt: true } : undefined);
    turn.pendingPlanRejectionFeedback = "Revise again";
    if (reason === "aborted") turn.abortController.abort();
    if (reason === "superseded") turn.superseded = true;
    try {
      expect(settleTurnEnd(turn)).toBeUndefined();
    } finally {
      finalizeTurn(turn);
    }
  });
});

describe("synthetic approval-mode retention", () => {
  test.each(["default", "acceptEdits", "auto"] as const)(
    "approved-plan continuation preserves %s and caps implementation permissions",
    (approvalMode) => {
      const turn = preparedTurn({ permissionMode: "plan", approvalMode });
      turn.pendingPlanApprovalContinuation = "Implement the approved plan";
      try {
        expect(settleTurnEnd(turn)?.options).toMatchObject({
          approvalMode,
          permissionMode: approvalMode,
        });
        turn.session.executionPolicy = {
          id: "interactive-host",
          sandbox: "provider",
          approvals: "ask",
          projectResources: true,
          networkAccess: "full",
        };
        turn.pendingPlanApprovalContinuation = "Implement safely";
        expect(settleTurnEnd(turn)?.options).toMatchObject({
          approvalMode,
          permissionMode: "default",
        });
      } finally {
        finalizeTurn(turn);
      }
    },
  );
});

describe("interrupt request cleanup", () => {
  test.each([false, true])("finalization clears only its own generation (newer=%s)", (newer) => {
    const turn = preparedTurn();
    const requested = turn.turnGeneration + (newer ? 1 : 0);
    turn.session.interruptRequestedGeneration = requested;
    finalizeTurn(turn);
    expect(turn.session.interruptRequestedGeneration).toBe(newer ? requested : undefined);
  });
});
