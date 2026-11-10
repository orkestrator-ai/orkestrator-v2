import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testing, parseOptions } from "../../scripts/recurring-live-ab";
import {
  BUSY_ROWS,
  busyFailed,
  busyRuntime,
  busyRowSummary,
  busySummaryLines,
  measureBusy,
  parseBusyClients,
  type AsyncCli,
  type BusyClient,
  type BusyRuntime,
  type ReviewSighting,
  clientProgressSample,
} from "../../scripts/recurring-live-ab-busy";
import {
  FAKE_PI_MODEL_REF,
  type FakeModelServer,
  type MarkerRecord,
} from "../../scripts/recurring-live-ab-fake-model";

setDefaultTimeout(30_000);

type Scenario = {
  lateResults?: boolean;
  reversedSubmission?: boolean;
  missingSubmission?: boolean;
  noApprovalFirstRound?: boolean;
  stopUnconfirmed?: boolean;
  /** Opening this many clients throws (a view that never appears). */
  failOpen?: number;
  /** The public API never lists the parked approval. */
  noApproval?: boolean;
  /** The review ends in this phase instead of `ready`. */
  reviewEnds?: string;
  /** The held turn reaches the model twice. */
  duplicateTurn?: boolean;
  /** Review views start showing the review only once it is consolidating. */
  lateView?: boolean;
  /** Review views never show anything past `preparing`. */
  stuckView?: boolean;
  /** Tab selection succeeds but the review header never renders. */
  emptyView?: boolean;
  /** Opening a review view throws. */
  failPrepare?: boolean;
};

/**
 * A busy profile in memory: the CLI, the registry, the fake model and the
 * clients share one virtual clock and one state, moved by the phase's own
 * commands, so every wait resolves on the next poll.
 */
function busyHarness(scenario: Scenario = {}) {
  let now = 0;
  const environments = [{ id: "env-fixture", name: "fixture-local", projectId: "p1" }] as Array<{
    id: string;
    name: string;
    projectId: string;
  }>;
  const markers = new Map<string, MarkerRecord>();
  const released = new Set<string>();
  const workflow: Record<
    string,
    { calls: number; resultsAt: number[]; submissions: Array<{ resultKey: string; at: number }> }
  > = {};
  let completions = 0;
  let queued: string | null = null;
  let approval: { id: string; answered: boolean } | null = null;
  let changed = 0;
  let burst = 0;
  let mails = 0;
  let reviewReads = 0;
  let commits = 0;
  let reads = 0;
  let reviewLaunches = 0;
  let replies = 0;
  /** What the review views show, shared by every view of the one review. */
  let sightings: ReviewSighting[] = [];
  let viewPhase: string | null = null;
  const prepared: string[] = [];
  const watched: string[] = [];
  const show = (phase: string) => {
    if (scenario.emptyView) return;
    if (scenario.stuckView && phase !== "preparing") return;
    if (scenario.lateView && (phase === "preparing" || phase === "reviewing")) return;
    if (viewPhase === phase) return;
    viewPhase = phase;
    sightings.push({ phase, at: now });
  };
  const linkCalls: boolean[] = [];
  const hiddenCalls: boolean[] = [];
  const closed: string[] = [];
  const calls: string[][] = [];
  const note = (id: string) => {
    const existing = markers.get(id);
    if (existing) {
      existing.requests += 1;
      existing.lastAt = now;
    } else markers.set(id, { requests: 1, toolResults: 0, firstAt: now, lastAt: now });
  };
  const model: FakeModelServer = {
    baseUrl: "http://127.0.0.1:1/v1",
    counts: () => ({ completions, models: 0, refused: 0 }),
    workflow: () =>
      Object.fromEntries(
        Object.entries(workflow).map(([tool, entry]) => [
          tool,
          {
            calls: entry.calls,
            resultsAt: [...entry.resultsAt],
            submissions: [...entry.submissions],
          },
        ]),
      ),
    marker: (id) => {
      const record = markers.get(id);
      return record ? { ...record } : null;
    },
    release: (id) => {
      released.add(id);
      // The held turn ends; the backend sends the queued prompt.
      if (id.startsWith("t-") && queued && markers.has(id)) {
        completions += 1;
        note(queued);
        queued = null;
      }
    },
    stop: async () => undefined,
  };
  const marker = (prompt: string, kind: "hold" | "tool") =>
    new RegExp(`\\[${kind}:([a-z0-9-]+)\\]`).exec(prompt)?.[1] ?? null;
  const json = (result: unknown) => ({ status: 0, stdout: JSON.stringify({ result }) });
  const listing = () =>
    json({
      items: environments.map((entry) => ({
        ...entry,
        environmentType: "local",
        ready: true,
        workspacePath: `/worktrees/${entry.name}`,
      })),
    });
  const cli: AsyncCli = async (args) => {
    calls.push(args);
    const verb = `${args[0]} ${args[1]}`;
    if (verb === "environment list") return listing();
    if (verb === "agent options")
      return { status: 0, stdout: `{"models":["${FAKE_PI_MODEL_REF}"]}` };
    if (verb === "environment create") {
      const name = args[args.indexOf("--name") + 1]!;
      environments.push({ id: `env-${name}`, name, projectId: "p1" });
      return json({ environment: { id: `env-${name}` } });
    }
    if (verb === "environment start") return json({});
    if (verb === "session start") {
      completions += 1;
      const environment = args[args.indexOf("--environment") + 1]!;
      return {
        status: 7,
        stdout: JSON.stringify({
          receipt: { resources: { sessionId: `ses-${environment}`, tabId: `tab-${environment}` } },
        }),
      };
    }
    if (verb === "session stop") {
      if (scenario.stopUnconfirmed) return { status: 7, stdout: "{}" };
      if (!approval || approval.answered)
        return { status: 8, stdout: JSON.stringify({ error: { code: "session-idle" } }) };
      approval = null;
      return json({});
    }
    if (verb === "session prompt") {
      if (approval && !approval.answered) return { status: 8, stdout: "{}" };
      const prompt = args[args.indexOf("--prompt") + 1]!;
      if (args.includes("--enqueue")) {
        queued = marker(prompt, "hold");
        return json({});
      }
      completions += 1;
      const held = marker(prompt, "hold");
      if (held) {
        note(held);
        if (scenario.duplicateTurn) note(held);
      }
      const tool = marker(prompt, "tool");
      if (tool) {
        note(tool);
        approval = { id: `approval-${tool}`, answered: false };
      }
      return json({});
    }
    if (verb === "mail send") {
      mails += 1;
      return json({ messageId: "m1" });
    }
    if (verb === "review launch") {
      reviewReads = 0;
      reviewLaunches += 1;
      sightings = [];
      viewPhase = null;
      if (!scenario.lateView) show("preparing");
      return json({ workflowId: `wf-${now}`, phase: "preparing" });
    }
    if (verb === "review cancel") return json({});
    return { status: 2, stdout: "{}" };
  };
  const reviewPhase = () => {
    reviewReads += 1;
    const phases = ["preparing", "reviewing", "consolidating", scenario.reviewEnds ?? "ready"];
    const phase = phases[Math.min(phases.length - 1, Math.floor(reviewReads / 2))]!;
    const submit = (tool: string) => {
      const entry = (workflow[tool] ??= { calls: 0, resultsAt: [], submissions: [] });
      entry.calls += 1;
      if (!scenario.missingSubmission)
        entry.submissions.push({
          resultKey: `${reviewLaunches}-${tool}`,
          at: now + (scenario.reversedSubmission ? 100_000 : 0),
        });
      if (!scenario.lateResults) entry.resultsAt.push(now);
    };
    // Multi Review's own results; `submit_review_preparation` is a build
    // pipeline's and never comes from a review.
    if (reviewReads === 1) submit("submit_validation_plan");
    if (reviewReads === 3) submit("submit_review_report");
    if (reviewReads === 5) submit("submit_consolidated_review");
    if (scenario.lateResults && reviewReads === 8) {
      for (const entry of Object.values(workflow)) entry.resultsAt.push(now + 50);
    }
    // The views render each phase a poll after the backend reaches it.
    const shown = phase;
    queueMicrotask(() => {
      now += 20;
      show(shown);
    });
    return phase;
  };
  const gateway = {
    metrics: async () => {
      reads += 1;
      return {
        recurringWork: {
          metrics: {
            kinds: { "diff-scan": { changed, started: changed, workUnits: {} } },
          },
          admission: [
            {
              pool: "workflow-provider",
              active: reads % 3,
              waiting: reads % 2,
              oldestWaitMs: reads % 2 ? 40 : null,
              granted: 10 + reads,
              rejected: { capacity: 1 },
            },
          ],
        },
      };
    },
    invoke: async (command: string, args: Record<string, unknown>) => {
      if (command === "create_environment") {
        environments.push({ id: "env-busy-ask", name: String(args.name), projectId: "p1" });
        return { id: "env-busy-ask" };
      }
      if (command !== "public_action") throw new Error(`unexpected ${command}`);
      const action = args.action;
      if (action === "session.interactions") {
        const pending =
          approval &&
          !approval.answered &&
          !scenario.noApproval &&
          !(scenario.noApprovalFirstRound && approval?.id === "approval-a-r1");
        return {
          ok: true,
          result: {
            items: pending
              ? [{ id: approval!.id, revision: 2, state: "pending", kind: "command-approval" }]
              : [],
          },
        };
      }
      if (action === "session.interaction.resolve") {
        expect((args.request as { requestId?: string }).requestId).toMatch(/^busy-/);
        approval!.answered = true;
        const id = approval!.id.replace("approval-", "");
        const record = markers.get(id)!;
        record.requests += 1;
        record.toolResults += 1;
        record.lastAt = now;
        replies += 1;
        return { ok: true, result: { result: "applied" } };
      }
      if (action === "review.get") return { ok: true, result: { phase: reviewPhase() } };
      throw new Error(`unexpected action ${String(action)}`);
    },
  };
  const environmentNames = () => environments.map((entry) => entry.name);
  const client = (label: string, linked: boolean): BusyClient => ({
    label,
    linked,
    markerState: async (name) => {
      if (name === "busy-1") {
        const held = Array.from(markers.keys()).find(
          (id) => id.startsWith("t-") && !released.has(id),
        );
        return held ? "working" : "idle";
      }
      if (name === "busy-ask") return approval && !approval.answered ? "waiting" : "idle";
      return "idle";
    },
    badges: async () => Object.fromEntries(environmentNames().map((name) => [name, burst || null])),
    approvalVisible: async () => Boolean(approval && !approval.answered),
    replyCount: async () => replies,
    mailCount: async () => mails,
    setHidden: async (hidden) => {
      hiddenCalls.push(hidden);
    },
    setLinkUp: (up) => {
      linkCalls.push(up);
    },
    prepareReview: async (environmentName) => {
      if (scenario.failPrepare) throw new Error("waitFor: Timeout 30000ms exceeded.\nCall log");
      prepared.push(`${label}:${environmentName}`);
    },
    watchReview: async (workflowId) => {
      watched.push(`${label}:${workflowId}`);
    },
    reviewPhases: async () => sightings.map((sighting) => ({ ...sighting })),
    close: async () => {
      closed.push(label);
    },
  });
  const opened: number[] = [];
  const runtime: BusyRuntime = {
    startFakeModel: () => model,
    writeFakePiModels: () => undefined,
    openClients: async ({ count, openEnvironment }) => {
      expect(openEnvironment).toBe("busy-ask");
      if (count === scenario.failOpen)
        throw new Error("waitFor: Timeout 60000ms exceeded.\nCall log");
      opened.push(count);
      return Array.from({ length: count }, (_, index) => client(`c${index + 1}`, index === 1));
    },
    writeBurst: (worktrees, relative, count) => {
      expect(worktrees).toHaveLength(environments.length);
      expect(relative.startsWith("busy-burst/")).toBe(true);
      burst = count;
      changed += environments.length;
    },
    removeBurst: () => {
      burst = 0;
    },
    commitFixture: () => {
      commits += 1;
      return true;
    },
    validationRuns: () =>
      new Map(
        Array.from({ length: reviewLaunches }, (_, index) => [
          `run-${index}`,
          { queuedMs: 5, commandMs: 20, runMs: 900 },
        ]),
      ),
    processes: () => ({ backend: { cpuMs: now, rssKiB: 1024 } }),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  return {
    cli,
    gateway,
    runtime,
    calls,
    opened,
    linkCalls,
    hiddenCalls,
    closed,
    prepared,
    watched,
    commits: () => commits,
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const options = (overrides: Partial<Parameters<typeof measureBusy>[2]> = {}) => ({
  busyRounds: 1,
  busyEnvironments: 4,
  busyClients: [0, 1, 2],
  busyBurstFiles: 5,
  dataDir: "/profile/data",
  ...overrides,
});

describe("busy phase options", () => {
  test("parses the busy flags and refuses impossible ones", () => {
    const parsed = parseOptions([
      "--busy-rounds",
      "3",
      "--busy-environments",
      "10",
      "--busy-clients",
      "0,2,2",
      "--busy-burst-files",
      "100",
      "--fixture-environments",
      "local",
    ]);
    expect(parsed).toMatchObject({
      busyRounds: 3,
      busyEnvironments: 10,
      busyClients: [0, 2],
      busyBurstFiles: 100,
    });
    expect(parseOptions([]).busyRounds).toBe(0);
    expect(parseBusyClients("1")).toEqual([1]);
    expect(() => parseBusyClients("3")).toThrow();
    expect(() => parseBusyClients("")).toThrow();
    expect(() => parseOptions(["--busy-environments", "2"])).toThrow();
    expect(() => parseOptions(["--busy-burst-files", "0"])).toThrow();
    expect(() =>
      parseOptions(["--busy-rounds", "1", "--fixture-environments", "container"]),
    ).toThrow(/local fixture/);
  });
});

describe("busy phase", () => {
  test("submission identity survives callbacks delayed beyond ready", async () => {
    const h = busyHarness({ lateResults: true });
    const result = await measureBusy(
      h.gateway,
      h.cli,
      options({ busyClients: [0] }),
      undefined,
      h.runtime,
    );
    expect(result.failures).toEqual([]);
    expect(result.samples["workflow-progress"]).toHaveLength(2);
  });
  test("an observation before its own submission cannot use a later unrelated phase", async () => {
    const h = busyHarness({ reversedSubmission: true });
    const result = await measureBusy(
      h.gateway,
      h.cli,
      options({ busyClients: [0] }),
      undefined,
      h.runtime,
    );
    expect(result.failures.filter((item) => item.step === "workflow-sample")).toHaveLength(3);
    expect(result.samples["workflow-progress"]).toEqual([]);
  });
  test("missing submissions cannot silently qualify", async () => {
    const h = busyHarness({ missingSubmission: true });
    const result = await measureBusy(
      h.gateway,
      h.cli,
      options({ busyClients: [0] }),
      undefined,
      h.runtime,
    );
    expect(result.failures.filter((item) => item.step === "workflow-sample")).toHaveLength(3);
    expect(busyFailed(result)).toBe(true);
  });
  test("an unconfirmed stop refuses session reuse", async () => {
    const h = busyHarness({ noApprovalFirstRound: true, stopUnconfirmed: true });
    await expect(
      measureBusy(
        h.gateway,
        h.cli,
        options({ busyClients: [0], busyRounds: 2 }),
        undefined,
        h.runtime,
      ),
    ).rejects.toThrow("could not confirm session stop");
    expect(h.calls.filter((call) => call[0] === "review" && call[1] === "launch")).toHaveLength(1);
  });
  test("a parked approval in round one cannot block round two", async () => {
    const h = busyHarness({ noApprovalFirstRound: true });
    const result = await measureBusy(
      h.gateway,
      h.cli,
      options({ busyClients: [0], busyRounds: 2 }),
      undefined,
      h.runtime,
    );
    expect(result.rounds.map((item) => item.failed)).toEqual([true, false]);
    expect(h.calls.filter((call) => call[0] === "session" && call[1] === "stop")).toHaveLength(2);
  });
  test("runs every step for 0, 1 and 2 clients and keeps every obligation", async () => {
    const h = busyHarness();
    const result = await measureBusy(h.gateway, h.cli, options(), undefined, h.runtime);
    expect(result.failures).toEqual([]);
    expect(result.timeouts).toEqual({});
    expect(busyFailed(result)).toBe(false);
    expect(result.environments).toBe(4);
    expect(h.commits()).toBe(1);
    expect(result.rounds.map((round) => round.clients)).toEqual([0, 1, 2]);
    expect(result.obligations).toEqual({
      turns: 3,
      queued: 3,
      approvals: 3,
      mails: 3,
      workflows: 3,
      duplicates: 0,
    });
    expect(h.opened).toEqual([1, 2]);
    // The second of two clients was cut and restored; the single client hidden and shown.
    expect(h.linkCalls).toEqual([false, true]);
    expect(h.hiddenCalls).toEqual([true, false]);
    expect(h.closed).toEqual(["c1", "c1", "c2"]);
    // Client rows have samples only from rounds with clients; backend rows from all.
    expect(result.samples["queued-dispatch"]).toHaveLength(3);
    expect(result.samples["workflow-complete"]).toHaveLength(3);
    expect(result.samples["workflow-progress"].length).toBeGreaterThan(0);
    // The plan's result is followed by its commands, not only a keyed wake: its own row.
    expect(result.samples["workflow-validation"]).toHaveLength(3);
    // Every client whose link stays up watched the review from its own view:
    // the hidden single client, and the first of two (the second is cut).
    expect(h.prepared).toEqual(["c1:busy-2", "c1:busy-2"]);
    expect(h.watched).toHaveLength(2);
    expect(result.reviewViews).toEqual({ watched: 2, sampled: 4, unobserved: 0 });
    expect(result.samples["workflow-progress-visible"]).toHaveLength(4);
    for (const value of result.samples["workflow-progress-visible"])
      expect(value).toBeGreaterThanOrEqual(0);
    // One new validation run per review, read from the review environment.
    expect(result.validationRuns).toEqual(
      Array.from({ length: 3 }, () => ({ queuedMs: 5, commandMs: 20, runMs: 900 })),
    );
    expect(result.samples["approval-backend"]).toHaveLength(3);
    // One client, then two (the cut one is not expected to follow the approval).
    expect(result.samples["approval-visible"]).toHaveLength(3);
    expect(result.samples["approved-turn-visible"]).toHaveLength(1);
    expect(result.samples["burst-badge"]).toHaveLength(3 * 4);
    expect(result.samples["outage-resume"]).toHaveLength(1);
    expect(result.samples["hidden-resume"]).toHaveLength(1);
    // A window sample before the rounds and one after each.
    expect(result.windowSamples).toHaveLength(4);
    // The approval environment asks; the others are made through the CLI.
    expect(
      h.calls.filter((call) => call[0] === "environment" && call[1] === "create"),
    ).toHaveLength(2);
    expect(
      h.calls.some(
        (call) =>
          call[0] === "review" && call[1] === "launch" && call.includes(`pi=${FAKE_PI_MODEL_REF}`),
      ),
    ).toBe(true);
    // Every command asks for JSON; no command carries a token.
    expect(h.calls.every((call) => call.includes("--json"))).toBe(true);
    const lines = busySummaryLines("candidate repeat 1", result).join("\n");
    expect(lines).toContain("3 reviews completed");
    expect(lines).toContain("Workflow progress visible after a result");
    expect(lines).toContain("Review views: 2 watched a review, 4 results timed in a view");
    expect(lines).toContain("Pending approval visible");
    expect(lines).toContain("≤ 2000");
    expect(lines).toContain("≤ 2400");
    // Granted and refused are deltas over the phase; peaks are the most any read saw.
    const pool = result.admission["workflow-provider"]!;
    expect(pool.granted).toBeGreaterThan(0);
    expect(pool).toMatchObject({ rejected: 0, maxActive: 2, maxWaiting: 1, maxOldestWaitMs: 40 });
    expect(lines).toContain("Admission: workflow-provider");
  });

  test("a review view that opens late times only the results it could have shown", async () => {
    const h = busyHarness({ lateView: true });
    const result = await measureBusy(
      h.gateway,
      h.cli,
      options({ busyClients: [1] }),
      undefined,
      h.runtime,
    );
    expect(result.failures).toEqual([]);
    // The report reached the backend before the view showed the review.
    expect(result.reviewViews).toEqual({ watched: 1, sampled: 1, unobserved: 1 });
    expect(result.samples["workflow-progress-visible"]).toHaveLength(1);
    expect(busyFailed(result)).toBe(false);
  });

  test("a review view that never shows the progress is a timeout, and one that cannot open fails the round", async () => {
    const stuck = busyHarness({ stuckView: true });
    const stuckResult = await measureBusy(
      stuck.gateway,
      stuck.cli,
      options({ busyClients: [1] }),
      undefined,
      stuck.runtime,
    );
    expect(stuckResult.samples["workflow-progress-visible"]).toEqual([]);
    expect(stuckResult.timeouts["workflow-progress-visible"]).toBe(2);
    expect(busyFailed(stuckResult)).toBe(true);

    const refused = busyHarness({ failPrepare: true });
    const refusedResult = await measureBusy(
      refused.gateway,
      refused.cli,
      options({ busyClients: [1] }),
      undefined,
      refused.runtime,
    );
    expect(refusedResult.failures).toEqual([
      {
        clients: 1,
        round: 1,
        step: "workflow-visible",
        detail: "c1: waitFor: Timeout 30000ms exceeded.",
      },
    ]);
    // The review itself still ran and was timed at the backend.
    expect(refusedResult.obligations.workflows).toBe(1);
    expect(refusedResult.reviewViews.watched).toBe(0);
  });

  test("a selected review view that never renders fails qualification", async () => {
    const h = busyHarness({ emptyView: true });
    const result = await measureBusy(
      h.gateway,
      h.cli,
      options({ busyClients: [1] }),
      undefined,
      h.runtime,
    );
    expect(h.prepared).toHaveLength(1);
    expect(h.watched).toHaveLength(1);
    expect(result.reviewViews).toEqual({ watched: 1, sampled: 0, unobserved: 2 });
    expect(result.samples["workflow-progress-visible"]).toEqual([]);
    expect(result.failures).toEqual([
      {
        clients: 1,
        round: 1,
        step: "workflow-visible",
        detail: "c1: review did not show terminal phase ready",
      },
    ]);
    expect(result.obligations.workflows).toBe(1);
    expect(busyFailed(result)).toBe(true);
  });

  test("client progress is the first sighting of the phase or a later one, after its result", () => {
    const sightings = [
      { phase: "preparing", at: 100 },
      { phase: "consolidating", at: 900 },
      { phase: "ready", at: 1_400 },
    ];
    // Reviewing was skipped between two renders; consolidating shows it.
    expect(clientProgressSample(sightings, 400, "reviewing")).toEqual({
      kind: "sample",
      ms: 500,
    });
    expect(clientProgressSample(sightings, 1_000, "ready")).toEqual({ kind: "sample", ms: 400 });
    // A view that showed nothing before the result was not watching yet.
    expect(clientProgressSample(sightings, 50, "reviewing")).toEqual({ kind: "unobserved" });
    expect(clientProgressSample([], 50, "reviewing")).toEqual({ kind: "unobserved" });
    // Never shown, shown before its own result, or an unknown phase: missing.
    expect(clientProgressSample(sightings.slice(0, 1), 400, "ready")).toEqual({
      kind: "missing",
    });
    expect(clientProgressSample(sightings, 1_000, "consolidating")).toEqual({ kind: "missing" });
    expect(clientProgressSample(sightings, 400, "fixing")).toEqual({ kind: "missing" });
  });

  test("records a lost approval, a failed review and a duplicated dispatch as failures", async () => {
    const h = busyHarness({ noApproval: true, reviewEnds: "failed", duplicateTurn: true });
    const result = await measureBusy(
      h.gateway,
      h.cli,
      options({ busyClients: [0] }),
      undefined,
      h.runtime,
    );
    expect(result.failures.map((failure) => failure.step)).toEqual([
      "approval",
      "workflow",
      "workflow-sample",
    ]);
    expect(result.failures[1]?.detail).toContain("failed");
    expect(result.obligations.duplicates).toBe(1);
    expect(result.timeouts["approval-backend"]).toBe(1);
    expect(busyFailed(result)).toBe(true);
    expect(result.rounds[0]?.failed).toBe(true);
  });

  test("a round that throws is recorded and the next round still runs", async () => {
    const h = busyHarness({ failOpen: 1 });
    const result = await measureBusy(h.gateway, h.cli, options(), undefined, h.runtime);
    expect(result.failures).toEqual([
      { clients: 1, round: 1, step: "round", detail: "waitFor: Timeout 60000ms exceeded." },
    ]);
    expect(result.rounds.map((round) => [round.clients, round.failed])).toEqual([
      [0, false],
      [1, true],
      [2, false],
    ]);
    // The failed round's held turn was released, so the next round's turn went out.
    expect(result.obligations.turns).toBe(2);
    expect(result.obligations.workflows).toBe(2);
    expect(busyFailed(result)).toBe(true);
  });

  test("summarises each row against its budget", () => {
    const samples = Object.fromEntries(Object.keys(BUSY_ROWS).map((row) => [row, []])) as never;
    const summary = busyRowSummary({
      environments: 1,
      rounds: [],
      samples: { ...(samples as object), "approval-visible": [100, 2_500] } as never,
      timeouts: {},
      obligations: { turns: 0, queued: 0, approvals: 0, mails: 0, workflows: 0, duplicates: 0 },
      failures: [],
      windowSamples: [],
      admission: {},
      validationRuns: [],
      reviewViews: { watched: 0, sampled: 0, unobserved: 0 },
      modelRequests: 0,
      durationMs: 0,
    });
    const approval = summary.find((entry) => entry.row === "approval-visible")!;
    expect(approval).toMatchObject({ count: 2, p95Ms: 2_500, withinBudget: false });
    expect(summary.find((entry) => entry.row === "outage-resume")?.withinBudget).toBeNull();
  });

  test("a failed busy phase fails the run", () => {
    const base = { error: undefined, soak: undefined, guardLines: 0 };
    const busy = {
      environments: 1,
      rounds: [],
      samples: {} as never,
      timeouts: {},
      obligations: { turns: 0, queued: 0, approvals: 0, mails: 0, workflows: 0, duplicates: 0 },
      failures: [],
      windowSamples: [],
      admission: {},
      validationRuns: [],
      reviewViews: { watched: 0, sampled: 0, unobserved: 0 },
      modelRequests: 0,
      durationMs: 0,
    };
    expect(__testing.resultExitCode([{ ...base, busy }])).toBe(0);
    expect(__testing.resultExitCode([{ ...base, busy, guardLines: 1 }])).toBe(1);
    expect(
      __testing.resultExitCode([
        { ...base, busy: { ...busy, failures: [{ clients: 0, round: 1, step: "queue" }] } },
      ]),
    ).toBe(1);
  });

  test("writes and removes bursts, reads validation timings and commits the review fixture", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "recurring-busy-"));
    directories.push(root);
    const worktree = path.join(root, "worktree");
    mkdirSync(worktree);
    busyRuntime.writeBurst([worktree], path.join("busy-burst", "r1"), 3);
    expect(readdirSync(path.join(worktree, "busy-burst", "r1")).sort()).toEqual([
      "f-0.txt",
      "f-1.txt",
      "f-2.txt",
    ]);
    busyRuntime.removeBurst([worktree], path.join("busy-burst", "r1"));
    expect(existsSync(path.join(worktree, "busy-burst", "r1"))).toBe(false);

    expect(busyRuntime.validationRuns(worktree).size).toBe(0);
    const runs = path.join(worktree, ".orkestrator", "review-artifacts");
    mkdirSync(path.join(runs, "review-validation-a"), { recursive: true });
    writeFileSync(
      path.join(runs, "review-validation-a", "state.json"),
      JSON.stringify({
        run: {
          startedAt: "2026-11-06T19:27:30.460Z",
          completedAt: "2026-11-06T19:27:31.576Z",
          results: [{ queuedMs: 7, durationMs: 11 }],
        },
      }),
    );
    // A run still being written (no completion) and an unrelated directory are skipped.
    mkdirSync(path.join(runs, "review-validation-b"));
    writeFileSync(path.join(runs, "review-validation-b", "state.json"), "{");
    mkdirSync(path.join(runs, "other"));
    expect(Array.from(busyRuntime.validationRuns(worktree))).toEqual([
      ["review-validation-a", { queuedMs: 7, commandMs: 11, runMs: 1_116 }],
    ]);

    expect(spawnSync("git", ["init", "-q", worktree]).status).toBe(0);
    expect(busyRuntime.commitFixture(worktree)).toBe(true);
    const log = spawnSync("git", ["-C", worktree, "log", "--format=%s"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("Busy review fixture");
  });
});
