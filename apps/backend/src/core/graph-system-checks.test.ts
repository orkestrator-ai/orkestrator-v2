import { afterEach, describe, expect, test } from "bun:test";
import type { GraphActivationReport } from "./graph-run-executors.js";
import { GRAPH_CHECKS_NONE_GRACE_MS, graphFailingChecks } from "./graph-system-checks.js";
import {
  SYSTEM_BRANCH,
  SYSTEM_REPO,
  systemWorld,
  type SystemWorld,
} from "./graph-system-test-support.js";

const worlds: SystemWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

const PR = `https://github.com/${SYSTEM_REPO}/pull/1`;
const MINUTE = 60_000;

/** A world whose environment has the run's pull request, monitored. */
async function world(): Promise<SystemWorld> {
  const created = await systemWorld();
  worlds.push(created);
  created.shell.addPull("OPEN");
  created.shell.remote.set(SYSTEM_BRANCH, created.head);
  created.monitor.set("e1", { prUrl: PR });
  return created;
}

const passed = (name: string) => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
});
const running = (name: string) => ({
  __typename: "CheckRun",
  name,
  status: "IN_PROGRESS",
  conclusion: null,
});
const failed = (name: string) => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion: "FAILURE",
  detailsUrl: `https://github.com/${SYSTEM_REPO}/actions/runs/1`,
});

async function summary(w: SystemWorld, report: GraphActivationReport): Promise<unknown> {
  if (report.state !== "complete") throw new Error(`expected complete, got ${report.state}`);
  const artifact = await w.artifacts.requireVerified(w.run.id, report.outputs.summary!);
  return "value" in artifact.body ? artifact.body.value : undefined;
}

function advance(w: SystemWorld, ms: number): void {
  w.now = new Date(w.now.getTime() + ms);
}

describe("wait-for-checks (D20)", () => {
  test("waits on the PR monitor without polling, then reports passed", async () => {
    const w = await world();
    const executor = w.executor();
    const activation = w.activation("checks");
    const first = await executor.start(w.context(activation));
    expect(first).toEqual({ state: "running", observeAfterMs: 30 * MINUTE });
    expect(w.monitor.watches).toBe(1);
    expect(w.shell.rollupReads).toEqual([]);

    // The monitor announces pending checks: the activation is flagged, still waits, reads nothing.
    w.monitor.set("e1", { checkSummary: { passed: 1, total: 2, pending: 1 } });
    expect(w.observations).toEqual(["run-1 checks#iter=1#attempt=1"]);
    const running_ = { ...activation, state: "running" as const };
    expect((await executor.observe(w.context(running_))).state).toBe("unchanged");
    expect(w.shell.rollupReads).toEqual([]);

    w.shell.rollup = [passed("lint"), passed("test")];
    w.monitor.set("e1", { checkSummary: { passed: 2, total: 2, pending: 0 } });
    expect(await summary(w, await executor.observe(w.context(running_)))).toEqual({
      state: "passed",
      headRef: w.head,
      total: 2,
      pending: 0,
      failing: [],
    });
    // One rollup read, at the decision; the monitor subscription is gone.
    expect(w.shell.rollupReads).toEqual([PR]);
    w.monitor.set("e1", { checkSummary: { passed: 2, total: 2, pending: 0 } });
    expect(w.observations).toHaveLength(2);
    expect(w.monitor.listeners.size).toBe(0);
  });

  test("a failing check reports failed at once, with the failing checks", async () => {
    const w = await world();
    w.shell.rollup = [passed("lint"), failed("test (ubuntu)"), running("e2e")];
    w.monitor.set("e1", { checkSummary: { passed: 1, total: 3, pending: 1 } });
    expect(await summary(w, await w.executor().start(w.context(w.activation("checks"))))).toEqual({
      state: "failed",
      headRef: w.head,
      total: 3,
      pending: 1,
      failing: [
        {
          name: "test (ubuntu)",
          conclusion: "failure",
          detailsUrl: `https://github.com/${SYSTEM_REPO}/actions/runs/1`,
          summary: null,
        },
      ],
    });
  });

  test("still pending at the deadline reports pending; the deadline survives a restart", async () => {
    const w = await world();
    w.shell.rollup = [passed("lint"), running("e2e")];
    w.monitor.set("e1", { checkSummary: { passed: 1, total: 2, pending: 1 } });
    const activation = w.activation("checks");
    expect((await w.executor().start(w.context(activation))).state).toBe("running");
    advance(w, 20 * MINUTE);
    // A restart (new process) keeps the first call's deadline: 10 minutes remain.
    const restarted = w.executor({ owner: "process-2" });
    const running_ = { ...activation, state: "running" as const };
    expect(await restarted.recover(w.context(running_))).toEqual({
      state: "unchanged",
      observeAfterMs: 10 * MINUTE,
    });
    advance(w, 10 * MINUTE);
    expect(await summary(w, await restarted.observe(w.context(running_)))).toEqual({
      state: "pending",
      headRef: w.head,
      total: 2,
      pending: 1,
      failing: [],
    });
    expect(w.monitor.watches).toBe(1);
  });

  test("no checks after the grace period reports none", async () => {
    const w = await world();
    w.monitor.set("e1", { checkSummary: { passed: 0, total: 0, pending: 0 } });
    const executor = w.executor();
    const activation = w.activation("checks");
    expect(await executor.start(w.context(activation))).toEqual({
      state: "running",
      observeAfterMs: GRAPH_CHECKS_NONE_GRACE_MS,
    });
    advance(w, GRAPH_CHECKS_NONE_GRACE_MS);
    expect(
      await summary(w, await executor.observe(w.context({ ...activation, state: "running" }))),
    ).toEqual({ state: "none", headRef: w.head, total: 0, pending: 0, failing: [] });
  });

  test("the final read is authoritative over a stale monitor count", async () => {
    const w = await world();
    w.shell.rollup = [passed("lint"), running("test")];
    w.monitor.set("e1", { checkSummary: { passed: 1, total: 1, pending: 0 } });
    expect((await w.executor().start(w.context(w.activation("checks")))).state).toBe("running");
    expect(w.shell.rollupReads).toHaveLength(1);
  });

  test("a pull request the monitor does not follow on this environment is refused", async () => {
    const w = await world();
    w.monitor.set("e1", { prUrl: `https://github.com/${SYSTEM_REPO}/pull/9` });
    const report = await w.executor().start(w.context(w.activation("checks")));
    expect(report).toMatchObject({ state: "failed", cause: "system-error" });
  });

  test("failing checks parse check runs and status contexts; running ones are not failing", () => {
    expect(
      graphFailingChecks([
        { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "TIMED_OUT" },
        { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "FAILURE" },
        {
          __typename: "StatusContext",
          context: "ci/legacy",
          state: "ERROR",
          targetUrl: "https://ci",
        },
        { __typename: "CheckRun", name: "ok", status: "COMPLETED", conclusion: "SUCCESS" },
      ]),
    ).toEqual([
      { name: "build", conclusion: "timed-out", detailsUrl: null, summary: null },
      { name: "ci/legacy", conclusion: "failure", detailsUrl: "https://ci", summary: null },
    ]);
  });
});
