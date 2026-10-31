import { describe, expect, test } from "bun:test";
import { NATIVE_AGENT_GOAL_LIMITS } from "@orkestrator/protocol/native-agent-goal";
import type { DelegationObservation } from "./coordinator-live-delegation.js";
import {
  coordinatorTurnsAfter,
  evaluateGoalScenario,
  GOAL_MAX_ITERATIONS,
  goalApplies,
  goalCheckCommand,
  goalDelegatingPrompt,
  goalDelegation,
  goalObjective,
  goalReadStatus,
  goalSetOutcome,
  goalSetPrompt,
  type GoalProbe,
  type GoalScenarioInput,
} from "./coordinator-live-goal.js";

const probe: GoalProbe = { platform: "codex", token: "abc123" };
const COORDINATOR = "coordinator:c1:conv-1";
const WORKER = "env-worker";
const iso = (at: number) => new Date(at).toISOString();
const SET_ENDED = 10_000;
const ENDED = 20_000;

function observation(
  at: number,
  coordinatorPhase: string,
  coordinatorTurnIds: string[] = [],
): DelegationObservation {
  return { at, coordinatorPhase, coordinatorTurnIds, queueLength: 0, delegations: [], mail: [] };
}

const SET_OUTPUT = JSON.stringify({
  goal: { goalId: "g1", status: "active", maxIterations: GOAL_MAX_ITERATIONS },
  wakeOwed: true,
});

/** A run that qualifies: two iterations, a passing check, one wake, one read. */
function passing(): GoalScenarioInput {
  return {
    coordinatorEnvironmentId: COORDINATOR,
    workerEnvironmentId: WORKER,
    setResults: [SET_OUTPUT],
    readResults: [JSON.stringify({ goal: { status: "claimed" } })],
    goal: {
      goalId: "g1",
      status: "claimed",
      statusReason: "agent-claimed",
      iterations: 2,
      maxIterations: GOAL_MAX_ITERATIONS,
      endedAt: iso(ENDED),
    },
    setEndedAt: SET_ENDED,
    wakeObservationStart: 1,
    observations: [
      observation(9_000, "idle", ["launch", "launch-wake", "set"]),
      observation(12_000, "idle", ["launch", "launch-wake", "set"]),
      observation(21_000, "working", ["launch", "launch-wake", "set"]),
      observation(23_000, "idle", ["launch", "launch-wake", "set", "goal-wake"]),
    ],
    delegations: [
      {
        environmentId: WORKER,
        requestedAt: iso(1_000),
        workerTabId: "startup-agent",
        state: "completed",
        completedAt: iso(3_000),
        wokenAt: iso(3_000),
      },
      {
        environmentId: WORKER,
        requestedAt: iso(9_500),
        workerTabId: "startup-agent",
        state: "completed",
        completedAt: iso(ENDED + 100),
        wokenAt: iso(ENDED + 200),
      },
    ],
    mail: [
      {
        id: "launch-notice",
        createdAt: iso(3_000),
        from: { kind: "system" },
        toEnvironmentId: COORDINATOR,
        toTabId: "tab",
        placement: "injected",
        body: "Worker finished without sending a report.",
      },
      {
        id: "goal-notice",
        createdAt: iso(ENDED + 200),
        from: { kind: "system" },
        toEnvironmentId: COORDINATOR,
        toTabId: "tab",
        placement: "injected",
        body: "Its goal is claimed (agent-claimed) after 2 of 3 iterations. Read more: `get_worker_goal`.",
      },
    ],
    escapedInteractions: [],
    workerInteractions: [],
  };
}

const failed = (input: GoalScenarioInput) =>
  evaluateGoalScenario(input)
    .filter((item) => !item.passed)
    .map((item) => item.name);

describe("the prompts", () => {
  test("only the second of two turns can satisfy the check", () => {
    expect(goalCheckCommand(probe)).toBe("test -f goal-abc123-two");
    const objective = goalObjective(probe);
    expect(objective).toContain("touch goal-abc123-one");
    expect(objective).toContain("without calling report_goal");
    expect(objective).toContain("touch goal-abc123-two");
    expect(objective).toContain("report_goal with status done");
    expect(objective.length).toBeLessThan(NATIVE_AGENT_GOAL_LIMITS.objectiveMaxChars);
  });

  test("the set prompt carries the tool's fields, and says how to react", () => {
    const prompt = goalSetPrompt(probe, WORKER);
    expect(prompt).toContain("set_worker_goal");
    expect(prompt).toContain(`environmentId "${WORKER}"`);
    expect(prompt).toContain(`maxIterations ${GOAL_MAX_ITERATIONS}`);
    expect(prompt).not.toContain("check ");
    expect(prompt).toContain(JSON.stringify(goalObjective(probe)));
    expect(prompt).toContain("get_worker_goal");
  });

  test("the launch task is one word, so the set turn finds an idle tab", () => {
    const prompt = goalDelegatingPrompt(probe);
    expect(prompt).toContain('name "goal-abc123"');
    expect(prompt).toContain("single word ready");
    expect(prompt).not.toContain("set_worker_goal");
  });

  test("the case applies where the platform's goal capability is on", () => {
    expect(goalApplies("claude")).toBe(true);
    expect(goalApplies("codex")).toBe(true);
  });
});

describe("tool output", () => {
  test("reads a set result and a goal read", () => {
    expect(goalSetOutcome(SET_OUTPUT)).toEqual({
      goalId: "g1",
      maxIterations: GOAL_MAX_ITERATIONS,
      wakeOwed: true,
    });
    expect(goalSetOutcome("A goal is already running")).toEqual({
      goalId: null,
      maxIterations: null,
      wakeOwed: false,
    });
    expect(goalReadStatus('{"goal":{"status":"blocked"}}')).toBe("blocked");
    expect(goalReadStatus("refused")).toBeNull();
  });

  test("the goal's delegation is the worker's newest", () => {
    const { delegations } = passing();
    expect(goalDelegation(delegations, WORKER)?.requestedAt).toBe(iso(9_500));
    expect(goalDelegation(delegations, "other")).toBeUndefined();
    expect(goalDelegation(delegations, undefined)).toBeUndefined();
  });
});

describe("counting wakes", () => {
  test("a turn is counted once, whether seen by phase, by record or both", () => {
    const { observations } = passing();
    expect(coordinatorTurnsAfter(observations, 1)).toBe(1);
    expect(
      coordinatorTurnsAfter([observation(1, "idle", ["a"]), observation(2, "idle", ["a"])], 1),
    ).toBe(0);
    expect(
      coordinatorTurnsAfter([observation(1, "idle", ["a"]), observation(2, "idle", ["a", "b"])], 1),
    ).toBe(1);
    expect(coordinatorTurnsAfter([observation(1, "working")], undefined)).toBe(0);
  });

  test("two wakes count as two", () => {
    expect(
      coordinatorTurnsAfter(
        [
          observation(1, "idle", ["a"]),
          observation(2, "working", ["a"]),
          observation(3, "idle", ["a", "b"]),
          observation(4, "working", ["a", "b"]),
          observation(5, "idle", ["a", "b", "c"]),
        ],
        1,
      ),
    ).toBe(2);
  });
});

describe("the verdict", () => {
  test("a qualifying run passes every check", () => {
    expect(failed(passing())).toEqual([]);
  });

  test("a wake per iteration fails", () => {
    const input = passing();
    input.observations = [
      ...input.observations,
      observation(30_000, "working", ["launch", "launch-wake", "set", "goal-wake"]),
      observation(31_000, "idle", ["launch", "launch-wake", "set", "goal-wake", "again"]),
    ];
    expect(failed(input)).toEqual(["one-wake"]);
  });

  test("no wake at all fails", () => {
    const input = passing();
    input.observations = input.observations.slice(0, 2);
    expect(failed(input)).toEqual(["one-wake"]);
  });

  test("a delegation closed between iterations fails even with one wake", () => {
    const input = passing();
    input.delegations = input.delegations.map((record, index) =>
      index === 1 ? { ...record, completedAt: iso(15_000), wokenAt: iso(15_100) } : record,
    );
    expect(failed(input)).toEqual(["delegation-held-until-goal-ended"]);
  });

  test("a goal that ended any other way fails", () => {
    for (const status of ["claimed", "limited", "paused", "blocked"]) {
      const input = passing();
      input.goal = { ...input.goal!, status, statusReason: "x" };
      expect(failed(input)).toContain("goal-claimed");
    }
  });

  test("coordinator claims cannot carry a shell check result", () => {
    const input = passing();
    input.goal = { ...input.goal!, lastCheck: { passed: false, exitCode: 1 } };
    expect(failed(input)).toEqual(["no-shell-check"]);
    const { lastCheck: _lastCheck, ...withoutCheck } = passing().goal!;
    expect(failed({ ...passing(), goal: withoutCheck })).toEqual([]);
  });

  test("a single iteration proves nothing about iterations", () => {
    const input = passing();
    input.goal = { ...input.goal!, iterations: 1 };
    expect(failed(input)).toEqual(["ran-more-than-one-iteration"]);
  });

  test("a different goal than the one set fails", () => {
    const input = passing();
    input.goal = { ...input.goal!, goalId: "other" };
    expect(failed(input)).toEqual(["goal-claimed"]);
  });

  test("a refused set fails", () => {
    expect(failed({ ...passing(), setResults: ['{"isError":true}'] })).toContain("goal-set");
    expect(failed({ ...passing(), setResults: [] })).toContain("goal-set");
    expect(
      failed({
        ...passing(),
        setResults: [SET_OUTPUT.replace('"wakeOwed":true', '"wakeOwed":false')],
      }),
    ).toEqual(["goal-set"]);
  });

  test("a coordinator that never read the finished goal fails", () => {
    expect(failed({ ...passing(), readResults: [] })).toEqual(["coordinator-read-goal"]);
    expect(
      failed({ ...passing(), readResults: [JSON.stringify({ goal: { status: "active" } })] }),
    ).toEqual(["coordinator-read-goal"]);
  });

  test("a notice that does not say how the goal ended fails, unless the worker reported", () => {
    const input = passing();
    input.mail = input.mail.map((message) =>
      message.id === "goal-notice" ? { ...message, body: "Worker finished." } : message,
    );
    expect(failed(input)).toEqual(["wake-names-outcome"]);
    input.delegations = input.delegations.map((record, index) =>
      index === 1 ? { ...record, wakeKind: "report" } : record,
    );
    expect(failed(input)).toEqual([]);
  });

  test("an escaped interaction fails", () => {
    expect(failed({ ...passing(), workerInteractions: ["command-approval"] })).toEqual([
      "no-user-action",
    ]);
  });
});
