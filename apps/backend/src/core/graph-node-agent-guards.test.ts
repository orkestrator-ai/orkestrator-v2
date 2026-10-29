/**
 * The guards around graph agent activations (item 209) through the real
 * executor, result service and agent tools server: the read-only guard at
 * dispatch, submit and consumption, the remote-ref guard, and the
 * enforcement floor re-checked on the live host at dispatch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { graphRoleProviderChoices } from "@orkestrator/protocol/graphs/agent-enforcement";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import {
  AGENT_TEST_COMMIT,
  TEST_DESCRIPTION,
  TEST_TICKET,
  TEST_WORKSPACE,
  agentTestTemplate,
  graphAgentWorld,
  submittingScript,
  turnSlots,
  type FakeAgentScript,
  type GraphAgentWorld,
} from "./graph-agent-test-support.js";

let world: GraphAgentWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

function activationOf(run: GraphRun, nodeId = "describe"): NodeActivation {
  const found = run.activations.filter((activation) => activation.nodeId === nodeId).at(-1);
  if (!found) throw new Error(`no activation of ${nodeId}`);
  return found;
}

function guard(activation: NodeActivation, kind: string) {
  return activation.guards?.find((entry) => entry.guard === kind);
}

async function launch(
  script: FakeAgentScript,
  options: Parameters<typeof agentTestTemplate>[0] = {},
): Promise<{ world: GraphAgentWorld; run: GraphRun }> {
  world = await graphAgentWorld({ script });
  world.start();
  const run = await world.launch(agentTestTemplate(options), {
    ticket: TEST_TICKET,
    target: TEST_WORKSPACE,
  });
  return { world, run };
}

describe("read-only guard", () => {
  test("a reviewer that commits is refused at submit time and can repair within its turn", async () => {
    const refusals: string[] = [];
    const { world, run } = await launch(async (turn, tools) => {
      const slots = turnSlots(turn);
      const repo = world!.repo;
      const start = repo.head;
      repo.commit();
      const refused = await tools.call("submit_description", {
        resultKey: slots.description,
        result: TEST_DESCRIPTION,
      });
      refusals.push(JSON.stringify(refused));
      // The repair: HEAD back where the step started, then submit again.
      repo.reset(start);
      await tools.call("submit_description", {
        resultKey: slots.description,
        result: TEST_DESCRIPTION,
      });
      return "idle";
    });
    const done = await world.drive(run.id);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("worktree_changed");
    expect(refusals[0]).toContain(AGENT_TEST_COMMIT);
    expect(done.status).toBe("complete");
    const activation = activationOf(done);
    expect(activation.state).toBe("complete");
    expect(guard(activation, "read-only")?.outcome).toBe("passed");
    expect(guard(activation, "remote-ref")?.outcome).toBe("passed");
    expect(guard(activation, "enforcement")?.outcome).toBe("passed");
    expect(activation.baseline?.capturedAt).toBeDefined();
    expect(activation.baseline?.paths).toEqual([]);
  });

  test("a reviewer that leaves a file is refused, removes it, and is accepted", async () => {
    const refusals: string[] = [];
    const { world, run } = await launch(async (turn, tools) => {
      const slots = turnSlots(turn);
      world!.repo.dirty = ["notes.md"];
      refusals.push(
        JSON.stringify(
          await tools.call("submit_description", {
            resultKey: slots.description,
            result: TEST_DESCRIPTION,
          }),
        ),
      );
      world!.repo.dirty = [];
      await tools.call("submit_description", {
        resultKey: slots.description,
        result: TEST_DESCRIPTION,
      });
      return "idle";
    });
    const done = await world.drive(run.id);
    expect(refusals[0]).toContain("worktree_changed");
    expect(refusals[0]).toContain("notes.md");
    expect(done.status).toBe("complete");
  });

  test("a commit discovered when the result is consumed fails the activation with evidence", async () => {
    const { world, run } = await launch(async (turn, tools, provider) => {
      await submittingScript()(turn, tools, provider);
      // After its result was accepted, the agent commits before ending its turn.
      world!.repo.commit();
      return "idle";
    });
    const done = await world.drive(run.id);
    const activation = activationOf(done);
    expect(activation.state).toBe("failed");
    expect(activation.errorCause).toBe("guard-violation");
    expect(activation.error).toContain("changed the environment HEAD");
    expect(activation.outputs).toEqual({});
    const evidence = guard(activation, "read-only");
    expect(evidence?.outcome).toBe("violated");
    expect(evidence?.detail).toContain("changed the environment HEAD");
    // No artifact was stored for the refused turn.
    expect(await world.artifacts.list(run.id)).not.toContainEqual(
      expect.objectContaining({ type: "pr-description@1" }),
    );
  });

  test("a step whose baseline cannot be established fails before dispatch", async () => {
    const { world, run } = await launch(submittingScript());
    world.repo.probeAvailable = false;
    const done = await world.drive(run.id);
    const activation = activationOf(done);
    expect(activation.state).toBe("failed");
    expect(activation.errorCause).toBe("guard-violation");
    expect(activation.error).toContain("cannot start");
    expect(activation.error).toContain("probe failed (timeout)");
    expect(activation.session).toBeUndefined();
    expect(guard(activation, "read-only")?.outcome).toBe("unavailable");
    expect(world.provider.sessions.size).toBe(0);
  });

  test("a step whose upstream refs cannot be read fails before dispatch", async () => {
    const { world, run } = await launch(submittingScript());
    world.repo.remoteReachable = false;
    const done = await world.drive(run.id);
    const activation = activationOf(done);
    expect(activation.state).toBe("failed");
    expect(activation.errorCause).toBe("guard-violation");
    expect(activation.error).toContain("upstream refs");
    expect(guard(activation, "remote-ref")?.outcome).toBe("unavailable");
    expect(world.provider.sessions.size).toBe(0);
  });
});

describe("remote-ref guard", () => {
  test("a builder that pushes its commit to another branch is detected", async () => {
    const { world, run } = await launch(
      async (turn, tools, provider) => {
        const repo = world!.repo;
        repo.commit();
        repo.push("origin", "refs/heads/sneaky");
        return submittingScript()(turn, tools, provider);
      },
      { profile: "builder" },
    );
    const done = await world.drive(run.id);
    const activation = activationOf(done);
    expect(activation.state).toBe("failed");
    expect(activation.errorCause).toBe("guard-violation");
    expect(activation.error).toContain("pushed during its turn");
    expect(activation.error).toContain("refs/heads/sneaky");
    expect(guard(activation, "remote-ref")?.outcome).toBe("violated");
    // A builder is not read-only guarded: its commit alone is its work.
    expect(guard(activation, "read-only")).toBeUndefined();
  });

  test("a push that moves the run branch is detected", async () => {
    const { world, run } = await launch(
      async (turn, tools, provider) => {
        const repo = world!.repo;
        repo.commit();
        repo.push("origin", "refs/heads/main");
        return submittingScript()(turn, tools, provider);
      },
      { profile: "builder" },
    );
    const done = await world.drive(run.id);
    const activation = activationOf(done);
    expect(activation.state).toBe("failed");
    expect(activation.error).toContain("refs/heads/main moved");
  });

  test("a builder that only commits completes", async () => {
    const { world, run } = await launch(
      async (turn, tools, provider) => {
        world!.repo.commit();
        return submittingScript()(turn, tools, provider);
      },
      { profile: "builder" },
    );
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    expect(guard(activationOf(done), "remote-ref")?.outcome).toBe("passed");
  });
});

describe("enforcement floor at dispatch", () => {
  test("a tier that dropped since launch fails the activation before dispatch with a clear message", async () => {
    world = await graphAgentWorld({ agent: "claude", script: submittingScript() });
    world.start();
    const template = agentTestTemplate();
    (template.nodes[0] as { minEnforcement?: string }).minEnforcement = "enforced";
    const run = await world.launch(template, { ticket: TEST_TICKET, target: TEST_WORKSPACE });
    // At launch the sandbox works: the picker offers Claude for the floor.
    const atLaunch = graphRoleProviderChoices(run.plan, world.host, ["claude"]);
    expect(atLaunch[0]?.choices[0]).toMatchObject({
      platform: "claude",
      tier: "enforced",
      allowed: true,
    });
    // Then the sandbox stops working before the step is dispatched.
    world.host = {
      claudeSandbox: false,
      claudeSandboxReason: "bubblewrap cannot create a user namespace on this host.",
    };
    const done = await world.drive(run.id);
    const activation = activationOf(done);
    expect(activation.state).toBe("failed");
    expect(activation.errorCause).toBe("guard-violation");
    expect(activation.error).toContain(
      "Claude Code holds step describe only at provider-configured",
    );
    expect(activation.error).toContain("below the step's floor (enforced)");
    expect(activation.error).toContain("bubblewrap cannot create a user namespace");
    expect(activation.enforcement).toBe("provider-configured");
    expect(activation.session).toBeUndefined();
    expect(guard(activation, "enforcement")?.outcome).toBe("violated");
    expect(world.provider.sessions.size).toBe(0);
    // The same judgement now filters the picker.
    expect(graphRoleProviderChoices(run.plan, world.host, ["claude"])[0]?.choices[0]).toMatchObject(
      { allowed: false, blockedBy: { nodeId: "describe", floor: "enforced" } },
    );
  });

  test("the applied tier and its reason are recorded with a passing enforcement result", async () => {
    world = await graphAgentWorld({ agent: "opencode", script: submittingScript() });
    world.start();
    const run = await world.launch(agentTestTemplate(), {
      ticket: TEST_TICKET,
      target: TEST_WORKSPACE,
    });
    const done = await world.drive(run.id);
    const activation = activationOf(done);
    expect(activation.enforcement).toBe("provider-configured");
    expect(activation.enforcementReason).toBeDefined();
    expect(guard(activation, "enforcement")).toMatchObject({ outcome: "passed" });
    expect(guard(activation, "enforcement")?.detail).toContain(
      "OpenCode holds this step at provider-configured",
    );
  });
});
