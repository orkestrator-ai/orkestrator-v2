/**
 * The run view's retry and skip (item 211): the pure record transforms and
 * the service commands through real scheduler passes with scripted
 * pass-through executors. Deterministic: a manual clock, no waits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import { bindAllRoles, type GraphRunWorld } from "./graph-run-executor-test-support.js";
import { GraphRunServiceError } from "./graph-run-service.js";
import {
  graphPlanDownstreamNodes,
  planGraphRunRetry,
  planGraphRunSkip,
} from "./graph-run-user-actions.js";
import {
  advanceUntil,
  failingPlan,
  harness as harnessOf,
  latest,
  launch,
} from "./graph-run-view-test-support.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

const harness = () => harnessOf(worlds);

const states = (run: GraphRun, nodeId: string) =>
  run.activations
    .filter((activation) => activation.nodeId === nodeId)
    .map((activation) => `${activation.attempt}:${activation.state}`);

async function refusal(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof GraphRunServiceError) return error.code;
    throw error;
  }
  throw new Error("not refused");
}

describe("retry (item 211)", () => {
  test("a skipped failure: the node reruns and its skipped consumer is decided again", async () => {
    const h = await harness();
    h.world.fakes.failQueue.set("build", ["timeout"]);
    h.world.fakes.held.add("slow");
    const launched = await launch(h, failingPlan({ onFailure: "skip" }));
    let run = await advanceUntil(
      h,
      launched.id,
      (current) => latest(current, "after") !== undefined,
    );
    expect(run.status).toBe("running");
    expect(states(run, "build")).toEqual(["1:failed"]);
    expect(states(run, "after")).toEqual(["1:skipped"]);
    const failed = latest(run, "build")!;
    const skipped = latest(run, "after")!;
    const unrouted = latest(run, "recover")!;

    run = await h.service.retry(run.id, failed.key);
    expect(run.rewinds).toHaveLength(1);
    const rewind = run.rewinds[0]!;
    expect(rewind).toMatchObject({ kind: "restart", requestedBy: "user", nodeId: "build" });
    // Both markers the failure left: `after` (no code) and `recover` (no error routed).
    expect(rewind.superseded.activations).toEqual([failed.key, skipped.key, unrouted.key]);
    expect(states(run, "build")).toEqual(["1:superseded"]);
    expect(states(run, "after")).toEqual(["1:superseded"]);
    expect(states(run, "recover")).toEqual(["1:superseded"]);
    // `slow` is independent of build: untouched.
    expect(states(run, "slow")).toEqual(["1:running"]);

    run = await advanceUntil(
      h,
      run.id,
      (current) => latest(current, "after")?.state === "complete",
    );
    expect(states(run, "build")).toEqual(["1:superseded", "2:complete"]);
    expect(latest(run, "after")!.inputs.code).toBe(latest(run, "build")!.outputs.code);
    h.world.fakes.held.delete("slow");
    run = await advanceUntil(h, run.id, (current) => current.status === "complete");
    expect(run.status).toBe("complete");
  });

  test("a routed failure: the error artifact and the recovery branch are superseded too", async () => {
    const h = await harness();
    h.world.fakes.failQueue.set("build", ["timeout"]);
    h.world.fakes.held.add("slow");
    const launched = await launch(h, failingPlan({ onFailure: "route" }));
    let run = await advanceUntil(
      h,
      launched.id,
      (current) => latest(current, "recover")?.state === "complete",
    );
    const failed = latest(run, "build")!;
    const recovered = latest(run, "recover")!;
    const errorId = failed.outputs.error!;
    expect(errorId).toBeDefined();

    run = await h.service.retry(run.id, failed.key);
    const rewind = run.rewinds[0]!;
    expect(rewind.superseded.activations).toContain(recovered.key);
    expect(rewind.superseded.artifacts).toContain(errorId);
    expect(rewind.superseded.artifacts).toContain(recovered.outputs.notes!);
    const stored = await h.world.storage.graphRuns.getGraphArtifact(run.id, errorId);
    expect(stored).toMatchObject({ state: "superseded", supersededBy: rewind.id });

    run = await advanceUntil(
      h,
      run.id,
      (current) => latest(current, "after")?.state === "complete",
    );
    expect(states(run, "recover")).toEqual(["1:superseded", "2:skipped"]);
  });

  test("refuses what is not a live failed position", async () => {
    const h = await harness();
    h.world.fakes.held.add("slow");
    const launched = await launch(h, failingPlan({ onFailure: "skip" }));
    const run = await advanceUntil(
      h,
      launched.id,
      (current) => latest(current, "after")?.state === "complete",
    );
    expect(await refusal(() => h.service.retry(run.id, latest(run, "build")!.key))).toBe(
      "invalid-state",
    );
    expect(await refusal(() => h.service.retry(run.id, "nope#iter=1#attempt=1"))).toBe("not-found");
    expect(await refusal(() => h.service.retry("missing-run", "x"))).toBe("not-found");
  });
});

describe("planGraphRunRetry and planGraphRunSkip (pure)", () => {
  function runWith(
    activations: NodeActivation[],
    status: GraphRun["status"] = "running",
  ): GraphRun {
    const plan = failingPlan({ onFailure: "skip" });
    return {
      format: "orkestrator.graph-run",
      formatVersion: 1,
      id: "run-1",
      projectId: "p1",
      environmentId: "e1",
      template: { id: plan.template.id, revision: 1, digest: plan.templateDigest },
      plan,
      bindings: { roles: bindAllRoles(plan), params: {}, inputs: {} },
      status,
      mock: false,
      activations,
      rewinds: [],
      loopIterations: {},
      usage: { agentSessions: 0, tokens: 0 },
      revision: 1,
      createdAt: "2026-10-29T00:00:00.000Z",
      updatedAt: "2026-10-29T00:00:00.000Z",
    };
  }

  function activation(
    nodeId: string,
    state: NodeActivation["state"],
    attempt = 1,
    createdAt = "2026-10-29T00:00:01.000Z",
    extra: Partial<NodeActivation> = {},
  ): NodeActivation {
    return {
      key: `${nodeId}#iter=1#attempt=${attempt}`,
      nodeId,
      iteration: 1,
      attempt,
      state,
      inputs: {},
      outputs: {},
      createdAt,
      ...extra,
    };
  }

  test("the downstream nodes of the plan", () => {
    const run = runWith([]);
    expect([...graphPlanDownstreamNodes(run, "build")].sort()).toEqual(["after", "recover"]);
    expect([...graphPlanDownstreamNodes(run, "slow")]).toEqual([]);
  });

  test("retry supersedes never-started markers created after the failure only", () => {
    const run = runWith([
      activation("build", "failed", 1, "2026-10-29T00:00:02.000Z", {
        startedAt: "2026-10-29T00:00:02.000Z",
      }),
      // An older marker (before this failure) and one that ran stay.
      activation("recover", "skipped", 1, "2026-10-29T00:00:01.000Z"),
      activation("after", "skipped", 1, "2026-10-29T00:00:03.000Z"),
      activation("slow", "skipped", 1, "2026-10-29T00:00:03.000Z"),
    ]);
    const planned = planGraphRunRetry(run, [], "build#iter=1#attempt=1", {
      rewindId: "rewind-1",
      at: "2026-10-29T00:00:04.000Z",
    });
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.rewind.superseded.activations).toEqual([
      "build#iter=1#attempt=1",
      "after#iter=1#attempt=1",
    ]);
    expect(planned.run.activations.map((entry) => entry.state)).toEqual([
      "superseded",
      "skipped",
      "superseded",
      "skipped",
    ]);
  });

  test("retry refusals", () => {
    const failed = activation("build", "failed");
    expect(
      planGraphRunRetry(runWith([failed], "failed"), [], failed.key, {
        rewindId: "r",
        at: "2026-10-29T00:00:04.000Z",
      }),
    ).toMatchObject({ ok: false, code: "invalid-state" });
    expect(
      planGraphRunRetry(runWith([failed, activation("build", "running", 2)]), [], failed.key, {
        rewindId: "r",
        at: "2026-10-29T00:00:04.000Z",
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid-state",
      message: expect.stringContaining("newer"),
    });
    expect(
      planGraphRunRetry(runWith([activation("build", "complete")]), [], failed.key, {
        rewindId: "r",
        at: "2026-10-29T00:00:04.000Z",
      }),
    ).toMatchObject({ ok: false, code: "invalid-state" });
    expect(
      planGraphRunRetry(runWith([]), [], failed.key, { rewindId: "r", at: "x" }),
    ).toMatchObject({ ok: false, code: "not-found" });
  });

  test("skip settles a ready or waiting position and refuses the rest", () => {
    for (const state of ["ready", "waiting"] as const) {
      const planned = planGraphRunSkip(
        runWith([activation("after", state)], "paused"),
        "after#iter=1#attempt=1",
        "2026-10-29T00:00:04.000Z",
      );
      if (!planned.ok) throw new Error(planned.message);
      expect(planned.run.activations[0]).toMatchObject({
        state: "skipped",
        finishedAt: "2026-10-29T00:00:04.000Z",
      });
    }
    expect(
      planGraphRunSkip(runWith([activation("after", "running")]), "after#iter=1#attempt=1", "x"),
    ).toMatchObject({ ok: false, code: "invalid-state" });
    expect(
      planGraphRunSkip(
        runWith([activation("after", "ready")], "complete"),
        "after#iter=1#attempt=1",
        "x",
      ),
    ).toMatchObject({ ok: false, code: "invalid-state" });
    expect(planGraphRunSkip(runWith([]), "after#iter=1#attempt=1", "x")).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });
});

describe("skip through the service", () => {
  test("a ready position held back by the run's limits is skipped; the run goes on", async () => {
    const h = await harness();
    h.world.fakes.held.add("build");
    const launched = await launch(h, failingPlan({ onFailure: "skip" }, 1));
    let run = await advanceUntil(
      h,
      launched.id,
      (current) => latest(current, "slow") !== undefined,
    );
    expect(latest(run, "build")!.state).toBe("running");
    const slow = latest(run, "slow")!;
    expect(slow.state).toBe("ready");
    expect(await refusal(() => h.service.skip(run.id, latest(run, "build")!.key))).toBe(
      "invalid-state",
    );
    expect(await refusal(() => h.service.skip(run.id, "nope"))).toBe("not-found");

    run = await h.service.skip(run.id, slow.key);
    expect(latest(run, "slow")!.state).toBe("skipped");
    h.world.fakes.held.delete("build");
    run = await advanceUntil(h, run.id, (current) => current.status === "complete");
    expect(states(run, "slow")).toEqual(["1:skipped"]);
    expect(states(run, "after")).toEqual(["1:complete"]);
  });
});
