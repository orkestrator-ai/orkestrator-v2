import { describe, expect, test } from "bun:test";
import type { BuildPipeline, PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import type { ReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import type { PersistedBuildPipeline } from "../models.js";
import {
  BuildPipelineLongChecks,
  applyLongCheckEvidence,
  LONG_CHECK_MAX_POLL_FAILURES,
  createBuildPipelineLongCheckHost,
  longCheckPlan,
  longCheckResultsPrompt,
  undeliveredLongChecks,
} from "./long-checks.js";

const HEAD = "b".repeat(40);
const SESSION_KEY = "pipeline-1:verify:0:session";

function pipeline(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  const session = {
    phase: "verify",
    detachedLongChecksAllowed: true,
    label: "Verify",
    sessionKey: SESSION_KEY,
    sdkSessionId: "sdk-verify",
    structuredRequestId: "request-verify",
    iteration: 0,
    status: "running",
    startedAt: "2026-11-22T10:00:00.000Z",
  } as unknown as PipelineSession;
  return {
    id: "pipeline-1",
    controller: "backend",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: "claude",
    phase: "verifying",
    sessions: [session],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    backendRevision: 1,
    createdAt: "2026-11-22T09:00:00.000Z",
    taskTitle: "Parity",
    taskSnapshot: {
      title: "Parity",
      description: "",
      acceptanceCriteria: "",
      acceptanceCriteriaItems: [{ id: "ac-1", text: "Parity holds" }],
      comments: [],
      images: [],
    },
    source: { type: "kanban", taskId: "task-1" },
    ...overrides,
  } as BuildPipeline;
}

const scope = {
  environmentId: "env-1",
  projectId: "project-1",
  tabId: pipelineWorkerTabId(SESSION_KEY),
};

/** A fake worker: start and status answer from `state`, recording every call. */
function fakeWorld(initial: BuildPipeline) {
  let current = structuredClone(initial);
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const state: { answer: (run: ReviewValidationRun) => unknown; fail?: string } = {
    answer: (run) => ({ ...run, status: "running" }),
  };
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ command, args });
    if (command === "get_environment_uncommitted_paths") return { head: HEAD, paths: [] } as T;
    if (command === "add_kanban_comment") return undefined as T;
    if (state.fail) throw new Error(state.fail);
    return state.answer(args.run as ReviewValidationRun) as T;
  };
  const host = createBuildPipelineLongCheckHost({
    listPipelines: async () =>
      [{ snapshot: current } as unknown as PersistedBuildPipeline] as const,
    mutate: async (_id, mutation) => {
      const next = structuredClone(current);
      await mutation(next);
      current = next;
      return current;
    },
    invoke,
    assertExecutionAllowed: async () => {},
  });
  return {
    host,
    invoke,
    calls,
    state,
    get pipeline() {
      return current;
    },
  };
}

function completed(run: ReviewValidationRun, status: "passed" | "failed"): ReviewValidationRun {
  return {
    ...run,
    status: "completed",
    completedAt: new Date().toISOString(),
    results: run.results.map((result, index) => ({
      ...result,
      status,
      exitCode: status === "passed" ? 0 : 1,
      durationMs: 1_800_000,
      stdoutPath: `.orkestrator/review-artifacts/${run.id}/validation-0${index + 1}.stdout.txt`,
      stderrPath: `.orkestrator/review-artifacts/${run.id}/validation-0${index + 1}.stderr.txt`,
      stdoutBytes: 10,
      stderrBytes: 0,
    })),
  };
}

describe("long check plans", () => {
  test("one heavy command each, relative paths, bounded timeouts, changed scope kept", () => {
    const plan = longCheckPlan(
      {
        name: "parity",
        commands: [
          { command: "bun run parity", cwd: "tools" },
          { command: "bun test tests/parity-changed.test.ts", scope: "changed", timeoutMinutes: 5 },
        ],
      },
      HEAD,
    );
    expect(plan.headRef).toBe(HEAD);
    expect(plan.commands).toEqual([
      expect.objectContaining({
        id: "c2",
        cwd: ".",
        scope: "changed",
        timeoutMs: 300_000,
        weight: 2,
      }),
      expect.objectContaining({ id: "c1", cwd: "tools", scope: "general", timeoutMs: 3_600_000 }),
    ]);
  });

  test("refuses escapes and out-of-range timeouts", () => {
    expect(() =>
      longCheckPlan({ name: "x", commands: [{ command: "ls", cwd: "../up" }] }, HEAD),
    ).toThrow("relative to the workspace root");
    expect(() =>
      longCheckPlan({ name: "x", commands: [{ command: "ls", timeoutMinutes: 500 }] }, HEAD),
    ).toThrow("between 1 and 120");
    expect(() => longCheckPlan({ name: "x", commands: [] }, HEAD)).toThrow("at least one command");
  });
});

describe("starting a long check", () => {
  test("records the check before the worker hears of it, then stores the worker's answer", async () => {
    const world = fakeWorld(pipeline());
    let recordedBeforeStart = false;
    const answer = world.state.answer;
    world.state.answer = (run) => {
      recordedBeforeStart =
        world.pipeline.longChecks?.some((check) => check.id === run.id) ?? false;
      return answer(run);
    };
    const summary = await world.host.start(scope, {
      name: "corpus parity",
      criterion: "ac-1",
      commands: [{ command: "bun run parity" }],
    });
    expect(recordedBeforeStart).toBe(true);
    expect(summary).toMatchObject({
      name: "corpus parity",
      stage: "verify",
      round: 1,
      status: "running",
    });
    const [check] = world.pipeline.longChecks!;
    expect(check).toMatchObject({
      phase: "verify",
      iteration: 0,
      sessionKey: SESSION_KEY,
      criterion: "ac-1",
      status: "running",
    });
    expect(check!.run.status).toBe("running");
    expect(check!.run.plan.headRef).toBe(HEAD);
  });

  test("only the running stage's own worker or dispatch may start one", async () => {
    const world = fakeWorld(pipeline());
    const input = { name: "x", commands: [{ command: "ls" }] };
    await expect(
      world.host.start({ environmentId: "env-1", projectId: "project-1", tabId: "someone" }, input),
    ).rejects.toThrow("authenticated worker");
    await expect(
      world.host.start(
        { environmentId: "env-1", projectId: "project-1", workflowResultKey: "request-verify" },
        input,
      ),
    ).resolves.toMatchObject({ status: "running" });
  });

  test("Review and the later stages cannot start one", async () => {
    const world = fakeWorld(
      pipeline({
        phase: "reviewing",
        sessions: [
          { ...pipeline().sessions[0]!, phase: "review", label: "Review" } as PipelineSession,
        ],
      }),
    );
    await expect(
      world.host.start(scope, { name: "x", commands: [{ command: "ls" }] }),
    ).rejects.toThrow("Build, Rework, Address Findings or Verify");
  });

  test("one check runs at a time", async () => {
    const world = fakeWorld(pipeline());
    await world.host.start(scope, { name: "first", commands: [{ command: "ls" }] });
    await expect(
      world.host.start(scope, { name: "second", commands: [{ command: "ls" }] }),
    ).rejects.toThrow("“first” is still running");
  });

  test("a failed start leaves the check for the supervisor to start", async () => {
    const world = fakeWorld(pipeline());
    world.state.fail = "worker unavailable";
    const summary = await world.host.start(scope, { name: "x", commands: [{ command: "ls" }] });
    expect(summary.status).toBe("running");
    expect(world.pipeline.longChecks![0]!.run.status).toBe("planned");
  });
});

describe("supervising long checks", () => {
  async function started() {
    const world = fakeWorld(pipeline());
    await world.host.start(scope, {
      name: "corpus parity",
      commands: [{ command: "bun run parity" }],
    });
    const saves: number[] = [];
    let now = 1_000_000;
    const poller = new BuildPipelineLongChecks({
      invoke: world.invoke,
      save: async () => {
        saves.push(now);
      },
      now: () => now,
    });
    return {
      world,
      poller,
      saves,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  test("settles a finished check and writes its result on the ticket once", async () => {
    const { world, poller, advance } = await started();
    const target = world.pipeline;
    world.state.answer = (run) => completed(run, "passed");
    await poller.poll(target);
    const [check] = target.longChecks!;
    expect(check).toMatchObject({ status: "passed", ticketComment: "posted" });
    expect(check!.settledAt).toBeDefined();
    const comments = world.calls.filter((call) => call.command === "add_kanban_comment");
    expect(comments).toHaveLength(1);
    expect(comments[0]!.args).toMatchObject({ taskId: "task-1" });
    expect(String(comments[0]!.args.text)).toContain(
      "**Long check “corpus parity”** (Verify, round 1) passed",
    );
    advance(10_000);
    await poller.poll(target);
    expect(world.calls.filter((call) => call.command === "add_kanban_comment")).toHaveLength(1);
  });

  test("retries one ticket identity across a lost reply, failed save and terminal transition", async () => {
    const { world } = await started();
    let durable = structuredClone(world.pipeline);
    world.state.answer = (run) => completed(run, "passed");
    const writes = new Map<unknown, unknown>();
    let attempts = 0;
    let failPostingSave = true;
    const poller = new BuildPipelineLongChecks({
      pollMs: 0,
      invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
        if (command !== "add_kanban_comment") return world.invoke<T>(command, args);
        expect(args.projectId).toBe("project-1");
        const existing = writes.get(args.requestId);
        if (existing !== undefined) expect(args.text).toBe(existing);
        writes.set(args.requestId, args.text);
        if (++attempts === 1) throw new Error("Lost comment reply");
        return undefined as T;
      },
      save: async (target) => {
        if (target.longChecks?.[0]?.ticketComment === "posted" && failPostingSave) {
          failPostingSave = false;
          throw new Error("Failed to save pipeline snapshot");
        }
        durable = structuredClone(target);
      },
    });
    await poller.poll(structuredClone(durable));
    expect(durable.longChecks?.[0]).toMatchObject({
      ticketComment: "failed",
      ticketCommentAttempts: 1,
    });
    expect(longCheckResultsPrompt(durable.longChecks!)).toContain("Ticket attachment: pending.");
    durable.phase = "complete";
    await expect(poller.poll(structuredClone(durable))).rejects.toThrow("Failed to save");
    await poller.poll(structuredClone(durable));
    expect(durable.longChecks?.[0]?.ticketComment).toBe("posted");
    expect(writes.size).toBe(1);
    expect(attempts).toBe(3);
  });

  test("an unavailable ticket reaches a bounded final failure and external tickets are skipped", async () => {
    const { world } = await started();
    world.state.answer = (run) => completed(run, "passed");
    const target = world.pipeline;
    let count = 0;
    const poller = new BuildPipelineLongChecks({
      invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
        if (command !== "add_kanban_comment") return world.invoke<T>(command, args);
        count++;
        throw new Error("Ticket unavailable");
      },
      save: async () => {},
    });
    const external = structuredClone(target);
    external.source = { type: "linear" } as BuildPipeline["source"];
    await poller.poll(external);
    expect(external.longChecks?.[0]?.ticketComment).toBe("skipped");
    const github = structuredClone(external);
    github.source = { type: "github" } as BuildPipeline["source"];
    delete github.longChecks![0]!.ticketComment;
    await poller.poll(github);
    expect(github.longChecks?.[0]).toMatchObject({ ticketComment: "skipped" });
    for (let pass = 0; pass < 5; pass++) await poller.poll(target);
    expect(count).toBe(3);
    expect(longCheckResultsPrompt(target.longChecks!)).toContain("Ticket attachment: failed.");
  });

  test("reads at most once per poll interval and persists progress sparingly", async () => {
    const { world, poller, saves, advance } = await started();
    const target = world.pipeline;
    await poller.poll(target);
    const reads = () =>
      world.calls.filter((call) => call.command === "status_review_validation").length;
    expect(reads()).toBe(1);
    await poller.poll(target);
    expect(reads()).toBe(1);
    const savesAfterFirst = saves.length;
    advance(6_000);
    await poller.poll(target);
    expect(reads()).toBe(2);
    // Nothing moved and the progress write is not due yet.
    expect(saves.length).toBe(savesAfterFirst);
  });

  test("a reporting outage retains the worker until its result arrives", async () => {
    const { world, poller, advance } = await started();
    const target = world.pipeline;
    world.state.fail = "Validation worker stopped reporting progress";
    for (let attempt = 0; attempt < LONG_CHECK_MAX_POLL_FAILURES; attempt += 1) {
      await poller.poll(target);
      advance(6_000);
    }
    const [check] = target.longChecks!;
    expect(check).toMatchObject({ status: "running", pollFailures: LONG_CHECK_MAX_POLL_FAILURES });
    world.state.fail = undefined;
    world.state.answer = (run) => completed(run, "passed");
    await poller.poll(target);
    expect(check).toMatchObject({ status: "passed", ticketComment: "posted" });
  });

  test("an unusable reply counts as a failed read, not a result", async () => {
    const { world, poller } = await started();
    const target = world.pipeline;
    world.state.answer = () => ({ nonsense: true });
    await poller.poll(target);
    expect(target.longChecks![0]).toMatchObject({ status: "running", pollFailures: 1 });
  });

  test("cancelling the pipeline cancels a running check and records it as incomplete", async () => {
    const { world, poller } = await started();
    const target = world.pipeline;
    world.state.answer = (run) => ({
      ...run,
      status: "cancelled",
      completedAt: new Date().toISOString(),
      results: run.results.map((result) => ({
        ...result,
        status: "incomplete",
        limitation: "Validation was cancelled",
      })),
    });
    world.state.fail = "The worker could not be reached";
    await poller.poll(target);
    expect(target.longChecks![0]).toMatchObject({ status: "running", pollFailures: 1 });
    world.state.fail = undefined;
    await poller.cancelAll(target);
    expect(world.calls.at(-1)!.command).toBe("cancel_review_validation");
    expect(target.longChecks![0]!.status).toBe("incomplete");
  });
});

describe("handing results back", () => {
  test("only this stage's undelivered checks of this round are held against it", () => {
    const base = pipeline();
    const run = (id: string) =>
      ({
        id,
        plan: { headRef: HEAD, commands: [], limitations: ["none"] },
        status: "running",
        startedAt: "2026-11-22T10:00:00.000Z",
        results: [],
      }) as ReviewValidationRun;
    const entry = (id: string, overrides: object) => ({
      id,
      name: id,
      phase: "verify" as const,
      iteration: 0,
      sessionKey: SESSION_KEY,
      status: "running" as const,
      startedAt: "2026-11-22T10:00:00.000Z",
      run: run(id),
      ...overrides,
    });
    base.longChecks = [
      entry("long-check-a", {}),
      entry("long-check-b", { deliveredAt: "2026-11-22T10:10:00.000Z" }),
      entry("long-check-c", { iteration: 1 }),
      entry("long-check-d", { phase: "build" }),
      entry("long-check-e", { sessionKey: "superseded" }),
    ];
    expect(undeliveredLongChecks(base, base.sessions[0]!)!.map((check) => check.id)).toEqual([
      "long-check-a",
    ]);
    base.longChecks = [entry("long-check-b", { deliveredAt: "2026-11-22T10:10:00.000Z" })];
    expect(undeliveredLongChecks(base, base.sessions[0]!)).toBeNull();
  });

  test("the results turn carries outcomes and paths, and says how to treat an unfinished check", async () => {
    const world = fakeWorld(pipeline());
    await world.host.start(scope, {
      name: "corpus parity",
      criterion: "ac-1",
      commands: [{ command: "bun run parity" }],
    });
    const check = world.pipeline.longChecks![0]!;
    check.run = completed(check.run, "failed");
    check.status = "failed";
    check.settledAt = new Date(Date.parse(check.startedAt) + 1_800_000).toISOString();
    const prompt = longCheckResultsPrompt([check]);
    expect(prompt).toContain("### “corpus parity”: failed after 30m 00s");
    expect(prompt).toContain("Criterion: ac-1");
    expect(prompt).toContain("Ticket attachment: pending.");
    expect(prompt).toContain("`bun run parity` (general), failed, exit 1, 30m 00s");
    expect(prompt).toContain(
      `stdout .orkestrator/review-artifacts/${check.id}/validation-01.stdout.txt (10 bytes)`,
    );
    expect(prompt).toContain("do not mark a criterion it was meant to settle as passed");
    expect(prompt).toContain("submit it now, even if you submitted one before");
  });
});

test("a fresh verdict cannot promote incomplete criterion evidence from its own attempt", async () => {
  const world = fakeWorld(pipeline());
  await world.host.start(scope, {
    name: "parity",
    criterion: "ac-1",
    commands: [{ command: "true" }],
  });
  const target = world.pipeline;
  const check = target.longChecks![0]!;
  check.status = "incomplete";
  check.deliveredAt = new Date().toISOString();
  const results = [
    { id: "ac-1", status: "passed" as const, evidence: "The verdict says it passed." },
  ];
  expect(applyLongCheckEvidence(target, target.sessions[0]!, results)).toBe(true);
  expect(results[0]).toMatchObject({ status: "not-checked" });
  expect(
    applyLongCheckEvidence(target, { ...target.sessions[0]!, sessionKey: "replacement" }, results),
  ).toBe(false);
});
