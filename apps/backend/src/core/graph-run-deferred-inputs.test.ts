/**
 * A run launched on a new environment (item 214, D7): its empty
 * `workspace@1` inputs wait for that environment and are stored from its
 * HEAD when the provisioner reports it ready.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import {
  bindAllRoles,
  compiledPlan,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import type { GraphRunProvisioner } from "./graph-run-pass.js";

const worlds: GraphRunWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

const HEAD = "c".repeat(40);

async function setup(outcome: Awaited<ReturnType<GraphRunProvisioner["provision"]>>) {
  const world = await graphRunWorld();
  worlds.push(world);
  const service = world.service({
    autoAdvance: false,
    provisioner: { provision: async () => outcome },
  });
  await service.init();
  const plan = compiledPlan({
    ...graphTemplateExample("build-pipeline-loop"),
    id: "loop",
    revision: 1,
  });
  return { world, service, plan };
}

describe("workspace inputs deferred to a new environment", () => {
  test("are stored from the environment's HEAD once it is ready", async () => {
    const { world, service, plan } = await setup({
      state: "ready",
      environmentId: "e2",
      workspace: { branch: "graph/loop", headRef: HEAD },
    });
    const run = await service.create({
      projectId: "p1",
      template: {
        id: plan.template.id,
        revision: plan.template.revision,
        digest: plan.templateDigest,
      },
      plan,
      roles: bindAllRoles(plan),
      // The ticket is given; the target is the new environment's code.
      inputs: { ticket: graphTypeExample(plan, "ticket@1") },
    });
    expect(run.status).toBe("provisioning");
    expect(run.bindings.inputs.target).toBeUndefined();
    await service.advanceNow(run.id);
    const after = (await service.get(run.id))!;
    expect(after.environmentId).toBe("e2");
    expect(after.status).not.toBe("failed");
    const artifact = await world.artifacts.requireVerified(run.id, after.bindings.inputs.target!);
    expect("value" in artifact.body && artifact.body.value).toEqual({
      branch: "graph/loop",
      headRef: HEAD,
      baseRef: null,
    });
  });

  test("a ready environment without a commit fails the run instead of starting it", async () => {
    const { service, plan } = await setup({ state: "ready", environmentId: "e2" });
    const run = await service.create({
      projectId: "p1",
      template: {
        id: plan.template.id,
        revision: plan.template.revision,
        digest: plan.templateDigest,
      },
      plan,
      roles: bindAllRoles(plan),
      inputs: { ticket: graphTypeExample(plan, "ticket@1") },
    });
    await service.advanceNow(run.id);
    const after = (await service.get(run.id))!;
    expect(after.status).toBe("failed");
    expect(after.environmentId).toBeUndefined();
    expect(after.error).toBe("The run's new environment has no commit to start from");
  });

  test("a launch on an existing environment still needs every required input", async () => {
    const { service, plan } = await setup({ state: "pending" });
    await expect(
      service.create({
        projectId: "p1",
        environmentId: "e1",
        template: {
          id: plan.template.id,
          revision: plan.template.revision,
          digest: plan.templateDigest,
        },
        plan,
        roles: bindAllRoles(plan),
        inputs: { ticket: graphTypeExample(plan, "ticket@1") },
      }),
    ).rejects.toThrow("The run input target is required");
  });
});
