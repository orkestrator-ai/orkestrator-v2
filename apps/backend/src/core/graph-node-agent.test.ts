import { afterEach, describe, expect, test } from "bun:test";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import {
  AGENT_TEST_BASE_COMMIT,
  AGENT_TEST_COMMIT,
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

function activationOf(run: GraphRun, nodeId = "describe"): NodeActivation {
  const found = run.activations.filter((activation) => activation.nodeId === nodeId).at(-1);
  if (!found) throw new Error(`no activation of ${nodeId}`);
  return found;
}

async function launched(
  options: Parameters<typeof agentTestTemplate>[0] = {},
  worldOptions: Parameters<typeof graphAgentWorld>[0] = {},
) {
  world = await graphAgentWorld({ script: submittingScript(), ...worldOptions });
  world.start();
  const run = await world.launch(agentTestTemplate(options), {
    ticket: TEST_TICKET,
    target: TEST_WORKSPACE,
  });
  return { world, run };
}

describe("graph agent node executor", () => {
  test("completes when every required port is accepted, with lineage and the workspace commit", async () => {
    const { world, run } = await launched();
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const activation = activationOf(done);
    expect(activation.state).toBe("complete");
    // The optional decision was not submitted; the required description was.
    expect(Object.keys(activation.outputs)).toEqual(["description"]);
    const artifact = await world.artifacts.get(run.id, activation.outputs.description!);
    expect(artifact?.type).toBe("pr-description@1");
    expect(artifact && "value" in artifact.body ? artifact.body.value : undefined).toEqual(
      TEST_DESCRIPTION,
    );
    // Lineage: the consumed input artifacts; workspace: HEAD after the turn.
    const consumed = Object.values(activation.inputs).flat().sort();
    expect([...(artifact?.inputs ?? [])].sort()).toEqual(consumed);
    expect(artifact?.workspace).toEqual({
      headRef: AGENT_TEST_COMMIT,
      baseRef: AGENT_TEST_BASE_COMMIT,
    });
    // Policy and tier were recorded, with the session they applied to.
    expect(activation.policy).toBeDefined();
    expect(activation.enforcement).toBeDefined();
    expect(activation.session?.turnMode).toBe("read-only");
    expect(activation.baseline?.headRef).toBe(AGENT_TEST_COMMIT);
    expect(world.provider.deliveries).toHaveLength(1);
  });

  test("result keys are UUIDs unique to the run, activation and request", async () => {
    const { world, run } = await launched();
    const first = await world.drive(run.id);
    const second = await world.drive(
      (await world.launch(agentTestTemplate(), { ticket: TEST_TICKET, target: TEST_WORKSPACE })).id,
    );
    const keys = (value: GraphRun) => Object.values(activationOf(value).session?.resultKeys ?? {});
    expect(keys(first)).toHaveLength(2);
    for (const key of [...keys(first), ...keys(second)]) {
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set([...keys(first), ...keys(second)]).size).toBe(4);
  });

  test("each output port gets its own tools, with read_artifact and ask_human only where granted", async () => {
    let listed: string[] = [];
    const { world, run } = await launched(
      { askHuman: true },
      {
        script: async (turn, tools, provider) => {
          listed = await tools.list();
          return submittingScript()(turn, tools, provider);
        },
      },
    );
    await world.drive(run.id);
    expect(listed).toEqual(
      [
        "validate_description",
        "submit_description",
        "validate_decision",
        "submit_decision",
        "get_workflow_result_status",
        "report_progress",
        "read_artifact",
        "ask_human",
      ].filter((name) => name !== "report_progress"),
    );
    // The turn declared its slots and extra tools to the bridge.
    const turn = world.provider.turns()[0]!;
    expect(turn.options.workflowResultSlots?.map((slot) => slot.tool)).toEqual([
      "submit_description",
      "submit_decision",
    ]);
    expect(turn.options.workflowResultExtraTools).toEqual(["read_artifact", "ask_human"]);
    expect(turn.options.readOnly).toBe(true);
    expect(turn.options.mode).toBe("plan");
  });

  test("a node that does not opt in has no ask_human", async () => {
    let listed: string[] = [];
    const { world, run } = await launched(
      {},
      {
        script: async (turn, tools, provider) => {
          listed = await tools.list();
          return submittingScript()(turn, tools, provider);
        },
      },
    );
    await world.drive(run.id);
    expect(listed).not.toContain("ask_human");
    expect(world.provider.turns()[0]!.prompt).toContain(
      "Nobody is watching this step: do not ask the user questions",
    );
  });

  test("read_artifact reads only the step's inputs, by path, within bounds", async () => {
    const reads: Record<string, unknown>[] = [];
    const { world, run } = await launched(
      {},
      {
        script: async (turn, tools, provider) => {
          const ticketId = /- ([a-f0-9]{64})/.exec(turn.prompt)?.[1];
          reads.push(toolContent(await tools.call("read_artifact", { id: ticketId })));
          reads.push(
            toolContent(
              await tools.call("read_artifact", { id: ticketId, path: "criteria[1].id" }),
            ),
          );
          reads.push(
            toolContent(await tools.call("read_artifact", { id: ticketId, path: "nothing.here" })),
          );
          reads.push(toolContent(await tools.call("read_artifact", { id: "f".repeat(64) })));
          return submittingScript()(turn, tools, provider);
        },
      },
    );
    await world.drive(run.id);
    expect(reads[0]).toMatchObject({ ok: true, type: "ticket@1", value: TEST_TICKET });
    expect(reads[1]).toMatchObject({ ok: true, path: "criteria.1.id", value: "ac-2" });
    expect(reads[2]).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(reads[3]).toMatchObject({ ok: false, error: { code: "not_an_input" } });
  });

  test("a builder runs as an ordinary turn", async () => {
    const { world, run } = await launched({ profile: "builder" });
    const done = await world.drive(run.id);
    const activation = activationOf(done);
    expect(activation.session?.turnMode).toBe("build");
    const turn = world.provider.turns()[0]!;
    expect(turn.options.readOnly).toBeUndefined();
    expect(turn.options.mode).toBe("build");
    const created = world.provider.session(turn.sessionId).createOptions;
    expect(created.readOnly).toBeUndefined();
    expect(created.reviewerSession).toBeUndefined();
  });

  test("a researcher on Claude keeps hosted search: an ordinary turn, tier at most provider-configured", async () => {
    const { world, run } = await launched({ profile: "researcher" });
    const done = await world.drive(run.id);
    const activation = activationOf(done);
    expect(activation.session?.turnMode).toBe("build");
    expect(activation.enforcement).not.toBe("enforced");
    expect(activation.enforcementReason).toContain("hosted web search stays available");
    expect(world.provider.turns()[0]!.options.readOnly).toBeUndefined();
  });

  test("a researcher on Codex runs read-only", async () => {
    const { world, run } = await launched({ profile: "researcher" }, { agent: "codex" });
    const done = await world.drive(run.id);
    expect(activationOf(done).session?.turnMode).toBe("read-only");
    expect(world.provider.turns()[0]!.options.readOnly).toBe(true);
  });

  test("a workspace output is filled from Git after the turn", async () => {
    const { world, run } = await launched({ profile: "builder", workspaceOutput: true });
    const done = await world.drive(run.id);
    const activation = activationOf(done);
    const code = await world.artifacts.get(run.id, activation.outputs.code!);
    expect(code && "value" in code.body ? code.body.value : undefined).toEqual({
      branch: "main",
      headRef: AGENT_TEST_COMMIT,
      baseRef: AGENT_TEST_BASE_COMMIT,
    });
  });

  test("one reminder after the idle-poll bound, in the same session, then completion", async () => {
    const { world, run } = await launched(
      {},
      {
        script: async (turn, tools, provider) =>
          turn.index === 1 ? "idle" : submittingScript()(turn, tools, provider),
      },
    );
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const turns = world.provider.turns();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.sessionId).toBe(turns[0]!.sessionId);
    expect(turns[1]!.requestId).not.toBe(turns[0]!.requestId);
    expect(turns[1]!.prompt).toContain("Orkestrator has not received your results");
    // The reminder carries the new request's own result instruction and keys.
    const keys = Object.values(turnSlots(turns[1]!));
    for (const key of keys) expect(turns[1]!.prompt).toContain(key);
    expect(activationOf(done).session?.reminderSent).toBe(true);
  });

  test("a second silent turn fails the step as an invalid result", async () => {
    const { world, run } = await launched({}, { script: async () => "idle" });
    const done = await world.drive(run.id);
    expect(done.status).toBe("failed");
    const activation = activationOf(done);
    expect(activation.errorCause).toBe("invalid-result");
    expect(activation.error).toContain("finished without calling submit_description");
  });

  test("a provider restart that cut the turn short is continued once", async () => {
    const { world, run } = await launched(
      {},
      {
        script: async (turn, tools, provider) =>
          turn.index === 1 ? "restart" : submittingScript()(turn, tools, provider),
      },
    );
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const turns = world.provider.turns();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.prompt).toContain("Orkestrator restarted while you were working");
  });

  test("a session failure fails the step as a provider error", async () => {
    const { world, run } = await launched({}, { script: async () => "error" });
    const done = await world.drive(run.id);
    expect(activationOf(done).errorCause).toBe("provider-error");
  });
});

describe("structured output transport", () => {
  test("one combined schema; a contract failure gets a bounded repair turn", async () => {
    const { world, run } = await launched(
      {},
      {
        toolResults: false,
        script: async (turn, _tools, provider) => {
          const value =
            turn.index === 1
              ? { description: { title: "" }, decision: null }
              : { description: TEST_DESCRIPTION, decision: { choice: "ship", rationale: "Done." } };
          provider.session(turn.sessionId).structured.set(turn.requestId, {
            ok: true,
            provider: "claude",
            requestId: turn.requestId,
            value,
          });
          return "idle";
        },
      },
    );
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const turns = world.provider.turns();
    expect(turns[0]!.options.schema).toMatchObject({
      type: "object",
      required: ["description", "decision"],
    });
    expect(turns[1]!.prompt).toContain("did not satisfy the result contract");
    const activation = activationOf(done);
    expect(Object.keys(activation.outputs).sort()).toEqual(["decision", "description"]);
    expect(activation.session?.repairAttempts).toBe(1);
  });

  test("a decision outside the port's choices is repaired, not accepted", async () => {
    const { world, run } = await launched(
      {},
      {
        toolResults: false,
        script: async (turn, _tools, provider) => {
          provider.session(turn.sessionId).structured.set(turn.requestId, {
            ok: true,
            provider: "claude",
            requestId: turn.requestId,
            value: {
              description: TEST_DESCRIPTION,
              decision: { choice: turn.index === 1 ? "maybe" : "hold", rationale: "Wait." },
            },
          });
          return "idle";
        },
      },
    );
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    expect(world.provider.turns()).toHaveLength(2);
  });
});

describe("restart recovery", () => {
  test("a crash between the durable dispatching and the send re-sends under the same id", async () => {
    world = await graphAgentWorld({ script: submittingScript() });
    world.start();
    const run = await world.launch(agentTestTemplate(), {
      ticket: TEST_TICKET,
      target: TEST_WORKSPACE,
    });
    let crashed = false;
    let journaled: string | undefined;
    world.provider.beforeSend = async () => {
      if (crashed) return;
      crashed = true;
      const stored = await world!.run(run.id);
      journaled = activationOf(stored).session?.dispatchState;
      // The process dies here: the send never happens.
      await new Promise(() => {});
    };
    void world.current().service.advanceNow(run.id);
    while (!crashed) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(journaled).toBe("dispatching");
    world.restart();
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const turns = world.provider.turns();
    expect(turns).toHaveLength(1);
    expect(world.provider.duplicateDeliveries).toBe(0);
  });

  test("a send that landed before the crash is proven and observed, never run twice", async () => {
    world = await graphAgentWorld({ script: submittingScript() });
    world.start();
    const run = await world.launch(agentTestTemplate(), {
      ticket: TEST_TICKET,
      target: TEST_WORKSPACE,
    });
    let crashed = false;
    world.provider.beforeSend = async (turn) => {
      if (crashed) return;
      crashed = true;
      // The prompt reached the provider, then the backend died before the
      // send returned: a late delivery of the first attempt.
      world!.provider.deliver(world!.provider.session(turn.sessionId), turn);
      await new Promise(() => {});
    };
    void world.current().service.advanceNow(run.id);
    while (!crashed) await new Promise((resolve) => setTimeout(resolve, 5));
    world.restart();
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    expect(world.provider.deliveries).toHaveLength(1);
  });

  test("a dispatch the provider retired as lost fails the step", async () => {
    world = await graphAgentWorld({ script: submittingScript() });
    world.start();
    const run = await world.launch(agentTestTemplate(), {
      ticket: TEST_TICKET,
      target: TEST_WORKSPACE,
    });
    let crashed = false;
    world.provider.beforeSend = async (turn) => {
      if (crashed) return;
      crashed = true;
      world!.provider.journal.set(turn.requestId, "lost");
      await new Promise(() => {});
    };
    void world.current().service.advanceNow(run.id);
    while (!crashed) await new Promise((resolve) => setTimeout(resolve, 5));
    world.restart();
    const done = await world.drive(run.id);
    expect(done.status).toBe("failed");
    expect(activationOf(done).error).toContain("lost in a provider restart");
    expect(activationOf(done).errorCause).toBe("provider-error");
    expect(world.provider.deliveries).toHaveLength(0);
  });

  test("an unprovable dispatch parks within the idle bound and then fails, never re-sent", async () => {
    world = await graphAgentWorld({ script: submittingScript() });
    world.provider.provesAbsence = false;
    world.start();
    const run = await world.launch(agentTestTemplate(), {
      ticket: TEST_TICKET,
      target: TEST_WORKSPACE,
    });
    let crashed = false;
    world.provider.beforeSend = async () => {
      if (crashed) return;
      crashed = true;
      await new Promise(() => {});
    };
    void world.current().service.advanceNow(run.id);
    while (!crashed) await new Promise((resolve) => setTimeout(resolve, 5));
    world.restart();
    const done = await world.drive(run.id);
    expect(done.status).toBe("failed");
    expect(activationOf(done).error).toContain("acceptance could not be confirmed");
    expect(world.provider.deliveries).toHaveLength(0);
  });
});
