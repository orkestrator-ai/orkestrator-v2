import { afterEach, describe, expect, test } from "bun:test";
import { compile } from "@orkestrator/protocol/graphs/compile";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  TEST_DESCRIPTION,
  TEST_TICKET,
  TEST_WORKSPACE,
  agentTestTemplate,
  graphAgentWorld,
  submittingScript,
  toolContent,
  turnSlots,
  type GraphAgentWorld,
} from "./graph-agent-test-support.js";

let world: GraphAgentWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

function activationOf(run: GraphRun, nodeId: string): NodeActivation {
  const found = run.activations.filter((activation) => activation.nodeId === nodeId).at(-1);
  if (!found) throw new Error(`no activation of ${nodeId}`);
  return found;
}

/** `draft` writes a description; `refine` continues its session (§5.2). */
function continueTemplate(from = "draft"): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "continue-test",
    revision: 1,
    name: "Continue",
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [{ name: "ticket", type: "ticket@1" }],
    outputs: [
      {
        name: "description",
        type: "pr-description@1",
        from: { node: "refine", port: "description" },
      },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "draft",
        kind: "agent",
        role: "worker",
        capabilities: { profile: "observer" },
        workspaceAccess: "none",
        prompt: { template: "Draft.\n\n{{> input.ticket}}\n" },
        inputs: [{ name: "ticket", type: "ticket@1" }],
        outputs: [{ name: "description", type: "pr-description@1" }],
      },
      {
        id: "refine",
        kind: "agent",
        role: "worker",
        capabilities: { profile: "observer" },
        workspaceAccess: "none",
        session: { mode: "continue", from },
        prompt: { template: "Refine your draft.\n\n{{> input.draft}}\n" },
        inputs: [
          { name: "draft", type: "pr-description@1" },
          { name: "ticket", type: "ticket@1" },
        ],
        outputs: [{ name: "description", type: "pr-description@1" }],
      },
    ],
    edges: [
      { id: "t1", from: { input: "ticket" }, to: { node: "draft", port: "ticket" } },
      { id: "t2", from: { input: "ticket" }, to: { node: "refine", port: "ticket" } },
      {
        id: "d",
        from: { node: "draft", port: "description" },
        to: { node: "refine", port: "draft" },
      },
    ],
    limits: { maxAgentSessions: 10, maxConcurrentAgents: 2 },
  } as GraphTemplateV1;
}

describe("session: continue", () => {
  test("the continuing step sends its turn into the source step's provider session", async () => {
    world = await graphAgentWorld({ script: submittingScript() });
    world.start();
    const run = await world.launch(continueTemplate(), { ticket: TEST_TICKET });
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const draft = activationOf(done, "draft");
    const refine = activationOf(done, "refine");
    expect(refine.session?.providerSessionId).toBe(draft.session?.providerSessionId);
    expect(refine.session?.continuedFrom).toBe(draft.key);
    expect(world.provider.sessions.size).toBe(1);
    const turns = world.provider.turns();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.prompt).toContain("Refine your draft.");
    // The continued session's earlier usage is not counted twice.
    expect(done.usage.tokens).toBe(0);
  });

  test("the compiler enforces the §5.2 constraints", () => {
    const template = continueTemplate("draft");
    const notPredecessor = structuredClone(template);
    notPredecessor.edges = notPredecessor.edges.filter((edge) => edge.id !== "d");
    (notPredecessor.nodes[1] as { inputs: unknown[] }).inputs = [
      { name: "ticket", type: "ticket@1" },
    ];
    (notPredecessor.nodes[1] as { prompt: unknown }).prompt = { template: "Refine." };
    expect(compile(notPredecessor).diagnostics.map((entry) => entry.code)).toContain(
      "session-not-predecessor",
    );
    const otherRole = structuredClone(template);
    otherRole.roles.push({ key: "other", multiplicity: "one" });
    (otherRole.nodes[1] as { role: string }).role = "other";
    expect(compile(otherRole).diagnostics.map((entry) => entry.code)).toContain(
      "session-role-mismatch",
    );
    const self = continueTemplate("refine");
    expect(compile(self).diagnostics.map((entry) => entry.code)).toContain(
      "session-source-invalid",
    );
  });
});

describe("report_progress", () => {
  test("entries are kept as provisional progress and dropped when the result is accepted", async () => {
    const progress: Record<string, unknown>[] = [];
    world = await graphAgentWorld({
      script: async (turn, tools) => {
        const slots = turnSlots(turn);
        const item = {
          id: "ac-1",
          status: "passed",
          evidence: "The button exists.",
        };
        if (turn.index === 1) {
          progress.push(
            toolContent(await tools.call("report_progress", { resultKey: slots.verdict, item })),
          );
          progress.push(
            toolContent(await tools.call("report_progress", { resultKey: "not-a-key", item })),
          );
          // Ends without its result: the reminder turn submits it.
          return "idle";
        }
        await tools.call("submit_verdict", {
          resultKey: slots.verdict,
          result: {
            complete: true,
            rationale: "Both criteria hold.",
            acceptanceCriteria: [
              { id: "ac-1", status: "passed", evidence: "The button exists." },
              { id: "ac-2", status: "passed", evidence: "Every row is exported." },
            ],
          },
        });
        return "idle";
      },
    });
    world.start();
    const template = agentTestTemplate();
    const node = template.nodes[0] as { outputs: unknown[] };
    node.outputs = [{ name: "verdict", type: "verification-verdict@1" }];
    template.outputs = [
      {
        name: "verdict",
        type: "verification-verdict@1",
        from: { node: "describe", port: "verdict" },
      },
    ];
    const run = await world.launch(template, { ticket: TEST_TICKET, target: TEST_WORKSPACE });
    const paused = await world.drive(
      run.id,
      (current) =>
        (current.activations.find((entry) => entry.nodeId === "describe")?.session?.progress
          ?.length ?? 0) > 0,
      6,
    );
    expect(progress[0]).toMatchObject({ ok: true, provisional: true });
    expect(progress[1]).toMatchObject({ ok: false, error: { code: "not_a_progress_output" } });
    expect(activationOf(paused, "describe").session?.progress?.[0]).toMatchObject({
      port: "verdict",
      item: { id: "ac-1" },
    });
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    // The accepted verdict replaces the provisional entries; its items have ids.
    const activation = activationOf(done, "describe");
    expect(activation.session?.progress).toBeUndefined();
    const verdict = await world.artifacts.get(run.id, activation.outputs.verdict!);
    expect(verdict?.itemIds).toEqual(["describe/criterion-1", "describe/criterion-2"]);
  });
});

describe("OpenCode", () => {
  test("submits every port through the broker's generic tool with one activation capability", async () => {
    const listed: string[][] = [];
    world = await graphAgentWorld({
      agent: "opencode",
      script: async (turn, tools) => {
        listed.push(await tools.list());
        const capability = turn.options.agentMcp?.workflowResultCapability;
        const slots = turn.options.workflowResultSlots ?? [];
        const ticketId = /- ([a-f0-9]{64})/.exec(turn.prompt)?.[1];
        const read = toolContent(
          await tools.call("read_artifact", { id: ticketId, capability, path: "title" }),
        );
        if (read.value !== TEST_TICKET.title) throw new Error("read_artifact failed on the broker");
        for (const slot of slots) {
          await tools.call("submit_graph_output", {
            resultKey: slot.resultKey,
            capability,
            result: slot === slots[0] ? TEST_DESCRIPTION : { choice: "ship", rationale: "Ready." },
          });
        }
        return "idle";
      },
    });
    world.start();
    const run = await world.launch(agentTestTemplate(), {
      ticket: TEST_TICKET,
      target: TEST_WORKSPACE,
    });
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const turn = world.provider.turns()[0]!;
    expect(turn.options.workflowResultSlots?.map((slot) => slot.tool)).toEqual([
      "submit_graph_output",
      "submit_graph_output",
    ]);
    expect(turn.prompt).toContain("submit it with `submit_graph_output`");
    expect(listed[0]).toContain("read_artifact");
    expect(Object.keys(activationOf(done, "describe").outputs).sort()).toEqual([
      "decision",
      "description",
    ]);
  });
});

describe("built-in prompts", () => {
  test("pull-request-description binds the push-free builder", async () => {
    world = await graphAgentWorld({ script: submittingScript() });
    world.start();
    const template = agentTestTemplate({
      promptBuiltIn: "pull-request-description",
      profile: "observer",
      ticketRender: "json-frame",
    });
    const node = template.nodes[0] as { workspaceAccess: string };
    node.workspaceAccess = "read";
    const run = await world.launch(template, { ticket: TEST_TICKET, target: TEST_WORKSPACE });
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const prompt = world.provider.turns()[0]!.prompt;
    expect(prompt).toContain("system step");
    expect(prompt).not.toMatch(/\bgh pr (create|edit)\b(?![^.]*not)/);
  });
});

describe("cancellation", () => {
  test("cancelling a run aborts a running step's session and closes its slots", async () => {
    world = await graphAgentWorld({
      script: async (turn, _tools, provider) => {
        // A long turn: it ends only when the session is aborted.
        while (provider.session(turn.sessionId).aborted === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return "idle";
      },
    });
    world.provider.runningPolls = 1_000;
    world.start();
    const run = await world.launch(agentTestTemplate(), {
      ticket: TEST_TICKET,
      target: TEST_WORKSPACE,
    });
    await world.current().service.advanceNow(run.id);
    const running = await world.run(run.id);
    expect(activationOf(running, "describe").state).toBe("running");
    await world.current().service.cancel(run.id);
    let done = await world.run(run.id);
    for (let pass = 0; pass < 5 && done.status !== "cancelled"; pass++) {
      done = (await world.current().service.advanceNow(run.id)) ?? done;
    }
    expect(done.status).toBe("cancelled");
    const session = world.provider.session(
      activationOf(done, "describe").session!.providerSessionId!,
    );
    expect(session.aborted).toBeGreaterThan(0);
  });
});

describe("steps without submitted outputs", () => {
  test("a step whose only output is a workspace commit completes when its turn ends", async () => {
    world = await graphAgentWorld({ script: async () => "idle" });
    world.start();
    const template = agentTestTemplate({ profile: "builder", workspaceOutput: true });
    const node = template.nodes[0] as { outputs: { name: string; type: string }[] };
    node.outputs = node.outputs.filter((port) => port.type === "workspace@1");
    template.outputs = [
      { name: "code", type: "workspace@1", from: { node: "describe", port: "code" } },
    ];
    const run = await world.launch(template, { ticket: TEST_TICKET, target: TEST_WORKSPACE });
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const turn = world.provider.turns()[0]!;
    expect(turn.options.agentMcp).toBeUndefined();
    expect(turn.prompt).not.toContain("submit_");
    expect(Object.keys(activationOf(done, "describe").outputs)).toEqual(["code"]);
  });
});

describe("enforcement floor", () => {
  test("a provider below the step's floor fails it before any session", async () => {
    world = await graphAgentWorld({ agent: "opencode", script: submittingScript() });
    world.start();
    const template = agentTestTemplate();
    (template.nodes[0] as { minEnforcement?: string }).minEnforcement = "enforced";
    const run = await world.launch(template, { ticket: TEST_TICKET, target: TEST_WORKSPACE });
    const done = await world.drive(run.id);
    const activation = activationOf(done, "describe");
    expect(activation.state).toBe("failed");
    expect(activation.errorCause).toBe("guard-violation");
    expect(activation.enforcement).toBe("provider-configured");
    expect(activation.session).toBeUndefined();
    expect(world.provider.sessions.size).toBe(0);
  });
});

describe("opt-in Orkestrator groups", () => {
  test("a node that opts into reading tickets gets the ticket tools on its credential", async () => {
    let listed: string[] = [];
    world = await graphAgentWorld({
      script: async (turn, tools, provider) => {
        listed = await tools.list();
        return submittingScript()(turn, tools, provider);
      },
    });
    world.start();
    const template = agentTestTemplate();
    (template.nodes[0] as { capabilities: unknown }).capabilities = {
      profile: "reviewer",
      allow: ["orkestrator:tickets.read"],
    };
    const run = await world.launch(template, { ticket: TEST_TICKET, target: TEST_WORKSPACE });
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    expect(listed).toContain("list_tickets");
    expect(listed).toContain("get_ticket");
    expect(listed).not.toContain("create_ticket");
    expect(world.provider.turns()[0]!.prompt).toContain("Orkestrator's tools for reading tickets");
  });
});
