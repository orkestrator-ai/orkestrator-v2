import "./testing/unit-test-env.js";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_HOLD_CEILING_MS,
} from "@orkestrator/protocol/agent-interactions";
import { sessions, type AcpProcess, type SessionState } from "./acp-context.js";
import {
  attachChild,
  clearApprovals,
  ensureSessionProcess,
  GROK_QUESTION_DEFAULT_TIMEOUT_MS,
  grokQuestionTimeoutMs,
  parkGrokInteraction,
  parkPermission,
} from "./acp-session.js";
import { closeSessionRetaining, denyPendingRequests } from "./acp-session-close.js";
import { holdParkedRequest } from "./acp-interaction-hold.js";
import { publicApprovals, publicInteractions } from "./acp-public.js";

describe("ensureSessionProcess fingerprint", () => {
  test("a session created without agentMcp keeps the same child", async () => {
    let closed = 0;
    const child = {
      close: async () => {
        closed += 1;
      },
    } as AcpProcess;
    const state = {
      child,
      approvals: new Map(),
      interactions: new Map(),
      status: "idle",
    } as SessionState;

    const first = await ensureSessionProcess(state);
    const second = await ensureSessionProcess(state);
    expect(first).toBe(child);
    expect(second).toBe(child);
    expect(closed).toBe(0);
  });
});

describe("close of Cursor tool metadata replay", () => {
  test("waits for the replay child to exit before confirming close", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closes = 0;
    const childState = { exitCode: null as number | null, signalCode: null as string | null };
    const replayChild = {
      child: childState,
      close: async () => {
        closes += 1;
        await gate;
        childState.exitCode = 0;
      },
    } as AcpProcess;
    const state = {
      id: "replay-close-test",
      acpSessionId: "vendor-session",
      child: null,
      approvals: new Map(),
      interactions: new Map(),
      cursorToolReplayChildren: new Set([replayChild]),
      status: "idle",
    } as SessionState;
    sessions.set(state.id, state);
    try {
      let settled = false;
      const closing = closeSessionRetaining(state).finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(closes).toBe(1);
      expect(settled).toBe(false);
      release();
      expect(await closing).toBe("closed");
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      release();
      sessions.delete(state.id);
    }
  });
});

describe("ACP child generations", () => {
  test("declines a superseded child's permission on that child", () => {
    const oldResponses: Array<{ id: number; result: unknown }> = [];
    const newResponses: Array<{ id: number; result: unknown }> = [];
    const child = (responses: Array<{ id: number; result: unknown }>) =>
      ({
        respond: (id: number, result: unknown) => responses.push({ id, result }),
      }) as AcpProcess;
    const oldChild = child(oldResponses);
    const newChild = child(newResponses);
    const state = {
      id: "generation-test",
      acpSessionId: "vendor-session",
      child: oldChild,
      approvals: new Map(),
      interactions: new Map(),
      status: "idle",
    } as SessionState;
    sessions.set(state.id, state);
    try {
      attachChild(state, oldChild);
      attachChild(state, newChild);

      oldChild.onPermission(7, {
        sessionId: state.acpSessionId,
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      });

      expect(oldResponses).toEqual([{ id: 7, result: { outcome: { outcome: "cancelled" } } }]);
      expect(newResponses).toEqual([]);
      expect(state.approvals).toHaveLength(0);
    } finally {
      sessions.delete(state.id);
    }
  });
});

describe("Grok reverse interactions", () => {
  test("parks plan mode exits under the provider tool-call id and resolves exactly once", () => {
    const responses: Array<{ id: number; result: unknown }> = [];
    const child = {
      respond: (id: number, result: unknown) => responses.push({ id, result }),
    } as AcpProcess;
    const state = {
      id: "grok-test",
      acpSessionId: "vendor-session",
      child,
      approvals: new Map(),
      interactions: new Map(),
      revision: 0,
      status: "running",
    } as SessionState;

    parkGrokInteraction(state, child, 17, "x.ai/exit_plan_mode", {
      sessionId: state.acpSessionId,
      toolCallId: "tool-plan-1",
      planContent: "# Plan\n\nImplement the adapter.",
    });

    expect(publicInteractions(state)).toEqual([
      expect.objectContaining({
        id: "tool-plan-1",
        kind: "plan-approval",
        plan: "# Plan\n\nImplement the adapter.",
        planTruncated: false,
      }),
    ]);
    state.interactions.get("tool-plan-1")!.respond({ outcome: "approved" });
    state.interactions.get("tool-plan-1")?.respond({ outcome: "cancelled" });
    expect(responses).toEqual([{ id: 17, result: { outcome: "approved" } }]);
    expect(state.interactions).toHaveLength(0);
  });
});

describe("permission metadata ownership", () => {
  test("a reused id cannot inherit trusted wrapper input from a completed turn", () => {
    for (const toolName of ["orkestrator__check_inbox", "orkestrator__get_annotation_request"]) {
      const responses: unknown[] = [];
      const child = {
        respond: (_id: number, result: unknown) => responses.push(result),
      } as AcpProcess;
      const state = {
        id: "permission-turn-test",
        acpSessionId: "vendor-session",
        status: "running",
        policy: { approvals: "ask" },
        messages: [
          { id: "old-user", role: "user", content: "old", parts: [] },
          {
            id: "old-assistant",
            role: "assistant",
            content: "",
            parts: [
              {
                type: "tool-invocation",
                toolUseId: "reused",
                toolName: "use_tool",
                toolArgs: { tool_name: toolName },
                toolState: "completed",
              },
            ],
          },
          { id: "new-user", role: "user", content: "new", parts: [] },
        ],
        approvals: new Map(),
        interactions: new Map(),
        revision: 0,
      } as unknown as SessionState;
      sessions.set(state.id, state);
      try {
        attachChild(state, child);
        const params = {
          sessionId: state.acpSessionId,
          toolCall: {
            toolCallId: "reused",
            _meta: { "x.ai/tool": { name: "use_tool" } },
          },
          options: [{ optionId: "allow", kind: "allow_once" }],
        };
        child.onPermission(1, params);
        expect(responses).toEqual([]);
        expect(state.approvals.size).toBe(1);
        clearApprovals(state);
        // Once the current turn supplies its own metadata the same wrapper is trusted.
        state.messages.push({
          id: "new-assistant",
          role: "assistant",
          content: "",
          createdAt: "",
          parts: [
            {
              type: "tool-invocation",
              content: "",
              toolUseId: "reused",
              toolName: "use_tool",
              toolArgs: { tool_name: toolName },
              sourcePartId: "new:0",
              sourceMessageId: "new-assistant",
            },
          ],
        });
        child.onPermission(2, params);
        expect(responses).toEqual([{ outcome: { outcome: "selected", optionId: "allow" } }]);
      } finally {
        clearApprovals(state);
        sessions.delete(state.id);
      }
    }
  });

  test("auto-approve leaves denied provider tools and unclassified requests pending", () => {
    for (const [name, kind, deny] of [
      ["write_file", "edit", "write_file"],
      ["run_terminal_cmd", "execute", "run_terminal_cmd"],
      ["run_terminal_cmd", "other", "shell"],
      ["unknown_tool", "vendor_kind", "shell"],
    ]) {
      const responses: unknown[] = [];
      const child = {
        respond: (_id: number, result: unknown) => responses.push(result),
      } as AcpProcess;
      const state = {
        id: "denied-provider-tool",
        acpSessionId: "vendor-session",
        messages: [],
        policy: { approvals: "auto-approve", toolPolicy: { deny: [deny] } },
        approvals: new Map(),
        interactions: new Map(),
        revision: 0,
      } as unknown as SessionState;
      sessions.set(state.id, state);
      try {
        attachChild(state, child);
        child.onPermission(1, {
          sessionId: state.acpSessionId,
          toolCall: { _meta: { "x.ai/tool": { name } }, kind },
          options: [{ optionId: "allow", kind: "allow_once" }],
        });
        expect(responses).toEqual([]);
        expect(state.approvals.size).toBe(1);
      } finally {
        clearApprovals(state);
        sessions.delete(state.id);
      }
    }
  });

  test("even trusted Orkestrator tools respect explicit tool denials", () => {
    const responses: unknown[] = [];
    const child = {
      respond: (_id: number, result: unknown) => responses.push(result),
    } as AcpProcess;
    const state = {
      id: "denied-mail",
      acpSessionId: "vendor-session",
      messages: [],
      policy: { approvals: "auto-approve", toolPolicy: { deny: ["orkestrator__check_inbox"] } },
      approvals: new Map(),
      interactions: new Map(),
      revision: 0,
    } as unknown as SessionState;
    sessions.set(state.id, state);
    try {
      attachChild(state, child);
      child.onPermission(1, {
        sessionId: state.acpSessionId,
        toolCall: {
          name: "use_tool",
          kind: "other",
          rawInput: { tool_name: "orkestrator__check_inbox" },
        },
        options: [{ optionId: "allow", kind: "allow_once" }],
      });
      expect(responses).toEqual([]);
      expect(state.approvals.size).toBe(1);
    } finally {
      clearApprovals(state);
      sessions.delete(state.id);
    }
  });
});

const START = 1_800_000_000_000;
const MINUTE = 60_000;
const WINDOW = AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
const CEILING = AGENT_INTERACTION_HOLD_CEILING_MS;
const GROK_QUESTION_ENV = [
  "GROK_ASK_USER_QUESTION_TIMEOUT_SECS",
  "GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED",
] as const;
const CANCELLED_PERMISSION = { outcome: { outcome: "cancelled" } };

describe("pausing a parked request's deadline", () => {
  let savedEnv: Partial<Record<(typeof GROK_QUESTION_ENV)[number], string>>;
  let parked: SessionState[];

  beforeEach(() => {
    // Whatever the developer's shell exports must not pick Grok's limit here.
    savedEnv = {};
    for (const name of GROK_QUESTION_ENV) {
      if (process.env[name] !== undefined) savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    parked = [];
    jest.useFakeTimers();
    jest.setSystemTime(new Date(START));
  });

  afterEach(() => {
    for (const state of parked) clearApprovals(state);
    jest.useRealTimers();
    for (const name of GROK_QUESTION_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  /** A session with a turn whose `session/prompt` times out at `turnEndsAt`. */
  function session(turnEndsAt: number | undefined) {
    const responses: Array<{ id: number; result: unknown }> = [];
    const child = {
      respond: (id: number, result: unknown) => responses.push({ id, result }),
    } as AcpProcess;
    const state = {
      id: "hold-test",
      acpSessionId: "vendor-session",
      child,
      approvals: new Map(),
      interactions: new Map(),
      revision: 0,
      status: "running",
      ...(turnEndsAt === undefined ? {} : { promptDeadlineAt: turnEndsAt }),
    } as SessionState;
    parked.push(state);
    return { state, child, responses };
  }

  function permission(turnEndsAt: number | undefined) {
    const parkedSession = session(turnEndsAt);
    parkPermission(parkedSession.state, parkedSession.child, 7, {
      sessionId: "vendor-session",
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    const id = [...parkedSession.state.approvals.keys()][0]!;
    return { ...parkedSession, id };
  }

  function question(turnEndsAt: number | undefined) {
    const parkedSession = session(turnEndsAt);
    parkGrokInteraction(parkedSession.state, parkedSession.child, 9, "x.ai/ask_user_question", {
      sessionId: "vendor-session",
      toolCallId: "tool-question-1",
      questions: [{ id: "q", question: "Which?", options: [{ label: "A" }] }],
    });
    return { ...parkedSession, id: "tool-question-1" };
  }

  test("a held permission outlives its window and is cancelled at the turn deadline", () => {
    const turnEndsAt = START + 30 * MINUTE;
    const { state, responses, id } = permission(turnEndsAt);
    expect(publicApprovals(state)).toEqual([
      expect.objectContaining({
        requestedAt: START,
        expiresAt: START + WINDOW,
        hold: { available: true, reason: "provider-limit" },
      }),
    ]);

    jest.advanceTimersByTime(MINUTE);
    expect(holdParkedRequest(state, "approvals", id, true)).toEqual({
      status: 200,
      body: {
        status: "applied",
        expiresAt: turnEndsAt,
        hold: { available: true, heldAt: START + MINUTE, reason: "provider-limit" },
      },
    });
    expect(state.revision).toBe(2);
    // Pausing again changes nothing, so publishes nothing new.
    expect(holdParkedRequest(state, "approvals", id, true)).toMatchObject({
      status: 200,
      body: { status: "unchanged", expiresAt: turnEndsAt },
    });
    expect(state.revision).toBe(2);

    jest.advanceTimersByTime(turnEndsAt - Date.now() - 1);
    // Well past the five-minute window: still parked, never answered by the hold.
    expect(responses).toEqual([]);
    expect(publicApprovals(state)).toEqual([
      expect.objectContaining({
        expiresAt: turnEndsAt,
        hold: { available: true, heldAt: START + MINUTE, reason: "provider-limit" },
      }),
    ]);

    jest.advanceTimersByTime(1);
    expect(responses).toEqual([{ id: 7, result: CANCELLED_PERMISSION }]);
    expect(state.approvals.size).toBe(0);
    expect(holdParkedRequest(state, "approvals", id, false)).toEqual({
      status: 409,
      body: { error: "Approval is no longer pending", status: "stale" },
    });
  });

  test("with no prompt request outstanding a pause holds until the day ceiling", () => {
    const { state, responses, id } = permission(undefined);
    expect(publicApprovals(state)[0]).toMatchObject({ hold: { available: true } });
    expect(holdParkedRequest(state, "approvals", id, true).body).toEqual({
      status: "applied",
      expiresAt: START + CEILING,
      hold: { available: true, heldAt: START },
    });
    jest.advanceTimersByTime(CEILING - 1);
    expect(responses).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(responses).toEqual([{ id: 7, result: CANCELLED_PERMISSION }]);
  });

  test("resume re-arms a fresh window, capped by the turn deadline", () => {
    const turnEndsAt = START + 30 * MINUTE;
    const { state, responses, id } = permission(turnEndsAt);
    jest.advanceTimersByTime(4 * MINUTE);
    holdParkedRequest(state, "approvals", id, true);
    jest.advanceTimersByTime(10 * MINUTE);

    expect(holdParkedRequest(state, "approvals", id, false).body).toEqual({
      status: "applied",
      expiresAt: START + 19 * MINUTE,
      hold: { available: true, reason: "provider-limit" },
    });
    expect(publicApprovals(state)[0]).toMatchObject({
      expiresAt: START + 19 * MINUTE,
      hold: { available: true, reason: "provider-limit" },
    });

    // Paused again and resumed three minutes before the turn ends: the fresh
    // window would run past it, so it ends with the turn instead.
    jest.advanceTimersByTime(MINUTE);
    holdParkedRequest(state, "approvals", id, true);
    jest.advanceTimersByTime(12 * MINUTE);
    expect(holdParkedRequest(state, "approvals", id, false).body).toMatchObject({
      status: "applied",
      expiresAt: turnEndsAt,
    });
    jest.advanceTimersByTime(turnEndsAt - Date.now() - 1);
    expect(responses).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(responses).toEqual([{ id: 7, result: CANCELLED_PERMISSION }]);
  });

  test("a question's pause ends at Grok's own question timeout", () => {
    const { state, responses, id } = question(START + 60 * MINUTE);
    expect(holdParkedRequest(state, "interactions", id, true).body).toEqual({
      status: "applied",
      expiresAt: START + GROK_QUESTION_DEFAULT_TIMEOUT_MS,
      hold: { available: true, heldAt: START, reason: "provider-limit" },
    });
    expect(publicInteractions(state)).toEqual([
      expect.objectContaining({
        id,
        kind: "question",
        requestedAt: START,
        expiresAt: START + 30 * MINUTE,
        hold: { available: true, heldAt: START, reason: "provider-limit" },
      }),
    ]);
    jest.advanceTimersByTime(30 * MINUTE - 1);
    expect(responses).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(responses).toEqual([{ id: 9, result: { outcome: "cancelled" } }]);
    expect(holdParkedRequest(state, "interactions", id, false)).toEqual({
      status: 409,
      body: { error: "Interaction is no longer pending", status: "stale" },
    });
  });

  test("a question's pause ends with the turn when the turn ends first", () => {
    const { state, id } = question(START + 20 * MINUTE);
    expect(holdParkedRequest(state, "interactions", id, true).body).toMatchObject({
      expiresAt: START + 20 * MINUTE,
      hold: { reason: "provider-limit" },
    });
  });

  test("a plan approval has no question timeout, only the turn's", () => {
    const { state, child } = session(START + 60 * MINUTE);
    parkGrokInteraction(state, child, 11, "x.ai/exit_plan_mode", {
      sessionId: "vendor-session",
      toolCallId: "tool-plan-1",
      planContent: "# Plan",
    });
    expect(holdParkedRequest(state, "interactions", "tool-plan-1", true).body).toMatchObject({
      status: "applied",
      expiresAt: START + 60 * MINUTE,
    });
  });

  test("Grok's question timeout follows the environment the agent is spawned with", () => {
    process.env.GROK_ASK_USER_QUESTION_TIMEOUT_SECS = "600";
    const shorter = question(START + 60 * MINUTE);
    expect(holdParkedRequest(shorter.state, "interactions", shorter.id, true).body).toMatchObject({
      expiresAt: START + 10 * MINUTE,
      hold: { reason: "provider-limit" },
    });

    process.env.GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED = "false";
    const disabled = question(undefined);
    expect(holdParkedRequest(disabled.state, "interactions", disabled.id, true).body).toEqual({
      status: "applied",
      expiresAt: START + CEILING,
      hold: { available: true, heldAt: START },
    });

    expect(grokQuestionTimeoutMs({})).toBe(GROK_QUESTION_DEFAULT_TIMEOUT_MS);
    expect(grokQuestionTimeoutMs({ GROK_ASK_USER_QUESTION_TIMEOUT_SECS: "90" })).toBe(90_000);
    // Grok ignores a value that is not a positive integer.
    for (const invalid of ["0", "-5", "1.5", "soon", ""]) {
      expect(grokQuestionTimeoutMs({ GROK_ASK_USER_QUESTION_TIMEOUT_SECS: invalid })).toBe(
        GROK_QUESTION_DEFAULT_TIMEOUT_MS,
      );
    }
    for (const off of ["false", "FALSE", "0"]) {
      expect(grokQuestionTimeoutMs({ GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED: off })).toBe(
        undefined,
      );
    }
    expect(
      grokQuestionTimeoutMs({
        GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED: "true",
        GROK_ASK_USER_QUESTION_TIMEOUT_SECS: "120",
      }),
    ).toBe(120_000);
  });

  test("a limit at or under the countdown leaves nothing to extend", () => {
    process.env.GROK_ASK_USER_QUESTION_TIMEOUT_SECS = "300";
    const { state, responses, id } = question(START + 60 * MINUTE);
    expect(publicInteractions(state)[0]).toMatchObject({
      expiresAt: START + WINDOW,
      hold: { available: false, reason: "no-extension" },
    });
    expect(holdParkedRequest(state, "interactions", id, true)).toEqual({
      status: 422,
      body: { error: "This request's deadline cannot be extended", status: "unavailable" },
    });
    expect(state.revision).toBe(1);
    // Expiry still cancels exactly as before.
    jest.advanceTimersByTime(WINDOW);
    expect(responses).toEqual([{ id: 9, result: { outcome: "cancelled" } }]);
  });

  test("a permission raised near the end of a turn shows the time the turn has left", () => {
    const turnEndsAt = START + 2 * MINUTE;
    const { state, responses, id } = permission(turnEndsAt);
    expect(publicApprovals(state)[0]).toMatchObject({
      requestedAt: START,
      expiresAt: turnEndsAt,
      hold: { available: false, reason: "no-extension" },
    });
    expect(holdParkedRequest(state, "approvals", id, true).status).toBe(422);
    jest.advanceTimersByTime(2 * MINUTE);
    expect(responses).toEqual([{ id: 7, result: CANCELLED_PERMISSION }]);
  });

  test("answering or dropping a held request stops its deadline", () => {
    const answered = permission(START + 30 * MINUTE);
    holdParkedRequest(answered.state, "approvals", answered.id, true);
    answered.state.approvals.get(answered.id)!.respond("allow");
    expect(answered.responses).toEqual([
      { id: 7, result: { outcome: { outcome: "selected", optionId: "allow" } } },
    ]);
    expect(holdParkedRequest(answered.state, "approvals", answered.id, false).status).toBe(409);

    const denied = question(START + 60 * MINUTE);
    holdParkedRequest(denied.state, "interactions", denied.id, true);
    denyPendingRequests(denied.state);
    expect(denied.responses).toEqual([{ id: 9, result: { outcome: "cancelled" } }]);

    // A child exit or generation swap drops parked requests without answering.
    const dropped = permission(START + 30 * MINUTE);
    holdParkedRequest(dropped.state, "approvals", dropped.id, true);
    const deadline = dropped.state.approvals.get(dropped.id)!.deadline;
    clearApprovals(dropped.state);
    expect(deadline.settled).toBe(true);

    jest.advanceTimersByTime(CEILING + MINUTE);
    expect(answered.responses).toHaveLength(1);
    expect(denied.responses).toHaveLength(1);
    expect(dropped.responses).toEqual([]);
  });
});
