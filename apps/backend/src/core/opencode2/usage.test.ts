import { afterEach, describe, expect, test } from "bun:test";
import { TURN_STOPPED_BY_USER_MESSAGE } from "../agent-provider-contract.js";
import { FakeOpenCode2Server, fakeOpenCode2Model } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import type { OpenCode2Message } from "./types.js";
import { openCode2ContextUsage, openCode2TurnUsage } from "./usage.js";

const assistant = (id: string, tokens: object, cost: number, provider = "openai") =>
  ({
    id,
    type: "assistant",
    model: { providerID: provider, id: "gpt-5" },
    content: [],
    tokens,
    cost,
    time: { created: 1_700_000_000_000, completed: 1_700_000_002_000 },
  }) as unknown as OpenCode2Message;

describe("openCode2ContextUsage", () => {
  test("lifetime totals come from the session, occupancy from the newest response", () => {
    const usage = openCode2ContextUsage(
      {
        cost: 0.42,
        tokens: { input: 1_000, output: 200, reasoning: 50, cache: { read: 300, write: 10 } },
        model: { providerID: "openai", id: "gpt-5" },
      },
      [
        assistant(
          "msg_1",
          { input: 400, output: 20, reasoning: 0, cache: { read: 100, write: 5 } },
          0.1,
        ),
      ],
    )!;
    expect(usage).toMatchObject({
      usedTokens: 505,
      lastTurnTokens: 525,
      inputTokens: 1_000,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadTokens: 300,
      cacheWriteTokens: 10,
      sessionTokens: 1_510,
      costUsd: 0.42,
      costSource: "estimate",
      source: "opencode",
      modelId: "openai/gpt-5",
      updatedAt: new Date(1_700_000_002_000).toISOString(),
    });
    expect(usage.turns).toEqual([
      expect.objectContaining({
        turnId: "msg_1",
        costUsd: 0.1,
        costSource: "estimate",
        durationMs: 2_000,
        totalTokens: 525,
      }),
    ]);
  });

  test("nothing spent is no usage; a Copilot cost has no stated source", () => {
    expect(openCode2ContextUsage({ cost: 0, tokens: {} }, [])).toBeUndefined();
    const copilot = openCode2ContextUsage({ cost: 1, tokens: { input: 1, output: 1 } }, [
      assistant("m", { input: 1, output: 1 }, 1, "github-copilot"),
    ])!;
    expect(copilot.costSource).toBeUndefined();
    expect(
      openCode2TurnUsage([assistant("m", { input: 1 }, 1, "github-copilot")])[0]!.costSource,
    ).toBeUndefined();
  });
});

let server: FakeOpenCode2Server | undefined;
let provider: OpenCode2Provider | undefined;
afterEach(async () => {
  await provider?.dispose();
  server?.stop();
  provider = undefined;
  server = undefined;
});

describe("OpenCode 2 session state", () => {
  test("usage, model and a stopped run are read from the server", async () => {
    server = new FakeOpenCode2Server();
    server.models.push(fakeOpenCode2Model("openai", "gpt-5"));
    provider = new OpenCode2Provider(server.client(), { monitorEvents: false });
    const id = await provider.createSession("build", "x", { model: "openai/gpt-5" });
    const session = server.sessions.get(id)!;
    Object.assign(session.info, {
      title: "Fix the bug",
      cost: 0.2,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      outcome: "interrupted",
    });
    server.pushRow(id, assistant("msg_a", { input: 10, output: 5 }, 0.2) as never);
    const state = await provider.sessionState(id);
    expect(state).toMatchObject({
      status: "idle",
      phase: "idle",
      title: "Fix the bug",
      sessionModelId: "openai/gpt-5",
      lastAssistantModelId: "openai/gpt-5",
      notices: [{ kind: "stopped", message: TURN_STOPPED_BY_USER_MESSAGE }],
      contextUsage: { sessionTokens: 15, costUsd: 0.2, costSource: "estimate" },
    });
    expect(await provider.refreshUsage(id)).toMatchObject({ sessionTokens: 15, usedTokens: 10 });
  });

  test("a failed last run reads as an error with the run's own message", async () => {
    server = new FakeOpenCode2Server();
    provider = new OpenCode2Provider(server.client(), { monitorEvents: false });
    const id = await provider.createSession("build", "x");
    server.sessions.get(id)!.info.outcome = "failed";
    server.pushRow(id, { type: "idle", outcome: "failed", error: { message: "provider down" } });
    expect(await provider.sessionState(id)).toMatchObject({
      status: "error",
      phase: "error",
      error: "provider down",
      notices: [{ kind: "error", message: "provider down" }],
    });
  });

  test("a parked permission reads blocked, and the interactive snapshot carries the rows", async () => {
    server = new FakeOpenCode2Server();
    provider = new OpenCode2Provider(server.client(), { monitorEvents: false });
    const id = await provider.createSession("build", "x");
    await provider.send(id, "go", { requestId: "r1" });
    const session = server.sessions.get(id)!;
    session.permissions.push({ id: "per_1", sessionID: id, action: "shell", resources: ["ls"] });
    const interactive = await provider.interactiveState(id);
    expect(interactive).toMatchObject({
      status: "blocked",
      phase: "blocked",
      messagesComplete: true,
    });
    expect(interactive.messages).toEqual([
      expect.objectContaining({ role: "user", content: "go" }),
    ]);
    expect(interactive.notices).toBeUndefined();
  });

  test("a sub-agent card is filled from its child session", async () => {
    server = new FakeOpenCode2Server();
    provider = new OpenCode2Provider(server.client(), { monitorEvents: false });
    const parent = await provider.createSession("build", "x");
    const child = await server.client().createSession({});
    server.pushRow(child.id, {
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "c1",
          name: "read",
          state: { status: "completed", input: { path: "a" }, content: [] },
        },
      ],
    });
    server.pushRow(parent, {
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "s1",
          name: "subagent",
          state: {
            status: "completed",
            input: { agent: "explore", description: "Look", prompt: "p" },
            metadata: { sessionID: child.id, status: "completed" },
            content: [],
          },
        },
      ],
    });
    const { messages } = await provider.interactiveState(parent);
    expect((messages[0]!.parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "subagent",
      subagentId: child.id,
      subagentActionCount: 1,
      subagentActions: [expect.objectContaining({ toolName: "read" })],
    });
  });
});
