import { afterEach, describe, expect, test } from "bun:test";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import { GraphAgentQuestionError } from "./graph-agent-questions.js";
import {
  TEST_TICKET,
  TEST_WORKSPACE,
  agentTestTemplate,
  graphAgentWorld,
  submittingScript,
  toolContent,
  type FakeAgentScript,
  type GraphAgentWorld,
} from "./graph-agent-test-support.js";

let world: GraphAgentWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

function activationOf(run: GraphRun): NodeActivation {
  const found = run.activations.filter((activation) => activation.nodeId === "describe").at(-1);
  if (!found) throw new Error("no activation");
  return found;
}

/** Asks once on the first turn, ends the turn, and submits on a later turn. */
function askingScript(outcomes: Record<string, unknown>[]): FakeAgentScript {
  return async (turn, tools, provider) => {
    if (turn.index === 1) {
      outcomes.push(
        toolContent(
          await tools.call("ask_human", {
            question: "Should the export include hidden columns?",
            choices: ["yes", "no"],
          }),
        ),
      );
      const outcome = outcomes.at(-1)!;
      if (outcome.status === "waiting") return "idle";
    }
    return submittingScript()(turn, tools, provider);
  };
}

async function waitingRun(holdMs = 30, script?: FakeAgentScript) {
  const outcomes: Record<string, unknown>[] = [];
  world = await graphAgentWorld({ script: script ?? askingScript(outcomes) });
  world.start({ holdMs });
  const run = await world.launch(agentTestTemplate({ askHuman: true }), {
    ticket: TEST_TICKET,
    target: TEST_WORKSPACE,
  });
  const waiting = await world.drive(run.id, (current) => current.status === "waiting", 20);
  return { world, run, waiting, outcomes };
}

describe("ask_human", () => {
  test("a question pauses the activation and the run shows waiting for you", async () => {
    const { world, waiting, outcomes } = await waitingRun();
    expect(waiting.status).toBe("waiting");
    const activation = activationOf(waiting);
    expect(activation.state).toBe("awaiting-human");
    expect(activation.session?.question).toMatchObject({
      text: "Should the export include hidden columns?",
      choices: ["yes", "no"],
    });
    expect(activation.session?.question?.answer).toBeUndefined();
    // The hold ended: the agent was told to end its turn.
    expect(outcomes[0]).toMatchObject({ ok: true, status: "waiting" });
    // Further passes neither poll the provider for a result nor fail it.
    const still = await world.drive(waiting.id, () => false, 8);
    expect(activationOf(still).state).toBe("awaiting-human");
    expect(world.provider.turns()).toHaveLength(1);
  });

  test("an answer after the hold arrives as the next turn and the step completes", async () => {
    const { world, waiting } = await waitingRun();
    const question = activationOf(waiting).session!.question!;
    await world
      .current()
      .wiring.questions.answer(
        { runId: waiting.id, activationKey: activationOf(waiting).key },
        { questionId: question.id, kind: "answered", choice: "no", text: "Only visible ones." },
        "user",
      );
    const done = await world.drive(waiting.id);
    expect(done.status).toBe("complete");
    const turns = world.provider.turns();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.sessionId).toBe(turns[0]!.sessionId);
    expect(turns[1]!.prompt).toContain("Only visible ones.");
    expect(turns[1]!.prompt).toContain("orkestrator-evidence");
    expect(activationOf(done).session?.question?.delivered).toBe("turn");
  });

  test("an answer within the hold returns as the tool result", async () => {
    const outcomes: Record<string, unknown>[] = [];
    world = await graphAgentWorld({ script: askingScript(outcomes) });
    const process = world.start({ holdMs: 5_000 });
    const run = await world.launch(agentTestTemplate({ askHuman: true }), {
      ticket: TEST_TICKET,
      target: TEST_WORKSPACE,
    });
    // Dispatch; the agent's ask_human call is now holding.
    await process.service.advanceNow(run.id);
    let asked: NodeActivation | undefined;
    for (let attempt = 0; attempt < 200 && !asked?.session?.question; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      asked = activationOf(await world.run(run.id));
    }
    const question = asked!.session!.question!;
    await process.wiring.questions.answer(
      { runId: run.id, activationKey: asked!.key },
      { questionId: question.id, kind: "answered", choice: "yes" },
      "user",
    );
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    expect(outcomes[0]).toMatchObject({ ok: true, status: "answered" });
    expect(String(outcomes[0]!.answer)).toContain("Choice: yes");
    // One turn: the answer never travelled as a second one.
    expect(world.provider.turns()).toHaveLength(1);
    expect(activationOf(done).session?.question?.delivered).toBe("tool");
  });

  test("survives a backend restart while waiting", async () => {
    const { world, waiting } = await waitingRun();
    const question = activationOf(waiting).session!.question!;
    const restarted = world.restart();
    // The new process recovers the waiting activation without dispatching.
    const recovered = await world.drive(waiting.id, () => false, 3);
    expect(activationOf(recovered).state).toBe("awaiting-human");
    expect(recovered.status).toBe("waiting");
    await restarted.wiring.questions.answer(
      { runId: waiting.id, activationKey: activationOf(waiting).key },
      { questionId: question.id, kind: "declined" },
      "user",
    );
    const done = await world.drive(waiting.id);
    expect(done.status).toBe("complete");
    const turns = world.provider.turns();
    expect(turns[1]!.prompt).toContain("The user declined to answer");
  });

  test("malformed, stale and repeated answers are refused and never delivered", async () => {
    const { world, waiting } = await waitingRun();
    const activation = activationOf(waiting);
    const question = activation.session!.question!;
    const questions = world.current().wiring.questions;
    const location = { runId: waiting.id, activationKey: activation.key };
    const refused = async (input: Parameters<typeof questions.answer>[1]) => {
      try {
        await questions.answer(location, input, "user");
        return null;
      } catch (error) {
        return error instanceof GraphAgentQuestionError ? error.code : String(error);
      }
    };
    expect(await refused({ questionId: crypto.randomUUID(), kind: "answered", text: "x" })).toBe(
      "invalid-answer",
    );
    expect(await refused({ questionId: question.id, kind: "answered" })).toBe("invalid-answer");
    expect(await refused({ questionId: question.id, kind: "answered", choice: "maybe" })).toBe(
      "invalid-answer",
    );
    expect(
      await refused({ questionId: question.id, kind: "answered", text: "y".repeat(8_001) }),
    ).toBe("invalid-answer");
    expect(activationOf(await world.run(waiting.id)).session?.question?.answer).toBeUndefined();
    expect(await refused({ questionId: question.id, kind: "answered", text: "Yes" })).toBeNull();
    expect(await refused({ questionId: question.id, kind: "answered", text: "No" })).toBe(
      "invalid-answer",
    );
  });

  test("a cancelled run closes a waiting question", async () => {
    const { world, waiting } = await waitingRun();
    await world.current().service.cancel(waiting.id);
    const done = await world.drive(waiting.id);
    expect(done.status).toBe("cancelled");
    expect(activationOf(done).state).toBe("cancelled");
    expect(activationOf(done).session?.question?.answer).toBeUndefined();
  });

  test("the graph_run_answer command validates its arguments", async () => {
    const { world, waiting } = await waitingRun();
    const { registerGraphRunCommands } = await import("./commands-registry-graph-runs.js");
    const handlers = new Map<
      string,
      (args: Record<string, unknown>, context: unknown) => unknown
    >();
    registerGraphRunCommands(((name: string, handler: never) =>
      handlers.set(name, handler)) as never);
    const answer = handlers.get("graph_run_answer")!;
    const context = { graphQuestions: world.current().wiring.questions };
    const activation = activationOf(waiting);
    await expect(
      Promise.resolve(answer({ runId: waiting.id, activationKey: activation.key }, context)),
    ).rejects.toThrow("questionId is required");
    await expect(
      Promise.resolve(
        answer(
          {
            runId: waiting.id,
            activationKey: activation.key,
            questionId: activation.session!.question!.id,
            kind: "approve",
          },
          context,
        ),
      ),
    ).rejects.toThrow("kind must be one of");
    const result = (await answer(
      {
        runId: waiting.id,
        activationKey: activation.key,
        questionId: activation.session!.question!.id,
        kind: "answered",
        choice: "yes",
      },
      context,
    )) as { question: { answer?: { choice?: string } } };
    expect(result.question.answer?.choice).toBe("yes");
  });
});
