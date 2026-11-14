import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import {
  exclusiveOpenCode2Reload,
  openCode2ReloadGateKey,
  withinOpenCode2Dispatch,
} from "./reload-gate.js";

/**
 * The always-run half of to-do 7905 tasks 2 and 3, on the fake server: the
 * provider's own bookkeeping when sessions share one server, and a steer sent
 * while the run waits on a card. What the real 2.2.6 server does with them
 * (overlapping runs, delivery order behind a card) is pinned by
 * `opencode2-concurrency.live.test.ts` and `opencode2-steer-cards.live.test.ts`.
 */

let server: FakeOpenCode2Server | undefined;
const providers: OpenCode2Provider[] = [];
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.dispose();
  server?.stop();
  server = undefined;
});

function provider(fake: FakeOpenCode2Server): OpenCode2Provider {
  const created = new OpenCode2Provider(fake.client(), { monitorEvents: false });
  providers.push(created);
  return created;
}

async function steer(on: OpenCode2Provider, sessionId: string, text: string, requestId: string) {
  const run = await on.activeSteerRun(sessionId);
  expect(run.state).toBe("running");
  return on.performSessionAction(sessionId, {
    kind: "steer",
    text,
    requestId,
    expectedRunId: (run as { runId: string }).runId,
  });
}

/** User texts of a session's history, oldest first, and where its runs ended. */
function timeline(fake: FakeOpenCode2Server, sessionId: string): string[] {
  return fake.sessions.get(sessionId)!.rows.flatMap((row) => {
    if (row.type === "user") return [`user:${String(row.text)}`];
    if (row.type === "idle") return [`idle:${String(row.outcome)}`];
    return [];
  });
}

describe("concurrent sessions on one server (to-do 7905 task 2)", () => {
  test("two providers and two sessions each settle their own turn, and a steer reaches only its session", async () => {
    server = new FakeOpenCode2Server();
    const tab = provider(server);
    const pipeline = provider(server);
    const gate = openCode2ReloadGateKey({ baseUrl: "http://fake.invalid", generation: "g1" });
    const [one, two, three] = await Promise.all([
      tab.createSession("build", "tab one"),
      tab.createSession("build", "tab two"),
      pipeline.createSession("build", "pipeline"),
    ]);
    const owner = (id: string) => (id === three ? pipeline : tab);
    const sessions = [one, two, three];
    await Promise.all(
      sessions.map((id, index) =>
        withinOpenCode2Dispatch(gate, () =>
          owner(id).send(id, `work ${index}`, { requestId: `concurrent-${index}` }),
        ),
      ),
    );
    expect(await tab.activityBatch([one, two])).toEqual(
      new Map([
        [one, "working"],
        [two, "working"],
      ]),
    );
    expect(await pipeline.status(three)).toBe("running");

    // A reload asked for while a dispatch holds the shared gate is refused.
    let release!: () => void;
    const holding = withinOpenCode2Dispatch(
      gate,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    expect(await exclusiveOpenCode2Reload(gate, async () => "reloaded")).toBe("busy");
    release();
    await holding;

    expect(
      await withinOpenCode2Dispatch(gate, () => steer(tab, one, "only one", "concurrent-steer")),
    ).toEqual({ outcome: "applied", requestId: "concurrent-steer" });

    // The runs settle in another order than they started.
    for (const id of [three, one, two]) server.finishRun(id);
    for (const [index, id] of sessions.entries()) {
      expect(await owner(id).status(id)).toBe("idle");
      expect(await owner(id).dispatchStatus(id, `concurrent-${index}`)).toBe("dispatched");
      expect(await owner(id).settleTurn(id, `concurrent-${index}`)).toBe(true);
    }
    expect(await tab.steerStatus(one, "concurrent-steer")).toBe("dispatched");
    expect(await tab.steerStatus(two, "concurrent-steer")).toBe("unknown");
    expect(await pipeline.steerStatus(three, "concurrent-steer")).toBe("unknown");
    expect(timeline(server, one)).toEqual(["user:work 0", "user:only one", "idle:succeeded"]);
    expect(timeline(server, two)).toEqual(["user:work 1", "idle:succeeded"]);
    expect(timeline(server, three)).toEqual(["user:work 2", "idle:succeeded"]);
  });
});

function resolution(
  sessionId: string,
  interactionId: string,
  action: AgentInteractionResolution["action"],
): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId,
    sessionId,
    action,
    // Allowing a permission answers it with no questions.
    ...(action === "answer"
      ? {
          answer: {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            interactionId,
            sessionId,
            answers: [],
          },
        }
      : {}),
    resolvedAt: Date.now() + 1_000,
  };
}

describe("a steer sent while a card is parked (to-do 7905 task 3)", () => {
  for (const decision of ["allowed", "denied"] as const) {
    test(`waits behind a permission card and joins the same run once it is ${decision}`, async () => {
      server = new FakeOpenCode2Server();
      const p = provider(server);
      const id = await p.createSession("build", "card");
      await p.send(id, "run a command", { requestId: "card-turn" });
      server.sessions.get(id)!.permissions.push({
        id: "per_1",
        sessionID: id,
        action: "shell",
        resources: ["echo parked"],
      });
      expect(await p.activity(id)).toBe("waiting");
      const [card] = (await p.interactions.listPendingInteractions(id)).requests;
      expect(card?.kind).toBe("permission");

      expect(await steer(p, id, "behind the card", "card-steer")).toEqual({
        outcome: "applied",
        requestId: "card-steer",
      });
      expect(await p.steerStatus(id, "card-steer")).toBe("dispatched");
      // Held in the inbox; the card is still the run's pending request.
      expect(server.sessions.get(id)!.inbox).toHaveLength(1);
      expect((await p.interactions.listPendingInteractions(id)).requests.map((r) => r.id)).toEqual([
        card!.id,
      ]);
      expect(await p.activity(id)).toBe("waiting");

      expect(
        (
          await p.interactions.resolveInteraction(
            id,
            card!.id,
            resolution(id, card!.id, decision === "allowed" ? "answer" : "deny"),
          )
        ).result,
      ).toBe("applied");
      expect(server.sessions.get(id)!.replies).toEqual([
        { kind: "permission", id: "per_1", decision: decision === "allowed" ? "once" : "reject" },
      ]);
      expect(await p.activity(id)).toBe("working");
      server.stepBoundary(id);
      expect(server.sessions.get(id)!.inbox).toEqual([]);
      server.finishRun(id);
      expect(await p.status(id)).toBe("idle");
      expect(timeline(server, id)).toEqual([
        "user:run a command",
        "user:behind the card",
        "idle:succeeded",
      ]);
      expect(await p.settleTurn(id, "card-steer")).toBe(true);
    });
  }

  test("a stop leaves the held steer in the inbox (to-do 8100)", async () => {
    server = new FakeOpenCode2Server();
    const p = provider(server);
    const id = await p.createSession("build", "card-stop");
    await p.send(id, "run a command", { requestId: "stop-turn" });
    server.sessions.get(id)!.permissions.push({
      id: "per_1",
      sessionID: id,
      action: "shell",
      resources: ["echo parked"],
    });
    expect(await steer(p, id, "held", "stop-steer")).toMatchObject({ outcome: "applied" });
    await p.abort(id);
    expect((await p.interactions.listPendingInteractions(id)).requests).toEqual([]);
    expect(await p.activity(id)).toBe("idle");
    expect(server.sessions.get(id)!.inbox).toHaveLength(1);
    expect(timeline(server, id)).toEqual(["user:run a command", "idle:interrupted"]);

    // The next prompt's run delivers the held steer first, as 2.2.6 does.
    await p.send(id, "the next prompt", { requestId: "after-stop" });
    server.finishRun(id);
    expect(timeline(server, id)).toEqual([
      "user:run a command",
      "idle:interrupted",
      "user:held",
      "user:the next prompt",
      "idle:succeeded",
    ]);
  });
});
