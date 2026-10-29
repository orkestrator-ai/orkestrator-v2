import { describe, expect, test } from "bun:test";
import type { GraphActivationBaseline } from "@orkestrator/protocol/graphs/run";
import { GraphAgentGuardError, GraphAgentGuards } from "./graph-agent-guards.js";
import {
  graphAttributePush,
  graphGuardPeerSource,
  type GraphGuardPeer,
  type GraphGuardPeerSource,
} from "./graph-agent-remote-attribution.js";
import { FakeGraphRepo } from "./graph-agent-test-support.js";
import {
  graphActivationFixture,
  graphEnvironmentFixture,
  graphRunFixture,
} from "./graph-run-test-support.js";
import type { Environment } from "./models.js";

const builder = { id: "build", label: "Build", workspaceAccess: "write" as const };

/**
 * Two environments of one project with one `origin`: separate clones
 * (containers) or, with `sharedRepository`, two worktrees of one repository
 * (local environments), which share remote-tracking refs and tags.
 */
function twoEnvironments(options: { sharedRepository?: boolean } = {}) {
  const a = new FakeGraphRepo();
  const b = options.sharedRepository
    ? new FakeGraphRepo(a.head, { refsOf: a })
    : new FakeGraphRepo(a.head, { remotes: a.remotes });
  const repos = new Map([
    ["e1", a],
    ["e2", b],
  ]);
  const repo = (id: string) => repos.get(id)!;
  const environments = {
    a: graphEnvironmentFixture({ id: "e1", branch: "env-a" }),
    b: graphEnvironmentFixture({ id: "e2", branch: "env-b" }),
  };
  const peers = new Map<string, GraphGuardPeer[]>();
  const guards = (source: GraphGuardPeerSource = async ({ runId }) => peers.get(runId) ?? []) =>
    new GraphAgentGuards({
      probe: (id) => repo(id).probe(),
      git: (id, args) => repo(id).git(id, args),
      lsRemote: (environment: Environment, args) =>
        repo(environment.id).lsRemote(environment, args),
      systemPushes: async () => new Set(),
      peers: source,
    });
  return { a, b, environments, peers, guards };
}

function peer(
  label: string,
  environmentId: string,
  baseline: GraphActivationBaseline,
  finishedAt?: string,
): GraphGuardPeer {
  return {
    label,
    environmentId,
    baseline: { ...baseline, capturedAt: baseline.capturedAt! },
    ...(finishedAt ? { finishedAt } : {}),
  };
}

async function outcome(promise: Promise<unknown>) {
  try {
    const results = (await promise) as Array<{ guard: string; outcome: string; detail?: string }>;
    return { results, error: undefined };
  } catch (error) {
    if (!(error instanceof GraphAgentGuardError)) throw error;
    return { results: error.results, error };
  }
}

/** Both activations make the byte-identical commit; `b` pushes it to a new branch. */
async function identicalCommits(
  world: ReturnType<typeof twoEnvironments>,
  push: { byUrl?: boolean } = {},
) {
  const guards = world.guards();
  const baselineA = await guards.capture(world.environments.a, builder);
  const baselineB = await guards.capture(world.environments.b, builder);
  world.peers.set("run-a", [peer("step build of run run-b", "e2", baselineB)]);
  world.peers.set("run-b", [peer("step build of run run-a", "e1", baselineA)]);
  const commitA = world.a.commit();
  const commitB = world.b.commit();
  // Same parent, tree, identity and second: one commit id.
  expect(commitA).toBe(commitB);
  world.b.push("origin", "refs/heads/qa-builder-probe", commitB, push);
  const certify = (environment: Environment, runId: string, baseline: GraphActivationBaseline) =>
    outcome(
      guards.certify({ environment, node: builder, baseline, runId, activationKey: "build" }),
    );
  return {
    a: await certify(world.environments.a, "run-a", baselineA),
    b: await certify(world.environments.b, "run-b", baselineB),
  };
}

describe("remote-ref attribution of an identical commit", () => {
  test("separate repositories: the pusher is blamed and the other activation passes", async () => {
    const { a, b } = await identicalCommits(twoEnvironments());
    expect(a.error).toBeUndefined();
    expect(a.results).toEqual([
      expect.objectContaining({ guard: "remote-ref", outcome: "passed" }),
    ]);
    expect(a.results[0]?.detail).toContain(
      "is an identical commit that step build of run run-b pushed",
    );
    expect(b.results).toEqual([
      expect.objectContaining({ guard: "remote-ref", outcome: "violated" }),
    ]);
    expect(b.error?.message).toContain("origin refs/heads/qa-builder-probe");
  });

  test("one shared repository: Git cannot tell, so both fail closed and say why", async () => {
    const { a, b } = await identicalCommits(twoEnvironments({ sharedRepository: true }));
    for (const side of [a, b]) {
      expect(side.results).toEqual([
        expect.objectContaining({ guard: "remote-ref", outcome: "unavailable" }),
      ]);
      expect(side.error?.message).toContain("cannot be attributed (ambiguous)");
      expect(side.error?.message).toContain("worktrees of one repository");
    }
    expect(a.error?.message).toContain("step build of run run-b made the identical commit");
  });

  test("a push by URL leaves no evidence anywhere: both fail closed", async () => {
    const { a, b } = await identicalCommits(twoEnvironments(), { byUrl: true });
    for (const side of [a, b]) {
      expect(side.results[0]).toMatchObject({ guard: "remote-ref", outcome: "unavailable" });
      expect(side.error?.message).toContain("no repository recorded the push");
    }
  });

  test("without a peer that made the same commit, the push is the activation's own", async () => {
    const world = twoEnvironments();
    const guards = world.guards();
    const baselineA = await guards.capture(world.environments.a, builder);
    const baselineB = await guards.capture(world.environments.b, builder);
    world.peers.set("run-a", [peer("step build of run run-b", "e2", baselineB)]);
    // `b` committed nothing; `a` pushes its own commit by URL (no local record).
    const mine = world.a.commit();
    world.a.push("origin", "refs/heads/mine", mine, { byUrl: true });
    const a = await outcome(
      guards.certify({
        environment: world.environments.a,
        node: builder,
        baseline: baselineA,
        runId: "run-a",
      }),
    );
    expect(a.results[0]).toMatchObject({ guard: "remote-ref", outcome: "violated" });
  });

  test("a peer source that fails, or a peer that cannot be read, clears nobody", async () => {
    for (const source of [
      async () => {
        throw new Error("storage unavailable");
      },
      async () => [
        peer("step build of run gone", "e-missing", {
          headRef: "b".repeat(40),
          pathsDigest: "",
          capturedAt: new Date().toISOString(),
        }),
      ],
    ] satisfies GraphGuardPeerSource[]) {
      const world = twoEnvironments();
      const guards = world.guards(source);
      const baseline = await guards.capture(world.environments.a, builder);
      const commit = world.a.commit();
      world.b.commit();
      // `b`'s repository records the push, but it is not a (readable) peer.
      world.b.push("origin", "refs/heads/feature", commit);
      const result = await outcome(
        guards.certify({ environment: world.environments.a, node: builder, baseline, runId: "r" }),
      );
      expect(result.results[0]).toMatchObject({ guard: "remote-ref", outcome: "violated" });
    }
  });

  test("a peer in the same checkout is ambiguous, whatever the evidence", () => {
    expect(
      graphAttributePush("none", [
        { label: "step review", evidence: "pushed", sameCheckout: true },
      ]),
    ).toMatchObject({ kind: "ambiguous", reason: expect.stringContaining("same checkout") });
    expect(graphAttributePush("pushed", [{ label: "step b", evidence: "none" }])).toEqual({
      kind: "self",
    });
    expect(graphAttributePush("unknown", [{ label: "step b", evidence: "pushed" }])).toMatchObject({
      kind: "ambiguous",
    });
    expect(graphAttributePush("pushed", [])).toEqual({ kind: "self" });
  });
});

describe("graphGuardPeerSource", () => {
  test("lists other activations whose turns overlap, never itself or mock runs", async () => {
    const captured = "2026-10-29T10:00:00.000Z";
    const baseline = { headRef: "a".repeat(40), pathsDigest: "", capturedAt: captured };
    const runs = [
      graphRunFixture({
        id: "run-a",
        environmentId: "e1",
        activations: [
          graphActivationFixture("build", {}, { state: "running", baseline }),
          // Finished before the query's window opened.
          graphActivationFixture("old", {}, { baseline, finishedAt: "2026-10-29T09:00:00.000Z" }),
          // Terminal with no finish time: too old to tell.
          graphActivationFixture("lost", {}, { state: "failed", baseline }),
          // No baseline: never dispatched.
          graphActivationFixture("waiting", {}, { state: "waiting" }),
        ],
      }),
      graphRunFixture({
        id: "run-b",
        environmentId: "e2",
        activations: [
          graphActivationFixture(
            "build",
            {},
            { state: "failed", baseline, finishedAt: "2026-10-29T10:05:00.000Z" },
          ),
        ],
      }),
      graphRunFixture({
        id: "run-mock",
        mock: true,
        activations: [graphActivationFixture("build", {}, { state: "running", baseline })],
      }),
    ];
    const source = graphGuardPeerSource({
      listRuns: async () => runs,
      now: () => new Date("2026-10-29T10:10:00.000Z"),
    });
    const peers = await source({
      runId: "run-a",
      activationKey: runs[0]!.activations[0]!.key,
      since: "2026-10-29T10:01:00.000Z",
    });
    expect(peers.map((entry) => [entry.label, entry.environmentId, entry.finishedAt])).toEqual([
      ["step build of run run-b", "e2", "2026-10-29T10:05:00.000Z"],
    ]);
  });
});
