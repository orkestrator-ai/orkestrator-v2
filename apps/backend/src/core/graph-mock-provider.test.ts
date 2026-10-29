/**
 * Mock runs end to end (item 213): the report §9 examples (Phase 4 parts
 * replaced as the Phase 2 exit criteria say) and every built-in's duplicate
 * run to completion on the real scheduler, gates and merges, with the mock
 * agent, system and human executors, while the live agent and system
 * executors sit behind recording fakes that must see nothing. Deterministic:
 * a manual clock, no waits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GraphMockWouldRun } from "@orkestrator/protocol/graphs/mock";
import { GRAPH_BUILT_IN_TEMPLATE_IDS } from "@orkestrator/protocol/graphs/builtins";
import { GRAPH_SYSTEM_ACTION_SPECS } from "@orkestrator/protocol/graphs/system-actions";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type { GraphAgentNode, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphMockRuns, graphMockInputs } from "./graph-mock-launch.js";
import { graphMockWorld, phase2Examples, type GraphMockWorld } from "./graph-mock-test-support.js";
import { graphLoopState } from "./graph-run-loops.js";
import { GraphRunView } from "./graph-run-view.js";

const worlds: GraphMockWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

async function world(options: { humanExecutor?: boolean } = {}): Promise<GraphMockWorld> {
  const created = await graphMockWorld(options);
  worlds.push(created);
  return created;
}

/** Nothing reached a provider, a command, the shell or the PR monitor. */
function expectNoLiveWork(w: GraphMockWorld, run: GraphRun): void {
  expect(w.calls.providers).toBe(0);
  expect(w.provider.sessions.size).toBe(0);
  expect(w.provider.turns()).toHaveLength(0);
  expect(w.calls.commands).toEqual([]);
  expect(w.calls.shell).toEqual([]);
  expect(w.calls.monitor).toEqual([]);
  expect(run.usage.tokens).toBe(0);
  for (const activation of run.activations) {
    expect(activation.session).toBeUndefined();
    expect(activation.policy).toBeUndefined();
    expect(activation.guards).toBeUndefined();
    expect(activation.baseline).toBeUndefined();
  }
}

/** Where a loop stands, read with the run's artifact values (as the run view would). */
async function loopState(w: GraphMockWorld, run: GraphRun, loopId: string) {
  const values = new Map<string, { value: unknown }>();
  for (const activation of run.activations) {
    for (const id of Object.values(activation.outputs)) {
      const artifact = await w.storage.graphRuns.getGraphArtifact(run.id, id);
      if (artifact && "value" in artifact.body) values.set(id, { value: artifact.body.value });
    }
  }
  const view = new GraphRunView(run, values);
  return graphLoopState(view, view.loop(loopId));
}

async function wouldRun(w: GraphMockWorld, run: GraphRun) {
  return (await w.storage.graphEffects.listGraphEffects(run.id)).map((effect) => ({
    state: effect.state,
    nodeId: effect.nodeId,
    wouldRun: effect.data?.wouldRun as GraphMockWouldRun | undefined,
  }));
}

describe("mock runs of the report §9 examples", () => {
  for (const { section, template } of phase2Examples()) {
    test(`§${section} (${template.id}) completes with zero provider sessions and no side effects`, async () => {
      const w = await world();
      const run = await w.finish((await w.launch(await w.save(template))).id);
      expect(run.status).toBe("complete");
      expect(run.mock).toBe(true);
      expect(run.environmentId).toBeUndefined();
      expectNoLiveWork(w, run);
      // Every side-effecting system node that ran left a "would have run" record instead.
      const effects = await wouldRun(w, run);
      const ranSystems = run.activations.filter(
        (activation) =>
          activation.state === "complete" &&
          run.plan.nodes.find((node) => node.id === activation.nodeId)?.kind === "system",
      );
      for (const activation of ranSystems) {
        const node = run.plan.nodes.find((entry) => entry.id === activation.nodeId)!;
        if (node.kind !== "system") continue;
        const record = effects.find(
          (effect) => effect.nodeId === node.id && effect.wouldRun !== undefined,
        );
        if (GRAPH_SYSTEM_ACTION_SPECS[node.action].sideEffect) {
          expect(record?.state).toBe("simulated");
          expect(record?.wouldRun?.action).toBe(node.action);
          expect(record?.wouldRun?.summary).toMatch(/^Would /);
        } else {
          expect(record).toBeUndefined();
        }
      }
      expect(effects.every((effect) => effect.state === "simulated")).toBe(true);
    });
  }

  test("§9.3 opens no pull request: the PR node records what it would have done", async () => {
    const w = await world();
    const template = phase2Examples().find((entry) => entry.section === "9.3")!.template;
    const run = await w.finish((await w.launch(await w.save(template))).id);
    expect(run.status).toBe("complete");
    const pr = (await wouldRun(w, run)).find((effect) => effect.nodeId === "pr")!;
    expect(pr.wouldRun).toMatchObject({
      action: "open-pull-request",
      label: "Open pull request",
      details: { draft: false, targetBranch: "the project's pull request base branch" },
    });
    expect(pr.wouldRun!.details.title).toBe("Add CSV export to the reports page");
    expect(pr.wouldRun!.summary).toContain("open a pull request");
    // The human approval answered by itself (approved, the brief forwarded unedited).
    const approve = run.activations.find((activation) => activation.nodeId === "approve")!;
    expect(approve.outlet).toBe("approved");
    expect(approve.outputs.brief).toBe(approve.inputs.brief as string);
    // The judge chose one of its declared choices, whatever the example said.
    const judge = run.activations.find((activation) => activation.nodeId === "judge")!;
    const decision = await w.storage.graphRuns.getGraphArtifact(run.id, judge.outputs.decision!);
    expect(["simplicity", "performance", "security"]).toContain(
      (decision!.body as { value: { choice: string } }).value.choice,
    );
    // The PR's mock output says no pull request was opened.
    const output = run.activations.find((activation) => activation.nodeId === "pr")!.outputs.pr!;
    const prResult = await w.storage.graphRuns.getGraphArtifact(run.id, output);
    expect((prResult!.body as { value: { summary: string } }).value.summary).toBe(
      "Mock run: no pull request was opened.",
    );
  });

  test("a writing agent's workspace output is a fake commit derived from its input, without git", async () => {
    const w = await world();
    const template = phase2Examples().find((entry) => entry.section === "9.2")!.template;
    const run = await w.finish((await w.launch(await w.save(template))).id);
    const build = run.activations.find((activation) => activation.nodeId === "build")!;
    const target = await w.storage.graphRuns.getGraphArtifact(run.id, build.inputs.code as string);
    const code = await w.storage.graphRuns.getGraphArtifact(run.id, build.outputs.code!);
    const input = (target!.body as { value: { headRef: string; branch: string } }).value;
    const output = (code!.body as { value: { headRef: string; baseRef: string; branch: string } })
      .value;
    expect(output.branch).toBe(input.branch);
    expect(output.baseRef).toBe(input.headRef);
    expect(output.headRef).toMatch(/^[a-f0-9]{40}$/);
    expect(output.headRef).not.toBe(input.headRef);
    expect(code!.workspace).toEqual({ headRef: output.headRef, baseRef: input.headRef });
    // The sealed package is an unwritten mock file that consumers still accept.
    const pkg = run.activations.find((activation) => activation.nodeId === "package")!;
    const sealed = await w.artifacts.verify(run.id, pkg.outputs.package!);
    expect(sealed.ok).toBe(true);
  });
});

describe("mock runs of the built-ins' duplicates", () => {
  for (const id of GRAPH_BUILT_IN_TEMPLATE_IDS) {
    test(`${id}'s duplicate completes with zero provider sessions`, async () => {
      const w = await world();
      const copy = await w.templates.duplicate(
        { scope: "builtin", id },
        { id: `mock-${id}`, projectId: w.projectId },
      );
      const run = await w.finish((await w.launch(copy.summary.ref)).id);
      expect(run.status).toBe("complete");
      expectNoLiveWork(w, run);
    });
  }

  test("a built-in itself is refused: it runs on its engine", async () => {
    const w = await world();
    await expect(
      w.mock.launch({ ref: { scope: "builtin", id: "multi-review" }, projectId: w.projectId }),
    ).rejects.toMatchObject({ code: "engine-template" });
  });
});

describe("pinned sequences", () => {
  function loopTemplate(): GraphTemplateV1 {
    const template = phase2Examples().find((entry) => entry.section === "9.2")!.template;
    template.loops![0]!.maxIterations = 5;
    template.limits = { ...template.limits, maxAgentSessions: 30 };
    return template;
  }
  const verdict = (complete: boolean) => ({
    outputs: {
      verdict: {
        complete,
        rationale: complete ? "Everything works." : "Not yet.",
        acceptanceCriteria: [],
      },
    },
  });

  test('"fail, fail, pass" on Verify converges on iteration 3', async () => {
    const w = await world();
    const ref = await w.save(loopTemplate());
    const run = await w.finish(
      (
        await w.launch(ref, {
          pins: { verify: [verdict(false), verdict(false), verdict(true)] },
        })
      ).id,
    );
    expect(run.status).toBe("complete");
    expect(run.loopIterations.rounds).toBe(3);
    expect(await loopState(w, run, "rounds")).toMatchObject({
      state: "done",
      reason: "converged",
      iteration: 3,
    });
    expect(
      run.activations
        .filter((activation) => activation.nodeId === "verify")
        .map((activation) => `${activation.iteration}:${activation.state}`),
    ).toEqual(["1:complete", "2:complete", "3:complete"]);
    expect(run.mockOptions?.pins?.verify).toHaveLength(3);
    expectNoLiveWork(w, run);
  });

  test("the last pin repeats: a failing Verify runs the loop to its bound", async () => {
    const w = await world();
    const run = await w.finish(
      (await w.launch(await w.save(loopTemplate()), { pins: { verify: [verdict(false)] } })).id,
    );
    expect(run.status).toBe("complete");
    expect(await loopState(w, run, "rounds")).toMatchObject({
      state: "done",
      reason: "bound",
      iteration: 5,
    });
  });

  test("pins stored on the template apply, and the launch's replace them node by node", async () => {
    const w = await world();
    const template = loopTemplate();
    template.mockPins = { verify: [verdict(true)] };
    const ref = await w.save(template);
    const stored = await w.finish((await w.launch(ref)).id);
    expect(stored.loopIterations.rounds).toBe(1);
    const replaced = await w.finish(
      (await w.launch(ref, { pins: { verify: [verdict(false), verdict(true)] } })).id,
    );
    expect(replaced.loopIterations.rounds).toBe(2);
  });

  test("a pinned failure is retried, and generated outputs pass their types", async () => {
    const w = await world();
    const template = loopTemplate();
    const build = template.nodes.find((node) => node.id === "build") as GraphAgentNode;
    build.retry = { attempts: 2, on: ["provider-error"] };
    const run = await w.finish(
      (
        await w.launch(await w.save(template), {
          pins: {
            build: [{ fail: "provider-error", message: "Mock outage" }, "generated"],
            verify: ["generated"],
          },
        })
      ).id,
    );
    expect(run.status).toBe("complete");
    const builds = run.activations.filter((activation) => activation.nodeId === "build");
    expect(builds.map((activation) => [activation.attempt, activation.state])).toEqual([
      [1, "failed"],
      [2, "complete"],
    ]);
    expect(builds[0]!.error).toBe("Mock outage");
    // Generated verdicts say `complete: true`, so the loop converges at once.
    expect(run.loopIterations.rounds).toBe(1);
  });

  test("a pinned value that does not fit its port fails the launch", async () => {
    const w = await world();
    const ref = await w.save(loopTemplate());
    await expect(
      w.launch(ref, { pins: { verify: [{ outputs: { verdict: { complete: "yes" } } }] } }),
    ).rejects.toMatchObject({ code: "invalid-launch" });
    await expect(w.launch(ref, { pins: { nowhere: ["example"] } })).rejects.toThrow(
      /no node nowhere/,
    );
    await expect(w.launch(ref, { pins: { "has-issues": ["example"] } })).rejects.toThrow(
      /take no pins/,
    );
  });

  test("human pins take another outlet, or pause for a person when a human executor exists", async () => {
    const template = phase2Examples().find((entry) => entry.section === "9.3")!.template;
    const w = await world();
    const ref = await w.save(template);
    const rejected = await w.finish(
      (await w.launch(ref, { pins: { approve: [{ outlet: "rejected" }] } })).id,
    );
    // Rejected: build and everything after it skip, so the required PR output is missing.
    expect(rejected.status).toBe("failed");
    expect(rejected.activations.find((a) => a.nodeId === "build")?.state).toBe("skipped");
    await expect(w.launch(ref, { pins: { approve: ["pause"] } })).rejects.toThrow(
      /cannot run human nodes/,
    );

    const withPeople = await world({ humanExecutor: true });
    const paused = await withPeople.finish(
      (await withPeople.launch(await withPeople.save(template), { pins: { approve: ["pause"] } }))
        .id,
      (run) => run.status === "waiting",
    );
    expect(paused.status).toBe("waiting");
    expect(paused.activations.find((a) => a.nodeId === "approve")?.state).toBe("awaiting-human");
  });

  test("an edit pin stores the edited value on the approved outlet", async () => {
    const template = phase2Examples().find((entry) => entry.section === "9.3")!.template;
    const w = await world();
    const edited = {
      summary: "Edited by a person.",
      approach: "Keep it small.",
      risks: [],
      filesTouched: ["src/a.ts"],
    };
    const run = await w.finish(
      (
        await w.launch(await w.save(template), {
          pins: { approve: [{ outlet: "approved", outputs: { brief: edited } }] },
        })
      ).id,
    );
    expect(run.status).toBe("complete");
    const approve = run.activations.find((a) => a.nodeId === "approve")!;
    expect(approve.outputs.brief).not.toBe(approve.inputs.brief as string);
    const build = run.activations.find((a) => a.nodeId === "build")!;
    expect(build.inputs.brief).toBe(approve.outputs.brief!);
    const brief = await w.storage.graphRuns.getGraphArtifact(run.id, approve.outputs.brief!);
    expect((brief!.body as { value: unknown }).value).toEqual(edited);
  });
});

describe("the runtime around mock runs", () => {
  test("stepMs makes each activation run for a while before it answers", async () => {
    const w = await world();
    const template = phase2Examples().find((entry) => entry.section === "9.2")!.template;
    const launched = await w.launch(await w.save(template), { stepMs: 5_000 });
    expect(launched.mockOptions?.stepMs).toBe(5_000);
    let run = (await w.service.advanceNow(launched.id))!;
    expect(run.activations.find((a) => a.nodeId === "build")?.state).toBe("running");
    run = await w.finish(run.id, undefined, 200);
    expect(run.status).toBe("complete");
  });

  test("a mock run in an environment holds none of its workspace locks", async () => {
    const w = await world();
    const template = phase2Examples().find((entry) => entry.section === "9.2")!.template;
    const ref = await w.save(template);
    const mock = await w.launch(ref, { environmentId: w.environmentId, stepMs: 10_000 });
    expect(mock.environmentId).toBe(w.environmentId);
    // The mock's writer (build) is running and stays so for ten seconds.
    const advanced = (await w.service.advanceNow(mock.id))!;
    expect(advanced.activations.find((a) => a.nodeId === "build")?.state).toBe("running");
    expect((await w.service.list(w.environmentId)).map((entry) => entry.id)).toContain(mock.id);
    // A real run's writer on the same environment is admitted all the same.
    const real = await w.service.create({
      projectId: w.projectId,
      environmentId: w.environmentId,
      template: mock.template,
      plan: mock.plan,
      roles: mock.bindings.roles,
      inputs: graphMockInputs(mock.plan).inputs,
    });
    const realAdvanced = (await w.service.advanceNow(real.id))!;
    expect(realAdvanced.activations.find((a) => a.nodeId === "build")?.state).not.toBe("ready");
    await w.service.cancel(real.id);
    await w.finish(real.id);
  });

  test("finished environment-less mock runs are pruned beyond the newest kept", async () => {
    const w = await world();
    const template = phase2Examples().find((entry) => entry.section === "9.1")!.template;
    const ref = await w.save(template);
    const pruning = new GraphMockRuns({
      templates: w.templates,
      runs: w.service,
      storage: w.storage,
      retained: 2,
    });
    try {
      const ids: string[] = [];
      for (let index = 0; index < 4; index++) {
        const result = await pruning.launch({ ref, projectId: w.projectId });
        await w.finish(result.run.id);
        ids.push(result.run.id);
      }
      await pruning.prune(w.projectId);
      const left = (await w.storage.graphRuns.listAllGraphRuns()).map((run) => run.id);
      expect(left).toEqual(ids.slice(2));
    } finally {
      pruning.dispose();
    }
  });
});
