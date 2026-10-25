import "./testing/unit-test-env.js";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_HOLD_CEILING_MS,
} from "@orkestrator/protocol/agent-interactions";
import type { AcpProcess, SessionState } from "./acp-context.js";
import { clearApprovals, parkGrokInteraction, parkPermission } from "./acp-session.js";
import { holdParkedRequest } from "./acp-interaction-hold.js";
import { publicApprovals, publicInteractions } from "./acp-public.js";
import { startPromptTurnClock, stopPromptTurnClock } from "./acp-prompt-clock.js";

const START = 1_800_000_000_000;
const MINUTE = 60_000;
const TURN = 30 * MINUTE;
const WINDOW = AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
const CEILING = AGENT_INTERACTION_HOLD_CEILING_MS;
const CANCELLED_PERMISSION = { outcome: { outcome: "cancelled" } };

describe("the turn's prompt clock while a parked request is held", () => {
  let parked: SessionState[];

  beforeEach(() => {
    parked = [];
    jest.useFakeTimers();
    jest.setSystemTime(new Date(START));
  });

  afterEach(() => {
    for (const state of parked) clearApprovals(state);
    jest.useRealTimers();
  });

  /** A session whose outstanding `session/prompt` runs on a pausable clock. */
  function turn(questionTimeoutMs?: number) {
    const responses: Array<{ id: number; result: unknown }> = [];
    const child = {
      respond: (id: number, result: unknown) => responses.push({ id, result }),
      questionTimeout: { timeoutMs: questionTimeoutMs, env: {}, source: "raised" },
    } as unknown as AcpProcess;
    const state = {
      id: "clock-test",
      acpSessionId: "vendor-session",
      child,
      approvals: new Map(),
      interactions: new Map(),
      revision: 0,
      status: "running",
    } as unknown as SessionState;
    parked.push(state);
    const timeouts: number[] = [];
    const clock = startPromptTurnClock(state, TURN, (timeoutAt) => timeouts.push(timeoutAt));
    return { state, child, responses, timeouts, clock };
  }

  function permission(session: ReturnType<typeof turn>, requestId = 7): string {
    const before = new Set(session.state.approvals.keys());
    parkPermission(session.state, session.child, requestId, {
      sessionId: "vendor-session",
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    return [...session.state.approvals.keys()].find((id) => !before.has(id))!;
  }

  test("holding stops the turn's timeout, so a pause runs to the day ceiling", () => {
    const session = turn();
    const { state, responses, timeouts } = session;
    expect(state.promptDeadlineAt).toBe(START + TURN);
    const id = permission(session);
    // The turn no longer limits the pause, so the card says nothing about it.
    expect(publicApprovals(state)[0]).toMatchObject({
      expiresAt: START + WINDOW,
      hold: { available: true },
    });
    expect(publicApprovals(state)[0]!.hold).toEqual({ available: true });

    jest.advanceTimersByTime(MINUTE);
    expect(holdParkedRequest(state, "approvals", id, true).body).toEqual({
      status: "applied",
      expiresAt: START + MINUTE + CEILING,
      hold: { available: true, heldAt: START + MINUTE },
    });
    // The turn had 29 minutes left; its timeout now waits past the latest
    // moment the held request could expire.
    expect(state.promptDeadlineAt).toBeUndefined();
    expect(timeouts).toEqual([START + MINUTE + 29 * MINUTE + CEILING]);

    // Two hours on, far past the turn's 30 minutes: still waiting.
    jest.advanceTimersByTime(2 * 60 * MINUTE);
    expect(responses).toEqual([]);
    expect(state.approvals.size).toBe(1);

    // Resume: a fresh window, and the turn restarts with the 29 minutes it had.
    const resumedAt = Date.now();
    expect(holdParkedRequest(state, "approvals", id, false).body).toEqual({
      status: "applied",
      expiresAt: resumedAt + WINDOW,
      hold: { available: true },
    });
    expect(state.promptDeadlineAt).toBe(resumedAt + 29 * MINUTE);
    expect(timeouts.at(-1)).toBe(resumedAt + 29 * MINUTE);
  });

  test("a resumed countdown is never cut short by the turn", () => {
    const session = turn();
    const { state, timeouts } = session;
    // Raised with two minutes of the turn left: the countdown shows that.
    jest.advanceTimersByTime(TURN - 2 * MINUTE);
    const id = permission(session);
    expect(publicApprovals(state)[0]).toMatchObject({
      expiresAt: START + TURN,
      hold: { available: true },
    });
    holdParkedRequest(state, "approvals", id, true);
    jest.advanceTimersByTime(60 * MINUTE);
    const resumedAt = Date.now();
    holdParkedRequest(state, "approvals", id, false);
    // Two minutes left would end the turn before the five-minute window.
    expect(state.promptDeadlineAt).toBe(resumedAt + WINDOW);
    expect(timeouts.at(-1)).toBe(resumedAt + WINDOW);
  });

  test("the clock restarts when a held request is answered, expires or is dropped", () => {
    const answered = turn();
    const id = permission(answered);
    jest.advanceTimersByTime(MINUTE);
    holdParkedRequest(answered.state, "approvals", id, true);
    jest.advanceTimersByTime(10 * MINUTE);
    answered.state.approvals.get(id)!.respond("allow");
    expect(answered.state.promptDeadlineAt).toBe(Date.now() + 29 * MINUTE);

    const expired = turn();
    const expiring = permission(expired);
    holdParkedRequest(expired.state, "approvals", expiring, true);
    jest.advanceTimersByTime(CEILING);
    expect(expired.responses).toEqual([{ id: 7, result: CANCELLED_PERMISSION }]);
    expect(expired.state.promptDeadlineAt).toBe(Date.now() + TURN);

    const dropped = turn();
    holdParkedRequest(dropped.state, "approvals", permission(dropped), true);
    clearApprovals(dropped.state);
    expect(dropped.state.promptDeadlineAt).toBe(Date.now() + TURN);
  });

  test("the clock stays stopped until the last held request is resumed", () => {
    const session = turn();
    const { state } = session;
    const first = permission(session, 7);
    const second = permission(session, 8);
    holdParkedRequest(state, "approvals", first, true);
    holdParkedRequest(state, "approvals", second, true);
    jest.advanceTimersByTime(MINUTE);
    holdParkedRequest(state, "approvals", first, false);
    expect(state.promptDeadlineAt).toBeUndefined();
    holdParkedRequest(state, "approvals", second, false);
    expect(state.promptDeadlineAt).toBe(Date.now() + TURN);
  });

  test("a held question still ends at a shorter question timeout Grok keeps", () => {
    const session = turn(10 * MINUTE);
    parkGrokInteraction(session.state, session.child, 9, "x.ai/ask_user_question", {
      sessionId: "vendor-session",
      toolCallId: "tool-question-1",
      questions: [{ id: "q", question: "Which?", options: [{ label: "A" }] }],
    });
    expect(holdParkedRequest(session.state, "interactions", "tool-question-1", true).body).toEqual({
      status: "applied",
      expiresAt: START + 10 * MINUTE,
      hold: { available: true, heldAt: START, reason: "provider-limit" },
    });
    jest.advanceTimersByTime(10 * MINUTE);
    expect(session.responses).toEqual([{ id: 9, result: { outcome: "cancelled" } }]);
    // Held from the start, so the turn lost none of its time.
    expect(session.state.promptDeadlineAt).toBe(Date.now() + TURN);
  });

  test("with Grok's question timeout raised a held question runs to the day ceiling", () => {
    const session = turn(CEILING);
    parkGrokInteraction(session.state, session.child, 9, "x.ai/ask_user_question", {
      sessionId: "vendor-session",
      toolCallId: "tool-question-1",
      questions: [{ id: "q", question: "Which?", options: [{ label: "A" }] }],
    });
    holdParkedRequest(session.state, "interactions", "tool-question-1", true);
    expect(publicInteractions(session.state)[0]).toMatchObject({
      expiresAt: START + CEILING,
      hold: { available: true, heldAt: START },
    });
  });

  test("stopping a clock a newer attempt replaced changes nothing", () => {
    const session = turn();
    const newer = startPromptTurnClock(session.state, TURN, () => undefined);
    stopPromptTurnClock(session.state, session.clock);
    expect(session.state.promptTurnClock).toBe(newer);
    stopPromptTurnClock(session.state, newer);
    expect(session.state.promptTurnClock).toBeUndefined();
    expect(session.state.promptDeadlineAt).toBeUndefined();
  });
});
