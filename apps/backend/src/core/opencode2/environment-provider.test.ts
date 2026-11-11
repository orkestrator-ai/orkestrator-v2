import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  PromptRejectedError,
  ProviderUnavailableError,
  TURN_STOPPED_BY_USER_MESSAGE,
} from "../agent-provider-contract.js";
import { FakeOpenCode2Server, fakeOpenCode2Model } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import {
  OPENCODE2_CAPABILITY_LIMITS,
  OpenCodeEnvironmentProvider,
  openCode2TurnTerminalError,
  type OpenCode2ServerConnection,
} from "./environment-provider.js";
import type { OpenCode2Message } from "./types.js";
import { openCode2CoordinatorPolicy, openCode2CoordinatorSignature } from "./coordinator.js";

let server: FakeOpenCode2Server | undefined;
let router: OpenCodeEnvironmentProvider | undefined;
afterEach(async () => {
  await router?.dispose();
  server?.stop();
  router = undefined;
  server = undefined;
});

function setup(options: { running?: boolean; refreshConfiguration?: () => Promise<void> } = {}) {
  server = new FakeOpenCode2Server();
  const fake = server;
  const connection: OpenCode2ServerConnection = {
    baseUrl: "http://127.0.0.1:1",
    password: "pw",
    directory: "/work",
    generation: "g1",
    ...(options.refreshConfiguration ? { refreshConfiguration: options.refreshConfiguration } : {}),
  };
  const state = { running: options.running ?? true, generation: "g1" };
  const connections: boolean[] = [];
  const created: OpenCode2Provider[] = [];
  router = new OpenCodeEnvironmentProvider({
    connection: async ({ start }) => {
      connections.push(start);
      if (start) state.running = true;
      return state.running ? { ...connection, generation: state.generation } : undefined;
    },
    createProvider: () => {
      const provider = new OpenCode2Provider(fake.client(), {
        monitorEvents: false,
        // Every provider, so the fixture model reaches the picker.
        allowedModelProviders: async () => [],
      });
      created.push(provider);
      return provider;
    },
  });
  return { server: fake, router, state, connections, created };
}

describe("OpenCodeEnvironmentProvider", () => {
  test("a new session is created and dispatched on the environment's server", async () => {
    const { server, router } = setup();
    const id = await router.createSession("build", "b");
    expect(server.sessions.has(id)).toBe(true);
    await router.send(id, "hello", { requestId: "req-1" });
    expect(await router.dispatchStatus(id, "req-1")).toBe("dispatched");
  });

  test("a new session's default model comes from the server's catalogue", async () => {
    const { server, router } = setup();
    server.models = [fakeOpenCode2Model("opencode", "beam-free")];
    const resolution = await router.resolveDefaultModel("opencode-go/beam-free");
    expect(resolution.modelId).toBe("opencode/beam-free");
    expect(resolution.substitution?.requestedModelId).toBe("opencode-go/beam-free");
    expect((await router.modelCatalog()).map((model) => model.id)).toEqual(["opencode/beam-free"]);
    expect(await router.connectedModelProviders()).toEqual(["opencode"]);
    expect((await router.rawModelCatalog()).map((model) => model.id)).toEqual([
      "opencode/beam-free",
    ]);
  });

  test("a /steer sent as a prompt is answered locally, never sent to the server", async () => {
    const { server, router } = setup();
    const id = await router.createSession("build", "b");
    await expect(
      router.send(id, "/steer also print the date", { requestId: "r-1" }),
    ).rejects.toThrow("There is no active OpenCode turn to steer");
    await expect(router.send(id, "/steer", { requestId: "u-1" })).rejects.toThrow(
      "Usage: /steer <instructions>",
    );
    expect(server.calls.some((call) => call.path.endsWith("/prompt"))).toBe(false);
  });

  test("observers never start the server and read a stopped one as idle", async () => {
    const { router, connections } = setup({ running: false });
    const batch = await router.activityBatch(["a", "b"]);
    expect(Object.fromEntries(batch)).toEqual({ a: "idle", b: "idle" });
    expect(await router.activity("a")).toBe("idle");
    expect(await router.authStatus()).toEqual({ state: "unknown" });
    expect(await router.mcpServers("a")).toEqual([]);
    expect(await router.commandCatalogue("a")).toMatchObject({ commands: [], status: "stale" });
    expect(await router.runtimeHealth("a")).toMatchObject({ authoritative: false });
    expect(connections.every((start) => start === false)).toBe(true);
  });

  test("every session can be steered", async () => {
    const { router } = setup();
    const id = await router.createSession("build", "b");
    expect(await router.steerSupported(id)).toBe(true);
    expect(await router.activeSteerRun(id)).toEqual({ state: "idle" });
  });

  test("a snapshot narrows capabilities and shows its transcript", async () => {
    const { server, router } = setup();
    const id = await router.createSession("build", "b");
    await router.send(id, "hello there", { requestId: "req-1" });
    server.finishRun(id);
    const snapshot = await router.interactiveSnapshot(id);
    expect(snapshot.capabilityLimits).toEqual(OPENCODE2_CAPABILITY_LIMITS);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]).toMatchObject({ role: "user", content: "hello there" });
    expect(snapshot.messages[1]).toMatchObject({ role: "assistant" });
    // The server's own catalogue, with its variants as the effort axis.
    expect(snapshot.composer?.models).toMatchObject([
      {
        platform: "opencode",
        id: "fixture/fixture",
        reasoning: [{ id: "default" }, { id: "low" }, { id: "high" }],
      },
    ]);
    expect(snapshot.composer?.executionProfiles?.map((profile) => profile.id)).toEqual([
      "build",
      "plan",
    ]);
    expect(snapshot.resumableSessionId).toBe(`opencode2:${id}`);
    const state = await router.sessionStateSnapshot(id);
    expect(state.capabilityLimits).toEqual(OPENCODE2_CAPABILITY_LIMITS);
    // A cursor this provider never minted expires rather than paging from a guess.
    expect(await router.transcriptPage(id, { cursor: "c", limit: 10, targetBytes: 1 })).toEqual({
      status: "expired",
    });
    expect((await router.commandCatalogue(id)).commands.map((command) => command.name)).toEqual([
      "/init",
      "/review",
    ]);
    expect(await router.interactions.listPendingInteractions(id)).toMatchObject({ requests: [] });
    expect(await router.messages(id)).toHaveLength(2);
  });

  test("a session forks, resumes and lists", async () => {
    const { server, router } = setup();
    const id = await router.createSession("build", "b");
    await router.send(id, "hello there", { requestId: "req-1" });
    server.finishRun(id);
    const firstUser = server.sessions.get(id)!.rows.find((row) => row.type === "user")!.id;
    const fork = await router.forkSession(id, firstUser);
    expect(server.sessions.has(fork.sessionId)).toBe(true);

    const listed = await router.listResumableSessions();
    expect(listed.map((entry) => entry.sessionId)).toContain(`opencode2:${id}`);

    router.releaseSession(id);
    expect(await router.resumeSession(`opencode2:${id}`)).toBe(id);
    await expect(router.resumeSession("opencode2:ses_missing")).rejects.toBeInstanceOf(
      PromptRejectedError,
    );
  });

  test("the resume picker archives and restores a conversation no tab holds", async () => {
    const { server, router } = setup();
    const id = await router.createSession("build", "b");
    // Held by its tab: refused, as Codex and Cursor refuse it.
    await expect(
      router.setResumableSessionArchived(`opencode2:${id}`, true),
    ).rejects.toBeInstanceOf(PromptRejectedError);
    expect(server.sessions.get(id)?.archived).toBeFalsy();
    await router.closeSession(id);
    await router.setResumableSessionArchived(`opencode2:${id}`, true);
    expect(server.sessions.get(id)?.archived).toBe(true);
    // The default list leaves the archived row out; the picker's list marks it.
    expect((await router.listResumableSessions()).map((entry) => entry.sessionId)).toEqual([]);
    expect(await router.listResumableSessions({ includeArchived: true })).toEqual([
      expect.objectContaining({ sessionId: `opencode2:${id}`, archived: true }),
    ]);
    await expect(router.resumeSession(`opencode2:${id}`)).rejects.toThrow("archived");

    await router.setResumableSessionArchived(`opencode2:${id}`, false);
    expect(server.sessions.get(id)?.archived).toBe(false);
    expect(await router.resumeSession(`opencode2:${id}`)).toBe(id);
  });

  test("cards, rule details, pages and usage come from the session's server", async () => {
    const { server, router, state } = setup();
    const id = await router.createSession("build", "b");
    const session = server.sessions.get(id)!;
    session.permissions.push({ id: "per_1", sessionID: id, action: "shell", resources: ["ls"] });
    const [card] = (await router.interactions.listPendingInteractions(id)).requests;
    expect(card).toMatchObject({
      kind: "permission",
      presentation: { confirmLabel: "Allow once" },
    });
    // Synchronous, as the permission-rule enforcer reads it.
    expect(router.interactions.permissionRuleDetail!(id, card!.id)).toEqual({
      subject: { kind: "command", command: "ls" },
      allowOnceAnswers: [],
    });
    expect(router.interactions.permissionRuleDetail!("ses_unknown", card!.id)).toBeNull();
    const applied = await router.interactions.resolveInteraction(id, card!.id, {
      version: 1,
      interactionId: card!.id,
      sessionId: id,
      action: "answer",
      answer: { version: 1, interactionId: card!.id, sessionId: id, answers: [] },
      resolvedAt: Date.now() + 1_000,
    });
    expect(applied.result).toBe("applied");
    expect(session.replies).toEqual([{ kind: "permission", id: "per_1", decision: "once" }]);
    session.info.cost = 0.5;
    session.info.tokens = { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } };
    expect(await router.refreshUsage(id)).toMatchObject({ sessionTokens: 7, costUsd: 0.5 });
    const window = await router.transcriptSnapshot(id, { limit: 10, targetBytes: 1e6 });
    expect(window).toMatchObject({ complete: true, historyPageable: true });
    // An observer never starts the server: with none running, nothing is pending.
    state.running = false;
    session.permissions.push({ id: "per_2", sessionID: id, action: "shell", resources: ["ls"] });
    expect((await router.interactions.listPendingInteractions(id)).requests).toEqual([]);
    expect(
      (await router.interactions.resolveInteraction(id, card!.id, applied as never)).result,
    ).toBe("stale");
    expect(await router.refreshUsage(id)).toBeUndefined();
  });

  test("a replaced server gets a new provider and the old one is disposed", async () => {
    const { router, state, created } = setup();
    const id = await router.createSession("build", "b");
    expect(created).toHaveLength(1);
    const dispose = mock(created[0]!.dispose.bind(created[0]!));
    created[0]!.dispose = dispose;
    state.generation = "g2";
    await router.status(id);
    expect(created).toHaveLength(2);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("closed sessions are not registered on a replacement generation", async () => {
    const { router, server, state } = setup();
    const closed = await router.createSession("build", "a");
    const open = await router.createSession("build", "b");
    await router.closeSession(closed);
    state.generation = "g2";
    await router.setResumableSessionArchived(`opencode2:${closed}`, true);
    expect(server.sessions.get(closed)?.archived).toBe(true);
    await expect(router.setResumableSessionArchived(`opencode2:${open}`, true)).rejects.toThrow(
      "open in a tab",
    );
    expect(server.sessions.get(open)?.archived).toBeFalsy();
  });

  test("the observation stream is never trusted: OpenCode events reach no hint yet", () => {
    const { router } = setup();
    expect(router.observationStreamLive()).toBe(false);
  });

  test("an MCP settings edit reloads an idle server's configuration", async () => {
    const refreshConfiguration = mock(async () => {});
    const { server, router } = setup({ refreshConfiguration });
    await router.createSession("build", "b");
    expect(await router.reloadMcpConfiguration()).toBe("reloaded");
    expect(refreshConfiguration).toHaveBeenCalledTimes(1);
    expect(server.calls.some((call) => call.path === "/api/location/reload")).toBe(true);
  });

  test("an MCP reload waits for work to finish, and needs a server it can rewrite", async () => {
    const refreshConfiguration = mock(async () => {});
    const { router } = setup({ refreshConfiguration });
    const id = await router.createSession("build", "b");
    await router.send(id, "keep working", { requestId: "req-1" });
    expect(await router.reloadMcpConfiguration()).toBe("busy");
    expect(refreshConfiguration).not.toHaveBeenCalled();

    const plain = setup();
    await plain.router.createSession("build", "c");
    expect(await plain.router.reloadMcpConfiguration()).toBe("unsupported");
    const stopped = setup({ running: false, refreshConfiguration });
    expect(await stopped.router.reloadMcpConfiguration()).toBe("not-running");
  });

  test("a disposed provider refuses further work", async () => {
    const { router } = setup();
    await router.dispose();
    await expect(router.createSession("build", "b")).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});

describe("openCode2TurnTerminalError", () => {
  const user = (id: string, requestId: string): OpenCode2Message => ({
    id,
    type: "user",
    text: "x",
    time: { created: 1 },
    metadata: { orkestrator: { requestId } },
  });
  const idle = (id: string, outcome: "succeeded" | "failed" | "interrupted"): OpenCode2Message =>
    ({ id, type: "idle", outcome, time: { created: 1 } }) as OpenCode2Message;

  test("reads the run boundary after the request's input", () => {
    expect(openCode2TurnTerminalError([user("a", "r"), idle("b", "succeeded")], "r")).toBeNull();
    expect(openCode2TurnTerminalError([user("a", "r"), idle("b", "interrupted")], "r")).toBe(
      TURN_STOPPED_BY_USER_MESSAGE,
    );
    expect(openCode2TurnTerminalError([user("a", "r"), idle("b", "failed")], "r")).toMatch(
      /failed/,
    );
    // An earlier run's boundary is not this request's.
    expect(
      openCode2TurnTerminalError(
        [idle("z", "failed"), user("a", "r"), idle("b", "succeeded")],
        "r",
      ),
    ).toBeNull();
  });

  test("throws while the run has not settled; an unknown request proves nothing", () => {
    expect(() => openCode2TurnTerminalError([user("a", "r")], "r")).toThrow(
      ProviderUnavailableError,
    );
    expect(openCode2TurnTerminalError([user("a", "other")], "r")).toBeNull();
  });
});

describe("a coordinator's server", () => {
  test("the server's launch authority reaches the provider it builds, and policy synchronization goes to it", async () => {
    server = new FakeOpenCode2Server();
    const research = { mode: "off" as const, servers: [] };
    const connection: OpenCode2ServerConnection = {
      baseUrl: server.baseUrl,
      password: "pw",
      directory: "/work",
      generation: "coordinator-g1",
      coordinator: {
        policy: openCode2CoordinatorPolicy("off"),
        research,
        signature: openCode2CoordinatorSignature(research),
        controlConnection: () => undefined,
      },
    };
    router = new OpenCodeEnvironmentProvider({ connection: async () => connection });
    const id = await router.createSession("coordinator", "Coordinator", {
      policy: openCode2CoordinatorPolicy("off"),
    });
    const session = server.sessions.get(id)!;
    expect(session.agent).toBe("plan");
    session.rules = [{ action: "*", resource: "*", effect: "allow" }];
    await router.synchronizeSessionPolicy(id, openCode2CoordinatorPolicy("off"));
    expect((session.rules as Array<{ effect: string }>)[0]?.effect).toBe("deny");
    await expect(
      router.synchronizeSessionPolicy(id, { ...openCode2CoordinatorPolicy("off"), id: "pipeline" }),
    ).rejects.toThrow(PromptRejectedError);
  });
});
