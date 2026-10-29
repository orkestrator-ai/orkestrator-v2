/**
 * Competing implementations end to end (item 403): three isolated builder
 * branches on the real agent executor, each committing in its own worktree;
 * a judge decides; `select-workspace` fast-forwards the run's branch to the
 * winner; every branch's worktree and branch is cleaned up. Then the
 * correctable refusal of an uncommitted branch, and a restart of the
 * winning branch (item 210) that selects again over the old choice.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { graphCompetingImplementationsTemplate } from "@orkestrator/protocol/graphs/isolation-template";
import {
  graphRunBranchRefPrefix,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import {
  TEST_TICKET,
  graphAgentWorld,
  toolContent,
  turnSlots,
  type FakeAgentScript,
  type GraphAgentWorld,
} from "./graph-agent-test-support.js";
import { FakeBranchRepo } from "./graph-branch-test-support.js";
import { GraphBranchWorktreeJanitor } from "./graph-branch-worktrees.js";
import { graphMockWouldRunKey } from "./graph-mock-system.js";
import { graphMockWorld } from "./graph-mock-test-support.js";
import { GraphNodeSystemExecutor } from "./graph-node-system.js";

let world: GraphAgentWorld | undefined;
let system: GraphNodeSystemExecutor | undefined;

afterEach(async () => {
  system?.shutdown();
  system = undefined;
  await world?.cleanup();
  world = undefined;
});

const WORKTREE = /Git worktree at `([^`]+)`/;

interface Harness {
  world: GraphAgentWorld;
  branches: () => FakeBranchRepo;
  choice: { value: string };
  /** Set per test: what a branch does before it submits. */
  beforeSubmit: { fn?: (path: string, branch: FakeBranchRepo) => void };
  submissions: Array<Record<string, unknown>>;
}

async function harness(): Promise<Harness> {
  let branchRepo: FakeBranchRepo | undefined;
  const branches = () => (branchRepo ??= new FakeBranchRepo(world!.repo));
  const choice = { value: "sample.2" };
  const beforeSubmit: Harness["beforeSubmit"] = {};
  const submissions: Array<Record<string, unknown>> = [];
  const script: FakeAgentScript = async (turn, tools) => {
    const slots = turnSlots(turn);
    const directory = WORKTREE.exec(turn.prompt)?.[1];
    if (directory) {
      // A builder branch: work and commit in its own worktree.
      const path = FakeBranchRepo.relative(directory);
      branches().commitIn(path);
      beforeSubmit.fn?.(path, branches());
      let result = await tools.call("submit_notes", {
        resultKey: slots.notes,
        result: { text: `Implemented in ${path}` },
      });
      submissions.push(toolContent(result));
      if (toolContent(result).accepted !== true) {
        // Corrected within the turn: commit what was left, then submit again.
        const worktree = branches().worktrees.get(path)!;
        worktree.dirty = [];
        branches().commitIn(path);
        result = await tools.call("submit_notes", {
          resultKey: slots.notes,
          result: { text: `Implemented in ${path}` },
        });
        submissions.push(toolContent(result));
      }
      return "idle";
    }
    await tools.call("submit_decision", {
      resultKey: slots.decision,
      result: { choice: choice.value, rationale: "Smallest change that meets the ticket." },
    });
    return "idle";
  };
  world = await graphAgentWorld({
    script,
    git: () => branches().git,
    branchWorktrees: () => branches().service(),
    serviceOptions: (current) => ({
      branchWorktrees: new GraphBranchWorktreeJanitor({
        worktrees: branches().service(),
        storage: current.storage,
      }),
    }),
    executors: (current, service) => {
      system = new GraphNodeSystemExecutor({
        storage: current.storage,
        invoke: async () => {
          throw new Error("no commands in tests");
        },
        shell: branches().shell(),
        prMonitor: { state: () => null, subscribe: () => () => undefined, watch: async () => {} },
        requestObservation: (runId, key) => service.requestObservation(runId, key),
        owner: "isolated-test",
        inlineWaitMs: 1_000,
        branchWorktrees: branches().service(),
      });
      service.executors.register(system);
    },
  });
  world.start();
  return { world, branches, choice, beforeSubmit, submissions };
}

function latest(run: GraphRun, nodeId: string, branchKey?: string): NodeActivation {
  return run.activations.findLast(
    (activation) =>
      activation.nodeId === nodeId &&
      activation.branchKey === branchKey &&
      activation.state !== "superseded",
  )!;
}

async function launch(h: Harness): Promise<GraphRun> {
  return h.world.launch(graphCompetingImplementationsTemplate(), {
    ticket: TEST_TICKET,
    target: { branch: "main", headRef: h.world.repo.head, baseRef: null },
  });
}

/** One more locked pass, so cleanup queued behind the last save has run. */
async function settleCleanup(h: Harness, runId: string): Promise<void> {
  await h.world.current().service.advanceNow(runId);
  await h.world.current().service.advanceNow(runId);
}

describe("competing implementations", () => {
  test("three branches each commit in their own worktree, the judged one is selected, the rest are cleaned up", async () => {
    const h = await harness();
    const base = h.world.repo.head;
    const launched = await launch(h);
    const run = await h.world.drive(launched.id);
    expect(run.status).toBe("complete");

    const implement = ["sample.1", "sample.2", "sample.3"].map((key) =>
      latest(run, "implement", key),
    );
    // One worktree per branch, each from the input commit, on its own branch.
    expect(new Set(implement.map((activation) => activation.worktree?.path)).size).toBe(3);
    for (const activation of implement) {
      expect(activation.state).toBe("complete");
      expect(activation.worktree).toMatchObject({
        path: `.orkestrator/graph-branches/${run.id}/implement/i1/${activation.branchKey}`,
        branch: `${graphRunBranchRefPrefix(run.id)}implement/i1/${activation.branchKey}`,
        baseRef: base,
      });
      expect(activation.guards?.map((guard) => [guard.guard, guard.outcome])).toEqual(
        expect.arrayContaining([
          ["read-only", "passed"],
          ["worktree", "passed"],
          ["remote-ref", "passed"],
        ]),
      );
    }
    // Every branch's prompt named its own worktree; the judge's named none.
    const prompts = h.world.provider.deliveries;
    expect(prompts.length).toBeGreaterThanOrEqual(4);

    // Each branch's `workspace@1` names its own branch and commit.
    const outputs = await Promise.all(
      implement.map((activation) =>
        h.world.artifacts.get(run.id, activation.outputs.code!).then((artifact) => artifact!),
      ),
    );
    const values = outputs.map(
      (artifact) => (artifact.body as { value: { branch: string; headRef: string } }).value,
    );
    expect(values.map((value) => value.branch)).toEqual(
      implement.map((activation) => activation.worktree!.branch),
    );
    const winner = values[1]!.headRef;

    // Select fast-forwarded the run's branch to the judged branch's commit.
    const select = latest(run, "select");
    expect(select.state).toBe("complete");
    const selected = await h.world.artifacts.get(run.id, select.outputs.code!);
    expect((selected!.body as { value: unknown }).value).toEqual({
      branch: "main",
      headRef: winner,
      baseRef: base,
    });
    expect(h.world.repo.head).toBe(winner);

    // Nothing of the branches is left: no worktree, no branch.
    await settleCleanup(h, run.id);
    expect([...h.branches().worktrees.keys()]).toEqual([]);
    expect(
      [...h.branches().branches.keys()].filter((name) =>
        name.startsWith(graphRunBranchRefPrefix(run.id)),
      ),
    ).toEqual([]);
    expect(h.branches().calls).toContainEqual(expect.stringContaining("merge --ff-only"));
  });

  test("a branch that submits with uncommitted work is refused and corrects itself", async () => {
    const h = await harness();
    h.beforeSubmit.fn = (path, branches) => {
      if (path.endsWith("sample.1") && h.submissions.length === 0) {
        branches.worktrees.get(path)!.dirty = ["scratch.txt"];
      }
    };
    const launched = await launch(h);
    const run = await h.world.drive(launched.id);
    expect(run.status).toBe("complete");
    const refused = h.submissions.find((submission) => submission.accepted !== true);
    expect(JSON.stringify(refused)).toContain("worktree_changed");
    expect(JSON.stringify(refused)).toContain("scratch.txt");
    expect(latest(run, "implement", "sample.1").state).toBe("complete");
  });

  test("restarting the winning branch runs it in a fresh worktree and selects again over the old choice", async () => {
    const h = await harness();
    const first = await h.world.drive((await launch(h)).id);
    expect(first.status).toBe("complete");
    const oldWinner = h.world.repo.head;
    await settleCleanup(h, first.id);

    const branch = latest(first, "implement", "sample.2");
    await h.world.current().service.restart(first.id, branch.key);
    const run = await h.world.drive(first.id);
    expect(run.status).toBe("complete");

    const restarted = latest(run, "implement", "sample.2");
    expect(restarted.attempt).toBe(2);
    expect(restarted.worktree?.baseRef).toBe(branch.worktree?.baseRef);
    const newWinner = h.world.repo.head;
    expect(newWinner).not.toBe(oldWinner);
    // The new commit starts from the input commit, not from the old winner.
    expect(h.branches().isAncestor(oldWinner, newWinner)).toBe(false);
    // The old tip is kept under a backup ref.
    expect(h.branches().branches.get(`refs/orkestrator-graph-backup/${run.id}/${oldWinner}`)).toBe(
      oldWinner,
    );
    await settleCleanup(h, run.id);
    expect([...h.branches().worktrees.keys()]).toEqual([]);
  });

  test("a choice that names no branch fails the select, and the run's branch stays put", async () => {
    const h = await harness();
    h.choice.value = "sample.3";
    const base = h.world.repo.head;
    // Sample 3 is judged, but the decision names a branch with a typo.
    h.choice.value = "sample.9";
    const template = graphCompetingImplementationsTemplate();
    const judge = template.nodes.find((node) => node.id === "judge")!;
    if (judge.kind === "agent") judge.outputs![0]!.choices = ["sample.1", "sample.2", "sample.9"];
    const launched = await h.world.launch(template, {
      ticket: TEST_TICKET,
      target: { branch: "main", headRef: base, baseRef: null },
    });
    const run = await h.world.drive(launched.id);
    expect(run.status).toBe("failed");
    expect(latest(run, "select").error).toContain("names no candidate branch");
    expect(h.world.repo.head).toBe(base);
    await settleCleanup(h, run.id);
    expect([...h.branches().worktrees.keys()]).toEqual([]);
  });
});

describe("a mock run", () => {
  test("simulates the branches and the select without Git or worktrees", async () => {
    const mockWorld = await graphMockWorld();
    try {
      const ref = await mockWorld.save(graphCompetingImplementationsTemplate());
      const launched = await mockWorld.launch(ref);
      const run = await mockWorld.finish(launched.id);
      expect(run.status).toBe("complete");
      // Nothing reached an environment: no shell, no command, no provider.
      expect(mockWorld.calls).toEqual({ commands: [], shell: [], monitor: [], providers: 0 });

      const branchValue = async (activation: NodeActivation) =>
        (
          (await mockWorld.artifacts.get(run.id, activation.outputs.code!))!.body as {
            value: { branch: string; headRef: string };
          }
        ).value;
      const branches = ["sample.1", "sample.2", "sample.3"].map((key) =>
        latest(run, "implement", key),
      );
      for (const activation of branches) {
        // A mock branch names its own branch, but no worktree was made.
        expect((await branchValue(activation)).branch).toBe(
          `${graphRunBranchRefPrefix(run.id)}implement/i1/${activation.branchKey}`,
        );
        expect(activation.worktree).toBeUndefined();
      }
      const decision = (
        (await mockWorld.artifacts.get(run.id, latest(run, "judge").outputs.decision!))!.body as {
          value: { choice: string };
        }
      ).value;
      const chosen = branches.find((activation) => activation.branchKey === decision.choice)!;
      const select = latest(run, "select");
      const selected = (
        (await mockWorld.artifacts.get(run.id, select.outputs.code!))!.body as {
          value: { branch: string; headRef: string };
        }
      ).value;
      expect(selected.headRef).toBe((await branchValue(chosen)).headRef);
      expect(selected.branch.startsWith("mock/run-")).toBe(true);
      const effects = await mockWorld.storage.graphEffects.listGraphEffects(run.id);
      const wouldRun = effects.find((effect) => effect.key === graphMockWouldRunKey(select.key));
      expect(wouldRun?.state).toBe("simulated");
      expect(JSON.stringify(wouldRun?.data)).toContain("Would fast-forward the run's branch");
    } finally {
      await mockWorld.cleanup();
    }
  });
});
