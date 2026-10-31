/**
 * Isolated branch worktrees (item 403) at unit level: the container path
 * through the environment command runner's Docker seam, the worktree list
 * parser, the janitor's rules and memory, environment deletion, the
 * worktree guard, and the scheduler's per-worktree locks.
 */
import { describe, expect, test } from "bun:test";
import { compile, type CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import { graphCompetingImplementationsTemplate } from "@orkestrator/protocol/graphs/isolation-template";
import {
  GRAPH_ISOLATION_BOUNDS,
  graphActivationKey,
  graphBranchWorktreePath,
  graphBranchWorktreeRef,
  type GraphActivationState,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import { CONTAINER_PINNED_ATTACHMENT_REMOVE } from "./commands-files.js";
import { createEnvironmentCommandRunner } from "./commands-review.js";
import { FakeGraphRepo } from "./graph-agent-test-support.js";
import { GraphAgentGuardError, GraphAgentGuards } from "./graph-agent-guards.js";
import { FakeBranchRepo } from "./graph-branch-test-support.js";
import {
  GraphBranchWorktreeJanitor,
  GraphBranchWorktrees,
  graphBranchAbsolutePath,
  graphBranchWorktreesToRemove,
  parseGraphBranchWorktreeList,
  removeEnvironmentGraphBranchWorktrees,
} from "./graph-branch-worktrees.js";
import { graphRunWorkspaceHold, selectGraphAdmissions } from "./graph-run-scheduling.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import type { Environment } from "./models.js";
import { CommandFailedError } from "./shell.js";

const RUN = "run-403";
const BASE = "b".repeat(40);
const fence = { beginMutation: () => () => undefined };

function plan(): CompiledGraphPlan {
  const result = compile(graphCompetingImplementationsTemplate());
  if (!result.plan) throw new Error("the competing implementations template must compile");
  return result.plan;
}

function activation(
  branchKey: string | undefined,
  state: GraphActivationState,
  options: { nodeId?: string; attempt?: number; worktree?: boolean } = {},
): NodeActivation {
  const nodeId = options.nodeId ?? "implement";
  const attempt = options.attempt ?? 1;
  const position = { nodeId, iteration: 1, ...(branchKey ? { branchKey } : {}) };
  return {
    key: graphActivationKey({ ...position, attempt }),
    ...position,
    attempt,
    state,
    inputs: {},
    outputs: {},
    createdAt: "2026-10-29T00:00:00.000Z",
    ...(options.worktree !== false && branchKey
      ? {
          worktree: {
            path: graphBranchWorktreePath(RUN, { nodeId, iteration: 1, branchKey }),
            branch: graphBranchWorktreeRef(RUN, { nodeId, iteration: 1, branchKey }),
            baseRef: BASE,
            createdAt: "2026-10-29T00:00:00.000Z",
          },
        }
      : {}),
  };
}

function run(activations: NodeActivation[], overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id: RUN,
    environmentId: "e1",
    mock: false,
    status: "running",
    plan: plan(),
    usage: { agentSessions: 0, tokens: 0 },
    activations,
    ...overrides,
  } as unknown as GraphRun;
}

describe("the container path", () => {
  /**
   * The real environment command runner with its process seam replaced: a
   * container's Git runs as `docker exec -w /workspace <container> git …`,
   * so the same relative paths serve local and container environments.
   */
  function containerWorld() {
    const environment = graphEnvironmentFixture({
      environmentType: "containerized",
      containerId: "container-1",
    }) as Environment;
    const commands: string[][] = [];
    let listing = "worktree /workspace\nHEAD " + BASE + "\nbranch refs/heads/main\n";
    let refs = "";
    const execute = (async (command: string, args: string[]) => {
      commands.push([command, ...args]);
      expect([command, ...args.slice(0, 4)]).toEqual([
        "docker",
        "exec",
        "-w",
        "/workspace",
        "container-1",
      ]);
      const inner = args.slice(4);
      if (inner[0] === "git" && inner[1] === "worktree" && inner[2] === "list") {
        return { stdout: listing, stderr: "" };
      }
      if (inner[0] === "git" && inner[1] === "for-each-ref") return { stdout: refs, stderr: "" };
      return { stdout: "", stderr: "" };
    }) as never;
    const worktrees = new GraphBranchWorktrees({
      storage: { getEnvironment: async () => environment },
      fence,
      createRunner: (env, held) => createEnvironmentCommandRunner(env, held, undefined, execute),
      now: () => new Date("2026-10-29T12:00:00.000Z"),
    });
    return {
      environment,
      commands,
      worktrees,
      setListing: (value: string) => (listing = value),
      setRefs: (value: string) => (refs = value),
    };
  }

  test("creates the branch's worktree inside /workspace with Git in the container", async () => {
    const world = containerWorld();
    const position = { nodeId: "implement", iteration: 1, branchKey: "sample.2" };
    const created = await world.worktrees.create(world.environment, { id: RUN }, position, BASE);
    const path = graphBranchWorktreePath(RUN, position);
    const branch = graphBranchWorktreeRef(RUN, position);
    expect(created).toEqual({
      path,
      branch,
      baseRef: BASE,
      createdAt: "2026-10-29T12:00:00.000Z",
    });
    const inner = world.commands.map((command) => command.slice(5));
    // `.orkestrator/` is Git-excluded inside the container first.
    expect(inner[0]![0]).toBe("bash");
    expect(inner).toContainEqual(["git", "check-ignore", "--quiet", "--no-index", "--", path]);
    expect(inner).toContainEqual(["git", "cat-file", "-e", `${BASE}^{commit}`]);
    expect(inner.at(-1)).toEqual(["git", "worktree", "add", "--quiet", "-B", branch, path, BASE]);
    expect(graphBranchAbsolutePath(world.environment, path)).toBe(`/workspace/${path}`);
  });

  test("a leftover of an earlier attempt is removed before the new worktree", async () => {
    const world = containerWorld();
    const position = { nodeId: "implement", iteration: 1, branchKey: "sample.2" };
    const path = graphBranchWorktreePath(RUN, position);
    world.setListing(`worktree /workspace\n\nworktree /workspace/${path}\nbranch refs/heads/x\n`);
    await world.worktrees.create(world.environment, { id: RUN }, position, BASE);
    const inner = world.commands.map((command) => command.slice(5));
    const removeAt = inner.findIndex((args) => args.join(" ").startsWith("git worktree remove"));
    const addAt = inner.findIndex((args) => args.join(" ").startsWith("git worktree add"));
    expect(inner[removeAt]).toEqual(["git", "worktree", "remove", "--force", "--force", path]);
    expect(removeAt).toBeLessThan(addAt);
  });

  test("removing a run removes its worktrees, its directory (pinned remover) and its branches", async () => {
    const world = containerWorld();
    const position = { nodeId: "implement", iteration: 1, branchKey: "sample.1" };
    const path = graphBranchWorktreePath(RUN, position);
    const branch = graphBranchWorktreeRef(RUN, position);
    world.setListing(
      `worktree /workspace\n\nworktree /workspace/${path}\nbranch refs/heads/${branch}\n`,
    );
    world.setRefs(`${branch}\n`);
    expect(await world.worktrees.removeRun(world.environment, RUN)).toBe(0);
    const inner = world.commands.map((command) => command.slice(5));
    expect(inner).toContainEqual(["git", "worktree", "remove", "--force", "--force", path]);
    expect(inner).toContainEqual([
      "node",
      "-e",
      CONTAINER_PINNED_ATTACHMENT_REMOVE,
      "/workspace",
      `.orkestrator/graph-branches/${RUN}`,
    ]);
    expect(inner).toContainEqual([
      "git",
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/orkestrator-graph/${RUN}/`,
    ]);
    expect(inner).toContainEqual(["git", "branch", "-D", "--quiet", branch]);
    expect(inner.at(-1)).toEqual(["git", "worktree", "prune"]);
  });

  test("environment deletion removes only runs that had isolated branches, and skips a stopped container", async () => {
    const world = containerWorld();
    const isolated = run([]);
    const plain = { ...run([]), id: "plain", plan: compile(plainTemplate()).plan! } as GraphRun;
    const runs = new Map([
      [isolated.id, isolated],
      [plain.id, plain],
    ]);
    const storage = {
      graphRuns: {
        listGraphRunIds: async () => [...runs.keys()],
        getGraphRun: async (id: string) => runs.get(id) ?? null,
      },
    };
    const createRunner = (env: Environment) =>
      createEnvironmentCommandRunner(env, fence, undefined, (async (
        command: string,
        args: string[],
      ) => {
        world.commands.push([command, ...args]);
        return { stdout: "", stderr: "" };
      }) as never);
    expect(
      await removeEnvironmentGraphBranchWorktrees(
        { ...world.environment, status: "running" },
        { storage, fence, createRunner },
      ),
    ).toEqual({ removed: 1, failed: 0 });
    expect(world.commands.some((command) => command.join(" ").includes("/plain"))).toBe(false);
    world.commands.length = 0;
    expect(
      await removeEnvironmentGraphBranchWorktrees(
        { ...world.environment, status: "stopped" },
        { storage, fence, createRunner },
      ),
    ).toEqual({ removed: 0, failed: 0 });
    expect(world.commands).toEqual([]);
  });
});

function plainTemplate() {
  const template = graphCompetingImplementationsTemplate();
  const implement = template.nodes[0]!;
  if (implement.kind === "agent") {
    delete implement.isolation;
    delete implement.replicate;
  }
  template.nodes = template.nodes.filter((node) => node.id !== "select");
  template.edges = template.edges.filter((edge) => !edge.id.endsWith("-select"));
  template.outputs = [];
  const judge = template.nodes[1]!;
  if (judge.kind === "agent") {
    judge.inputs = judge.inputs!.map((port) =>
      port.type.startsWith("list<") ? { ...port, type: port.type.slice(5, -1) } : port,
    );
  }
  return template;
}

describe("parseGraphBranchWorktreeList", () => {
  test("keeps our worktrees, relative to the root, with their branches", () => {
    const listed = parseGraphBranchWorktreeList(
      [
        "worktree /private/var/env",
        "HEAD " + BASE,
        "branch refs/heads/main",
        "",
        `worktree /var/env/.orkestrator/graph-branches/${RUN}/implement/i1/sample.1`,
        "HEAD " + BASE,
        `branch refs/heads/orkestrator-graph/${RUN}/implement/i1/sample.1`,
        "",
        "worktree /elsewhere/.claude/worktrees/x",
        "",
        `worktree /var/env/.orkestrator/graph-branches/${RUN}/../../etc`,
        "detached",
      ].join("\n"),
    );
    expect(listed).toEqual([
      {
        path: `.orkestrator/graph-branches/${RUN}/implement/i1/sample.1`,
        branch: `orkestrator-graph/${RUN}/implement/i1/sample.1`,
      },
    ]);
  });
});

describe("the janitor", () => {
  test("a directory goes when its activation is terminal, unless a newer live attempt owns it", () => {
    const record = run([
      activation("sample.1", "complete"),
      activation("sample.2", "running"),
      activation("sample.3", "superseded"),
      activation("sample.3", "admitting", { attempt: 2 }),
      activation("sample.4", "failed"),
      activation("sample.4", "ready", { attempt: 2, worktree: false }),
    ]);
    expect(graphBranchWorktreesToRemove(record).map((worktree) => worktree.path)).toEqual([
      graphBranchWorktreePath(RUN, { nodeId: "implement", iteration: 1, branchKey: "sample.1" }),
      graphBranchWorktreePath(RUN, { nodeId: "implement", iteration: 1, branchKey: "sample.4" }),
    ]);
  });

  test("removes each directory once, then the whole run once it ends; mock runs never", async () => {
    const repo = new FakeBranchRepo(new FakeGraphRepo(BASE));
    const worktrees = repo.service();
    const environment = graphEnvironmentFixture({ worktreePath: "/root" }) as Environment;
    for (const key of ["sample.1", "sample.2"]) {
      await worktrees.create(
        environment,
        { id: RUN },
        { nodeId: "implement", iteration: 1, branchKey: key },
        BASE,
      );
    }
    const janitor = new GraphBranchWorktreeJanitor({
      worktrees,
      storage: { getEnvironment: async () => environment },
    });
    const running = run([activation("sample.1", "complete"), activation("sample.2", "running")]);
    expect(janitor.wants(run(running.activations, { mock: true }))).toBe(false);
    expect(janitor.wants(running)).toBe(true);
    await janitor.reconcile(running);
    expect([...repo.worktrees.keys()]).toEqual([
      graphBranchWorktreePath(RUN, { nodeId: "implement", iteration: 1, branchKey: "sample.2" }),
    ]);
    // Nothing new: no Git at all.
    const calls = repo.calls.length;
    expect(janitor.wants(running)).toBe(false);
    await janitor.reconcile(running);
    expect(repo.calls.length).toBe(calls);
    // The run ends: worktrees and branches go, once.
    const ended = run(running.activations, { status: "complete" });
    await janitor.reconcile(ended);
    expect(repo.worktrees.size).toBe(0);
    expect([...repo.branches.keys()]).toEqual([]);
    expect(janitor.wants(ended)).toBe(false);
    // A restart reopens it: the next end cleans up again.
    expect(janitor.wants(running)).toBe(true);
    expect(janitor.wants(ended)).toBe(true);
  });
});

describe("namespaced node ids (item 402)", () => {
  test("an isolated node inlined from a sub-graph gets one worktree directory and a valid branch", async () => {
    const repo = new FakeBranchRepo(new FakeGraphRepo(BASE));
    const environment = graphEnvironmentFixture({ worktreePath: "/root" }) as Environment;
    const created = await repo
      .service()
      .create(
        environment,
        { id: RUN },
        { nodeId: "bake/implement", iteration: 1, branchKey: "sample.1" },
        BASE,
      );
    expect(created.path).toBe(`.orkestrator/graph-branches/${RUN}/bake--implement/i1/sample.1`);
    expect(created.branch).toBe(`orkestrator-graph/${RUN}/bake--implement/i1/sample.1`);
    expect(await repo.service().list(environment)).toEqual([
      { path: created.path, branch: created.branch },
    ]);
    expect(await repo.service().removeRun(environment, RUN)).toBe(0);
    expect(repo.worktrees.size).toBe(0);
  });
});

describe("the worktree guard", () => {
  async function guarded(
    change: (repo: FakeBranchRepo, path: string) => void,
    runGit = (repo: FakeBranchRepo, id: string, args: string[]) => repo.git(id, args),
  ) {
    const main = new FakeGraphRepo(BASE);
    const repo = new FakeBranchRepo(main);
    const environment = graphEnvironmentFixture({ worktreePath: "/root" }) as Environment;
    const worktree = await repo
      .service()
      .create(
        environment,
        { id: RUN },
        { nodeId: "implement", iteration: 1, branchKey: "sample.1" },
        BASE,
      );
    const guards = new GraphAgentGuards({
      probe: main.probe,
      git: (id, args) => runGit(repo, id, args),
      lsRemote: main.lsRemote,
    });
    const node = plan().nodes.find((entry) => entry.id === "implement")!;
    if (node.kind !== "agent") throw new Error("implement is an agent");
    const baseline = await guards.capture(environment, node);
    expect(baseline.paths).toEqual([]);
    repo.commitIn(worktree.path);
    change(repo, worktree.path);
    const attempt = { environmentId: environment.id, node, baseline, worktree };
    const refusal = await guards.refusal(attempt);
    const certified = await guards
      .certify({ environment, node, baseline, runId: RUN, worktree })
      .then((results) => ({ ok: true as const, results, message: "" }))
      .catch((error: GraphAgentGuardError) => ({
        ok: false as const,
        results: error.results,
        message: error.message,
      }));
    return { refusal, certified, repo, worktree };
  }

  test.each(["clean", "dirty", "failed"] as const)(
    "a timed-out isolated status retries in the same worktree and certifies %s",
    async (outcome) => {
      const statusCalls: string[][] = [];
      const { refusal, certified, repo, worktree } = await guarded(
        () => undefined,
        async (repo, id, args) => {
          if (!args.includes("status")) return repo.git(id, args);
          statusCalls.push(args);
          if (args[2] === "status") throw new CommandFailedError("timeout", { timedOut: true });
          if (outcome === "failed")
            throw new CommandFailedError("retry failed", { timedOut: true });
          return outcome === "dirty" ? "?? notes.txt\n" : "";
        },
      );
      const initial = ["-C", worktree.path, "status", "--porcelain", "--untracked-files=all"];
      const fallback = ["-C", worktree.path, "-c", "core.fsmonitor=false", ...initial.slice(2)];
      // Both submit-time refusal and consumption-time certification read the worktree.
      expect(statusCalls).toEqual([initial, fallback, initial, fallback]);
      expect(repo.worktrees.has(worktree.path)).toBe(true);
      if (outcome === "dirty") {
        expect(refusal).toMatchObject({ code: "worktree_changed", nextAction: "correct" });
        expect(refusal?.message).toContain(worktree.path);
        expect(refusal?.message).toContain("notes.txt");
      } else {
        expect(refusal).toBeNull();
      }
      expect(certified.ok).toBe(outcome === "clean");
      expect(certified.results).toContainEqual(
        expect.objectContaining({
          guard: "worktree",
          outcome:
            outcome === "clean" ? "passed" : outcome === "dirty" ? "violated" : "unavailable",
          ...(outcome === "dirty" ? { paths: ["notes.txt"] } : {}),
        }),
      );
      if (outcome === "failed") {
        expect(certified.message).toContain(worktree.path);
        expect(certified.message).toContain("retry failed");
      }
    },
  );

  test("a committed branch passes every guard", async () => {
    const { refusal, certified } = await guarded(() => undefined);
    expect(refusal).toBeNull();
    expect(certified.ok).toBe(true);
    expect(certified.results.map((result) => [result.guard, result.outcome])).toEqual([
      ["read-only", "passed"],
      ["worktree", "passed"],
      ["remote-ref", "passed"],
    ]);
  });

  test("uncommitted work is refused at submit, then fails certification", async () => {
    const { refusal, certified } = await guarded((repo, path) => {
      repo.worktrees.get(path)!.dirty = ["notes.txt"];
    });
    expect(refusal).toMatchObject({ code: "worktree_changed", nextAction: "correct" });
    expect(refusal?.message).toContain("notes.txt");
    expect(certified.ok).toBe(false);
    expect(JSON.stringify(certified.results)).toContain('"violated"');
  });

  test("a branch switched away or rewritten below its base fails", async () => {
    const switched = await guarded((repo, path) => {
      repo.worktrees.get(path)!.branch = "main";
    });
    expect(switched.refusal?.message).toContain("no longer on its branch");
    expect(switched.certified.ok).toBe(false);
    const rewritten = await guarded((repo, path) => {
      repo.worktrees.get(path)!.head = "f".repeat(40);
      repo.main.commits.set("f".repeat(40), { parent: "e".repeat(40), time: 0 });
    });
    expect(rewritten.certified.ok).toBe(false);
    expect(rewritten.certified.message).toContain("no longer descends");
  });

  test("the run's own checkout changing fails the branch (read-only guard)", async () => {
    const { refusal, certified } = await guarded((repo) => {
      repo.main.dirty = ["src/main.ts"];
    });
    expect(refusal).toMatchObject({ code: "worktree_changed" });
    expect(certified.ok).toBe(false);
  });
});

describe("scheduling", () => {
  test("isolated branches read the run's workspace and run together, beside readers", () => {
    const branches = ["sample.1", "sample.2", "sample.3"].map((key) =>
      activation(key, "ready", { worktree: false }),
    );
    const decision = selectGraphAdmissions(run(branches), {
      others: { writers: 0, readers: 1 },
      workspaceKnown: true,
    });
    expect(decision.admit).toHaveLength(3);
    const admitted = run(branches.map((entry) => ({ ...entry, state: "running" as const })));
    expect(graphRunWorkspaceHold(admitted)).toEqual({ writers: 0, readers: 3, worktrees: 3 });
  });

  test("a writer elsewhere on the workspace blocks them", () => {
    const decision = selectGraphAdmissions(run([activation("sample.1", "ready")]), {
      others: { writers: 1, readers: 0 },
      workspaceKnown: true,
    });
    expect(decision.blocked).toEqual([
      { key: expect.stringContaining("sample.1"), reason: "workspace-lock" },
    ]);
  });

  test("the environment's live worktrees are bounded", () => {
    const decision = selectGraphAdmissions(
      run([activation("sample.1", "ready"), activation("sample.2", "ready")]),
      {
        others: {
          writers: 0,
          readers: GRAPH_ISOLATION_BOUNDS.maxLiveWorktreesPerEnvironment - 1,
          worktrees: GRAPH_ISOLATION_BOUNDS.maxLiveWorktreesPerEnvironment - 1,
        },
        workspaceKnown: true,
      },
    );
    expect(decision.admit).toHaveLength(1);
    expect(decision.blocked).toEqual([
      { key: expect.stringContaining("sample.2"), reason: "worktree-limit" },
    ]);
  });
});
