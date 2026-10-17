import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import {
  POLICY_DENIAL_MAX_CONTINUATIONS,
  sessions,
  type AcpProcess,
  type JsonObject,
  type SessionState,
} from "./acp-context.js";
import {
  POLICY_DENIAL_CONTINUATION,
  requestPromptWithRetriableProviderRetries,
  turnTerminalError,
} from "./acp-prompt.js";
import {
  attachChild,
  clearApprovals,
  policyDenialOutcome,
  recordTurnUsage,
  finalizeTurnUsage,
  parkGrokInteraction,
} from "./acp-session.js";

/*
 * Grok 1.0.52 ends its turn on any non-allow answer to a permission request
 * (`stopReason: "cancelled"`, `_meta.cancellationCategory` `PermissionRejected`
 * for `reject_once`, `PermissionCancelled` for `cancelled`). A read-only
 * coordinator or reviewer turn therefore ended at its first refused write,
 * with no report. These pin the refusal's shape and the continuation that
 * keeps such a turn going.
 */

const GROK_WRITE_OPTIONS = [
  {
    optionId: "allow-edits-session",
    name: "Allow edits",
    kind: "allow_always",
  },
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];
const REJECTED = { outcome: { outcome: "selected", optionId: "reject-once" } };
const ENDED_ON_REJECTION = {
  stopReason: "cancelled",
  _meta: { cancellationCategory: "PermissionRejected" },
};

describe("a policy refusal's answer", () => {
  test("selects reject_once, never reject_always, and falls back to cancelled", () => {
    expect(policyDenialOutcome({ options: GROK_WRITE_OPTIONS })).toEqual(REJECTED);
    // Grok offers `reject-always` for commands; it would persist a "never
    // allow" grant in the user's own per-project approvals.
    expect(
      policyDenialOutcome({
        options: [
          { optionId: "always-allow", kind: "allow_always" },
          { optionId: "reject-always", kind: "reject_always" },
        ],
      }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(policyDenialOutcome({})).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});

interface Attempt {
  prompt: JsonObject;
  /** Refuse a write before answering, as Grok asks mid-turn. */
  asks: boolean;
}

/**
 * A read-only session with an attached child whose `session/prompt` answers
 * come from `script`, one per attempt. An attempt can first raise a
 * permission request through the bridge's own handler.
 */
function readOnlyTurn(
  script: Array<{
    ask?: boolean;
    result: unknown;
    during?: (state: SessionState, child: AcpProcess) => void | Promise<void>;
  }>,
) {
  const responses: unknown[] = [];
  const attempts: Attempt[] = [];
  const state = {
    id: `policy-denial-${crypto.randomUUID()}`,
    acpSessionId: "vendor-session",
    status: "running",
    promptSequence: 4,
    readOnly: true,
    messages: [],
    approvals: new Map(),
    interactions: new Map(),
    activeSubagentDescriptors: new Map(),
    revision: 0,
    sessionConfig: { composer: {} },
    turnStartedAt: Date.now(),
    currentTurnUsage: {},
    currentTurnOutput: null,
  } as unknown as SessionState;
  const child = {
    respond: (_id: number, result: unknown) => responses.push(result),
    request: async (method: string, params: JsonObject) => {
      expect(method).toBe("session/prompt");
      const step = script[Math.min(attempts.length, script.length - 1)]!;
      attempts.push({ prompt: params, asks: step.ask === true });
      if (step.ask) {
        child.onPermission(attempts.length, {
          sessionId: state.acpSessionId,
          toolCall: {
            toolCallId: `write-${attempts.length}`,
            kind: "edit",
            title: "Write",
          },
          options: GROK_WRITE_OPTIONS,
        });
      }
      await step.during?.(state, child);
      return step.result;
    },
  } as unknown as AcpProcess;
  sessions.set(state.id, state);
  attachChild(state, child);
  const run = (schema?: JsonObject) =>
    requestPromptWithRetriableProviderRetries(
      state,
      child,
      {
        sessionId: state.acpSessionId,
        prompt: [{ type: "text", text: "Coordinate." }],
      },
      4,
      schema,
    );
  const cleanup = () => {
    clearApprovals(state);
    sessions.delete(state.id);
  };
  return { state, run, attempts, responses, cleanup };
}

const promptText = (attempt: Attempt | undefined) =>
  ((attempt?.prompt.prompt as Array<{ text: string }> | undefined) ?? [])[0]?.text;

describe("a turn the agent ended on the bridge's policy refusal", () => {
  test("is continued, and the agent's report ends it", async () => {
    const turn = readOnlyTurn([
      { ask: true, result: ENDED_ON_REJECTION },
      {
        ask: true,
        result: {
          stopReason: "cancelled",
          _meta: { cancellationCategory: "PermissionCancelled" },
        },
      },
      { result: { stopReason: "end_turn" } },
    ]);
    try {
      expect(await turn.run()).toEqual({ stopReason: "end_turn" });
      expect(turn.attempts.map(promptText)).toEqual([
        "Coordinate.",
        POLICY_DENIAL_CONTINUATION,
        POLICY_DENIAL_CONTINUATION,
      ]);
      expect(turn.responses).toEqual([REJECTED, REJECTED]);
      expect(turn.state.policyDeniedRequests).toBe(2);
      expect(turnTerminalError(turn.state, "end_turn", 4)).toBeUndefined();
    } finally {
      turn.cleanup();
    }
  });

  test("an agent that names no cancellation category is continued on the bridge's record", async () => {
    const turn = readOnlyTurn([
      { ask: true, result: { stopReason: "cancelled" } },
      { result: { stopReason: "end_turn" } },
    ]);
    try {
      expect(await turn.run()).toEqual({ stopReason: "end_turn" });
      expect(turn.attempts).toHaveLength(2);
    } finally {
      turn.cleanup();
    }
  });

  test("a structured turn's continuation restates its schema", async () => {
    const turn = readOnlyTurn([
      { ask: true, result: ENDED_ON_REJECTION },
      { result: { stopReason: "end_turn" } },
    ]);
    try {
      await turn.run({ type: "object" });
      expect(promptText(turn.attempts[1])).toStartWith(
        `${POLICY_DENIAL_CONTINUATION}\n\nEnd your turn`,
      );
      expect(promptText(turn.attempts[1])).toEndWith('{"type":"object"}');
    } finally {
      turn.cleanup();
    }
  });

  test("ends with a recorded failure once its continuations run out", async () => {
    const turn = readOnlyTurn([{ ask: true, result: ENDED_ON_REJECTION }]);
    try {
      expect(await turn.run()).toEqual(ENDED_ON_REJECTION);
      expect(turn.attempts).toHaveLength(POLICY_DENIAL_MAX_CONTINUATIONS + 1);
      expect(turnTerminalError(turn.state, "cancelled", 4)).toMatch(
        / kept ending the turn on tool calls this session's policy refuses$/,
      );
      // Another turn's exhaustion says nothing about this one.
      expect(turnTerminalError(turn.state, "cancelled", 5)).toMatch(/ cancelled the turn$/);
    } finally {
      turn.cleanup();
    }
  });
});

describe("a cancelled turn that is not continued", () => {
  test("one in which the bridge refused nothing", async () => {
    const turn = readOnlyTurn([{ result: ENDED_ON_REJECTION }]);
    try {
      expect(await turn.run()).toEqual(ENDED_ON_REJECTION);
      expect(turn.attempts).toHaveLength(1);
    } finally {
      turn.cleanup();
    }
  });

  test("one the agent ended for another named reason", async () => {
    const midTurnAbort = {
      stopReason: "cancelled",
      _meta: { cancellationCategory: "MidTurnAbort" },
    };
    const turn = readOnlyTurn([{ ask: true, result: midTurnAbort }]);
    try {
      expect(await turn.run()).toEqual(midTurnAbort);
      expect(turn.attempts).toHaveLength(1);
    } finally {
      turn.cleanup();
    }
  });

  test("one the user cancelled or closed", async () => {
    const turn = readOnlyTurn([{ ask: true, result: ENDED_ON_REJECTION }]);
    turn.state.retryCancelledPromptSequence = 4;
    try {
      expect(await turn.run()).toEqual(ENDED_ON_REJECTION);
      expect(turn.attempts).toHaveLength(1);
      expect(turnTerminalError(turn.state, "cancelled", 4)).toBeUndefined();
    } finally {
      turn.cleanup();
    }
  });

  test("one under a policy that parks requests for a person", async () => {
    const turn = readOnlyTurn([{ ask: true, result: ENDED_ON_REJECTION }]);
    turn.state.readOnly = false;
    try {
      expect(await turn.run()).toEqual(ENDED_ON_REJECTION);
      expect(turn.attempts).toHaveLength(1);
      expect(turn.state.policyDeniedRequests).toBeUndefined();
      expect(turn.state.approvals.size).toBe(1);
    } finally {
      turn.cleanup();
    }
  });
});

describe("continued attempt accounting and lifecycle", () => {
  test("merges duplicate carriers per attempt, sums consumption and retains the latest context", async () => {
    const first = {
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.1,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
      apiDurationMs: 10,
    };
    const second = {
      totalTokens: 27,
      inputTokens: 20,
      outputTokens: 7,
      // ACP reports cost as the session's cumulative total, not per attempt.
      costUsd: 0.3,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      reasoningTokens: 6,
      apiDurationMs: 20,
    };
    const turn = readOnlyTurn([
      {
        ask: true,
        result: {
          ...ENDED_ON_REJECTION,
          usage: first,
          _meta: { ...ENDED_ON_REJECTION._meta, usage: first },
        },
        during: (state, child) => {
          for (const sessionUpdate of ["response_completed", "turn_completed"]) {
            child.onVendor("x.ai/session/update", {
              sessionId: state.acpSessionId,
              update: { sessionUpdate, usage: first },
            });
          }
          recordTurnUsage(state, { sessionUpdate: "usage_update", used: 100, size: 1000 });
        },
      },
      {
        result: { stopReason: "end_turn", usage: second },
        during: (state) => {
          recordTurnUsage(state, { usage: second });
          recordTurnUsage(state, { sessionUpdate: "usage_update", used: 80, size: 2000 });
        },
      },
    ]);
    try {
      turn.state.usage = { turn: {}, sessionTokens: 50, updatedAt: new Date().toISOString() };
      await turn.run();
      finalizeTurnUsage(turn.state);
      expect(turn.state.currentTurnUsage).toEqual({
        totalTokens: 42,
        inputTokens: 30,
        outputTokens: 12,
        costUsd: 0.3,
        cacheReadTokens: 6,
        cacheWriteTokens: 3,
        reasoningTokens: 9,
        apiDurationMs: 30,
        contextUsedTokens: 80,
        contextWindow: 2000,
      });
      expect(turn.state.usage).toMatchObject({
        sessionTokens: 92,
        lastTurnTokens: 42,
        turns: [{ totalTokens: 42, costUsd: 0.3 }],
      });

      // The HTTP handler ends the turn; a late carrier repeats the last
      // attempt's numbers and must not replace the summed turn.
      turn.state.turnStartedAt = undefined;
      turn.state.currentTurnUsage = undefined;
      recordTurnUsage(turn.state, { usage: { ...second, reasoningTokens: 8 } });
      expect(turn.state.usage).toMatchObject({
        turn: { totalTokens: 42, inputTokens: 30, reasoningTokens: 11, costUsd: 0.3 },
        sessionTokens: 92,
        lastTurnTokens: 42,
      });
    } finally {
      turn.cleanup();
    }
  });

  test("clears partial structured output at the attempt boundary", async () => {
    const turn = readOnlyTurn([
      {
        ask: true,
        result: ENDED_ON_REJECTION,
        during: (state) => {
          state.currentTurnOutput = '{"stale":';
        },
      },
      {
        result: { stopReason: "end_turn" },
        during: (state) => {
          expect(state.currentTurnOutput).toBe("");
          state.currentTurnOutput += '{"ok":true}';
        },
      },
    ]);
    try {
      await turn.run({ type: "object" });
      expect(JSON.parse(turn.state.currentTurnOutput!)).toEqual({ ok: true });
    } finally {
      turn.cleanup();
    }
  });

  test.each(["cancel", "close", "remove", "replace", "error", "sequence"])(
    "does not continue when %s occurs while the refused attempt is pending",
    async (change) => {
      let release!: () => void;
      let entered!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const turn = readOnlyTurn([
        {
          ask: true,
          result: ENDED_ON_REJECTION,
          during: async () => {
            entered();
            await pending;
          },
        },
      ]);
      try {
        const run = turn.run();
        await started;
        if (change === "cancel") turn.state.retryCancelledPromptSequence = 4;
        if (change === "close") turn.state.closing = true;
        if (change === "remove") sessions.delete(turn.state.id);
        if (change === "replace") turn.state.child = {} as AcpProcess;
        if (change === "error") turn.state.status = "error";
        if (change === "sequence") turn.state.promptSequence += 1;
        release();
        await run;
        expect(turn.attempts).toHaveLength(1);
      } finally {
        release();
        turn.cleanup();
      }
    },
  );

  test.each(["x.ai/ask_user_question", "x.ai/exit_plan_mode"])(
    "cancels a parked %s from the ended attempt before continuing",
    async (method) => {
      const turn = readOnlyTurn([
        {
          ask: true,
          result: ENDED_ON_REJECTION,
          during: (state, child) => {
            parkGrokInteraction(state, child, 99, method, {
              sessionId: state.acpSessionId,
              toolCallId: "parked",
              planContent: "Plan",
              questions: [{ question: "Which option?" }],
            });
            expect(state.interactions.size).toBe(1);
          },
        },
        {
          result: { stopReason: "end_turn" },
          during: (state) => {
            expect(state.interactions.size).toBe(0);
          },
        },
      ]);
      try {
        await turn.run();
        expect(turn.responses).toEqual([REJECTED, { outcome: "cancelled" }]);
      } finally {
        turn.cleanup();
      }
    },
  );
});
