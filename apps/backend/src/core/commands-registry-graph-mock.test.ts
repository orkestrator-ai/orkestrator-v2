import { afterEach, describe, expect, test } from "bun:test";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphMockWouldRun } from "@orkestrator/protocol/graphs/mock";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { GraphMockLaunchResult } from "./graph-mock-launch.js";
import { graphMockWorld, phase2Examples, type GraphMockWorld } from "./graph-mock-test-support.js";
import type { GraphEffectRecord } from "./storage-graph-effects.js";

const commands = createCommandRegistry();
const worlds: GraphMockWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

async function setup() {
  const world = await graphMockWorld();
  worlds.push(world);
  const context = {
    storage: world.storage,
    graphTemplates: world.templates,
    graphRuns: world.service,
    graphMock: world.mock,
  } as unknown as CommandContext;
  const run = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`Not registered: ${name}`);
    return (await handler(args, context)) as T;
  };
  const refused = async (name: string, args: Record<string, unknown>) => {
    try {
      await run(name, args);
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    }
    throw new Error(`${name} was not refused`);
  };
  return { world, run, refused };
}

describe("graph_run_mock", () => {
  test("starts an environment-less mock run with placeholders and example inputs", async () => {
    const { world, run } = await setup();
    const ref = await world.save(
      phase2Examples().find((example) => example.section === "9.3")!.template,
    );
    const result = await run<GraphMockLaunchResult>("graph_run_mock", {
      ref,
      projectId: world.projectId,
      // A pin may name a node inlined from the Multi Review sub-graph (item 402).
      pins: { approve: [{ outlet: "approved" }], "review/consolidate": ["generated"] },
    });
    expect(result.run).toMatchObject({ mock: true, projectId: world.projectId, status: "running" });
    expect(result.run.environmentId).toBeUndefined();
    expect(result.exampleInputs.sort()).toEqual(["target", "ticket"]);
    // The parent's roles, the ones it binds into the sub-graph included.
    expect(result.placeholderRoles).toEqual(
      expect.arrayContaining(["designer", "preparer", "reviewer", "consolidator", "describer"]),
    );
    expect(result.pins).toEqual({
      approve: [{ outlet: "approved" }],
      "review/consolidate": ["generated"],
    });
    const stored = await world.storage.graphRuns.getGraphRun(result.run.id);
    expect(stored?.bindings.roles.designer).toEqual({ platform: "claude", model: "mock" });
    expect(stored?.mockOptions?.pins?.["review/consolidate"]).toEqual(["generated"]);
    // A panel role gets two placeholders by default, or `panel` of them.
    const review = await world.save({
      ...graphTemplateExample("multi-review"),
      id: "mr",
      revision: 0,
    });
    const panel = await run<GraphMockLaunchResult>("graph_run_mock", {
      ref: review,
      projectId: world.projectId,
      panel: 3,
    });
    const panelRun = await world.storage.graphRuns.getGraphRun(panel.run.id);
    expect(panelRun?.bindings.roles.reviewer).toEqual([
      { platform: "claude", model: "mock" },
      { platform: "claude", model: "mock" },
      { platform: "claude", model: "mock" },
    ]);
  });

  test("validates its arguments", async () => {
    const { world, refused } = await setup();
    const ref = await world.save({
      ...graphTemplateExample("multi-review"),
      id: "mr",
      revision: 0,
    });
    expect((await refused("graph_run_mock", { ref })).message).toBe("projectId is required");
    expect(
      (await refused("graph_run_mock", { ref, projectId: world.projectId, extra: 1 })).message,
    ).toContain("Unknown arguments: extra");
    expect(await refused("graph_run_mock", { ref, projectId: "missing" })).toMatchObject({
      code: "not-found",
    });
    expect(
      await refused("graph_run_mock", { ref, projectId: world.projectId, environmentId: "nope" }),
    ).toMatchObject({ code: "not-found" });
    expect(
      (await refused("graph_run_mock", { ref, projectId: world.projectId, pins: { fix: "x" } }))
        .message,
    ).toContain("Invalid pins");
    expect(
      (await refused("graph_run_mock", { ref, projectId: world.projectId, stepMs: 1.5 })).message,
    ).toBe("stepMs must be an integer");
    expect(
      (await refused("graph_run_mock", { ref, projectId: world.projectId, params: { a: [] } }))
        .message,
    ).toContain("params.a");
    expect(
      await refused("graph_run_mock", {
        ref: { scope: "user", id: "absent" },
        projectId: world.projectId,
      }),
    ).toMatchObject({ code: "not-found" });
  });
});

describe("graph_run_effects", () => {
  test("lists a mock run's would-have-run records", async () => {
    const { world, run, refused } = await setup();
    const ref = await world.save({
      ...graphTemplateExample("multi-review"),
      id: "mr",
      revision: 0,
    });
    const launched = await run<GraphMockLaunchResult>("graph_run_mock", {
      ref,
      projectId: world.projectId,
      params: { autoPr: true },
    });
    await world.finish(launched.run.id);
    const { effects } = await run<{ effects: GraphEffectRecord[] }>("graph_run_effects", {
      runId: launched.run.id,
    });
    const byNode = new Map(effects.map((effect) => [effect.nodeId, effect]));
    expect(byNode.get("package")?.state).toBe("simulated");
    const pr = byNode.get("pr");
    expect(pr?.state).toBe("simulated");
    expect((pr!.data!.wouldRun as GraphMockWouldRun).action).toBe("open-pull-request");
    expect(world.calls.commands).toEqual([]);
    expect(await refused("graph_run_effects", { runId: "nope nope" })).toMatchObject({
      code: "invalid-launch",
    });
  });
});
