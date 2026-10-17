import { describe, expect, jest, test } from "bun:test";
import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_HOLD_CEILING_MS,
} from "@orkestrator/protocol/agent-interactions";
import {
  createSession,
  getPendingInteractions,
  getPendingPlanApprovals,
  getPendingQuestions,
  nextQueryCall,
  sendPrompt,
  track,
} from "./session-manager-test-harness.js";
import { holdPendingRequest } from "./session-manager-interaction-holds.js";

const WINDOW = AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
const CEILING = AGENT_INTERACTION_HOLD_CEILING_MS;

/** Let every settled promise chain run; fake timers do not drive microtasks. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** A running turn, with fake timers armed before anything is parked. */
async function runningTurn(name: string) {
  const session = createSession(name);
  track(session.id);
  const prompt = sendPrompt(session.id, "go");
  const call = await nextQueryCall();
  session.executionPolicy = {
    id: "interactive-host",
    sandbox: "none",
    approvals: "ask",
    projectResources: true,
    networkAccess: "full",
  };
  jest.useFakeTimers();
  const finish = async () => {
    jest.useRealTimers();
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt.catch(() => undefined);
  };
  return { session, call, finish };
}

function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return () => settled;
}

describe("pausing a parked request's deadline", () => {
  test("a paused question outlives its window, and a resume restarts a fresh one", async () => {
    const { session, call, finish } = await runningTurn("hold-question");
    try {
      const decision = call.options.canUseTool!("AskUserQuestion", {
        questions: [{ question: "Still there?" }],
      });
      const settled = settledFlag(decision);
      await flush();
      const [question] = getPendingQuestions(session.id);
      expect(question?.hold).toEqual({ available: true });
      expect(question?.requestedAt).toBe(Date.now());

      jest.advanceTimersByTime(WINDOW - 1_000);
      const pausedAt = Date.now();
      expect(holdPendingRequest("questions", session.id, question!.id, true)).toEqual({
        status: "applied",
        expiresAt: pausedAt + CEILING,
        hold: { available: true, heldAt: pausedAt },
      });
      // The published request moves with the deadline.
      expect(getPendingQuestions(session.id)[0]).toMatchObject({
        expiresAt: pausedAt + CEILING,
        hold: { available: true, heldAt: pausedAt },
      });

      jest.advanceTimersByTime(2 * 60 * 60_000);
      await flush();
      expect(settled()).toBe(false);
      expect(getPendingQuestions(session.id)).toHaveLength(1);

      const resumedAt = Date.now();
      expect(holdPendingRequest("questions", session.id, question!.id, false)).toEqual({
        status: "applied",
        expiresAt: resumedAt + WINDOW,
        hold: { available: true },
      });
      jest.advanceTimersByTime(WINDOW - 1);
      await flush();
      expect(settled()).toBe(false);
      jest.advanceTimersByTime(1);
      await expect(decision).resolves.toEqual({
        behavior: "deny",
        message: "Question timed out after 5 minutes",
      });
      expect(getPendingQuestions(session.id)).toEqual([]);
    } finally {
      await finish();
    }
  });

  test("a pause still ends at the ceiling, and Claude is told it stayed paused", async () => {
    const { session, call, finish } = await runningTurn("hold-plan-ceiling");
    try {
      const decision = call.options.canUseTool!("ExitPlanMode", { plan: "# Plan" });
      await flush();
      const [approval] = getPendingPlanApprovals(session.id);
      expect(holdPendingRequest("plan-approvals", session.id, approval!.id, true).status).toBe(
        "applied",
      );
      // Pausing twice changes nothing.
      expect(holdPendingRequest("plan-approvals", session.id, approval!.id, true).status).toBe(
        "unchanged",
      );
      jest.advanceTimersByTime(CEILING);
      await expect(decision).resolves.toEqual({
        behavior: "deny",
        message: "Plan approval timed out after staying paused for 24 hours",
      });
      expect(holdPendingRequest("plan-approvals", session.id, approval!.id, false).status).toBe(
        "stale",
      );
    } finally {
      await finish();
    }
  });

  test("a paused tool approval is not denied while paused and still answers normally", async () => {
    const { session, call, finish } = await runningTurn("hold-tool-approval");
    try {
      const decision = call.options.canUseTool!("Bash", { command: "ls" }, {
        signal: new AbortController().signal,
        requestId: "hold-tool-approval-request",
      } as never);
      await flush();
      expect(getPendingInteractions(session.id)[0]?.hold).toEqual({ available: true });
      holdPendingRequest("interactions", session.id, "hold-tool-approval-request", true);
      jest.advanceTimersByTime(WINDOW * 12);
      await flush();
      expect(getPendingInteractions(session.id)).toHaveLength(1);
      jest.useRealTimers();

      const { respondToInteraction } = await import("./session-manager-interactions.js");
      expect(respondToInteraction("hold-tool-approval-request", { action: "accept" })).toBe(true);
      await expect(decision).resolves.toEqual({
        behavior: "allow",
        updatedInput: { command: "ls" },
      });
      // Answered is closed: the hold route reports it stale.
      expect(
        holdPendingRequest("interactions", session.id, "hold-tool-approval-request", false).status,
      ).toBe("stale");
    } finally {
      await finish();
    }
  });

  test("an MCP elicitation pauses but warns that its server may stop waiting", async () => {
    const { session, call, finish } = await runningTurn("hold-elicitation");
    try {
      const result = call.options.onElicitation!(
        { serverName: "linear", message: "Which team?", mode: "url", url: "https://example.com" },
        { signal: new AbortController().signal, requestId: "hold-elicitation-request" },
      );
      await flush();
      expect(getPendingInteractions(session.id)[0]?.hold).toEqual({
        available: true,
        reason: "upstream-may-expire",
      });
      const paused = holdPendingRequest(
        "interactions",
        session.id,
        "hold-elicitation-request",
        true,
      );
      expect(paused).toMatchObject({
        status: "applied",
        hold: { available: true, reason: "upstream-may-expire" },
      });
      jest.advanceTimersByTime(CEILING);
      // Expiry is unchanged by the pause: an unanswered elicitation is cancelled.
      await expect(result).resolves.toEqual({ action: "cancel" });
    } finally {
      await finish();
    }
  });

  test("an unknown request, or one from another session, is stale", async () => {
    const { session, call, finish } = await runningTurn("hold-unknown");
    try {
      const other = createSession("hold-unknown-other");
      track(other.id);
      void call.options.canUseTool!("AskUserQuestion", { questions: [{ question: "Mine?" }] });
      await flush();
      const [question] = getPendingQuestions(session.id);
      expect(holdPendingRequest("questions", session.id, "never-parked", true).status).toBe(
        "stale",
      );
      expect(holdPendingRequest("questions", other.id, question!.id, true).status).toBe("stale");
      expect(holdPendingRequest("interactions", session.id, question!.id, true).status).toBe(
        "stale",
      );
    } finally {
      await finish();
    }
  });
});
