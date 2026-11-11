import { describe, expect, test } from "bun:test";
import type { ReadOnlyToolCall } from "./coordinator-live.js";
import {
  changesOutcome,
  compactRow,
  delegationsOpenedSince,
  evaluateGapToolsScenario,
  fillGapPlaceholders,
  GAP_TOOLS,
  gapSteps,
  gapTurnPrompt,
  namedEnvironments,
  parseGapSteps,
  refusalReason,
  scheduleFiresAt,
  type GapToolsInput,
  type GapToolsProbe,
} from "./coordinator-live-gap-tools.js";

const probe: GapToolsProbe = { platform: "codex", token: "abc123", projectId: "project-1" };
const COORDINATOR = "coordinator:c1:conv-1";
const WORKER = "env-worker";
const FORK = "env-fork";
const BASE = "a".repeat(40);
const WORKER_HEAD = "c".repeat(40);
const CREATED_AT = Date.parse("2026-11-11T09:00:00.000Z");
const HOUR = 3_600_000;
const NO_PR =
  "This worker has no pull request, so there are no conflicts to resolve; raise one with create_pr";
const NO_QUESTION =
  "That tab has no pending interaction with that id (it was answered, withdrawn or its turn ended). Read state.interactions from get_tab_state.";
const once = (at: number) => `once at ${new Date(at).toISOString()}`;

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
      list_worker_commands: [
        JSON.stringify({
          commands: [
            { id: "pi:/model", name: "/model", source: "builtin" },
            { id: "orkestrator:compact", name: "/compact", source: "orkestrator" },
          ],
        }),
      ],
      run_worker_command: [
        JSON.stringify({
          commandId: "orkestrator:compact",
          startsTurn: false,
          delegationOpened: false,
          outcome: "dispatched",
        }),
      ],
      create_schedule: [
        JSON.stringify({ scheduleId: "job-1", state: "active", when: once(CREATED_AT) }),
      ],
      pause_schedule: [JSON.stringify({ scheduleId: "job-1", state: "paused" })],
      update_schedule: [
        JSON.stringify({ scheduleId: "job-1", state: "paused", when: once(CREATED_AT + HOUR) }),
      ],
      resume_schedule: [JSON.stringify({ scheduleId: "job-1", state: "active" })],
      resolve_conflicts: [JSON.stringify({ isError: true, error: NO_PR })],
      answer_worker_question: [JSON.stringify({ isError: true, error: NO_QUESTION })],
    },
    baseCommit: BASE,
    workerHead: WORKER_HEAD,
    forkExists: true,
    forkCheckout: { head: WORKER_HEAD, uncommittedPaths: [], content: "committed-abc123\n" },
    phaseAfterStop: "idle",
    phaseAfterCommand: "idle",
    stoppedDelegation: {
      environmentId: WORKER,
      requestedAt: new Date(1_000).toISOString(),
      workerTabId: "startup-agent",
      state: "completed",
      wokenAt: new Date(2_000).toISOString(),
    },
    delegationsOpenedByCommand: 0,
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
    workerObserved: true,
  };
}

/** The same run on Claude, whose own /compact starts a provider turn. */
function claudeCompact(): GapToolsInput {
  const input = passing();
  return {
    ...input,
    probe: { ...probe, platform: "claude" },
    outputs: {
      ...input.outputs,
      list_worker_commands: [
        JSON.stringify({
          commands: [{ id: "claude:/compact", name: "/compact", source: "builtin" }],
        }),
      ],
      run_worker_command: [
        JSON.stringify({
          commandId: "claude:/compact",
          startsTurn: true,
          delegationOpened: true,
          outcome: "dispatched",
        }),
      ],
    },
    delegationsOpenedByCommand: 1,
    commandDelegation: {
      environmentId: WORKER,
      requestedAt: new Date(3_000).toISOString(),
      workerTabId: "startup-agent",
      state: "completed",
      wokenAt: new Date(4_000).toISOString(),
    },
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

  test("a fork on some other commit, or whose checkout is not the worker's commit, fails", () => {
    const input = passing();
    const stale = "d".repeat(40);
    // Not the coordinator base, but not the worker's HEAD either.
    expect(
      failures({
        ...input,
        outputs: {
          ...input.outputs,
          fork_worker: [JSON.stringify({ environmentId: FORK, baseCommit: stale })],
        },
      }),
    ).toEqual(["fork-from-last-commit"]);
    const checkout = input.forkCheckout!;
    for (const forkCheckout of [
      { ...checkout, head: stale },
      { ...checkout, content: "committed-abc123\nuncommitted-abc123\n" },
      { ...checkout, content: null },
      { ...checkout, uncommittedPaths: ["gap-abc123.txt"] },
    ]) {
      expect(failures({ ...input, forkCheckout })).toEqual(["fork-from-last-commit"]);
    }
    const { forkCheckout: _unread, ...unread } = input;
    expect(failures(unread)).toEqual(["fork-from-last-commit"]);
    const { workerHead: _noHead, ...noHead } = input;
    expect(failures(noHead)).toEqual(["fork-from-last-commit"]);
    // A worker that never committed: its HEAD is still the coordinator base.
    expect(failures({ ...input, workerHead: BASE })).toEqual(["fork-from-last-commit"]);
  });

  test("a stop that left the turn running, or woke the coordinator without saying so, fails", () => {
    const input = passing();
    expect(failures({ ...input, phaseAfterStop: "running" })).toEqual(["turn-stopped"]);
    expect(failures({ ...input, mail: [] })).toEqual(["stop-wakes-once"]);
    expect(failures({ ...input, mail: [...input.mail, { ...input.mail[0]!, id: "m2" }] })).toEqual([
      "stop-wakes-once",
    ]);
  });

  test("Orkestrator's /compact that opened a delegation, or a turn, fails", () => {
    const input = passing();
    expect(
      failures({
        ...input,
        outputs: {
          ...input.outputs,
          run_worker_command: [
            JSON.stringify({
              commandId: "orkestrator:compact",
              startsTurn: true,
              delegationOpened: true,
            }),
          ],
        },
      }),
    ).toEqual(["command-ran-as-listed"]);
    expect(failures({ ...input, delegationsOpenedByCommand: 1 })).toEqual([
      "command-ran-as-listed",
    ]);
    expect(failures({ ...input, phaseAfterCommand: "working" })).toEqual(["command-ran-as-listed"]);
  });

  test("Claude's own /compact qualifies when its turn opened one delegation that woke the coordinator", () => {
    expect(failures(claudeCompact())).toEqual([]);
    expect(
      evaluateGapToolsScenario(claudeCompact()).find((check) => check.name === "commands-listed")
        ?.detail,
    ).toBe("/compact listed as claude:/compact");
  });

  test("Claude's own /compact that opened no delegation, or was never woken, fails", () => {
    const input = claudeCompact();
    expect(failures({ ...input, delegationsOpenedByCommand: 0 })).toEqual([
      "command-ran-as-listed",
    ]);
    expect(
      failures({
        ...input,
        commandDelegation: { ...input.commandDelegation!, wokenAt: undefined },
      }),
    ).toEqual(["command-ran-as-listed"]);
    expect(
      failures({
        ...input,
        outputs: {
          ...input.outputs,
          run_worker_command: [
            JSON.stringify({
              commandId: "claude:/compact",
              startsTurn: false,
              delegationOpened: false,
            }),
          ],
        },
      }),
    ).toEqual(["command-ran-as-listed"]);
  });

  test("a command run that is not the listed row, or no /compact row at all, fails", () => {
    const input = passing();
    expect(
      failures({
        ...input,
        outputs: {
          ...input.outputs,
          run_worker_command: [
            JSON.stringify({ commandId: "pi:/model", startsTurn: false, delegationOpened: false }),
          ],
        },
      }),
    ).toEqual(["command-ran-as-listed"]);
    expect(
      failures({
        ...input,
        outputs: {
          ...input.outputs,
          list_worker_commands: [
            JSON.stringify({ commands: [{ id: "pi:/model", name: "/model" }] }),
          ],
        },
      }),
    ).toEqual(["commands-listed", "command-ran-as-listed"]);
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

  test("an update that did not retime, replaced the schedule, or unpaused it fails", () => {
    const input = passing();
    const updated = (answer: Record<string, unknown>) =>
      failures({
        ...input,
        outputs: { ...input.outputs, update_schedule: [JSON.stringify(answer)] },
      });
    // Answers with the ID, but the time did not move.
    expect(updated({ scheduleId: "job-1", state: "paused", when: once(CREATED_AT) })).toEqual([
      "schedule-edits",
    ]);
    expect(
      updated({ scheduleId: "job-2", state: "paused", when: once(CREATED_AT + HOUR) }),
    ).toEqual(["schedule-edits"]);
    expect(
      updated({ scheduleId: "job-1", state: "active", when: once(CREATED_AT + HOUR) }),
    ).toEqual(["schedule-edits"]);
    expect(updated({ scheduleId: "job-1", state: "paused" })).toEqual(["schedule-edits"]);
    // The seconds between the two calls do not matter.
    expect(
      updated({ scheduleId: "job-1", state: "paused", when: once(CREATED_AT + HOUR + 20_000) }),
    ).toEqual([]);
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

  test("a refusal for some other reason (a broken route, an unknown tool) does not count", () => {
    const input = passing();
    for (const error of [
      "Unknown tool: resolve_conflicts",
      "node-unreachable: the node did not answer",
      "Internal bridge error",
    ]) {
      expect(
        failures({
          ...input,
          outputs: {
            ...input.outputs,
            resolve_conflicts: [JSON.stringify({ isError: true, error })],
            answer_worker_question: [JSON.stringify({ isError: true, error })],
          },
        }),
      ).toEqual(["resolve-refused-without-pr", "answer-refused-without-question"]);
    }
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
      detail("command-ran-as-listed", {
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

  test("a worker whose session was never read fails, since nothing proves no approval escaped", () => {
    expect(failures({ ...passing(), workerObserved: false })).toEqual(["no-user-action"]);
  });
});

describe("gap-tools readers", () => {
  test("a delegation counts as opened only when it is not the one seen before", () => {
    const record = (requestedAt: string) => ({
      environmentId: WORKER,
      requestedAt,
      workerTabId: "startup-agent",
      state: "completed" as const,
    });
    expect(delegationsOpenedSince(record("a"), record("a"))).toBe(0);
    expect(delegationsOpenedSince(record("a"), record("b"))).toBe(1);
    expect(delegationsOpenedSince(undefined, record("b"))).toBe(1);
    expect(delegationsOpenedSince(record("a"), undefined)).toBe(0);
    expect(delegationsOpenedSince(undefined, undefined)).toBe(0);
  });

  test("the /compact row is found by name or by the session action's ID", () => {
    expect(
      compactRow(JSON.stringify({ commands: [{ id: "claude:/compact", name: "/compact" }] })),
    ).toEqual({ id: "claude:/compact" });
    expect(compactRow(JSON.stringify({ commands: [{ id: "orkestrator:compact" }] }))).toEqual({
      id: "orkestrator:compact",
    });
    expect(
      compactRow(JSON.stringify({ commands: [{ id: "x:/compactor", name: "/compactor" }] })),
    ).toBeUndefined();
    expect(compactRow(undefined)).toBeUndefined();
  });

  test("a schedule's fire time comes from its trigger, else from nextFireAt", () => {
    expect(scheduleFiresAt({ when: once(CREATED_AT) })).toBe(CREATED_AT);
    expect(
      scheduleFiresAt({ when: 'cron "0 9 * * *" (UTC)', nextFireAt: new Date(5).toISOString() }),
    ).toBe(5);
    expect(scheduleFiresAt({ when: "every 1h" })).toBeUndefined();
    expect(scheduleFiresAt(undefined)).toBeUndefined();
  });
});
