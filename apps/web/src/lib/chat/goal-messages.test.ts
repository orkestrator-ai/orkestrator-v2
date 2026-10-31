import { describe, expect, test } from "bun:test";
import {
  renderGoalCarrier,
  type NativeAgentGoal,
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import { buildMessageForkActionKinds } from "@/components/chat/message-fork";
import { getNativeMessageSearchProjection } from "@/components/chat/native-message-search";
import { isClientOnlyNativeMessage } from "./client-only-messages";
import {
  createGoalTurnNativeMessage,
  goalStatusRows,
  hasBackendTurnClock,
  isGoalQueueItem,
  withGoalStatusRows,
  withGoalTurnsAsPrompts,
} from "./goal-messages";
import type { NativeMessage } from "./native-message-types";

const SET_AT = "2026-10-31T10:00:00.000Z";

function fullGoal(overrides: Partial<NativeAgentGoal> = {}): NativeAgentGoal {
  return {
    goalId: "goal-1",
    objective: "Make the build green\nand keep it green",
    status: "active",
    providerSessionId: "provider-1",
    iterations: 2,
    maxIterations: 20,
    noProgressStreak: 0,
    setAt: SET_AT,
    updatedAt: SET_AT,
    ...overrides,
  };
}

function view(overrides: Partial<NativeAgentGoalView> = {}): NativeAgentGoalView {
  const {
    providerSessionId: _providerSessionId,
    lastCheck: _lastCheck,
    lastVerdict: _lastVerdict,
    verifierRun: _verifierRun,
    pendingReport: _pendingReport,
    workspaceFingerprint: _workspaceFingerprint,
    evaluatedRequestId: _evaluatedRequestId,
    ...rest
  } = fullGoal();
  return { ...rest, ...overrides };
}

function userRow(id: string, content: string, createdAt = "2026-10-31T10:01:00.000Z") {
  return {
    id,
    role: "user" as const,
    content,
    parts: [{ type: "text" as const, content }],
    createdAt,
  };
}

function assistantRow(id: string, createdAt: string): NativeMessage {
  return {
    id,
    role: "assistant",
    content: "working",
    parts: [{ type: "text", content: "working" }],
    createdAt,
  };
}

const CARRIER = renderGoalCarrier(fullGoal({ check: "bun test" }));

describe("createGoalTurnNativeMessage", () => {
  test("a carrier becomes a tile row with its iteration and objective, not a user row", () => {
    const row = createGoalTurnNativeMessage(userRow("provider-row", CARRIER))!;
    expect(row.role).toBe("system");
    expect(row.id).toBe("goal-turn-provider-row");
    expect(isClientOnlyNativeMessage(row)).toBe(true);
    expect(row.goalTurn).toEqual({
      iteration: 2,
      maxIterations: 20,
      objective: "Make the build green\nand keep it green",
      check: "bun test",
    });
    // The raw transport text never survives into anything that can render it.
    expect(JSON.stringify(row)).not.toContain("orkestrator-goal");
  });

  test("a failed check in the carrier stays visible on the turn that answered it", () => {
    const carrier = renderGoalCarrier(
      fullGoal({
        check: "bun test",
        lastCheck: {
          passed: false,
          exitCode: 2,
          durationMs: 40,
          outputTail: "1 failing <test>",
          at: SET_AT,
        },
      }),
    );
    expect(createGoalTurnNativeMessage(userRow("row", carrier))!.goalTurn?.failedCheck).toEqual({
      exitCode: 2,
      outputTail: "1 failing <test>",
    });
  });

  test("carrier text in the middle of a message stays the user's own message", () => {
    expect(
      createGoalTurnNativeMessage(userRow("row", `Why did I get this?\n\n${CARRIER}`)),
    ).toBeNull();
    expect(createGoalTurnNativeMessage(userRow("row", "plain"))).toBeNull();
  });

  test("only a user row can be a goal turn", () => {
    expect(
      createGoalTurnNativeMessage({ ...userRow("row", CARRIER), role: "assistant" }),
    ).toBeNull();
  });

  test("a carrier that cannot be read is still a goal turn, with no raw text", () => {
    const row = createGoalTurnNativeMessage(
      userRow("row", '<orkestrator-goal version="1">\ntruncated by a provi'),
    )!;
    expect(row.role).toBe("system");
    expect(row.goalTurn).toEqual({});
    expect(row.content).toBe("");
  });

  test("a carrier found only in the row's text part is still a goal turn", () => {
    const row = createGoalTurnNativeMessage({ ...userRow("row", CARRIER), content: "" })!;
    expect(row.goalTurn?.iteration).toBe(2);
  });

  test("a forged payload's optional fields cannot reach a renderer", () => {
    const forged = CARRIER.replace('"check": "bun test"', '"check": {"a": 1}');
    expect(createGoalTurnNativeMessage(userRow("row", forged))!.goalTurn?.check).toBeUndefined();
  });
});

describe("goal turns and the rest of the transcript", () => {
  const turn = createGoalTurnNativeMessage(userRow("row", CARRIER))!;

  test("a goal turn offers no prompt fork", () => {
    const kinds = buildMessageForkActionKinds(
      [userRow("mine", "hello"), turn, assistantRow("a", "2026-10-31T10:02:00.000Z")],
      false,
    );
    expect(kinds.get("mine")).toBe("prompt");
    expect(kinds.has(turn.id)).toBe(false);
  });

  test("search reads the objective the tile shows, never the carrier", () => {
    expect(getNativeMessageSearchProjection(turn).text).toBe(
      "Make the build green\nand keep it green",
    );
  });

  test("a goal turn starts a turn for the clocks without becoming a user row on screen", () => {
    const rows = [userRow("mine", "hello"), turn, assistantRow("a", "2026-10-31T10:02:00.000Z")];
    const clocks = withGoalTurnsAsPrompts(rows);
    expect(clocks.map((row) => row.role)).toEqual(["user", "user", "assistant"]);
    expect(rows[1]!.role).toBe("system");
    expect(hasBackendTurnClock(clocks[1]!)).toBe(true);
    // No goal rows: the same list, so memoized readers keep their identity.
    const plain = [userRow("mine", "hello")];
    expect(withGoalTurnsAsPrompts(plain)).toBe(plain);
  });

  test("queued goal turns are the loop's, and everything else stays in the queue", () => {
    expect(isGoalQueueItem({ id: "goal:goal-1:3", text: "anything" })).toBe(true);
    expect(isGoalQueueItem({ id: "other", text: CARRIER })).toBe(true);
    expect(isGoalQueueItem({ id: "other", text: `see ${CARRIER}` })).toBe(false);
  });
});

describe("goal status rows", () => {
  test("a running goal has only its set row, and says what will prove it", () => {
    expect(goalStatusRows(view({ check: "bun test" })).map((row) => row.content)).toEqual([
      "Goal set. It finishes when this check passes: bun test",
    ]);
    expect(goalStatusRows(view())[0]!.content).toContain("will end as unverified");
  });

  test("a check row knows which run it reports", () => {
    const rows = goalStatusRows(
      view({
        check: "bun test",
        lastCheck: { passed: false, exitCode: 3, durationMs: 5, at: "2026-10-31T10:05:00.000Z" },
      }),
    );
    expect(rows[1]).toMatchObject({
      content: "Check failed with exit code 3",
      goalStatus: { kind: "check", tone: "failure", checkAt: "2026-10-31T10:05:00.000Z" },
    });
  });

  test("a stop names its reason, and the user's own stop is not an alarm", () => {
    const failed = goalStatusRows(
      view({ status: "paused", statusReason: "turn-failed", statusDetail: "rate limited" }),
    ).at(-1)!;
    expect(failed.content).toBe("Paused because a turn failed: rate limited");
    expect(failed.goalStatus).toEqual({ kind: "stopped", tone: "attention" });
    const mine = goalStatusRows(view({ status: "paused", statusReason: "user-paused" })).at(-1)!;
    expect(mine.goalStatus?.tone).toBe("neutral");
    expect(mine.content).toBe("Paused because you paused it");
  });

  test("an ended goal says how it ended", () => {
    const complete = goalStatusRows(
      view({ status: "complete", statusReason: "check-passed", endedAt: SET_AT }),
    ).at(-1)!;
    expect(complete.goalStatus).toEqual({ kind: "ended", tone: "success" });
    const claimed = goalStatusRows(
      view({ status: "claimed", statusReason: "agent-claimed", endedAt: SET_AT }),
    ).at(-1)!;
    expect(claimed.goalStatus).toEqual({ kind: "ended", tone: "attention" });
    expect(claimed.content).toContain("unverified");
  });

  test("rows sit among the transcript by their clocks and are stable across reads", () => {
    const goal = view({
      lastCheck: { passed: true, exitCode: 0, durationMs: 5, at: "2026-10-31T10:03:00.000Z" },
    });
    const merged = withGoalStatusRows(
      [
        assistantRow("before", "2026-10-31T09:59:00.000Z"),
        assistantRow("between", "2026-10-31T10:02:00.000Z"),
      ],
      goal,
    );
    expect(merged.map((row) => row.goalStatus?.kind ?? row.id)).toEqual([
      "before",
      "set",
      "between",
      "check",
    ]);
    expect(merged.map((row) => row.id)).toEqual(
      withGoalStatusRows(
        [
          assistantRow("before", "2026-10-31T09:59:00.000Z"),
          assistantRow("between", "2026-10-31T10:02:00.000Z"),
        ],
        goal,
      ).map((row) => row.id),
    );
    expect(merged.every((row) => row.goalStatus === undefined || row.role === "system")).toBe(true);
  });

  test("a row older than a partial window waits for that history to load", () => {
    const window = [assistantRow("late", "2026-10-31T11:00:00.000Z")];
    expect(
      withGoalStatusRows(window, view(), { canLoadEarlier: true }).map((row) => row.id),
    ).toEqual(["late"]);
    expect(withGoalStatusRows(window, view()).map((row) => row.goalStatus?.kind ?? row.id)).toEqual(
      ["set", "late"],
    );
  });
});
