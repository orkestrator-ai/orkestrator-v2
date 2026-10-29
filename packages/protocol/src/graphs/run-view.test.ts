import { describe, expect, test } from "bun:test";
import { activationFixture, graphRunFixture } from "./run-fixtures.test-support.js";
import {
  compareGraphRunsNewestFirst,
  graphActivationRetryRefusal,
  graphActivationSkipRefusal,
  graphRunActions,
  graphRunSummary,
  graphRunViewSnapshot,
} from "./run-view.js";

const POLICY = {
  id: "pipeline",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "restricted",
} as const;

describe("graphRunSummary", () => {
  test("counts live activations by state and keeps the plan out", () => {
    const run = graphRunFixture({
      activations: [
        activationFixture({ nodeId: "build" }, { state: "complete" }),
        activationFixture({ nodeId: "prepare" }, { state: "failed", error: "boom" }),
        activationFixture({ nodeId: "prepare", attempt: 2 }, { state: "running" }),
        activationFixture({ nodeId: "review" }, { state: "awaiting-human" }),
        activationFixture({ nodeId: "verify" }, { state: "superseded", supersededBy: "r1" }),
      ],
      mock: true,
      error: "stopped",
    });
    const summary = graphRunSummary(run);
    expect(summary).toMatchObject({
      id: "run-1",
      name: "Build Pipeline loop",
      status: "running",
      mock: true,
      error: "stopped",
      activations: { live: 4, running: 1, awaitingHuman: 1, complete: 1, failed: 1 },
    });
    expect("plan" in summary).toBe(false);
    expect("activations" in summary && Array.isArray(summary.activations)).toBe(false);
  });

  test("orders runs newest first, ties by id", () => {
    const runs = [
      { id: "b", createdAt: "2026-10-29T00:00:00.000Z" },
      { id: "a", createdAt: "2026-10-29T00:00:00.000Z" },
      { id: "c", createdAt: "2026-10-29T01:00:00.000Z" },
    ];
    expect(runs.sort(compareGraphRunsNewestFirst).map((run) => run.id)).toEqual(["c", "a", "b"]);
  });
});

describe("graphRunViewSnapshot", () => {
  test("drops the runtime's own prompts and keeps everything the view shows", () => {
    const run = graphRunFixture({
      activations: [
        activationFixture(
          { nodeId: "build" },
          {
            state: "running",
            policy: POLICY,
            enforcement: "enforced",
            session: {
              agent: "claude",
              requestId: "request-1",
              dispatchState: "sent",
              resultTransport: "tool-call-v1",
              repairPrompt: "x".repeat(1000),
              continuationPrompt: "y",
              tokenCount: 12,
            },
          },
        ),
      ],
    });
    const snapshot = graphRunViewSnapshot(run);
    const session = snapshot.activations[0]!.session!;
    expect(session.repairPrompt).toBeUndefined();
    expect(session.continuationPrompt).toBeUndefined();
    expect(session.tokenCount).toBe(12);
    // The record itself is not mutated.
    expect(run.activations[0]!.session!.repairPrompt).toHaveLength(1000);
  });

  test("returns the run itself when there is nothing to drop", () => {
    const run = graphRunFixture();
    expect(graphRunViewSnapshot(run)).toBe(run);
  });
});

describe("user actions", () => {
  test("run-wide actions follow the status", () => {
    expect(graphRunActions({ status: "running" })).toEqual({
      pause: true,
      resume: false,
      cancel: true,
    });
    expect(graphRunActions({ status: "paused" })).toEqual({
      pause: false,
      resume: true,
      cancel: true,
    });
    expect(graphRunActions({ status: "cancelling" }).cancel).toBe(false);
    expect(graphRunActions({ status: "complete" })).toEqual({
      pause: false,
      resume: false,
      cancel: false,
    });
  });

  test("retry takes the newest failed attempt of a live run only", () => {
    const failed = activationFixture({ nodeId: "prepare" }, { state: "failed" });
    const run = graphRunFixture({ activations: [failed] });
    expect(graphActivationRetryRefusal(run, failed)).toBeNull();
    expect(graphActivationRetryRefusal({ ...run, status: "paused" }, failed)).toBeNull();
    expect(graphActivationRetryRefusal({ ...run, status: "failed" }, failed)).toMatch(
      /restart from a node/,
    );
    const newer = activationFixture({ nodeId: "prepare", attempt: 2 }, { state: "running" });
    expect(graphActivationRetryRefusal({ ...run, activations: [failed, newer] }, failed)).toMatch(
      /newer attempt/,
    );
    const complete = activationFixture({ nodeId: "build" }, { state: "complete" });
    expect(graphActivationRetryRefusal(run, complete)).toMatch(/complete activation/);
  });

  test("skip takes a position that was not admitted yet", () => {
    const ready = activationFixture({ nodeId: "prepare" }, { state: "ready" });
    const run = graphRunFixture({ activations: [ready] });
    expect(graphActivationSkipRefusal(run, ready)).toBeNull();
    expect(graphActivationSkipRefusal(run, { ...ready, state: "waiting" })).toBeNull();
    expect(graphActivationSkipRefusal(run, { ...ready, state: "running" })).toMatch(
      /running activation/,
    );
    expect(graphActivationSkipRefusal({ ...run, status: "complete" }, ready)).toMatch(
      /complete run/,
    );
  });
});
