import { describe, expect, test } from "bun:test";
import type { ReadOnlyToolCall } from "./coordinator-live.js";
import {
  changesOutcome,
  evaluateGapToolsScenario,
  fillGapPlaceholders,
  GAP_TOOLS,
  gapSteps,
  gapTurnPrompt,
  namedEnvironments,
  parseGapSteps,
  refusalReason,
  type GapToolsInput,
  type GapToolsProbe,
} from "./coordinator-live-gap-tools.js";

const probe: GapToolsProbe = { platform: "codex", token: "abc123", projectId: "project-1" };
const COORDINATOR = "coordinator:c1:conv-1";
const WORKER = "env-worker";
const FORK = "env-fork";
const BASE = "a".repeat(40);
const WORKER_HEAD = "c".repeat(40);

const ok = (name: string): ReadOnlyToolCall => ({
  name: `mcp__orkestrator__${name}`,
  args: "{}",
  state: "succeeded",
});
const failed = (name: string): ReadOnlyToolCall => ({
  name: `mcp__orkestrator__${name}`,
  args: "{}",
  state: "refused",
});

const diff = (lines: string[]) => ({
  files: [
    { path: "gap-abc123.txt", diff: `@@ -0,0 +1 @@\n${lines.map((l) => `+${l}`).join("\n")}` },
  ],
});

/** A run that qualifies. */
function passing(): GapToolsInput {
  return {
    probe,
    coordinatorEnvironmentId: COORDINATOR,
    workerEnvironmentId: WORKER,
    calls: [
      ok("get_launch_options"),
      ok("launch_environment"),
      ...GAP_TOOLS.filter(
        (tool) => tool !== "resolve_conflicts" && tool !== "answer_worker_question",
      ).map(ok),
      failed("resolve_conflicts"),
      failed("answer_worker_question"),
    ],
    outputs: {
      get_worker_changes: [
        JSON.stringify({
          committed: { files: [{ path: "gap-abc123.txt" }] },
          uncommitted: { files: [{ path: "gap-abc123.txt" }] },
          committedDiffs: diff(["committed-abc123"]),
          uncommittedDiffs: diff(["uncommitted-abc123"]),
        }),
      ],
      fork_worker: [
        JSON.stringify({
          fork: { environmentId: FORK, baseCommit: WORKER_HEAD },
          sourceEnvironmentId: WORKER,
        }),
      ],
      stop_worker_turn: [JSON.stringify({ stopped: true, delegationOpen: true })],
      list_worker_commands: [JSON.stringify({ commands: [{ id: "orkestrator:compact" }] })],
      run_worker_command: [
        JSON.stringify({ startsTurn: false, delegationOpened: false, outcome: "dispatched" }),
      ],
      pause_schedule: [JSON.stringify({ scheduleId: "job-1", state: "paused" })],
      update_schedule: [JSON.stringify({ scheduleId: "job-1", state: "paused" })],
      resume_schedule: [JSON.stringify({ scheduleId: "job-1", state: "active" })],
      resolve_conflicts: [JSON.stringify({ isError: true })],
      answer_worker_question: [JSON.stringify({ isError: true })],
    },
    baseCommit: BASE,
    forkExists: true,
    phaseAfterStop: "idle",
    phaseAfterCommand: "idle",
    stoppedDelegation: {
      environmentId: WORKER,
      requestedAt: new Date(1_000).toISOString(),
      workerTabId: "startup-agent",
      state: "completed",
      wokenAt: new Date(2_000).toISOString(),
    },
    delegationsAfterStop: 0,
    mail: [
      {
        id: "m1",
        createdAt: new Date(1_500).toISOString(),
        from: { kind: "system" },
        toEnvironmentId: COORDINATOR,
        toTabId: "coordinator",
        placement: "injected",
        injectedAt: new Date(2_000).toISOString(),
        body: "Worker gap stopped because you stopped its turn with stop_worker_turn, before it sent a report.",
      },
    ],
    scheduleGone: true,
    actionRequestsCreated: 0,
    escapedInteractions: [],
    workerInteractions: [],
  };
}

function failures(input: GapToolsInput): string[] {
  return evaluateGapToolsScenario(input)
    .filter((check) => !check.passed)
    .map((check) => check.name);
}

describe("gap-tools prompts", () => {
  test("every turn's steps parse back exactly, so a fake model replays what a real one reads", () => {
    const turns = [
      gapSteps.launch(probe),
      gapSteps.changes(probe, WORKER),
      gapSteps.longTurn(probe, WORKER),
      gapSteps.stop(probe, WORKER),
      gapSteps.commands(probe, WORKER),
      gapSteps.schedules(probe),
      gapSteps.refusals(probe, WORKER),
    ];
    for (const steps of turns) expect(parseGapSteps(gapTurnPrompt(steps))).toEqual(steps);
    // Together they call every gap tool exactly once.
    const tools = turns.flat().map((step) => step.tool);
    for (const tool of GAP_TOOLS) expect(tools.filter((name) => name === tool)).toHaveLength(1);
  });

  test("a worker on a connected node gets nodeId on every worker tool", () => {
    const remote = { ...probe, nodeId: "node-leaf" };
    const steps = [
      ...gapSteps.launch(remote),
      ...gapSteps.changes(remote, WORKER),
      ...gapSteps.longTurn(remote, WORKER),
      ...gapSteps.stop(remote, WORKER),
      ...gapSteps.commands(remote, WORKER),
      ...gapSteps.refusals(remote, WORKER),
    ];
    for (const step of steps) expect(step.args.nodeId).toBe("node-leaf");
    // Schedules belong to the coordinator, never to a node.
    for (const step of gapSteps.schedules(remote)) expect(step.args.nodeId).toBeUndefined();
  });

  test("placeholders fill from earlier results, and an unfilled one refuses", () => {
    const results = new Map<string, unknown>([
      ["get_launch_options", { coordinatorBase: { baseBranch: "main", baseCommit: BASE } }],
    ]);
    expect(
      fillGapPlaceholders(
        { baseBranch: "<get_launch_options.coordinatorBase.baseBranch>", nested: ["x"] },
        results,
      ),
    ).toEqual({ baseBranch: "main", nested: ["x"] });
    expect(fillGapPlaceholders({ id: "<create_schedule.scheduleId>" }, results)).toBeUndefined();
  });

  test("environment IDs are read from a result, without the worker's own", () => {
    expect(
      namedEnvironments(
        JSON.stringify({ environmentId: FORK, source: { environmentId: WORKER } }),
        WORKER,
      ),
    ).toEqual([FORK]);
  });

  test("the split diff needs each line on its own side only", () => {
    expect(changesOutcome(passing().outputs.get_worker_changes![0], probe)).toEqual({
      listed: true,
      committedSide: true,
      uncommittedSide: true,
      unsupported: false,
    });
    // An older node that ignored diffScope answers one combined diff.
    const combined = JSON.stringify({
      committed: { files: [{ path: "gap-abc123.txt" }] },
      uncommitted: { files: [{ path: "gap-abc123.txt" }] },
      diffs: diff(["committed-abc123", "uncommitted-abc123"]),
      diffScopeUnsupported: "the node predates diffScope",
    });
    expect(changesOutcome(combined, probe)).toMatchObject({
      committedSide: false,
      uncommittedSide: false,
      unsupported: true,
    });
  });
});

describe("gap-tools verdict", () => {
  test("a qualifying run passes every check", () => {
    expect(failures(passing())).toEqual([]);
  });

  test("a tool called twice, or never, fails the once-each check", () => {
    const input = passing();
    expect(failures({ ...input, calls: [...input.calls, ok("fork_worker")] })).toEqual([
      "each-gap-tool-called-once",
    ]);
    expect(
      failures({
        ...input,
        calls: input.calls.filter((call) => !call.name.endsWith("pause_schedule")),
      }),
    ).toEqual(["each-gap-tool-called-once"]);
  });

  test("a fork from the coordinator base, not the worker's commit, fails", () => {
    const input = passing();
    expect(
      failures({
        ...input,
        outputs: {
          ...input.outputs,
          fork_worker: [JSON.stringify({ environmentId: FORK, baseCommit: BASE })],
        },
      }),
    ).toEqual(["fork-from-last-commit"]);
    expect(failures({ ...input, forkExists: false })).toEqual(["fork-from-last-commit"]);
  });

  test("a stop that left the turn running, or woke the coordinator without saying so, fails", () => {
    const input = passing();
    expect(failures({ ...input, phaseAfterStop: "running" })).toEqual(["turn-stopped"]);
    expect(failures({ ...input, mail: [] })).toEqual(["stop-wakes-once"]);
    expect(failures({ ...input, mail: [...input.mail, { ...input.mail[0]!, id: "m2" }] })).toEqual([
      "stop-wakes-once",
    ]);
  });

  test("a command that opened a delegation, or a turn, fails", () => {
    const input = passing();
    expect(
      failures({
        ...input,
        outputs: {
          ...input.outputs,
          run_worker_command: [JSON.stringify({ startsTurn: true, delegationOpened: true })],
        },
      }),
    ).toEqual(["command-ran-without-a-turn"]);
    expect(failures({ ...input, delegationsAfterStop: 1 })).toEqual(["command-ran-without-a-turn"]);
  });

  test("a schedule left behind, or not paused, fails", () => {
    const input = passing();
    expect(failures({ ...input, scheduleGone: false })).toEqual(["schedule-edits"]);
    expect(
      failures({
        ...input,
        outputs: { ...input.outputs, pause_schedule: [JSON.stringify({ state: "active" })] },
      }),
    ).toEqual(["schedule-edits"]);
  });

  test("conflicts or a question answer accepted for a worker with neither fails", () => {
    const input = passing();
    const accepted = input.calls.map((call) =>
      call.name.endsWith("resolve_conflicts") || call.name.endsWith("answer_worker_question")
        ? { ...call, state: "succeeded" as const }
        : call,
    );
    expect(
      failures({
        ...input,
        calls: accepted,
        outputs: {
          ...input.outputs,
          resolve_conflicts: [JSON.stringify({ launched: true })],
          answer_worker_question: [JSON.stringify({ requestId: "r1" })],
        },
      }),
    ).toEqual(["resolve-refused-without-pr", "answer-refused-without-question"]);
    expect(failures({ ...input, actionRequestsCreated: 1 })).toEqual([
      "answer-refused-without-question",
    ]);
  });

  test("a refusal's reason is one bounded line, and an answer that is not a refusal has none", () => {
    expect(
      refusalReason(
        JSON.stringify({ isError: true, error: `The worker\nhas no PR. ${"y".repeat(400)}` }),
      ),
    ).toBe(`The worker has no PR. ${"y".repeat(178)}`);
    expect(refusalReason("Error: not found")).toBe("Error: not found");
    expect(refusalReason(JSON.stringify({ isError: true }))).toBe('{"isError":true}');
    expect(refusalReason(JSON.stringify({ stopped: true }))).toBeUndefined();
    expect(refusalReason(undefined)).toBeUndefined();
  });

  test("a call refused when it should run says why in its check", () => {
    const input = passing();
    const detail = (name: string, outputs: GapToolsInput["outputs"]) =>
      evaluateGapToolsScenario({ ...input, outputs: { ...input.outputs, ...outputs } }).find(
        (check) => check.name === name,
      )?.detail;
    expect(
      detail("command-ran-without-a-turn", {
        run_worker_command: [JSON.stringify({ isError: true, error: "Nothing to compact" })],
      }),
    ).toContain("refused: Nothing to compact");
    expect(
      detail("schedule-edits", {
        pause_schedule: [JSON.stringify({ isError: true, error: "Scheduling is off" })],
      }),
    ).toContain("pause_schedule refused: Scheduling is off");
  });

  test("an approval that reached the harness fails", () => {
    expect(failures({ ...passing(), workerInteractions: ["command-approval"] })).toEqual([
      "no-user-action",
    ]);
  });
});
