import { describe, expect, test } from "bun:test";
import { GRAPH_RUN_BOUNDS } from "@orkestrator/protocol/graphs/run";
import {
  GraphAgentGuardError,
  GraphAgentGuards,
  graphPathsDigest,
  mergeGraphGuardResults,
} from "./graph-agent-guards.js";
import { FakeGraphRepo } from "./graph-agent-test-support.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";

const environment = graphEnvironmentFixture();
const reviewer = { id: "review", workspaceAccess: "read" as const };
const builder = { id: "build", label: "Build", workspaceAccess: "write" as const };

function guardsOver(repo: FakeGraphRepo, systemPushes: string[] = []) {
  return new GraphAgentGuards({
    probe: repo.probe,
    git: repo.git,
    lsRemote: repo.lsRemote,
    systemPushes: async () => new Set(systemPushes),
  });
}

async function failure(promise: Promise<unknown>): Promise<GraphAgentGuardError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraphAgentGuardError) return error;
    throw error;
  }
  throw new Error("expected a guard failure");
}

describe("GraphAgentGuards capture", () => {
  test("records HEAD, the sorted path set, the capture time and the watched run branch", async () => {
    const repo = new FakeGraphRepo();
    repo.dirty = ["b.txt", "a.txt"];
    repo.remotes.set("fork", new Map());
    const baseline = await guardsOver(repo).capture(environment, reviewer);
    expect(baseline.headRef).toBe(repo.head);
    expect(baseline.paths).toEqual(["a.txt", "b.txt"]);
    expect(baseline.pathCount).toBe(2);
    expect(baseline.pathsDigest).toBe(graphPathsDigest(["b.txt", "a.txt"]));
    expect(baseline.capturedAt).toBeDefined();
    // `origin` exists, so only it is watched.
    expect(baseline.upstream).toEqual([
      { remote: "origin", ref: "refs/heads/main", sha: repo.head },
    ]);
  });

  test("a large path set is kept as its digest and count only", async () => {
    const repo = new FakeGraphRepo();
    repo.dirty = Array.from({ length: GRAPH_RUN_BOUNDS.maxBaselinePaths + 1 }, (_, i) => `f${i}`);
    const baseline = await guardsOver(repo).capture(environment, reviewer);
    expect(baseline.paths).toBeUndefined();
    expect(baseline.pathCount).toBe(GRAPH_RUN_BOUNDS.maxBaselinePaths + 1);
  });

  test("writers keep no paths; a repository without remotes watches nothing", async () => {
    const repo = new FakeGraphRepo();
    repo.dirty = ["a.txt"];
    repo.remotes.clear();
    const baseline = await guardsOver(repo).capture(environment, builder);
    expect(baseline.paths).toBeUndefined();
    expect(baseline.upstream).toEqual([]);
  });

  test("without origin, every configured remote is watched", async () => {
    const repo = new FakeGraphRepo();
    repo.remotes.clear();
    repo.remotes.set("upstream", new Map());
    repo.remotes.set("mirror", new Map([["refs/heads/main", repo.head]]));
    const baseline = await guardsOver(repo).capture(environment, reviewer);
    expect(baseline.upstream?.map((entry) => [entry.remote, entry.sha])).toEqual([
      ["upstream", null],
      ["mirror", repo.head],
    ]);
  });

  test("fails closed when the worktree or a remote cannot be observed", async () => {
    const repo = new FakeGraphRepo();
    repo.probeAvailable = false;
    const unobserved = await failure(guardsOver(repo).capture(environment, builder));
    expect(unobserved.message).toContain("Step Build cannot start");
    repo.probeAvailable = true;
    repo.remoteReachable = false;
    const unreachable = await failure(guardsOver(repo).capture(environment, builder));
    expect(unreachable.results[0]).toMatchObject({ guard: "remote-ref", outcome: "unavailable" });
    // Three attempts before giving up.
    expect(repo.lsRemoteCalls).toBe(3);
  });

  test("without an ls-remote dependency nothing is dispatched", async () => {
    const repo = new FakeGraphRepo();
    const guards = new GraphAgentGuards({ probe: repo.probe, git: repo.git });
    const error = await failure(guards.capture(environment, reviewer));
    expect(error.message).toContain("cannot reach this environment's remotes");
  });
});

describe("GraphAgentGuards read-only certification", () => {
  test("a digest-only baseline detects a changed path set and refuses it at submit", async () => {
    const repo = new FakeGraphRepo();
    repo.dirty = Array.from({ length: GRAPH_RUN_BOUNDS.maxBaselinePaths + 1 }, (_, i) => `f${i}`);
    const guards = guardsOver(repo);
    const baseline = await guards.capture(environment, reviewer);
    repo.dirty = [...repo.dirty, "new.txt"];
    const refusal = await guards.refusal({ environmentId: "e1", node: reviewer, baseline });
    expect(refusal).toMatchObject({ code: "worktree_changed", nextAction: "correct" });
    expect(refusal?.message).toContain("66 now");
    const error = await failure(
      guards.certify({ environment, node: reviewer, baseline, runId: "r" }),
    );
    expect(error.message).toContain("changed the set of uncommitted paths");
    expect(error.results[0]?.paths?.length).toBe(GRAPH_RUN_BOUNDS.maxGuardPaths);
  });

  test("a probe that fails after the turn fails the activation (fail closed)", async () => {
    const repo = new FakeGraphRepo();
    const guards = guardsOver(repo);
    const baseline = await guards.capture(environment, reviewer);
    repo.probeAvailable = false;
    // Nothing the model can fix: no refusal at submit time.
    expect(await guards.refusal({ environmentId: "e1", node: reviewer, baseline })).toBeNull();
    const error = await failure(
      guards.certify({ environment, node: reviewer, baseline, runId: "r" }),
    );
    expect(error.results[0]).toMatchObject({ guard: "read-only", outcome: "unavailable" });
  });

  test("writers are never refused at submit; a baseline from before the guards is not certified", async () => {
    const repo = new FakeGraphRepo();
    const guards = guardsOver(repo);
    const baseline = await guards.capture(environment, builder);
    repo.commit();
    expect(await guards.refusal({ environmentId: "e1", node: builder, baseline })).toBeNull();
    const legacy = { headRef: repo.head, pathsDigest: graphPathsDigest([]) };
    const results = await guards.certify({
      environment,
      node: reviewer,
      baseline: legacy,
      runId: "r",
    });
    expect(results.map((result) => [result.guard, result.outcome])).toEqual([
      ["read-only", "unavailable"],
      ["remote-ref", "unavailable"],
    ]);
  });
});

describe("GraphAgentGuards remote refs", () => {
  test("a push of the run's own system node is not blamed on the agent", async () => {
    const repo = new FakeGraphRepo();
    const baseline = await guardsOver(repo).capture(environment, builder);
    const commit = repo.commit();
    repo.push("origin", "refs/heads/main", commit);
    const results = await guardsOver(repo, [commit]).certify({
      environment,
      node: builder,
      baseline,
      runId: "r",
    });
    expect(results).toEqual([expect.objectContaining({ guard: "remote-ref", outcome: "passed" })]);
  });

  test("moving onto commits that existed before the turn publishes nothing of the step's", async () => {
    const repo = new FakeGraphRepo();
    // An older commit, made well before the step started, already on a branch.
    const old = repo.commit();
    repo.commits.get(old)!.time -= 3_600;
    repo.reflog.length = 0;
    repo.reset(repo.commits.get(old)!.parent);
    repo.push("origin", "refs/heads/feature", old);
    const baseline = await guardsOver(repo).capture(environment, builder);
    // A fast-forward onto it during the turn.
    repo.reset(old);
    const results = await guardsOver(repo).certify({
      environment,
      node: builder,
      baseline,
      runId: "r",
    });
    expect(results[0]?.outcome).toBe("passed");
  });

  test("a commit pushed and then abandoned is still found through the HEAD reflog", async () => {
    const repo = new FakeGraphRepo();
    const baseline = await guardsOver(repo).capture(environment, reviewer);
    const start = repo.head;
    const commit = repo.commit();
    repo.push("origin", "refs/tags/v9", commit);
    repo.reset(start);
    const error = await failure(
      guardsOver(repo).certify({ environment, node: reviewer, baseline, runId: "r" }),
    );
    expect(error.results.map((result) => [result.guard, result.outcome])).toEqual([
      ["read-only", "passed"],
      ["remote-ref", "violated"],
    ]);
    expect(error.message).toContain("origin refs/tags/v9");
  });

  test("a remote that cannot be listed after the turn fails the activation", async () => {
    const repo = new FakeGraphRepo();
    const baseline = await guardsOver(repo).capture(environment, builder);
    repo.remoteReachable = false;
    const error = await failure(
      guardsOver(repo).certify({ environment, node: builder, baseline, runId: "r" }),
    );
    expect(error.results[0]).toMatchObject({ guard: "remote-ref", outcome: "unavailable" });
    expect(error.message).toContain("could not verify the upstream refs");
  });
});

describe("mergeGraphGuardResults", () => {
  test("keeps the newest result per guard", () => {
    const at = "2026-10-29T00:00:00.000Z";
    const merged = mergeGraphGuardResults(
      [
        { guard: "enforcement", outcome: "passed", at },
        { guard: "read-only", outcome: "unavailable", at },
      ],
      [{ guard: "read-only", outcome: "passed", at }],
    );
    expect(merged.map((result) => [result.guard, result.outcome])).toEqual([
      ["enforcement", "passed"],
      ["read-only", "passed"],
    ]);
  });
});
