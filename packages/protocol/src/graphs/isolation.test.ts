/**
 * Isolated branch worktrees (item 403): names, the select rule, the
 * compiler's workspace rules for isolated writers, the run record's
 * worktree field, the code-rewind refusal and the prompt frame.
 */
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.js";
import { agentOf, baseTemplate } from "./compile-fixtures.test-support.js";
import {
  GRAPH_ISOLATION_BOUNDS,
  graphBranchNodeSegment,
  graphBranchWorktreePath,
  graphBranchWorktreeRef,
  graphMainWorkspaceAccess,
  graphNodeIsolated,
  graphRunBranchRefPrefix,
  parseGraphBranchWorktreePath,
  resolveGraphSelectChoice,
  type GraphSelectCandidate,
} from "./isolation.js";
import { graphCompetingImplementationsTemplate } from "./isolation-template.js";
import { graphRunCodeRewindBlocker } from "./run-rewind.js";
import { validateGraphRun } from "./run-guards.js";
import {
  activationFixture,
  COMMIT_A,
  graphRunFixture,
  POLICY_FIXTURE,
} from "./run-fixtures.test-support.js";
import { graphSystemContract } from "./system-contract.js";
import { validateGraphTemplate, type GraphTemplateV1 } from "./template.js";
import { resolverOf } from "./subgraph-fixtures.test-support.js";
import { compileGraphCapabilities } from "./capability-profiles.js";
import { graphNodeGrantedActions } from "./system-contract.js";
import { GraphTypeLibrary } from "./types.js";

const RUN = "8c1d1f5e-1111-4222-8333-944455556666";

describe("names", () => {
  test("worktree path and branch share one leaf per run, node, iteration and branch", () => {
    const position = { nodeId: "implement", iteration: 2, branchKey: "panel.1+lens.tests" };
    expect(graphBranchWorktreePath(RUN, position)).toBe(
      `.orkestrator/graph-branches/${RUN}/implement/i2/panel.1+lens.tests`,
    );
    expect(graphBranchWorktreeRef(RUN, position)).toBe(
      `orkestrator-graph/${RUN}/implement/i2/panel.1+lens.tests`,
    );
    expect(graphRunBranchRefPrefix(RUN)).toBe(`orkestrator-graph/${RUN}/`);
  });

  test("a colon in a branch key (not allowed in refs) becomes an underscore", () => {
    expect(graphBranchWorktreeRef(RUN, { nodeId: "a", iteration: 1, branchKey: "item:3" })).toBe(
      `orkestrator-graph/${RUN}/a/i1/item_3`,
    );
  });

  test("an inlined sub-graph's node id (item 402) stays one segment: '/' becomes '--'", () => {
    const position = { nodeId: "bake/implement", iteration: 1, branchKey: "sample.1" };
    const path = graphBranchWorktreePath(RUN, position);
    expect(path).toBe(`.orkestrator/graph-branches/${RUN}/bake--implement/i1/sample.1`);
    expect(graphBranchWorktreeRef(RUN, position)).toBe(
      `orkestrator-graph/${RUN}/bake--implement/i1/sample.1`,
    );
    expect(graphBranchNodeSegment("outer/inner/fix")).toBe("outer--inner--fix");
    // Distinct ids never collide: a graph id holds no "--".
    expect(graphBranchNodeSegment("a/b-c")).not.toBe(graphBranchNodeSegment("a-b/c"));
    expect(parseGraphBranchWorktreePath(path)).toEqual({ runId: RUN });
    expect(parseGraphBranchWorktreePath(path.replace("bake--implement", "bake---x"))).toBeNull();
    expect(() => graphBranchNodeSegment("a//b")).toThrow();
  });

  test("names refuse ids outside their grammar", () => {
    expect(() =>
      graphBranchWorktreePath("../x", { nodeId: "a", iteration: 1, branchKey: "b" }),
    ).toThrow();
    expect(() =>
      graphBranchWorktreePath(RUN, { nodeId: "A/B", iteration: 1, branchKey: "b" }),
    ).toThrow();
    expect(() =>
      graphBranchWorktreePath(RUN, { nodeId: "a", iteration: 0, branchKey: "b" }),
    ).toThrow();
    expect(() =>
      graphBranchWorktreePath(RUN, { nodeId: "a", iteration: 1, branchKey: "#" }),
    ).toThrow();
  });

  test("only our own paths parse back", () => {
    const path = graphBranchWorktreePath(RUN, { nodeId: "a", iteration: 1, branchKey: "sample.2" });
    expect(parseGraphBranchWorktreePath(path)).toEqual({ runId: RUN });
    expect(parseGraphBranchWorktreePath(`${path}/../../x`)).toBeNull();
    expect(parseGraphBranchWorktreePath(".orkestrator/graph-artifacts/x/y/i1/z")).toBeNull();
    expect(parseGraphBranchWorktreePath(`/abs/${path}`)).toBeNull();
  });

  test("an isolated writer reads the run's own workspace", () => {
    const isolated = { kind: "agent", workspaceAccess: "write", isolation: "worktree" } as const;
    expect(graphNodeIsolated(isolated)).toBe(true);
    expect(graphMainWorkspaceAccess(isolated)).toBe("read");
    expect(graphMainWorkspaceAccess({ kind: "agent", workspaceAccess: "write" })).toBe("write");
    expect(graphNodeIsolated({ kind: "system" })).toBe(false);
  });
});

describe("resolveGraphSelectChoice", () => {
  const candidates: GraphSelectCandidate[] = [
    {
      branchKey: "sample.1",
      branch: "orkestrator-graph/r/x/i1/sample.1",
      headRef: "1",
      usable: true,
    },
    {
      branchKey: "sample.2",
      branch: "orkestrator-graph/r/x/i1/sample.2",
      headRef: "2",
      usable: false,
    },
    {
      branchKey: "sample.3",
      branch: "orkestrator-graph/r/x/i1/sample.3",
      headRef: "3",
      usable: true,
    },
  ];

  test("matches the branch key, its last part, or the Git branch", () => {
    expect(resolveGraphSelectChoice(candidates, "sample.3")).toEqual({
      ok: true,
      index: 2,
      matched: "choice",
    });
    expect(resolveGraphSelectChoice(candidates, "1")).toMatchObject({ ok: true, index: 0 });
    expect(resolveGraphSelectChoice(candidates, "orkestrator-graph/r/x/i1/sample.3")).toMatchObject(
      { ok: true, index: 2 },
    );
  });

  test("a choice naming a failed branch, nothing, or several fails unless the fallback applies", () => {
    expect(resolveGraphSelectChoice(candidates, "sample.2")).toMatchObject({ ok: false });
    expect(resolveGraphSelectChoice(candidates, "sample.9")).toMatchObject({ ok: false });
    expect(resolveGraphSelectChoice(candidates, undefined)).toMatchObject({ ok: false });
    expect(resolveGraphSelectChoice(candidates, "sample.2", "first")).toEqual({
      ok: true,
      index: 0,
      matched: "fallback",
    });
    const ambiguous: GraphSelectCandidate[] = [
      { branchKey: "panel.1+lens.api", branch: "a", headRef: "1", usable: true },
      { branchKey: "panel.2+lens.api", branch: "b", headRef: "2", usable: true },
    ];
    expect(resolveGraphSelectChoice(ambiguous, "api")).toMatchObject({ ok: false });
    expect(
      resolveGraphSelectChoice(
        candidates.map((candidate) => ({ ...candidate, usable: false })),
        "x",
        "first",
      ),
    ).toEqual({ ok: false, message: "No candidate branch succeeded" });
  });
});

describe("the compiler", () => {
  test("competing implementations compiles clean, and the plan says isolated", () => {
    const result = compile(graphCompetingImplementationsTemplate());
    expect(result.diagnostics).toEqual([]);
    const implement = result.plan!.nodes.find((node) => node.id === "implement")!;
    expect(implement).toMatchObject({
      kind: "agent",
      workspaceAccess: "write",
      isolation: "worktree",
    });
    // Unisolated nodes carry no field, so earlier plans keep their digests.
    expect("isolation" in result.plan!.nodes.find((node) => node.id === "judge")!).toBe(false);
    expect(result.plan!.nodes.find((node) => node.id === "select")!.workspaceAccess).toBe("write");
  });

  test("an isolated node inlined from a sub-graph (item 402) keeps its isolation", () => {
    const child = graphCompetingImplementationsTemplate();
    child.revision = 1;
    const parent: GraphTemplateV1 = {
      ...graphCompetingImplementationsTemplate(),
      id: "parent",
      roles: [{ key: "worker", multiplicity: "one" }],
      outputs: [{ name: "code", type: "workspace@1", from: { node: "bake", port: "code" } }],
      nodes: [
        {
          id: "bake",
          kind: "subgraph",
          template: { scope: "user", id: "competing-implementations", revision: 1 },
          roles: { builder: "worker", judge: "worker" },
          inputs: [
            { name: "ticket", type: "ticket@1" },
            { name: "target", type: "workspace@1" },
          ],
          outputs: [{ name: "code", type: "workspace@1" }],
        },
      ],
      edges: [
        { id: "ticket", from: { input: "ticket" }, to: { node: "bake", port: "ticket" } },
        { id: "target", from: { input: "target" }, to: { node: "bake", port: "target" } },
      ],
    };
    const result = compile(parent, { resolveTemplate: resolverOf(child) });
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(result.plan!.nodes.find((node) => node.id === "bake/implement")).toMatchObject({
      isolation: "worktree",
    });
    expect(
      graphBranchWorktreePath("r1", {
        nodeId: "bake/implement",
        iteration: 1,
        branchKey: "sample.3",
      }),
    ).toBe(".orkestrator/graph-branches/r1/bake--implement/i1/sample.3");
  });

  test("without isolation the same template has a replicated writer (D3)", () => {
    const template = graphCompetingImplementationsTemplate();
    delete agentOf(template, "implement").isolation;
    expect(compile(template).diagnostics.map((entry) => entry.code)).toContain("replicated-writer");
  });

  test("isolated branches may run beside each other and readers, never beside a writer", () => {
    const template = baseTemplate();
    const build = agentOf(template, "build");
    build.replicate = { over: "samples", count: 2 };
    build.isolation = "worktree";
    // Review reads the run input, not Build's commit: the two can overlap.
    template.edges = template.edges.filter((edge) => edge.id !== "build-review");
    template.edges.push({
      id: "target-review",
      from: { input: "target" },
      to: { node: "review", port: "code" },
    });
    template.outputs = template.outputs!.filter((output) => output.name === "report");
    const reading = compile(template).diagnostics.map((entry) => entry.code);
    expect(reading).not.toContain("workspace-read-write-race");
    expect(reading).not.toContain("replicated-writer");

    agentOf(template, "review").workspaceAccess = "write";
    agentOf(template, "review").capabilities = { profile: "builder" };
    expect(compile(template).diagnostics).toContainEqual(
      expect.objectContaining({ code: "workspace-read-write-race", nodeId: "build" }),
    );
  });

  test("the branch bound is the isolation bound", () => {
    const template = graphCompetingImplementationsTemplate();
    agentOf(template, "implement").replicate = {
      over: "samples",
      count: GRAPH_ISOLATION_BOUNDS.maxBranches,
    };
    expect(compile(template).diagnostics.map((entry) => entry.code)).not.toContain(
      "isolation-branch-limit",
    );
  });

  test("the schema accepts only worktree isolation", () => {
    const template = graphCompetingImplementationsTemplate() as unknown as {
      nodes: Array<Record<string, unknown>>;
    };
    template.nodes[0]!.isolation = "shared";
    expect(validateGraphTemplate(template).ok).toBe(false);
  });
});

describe("the run record", () => {
  const plan = compile(graphCompetingImplementationsTemplate()).plan!;
  const position = { nodeId: "implement", iteration: 1, branchKey: "sample.1" };
  const worktree = {
    path: graphBranchWorktreePath(RUN, position),
    branch: graphBranchWorktreeRef(RUN, position),
    baseRef: COMMIT_A,
    createdAt: "2026-10-29T00:00:00.000Z",
  };
  const run = (activationWorktree: unknown) =>
    graphRunFixture({
      id: RUN,
      plan,
      template: { id: plan.template.id, revision: 0, digest: plan.templateDigest },
      loopIterations: {},
      bindings: { roles: {}, params: {}, inputs: {} },
      activations: [
        activationFixture(position, {
          state: "running",
          worktree: activationWorktree as never,
        }),
      ],
    });

  test("an activation keeps its worktree", () => {
    expect(validateGraphRun(run(worktree)).ok).toBe(true);
  });

  test("a worktree of another run or outside our directory is refused", () => {
    const other = graphBranchWorktreePath("other-run", position);
    expect(validateGraphRun(run({ ...worktree, path: other })).ok).toBe(false);
    expect(validateGraphRun(run({ ...worktree, path: "../../etc" })).ok).toBe(false);
    expect(validateGraphRun(run({ ...worktree, branch: "main" })).ok).toBe(false);
    expect(validateGraphRun(run({ ...worktree, baseRef: "HEAD" })).ok).toBe(false);
  });

  test("a code rewind of an isolated branch is refused; a restart is the way back", () => {
    const paused = { ...run(worktree), status: "paused" as const };
    paused.activations = [{ ...paused.activations[0]!, state: "complete" }];
    expect(graphRunCodeRewindBlocker(paused, paused.activations[0]!.key)).toContain("Restart it");
  });
});

test("the prompt names the branch's worktree in a locked frame", () => {
  const node = agentOf(graphCompetingImplementationsTemplate(), "implement");
  const compiled = compileGraphCapabilities({
    spec: node.capabilities,
    environment: POLICY_FIXTURE,
  });
  const actions = graphNodeGrantedActions(node, new GraphTypeLibrary(), compiled);
  const directory = "/workspace/.orkestrator/graph-branches/r/implement/i1/sample.1";
  const contract = graphSystemContract({
    compiled,
    actions,
    slots: [],
    worktree: {
      directory,
      branch: "orkestrator-graph/r/implement/i1/sample.1",
      baseRef: COMMIT_A,
      root: "/workspace",
    },
  });
  expect(contract).toContain("## Your isolated worktree");
  expect(contract).toContain(`Change directory to \`${directory}\``);
  expect(contract).toContain("never push");
  expect(graphSystemContract({ compiled, actions, slots: [] })).not.toContain("isolated worktree");
});
