import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  PromptRejectedError,
  ProviderUnavailableError,
  TURN_STOPPED_BY_USER_MESSAGE,
} from "../agent-provider-contract.js";
import { FakeOpenCode2Server, fakeOpenCode2Model } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import {
  OPENCODE2_CAPABILITY_LIMITS,
  OPENCODE2_RUN_CUT_SHORT_MESSAGE,
  OPENCODE2_UNSETTLED_RUN_GRACE_MS,
  OpenCodeEnvironmentProvider,
  openCode2TurnTerminalError,
  type OpenCode2ServerConnection,
} from "./environment-provider.js";
import { openCode2ReloadGateCount } from "./reload-gate.js";
import type { OpenCode2Message } from "./types.js";
import { openCode2CoordinatorPolicy, openCode2CoordinatorSignature } from "./coordinator.js";

let server: FakeOpenCode2Server | undefined;
let router: OpenCodeEnvironmentProvider | undefined;
let peers: OpenCodeEnvironmentProvider[] = [];
afterEach(async () => {
  await router?.dispose();
  for (const peer of peers) await peer.dispose();
  server?.stop();
  router = undefined;
  server = undefined;
  peers = [];
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
  const build = () =>
    new OpenCodeEnvironmentProvider({
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
  router = build();
  /**
   * Another provider on the same environment server, as a pipeline, review,
   * graph or subork provider is: its own sessions, the same server.
   */
  const peer = () => {
    const provider = build();
    peers.push(provider);
    return provider;
  };
  return { server: fake, router, state, connections, created, peer };
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

  test("an MCP inventory read passes the caller's signal to the session's provider", async () => {
    const { router, created } = setup();
    const id = await router.createSession("build", "b");
    const provider = created.at(-1)!;
    const read = spyOn(provider, "mcpServers").mockImplementation(async () => []);
    const signal = new AbortController().signal;

    await router.mcpServers(id, { signal });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toBe(id);
    expect(read.mock.calls[0]![1]?.signal).toBe(signal);
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

  test("an MCP reload is refused while another provider's session runs on the shared server", async () => {
    const refreshConfiguration = mock(async () => {});
    const { server, router, peer } = setup({ refreshConfiguration });
    // The tab's own session is idle; a pipeline's session on the same server is not.
    await router.createSession("build", "tab");
    const pipeline = peer();
    const workflowSession = await pipeline.createSession("build", "pipeline");
    await pipeline.send(workflowSession, "keep working", { requestId: "req-w" });

    expect(await router.reloadMcpConfiguration()).toBe("busy");
    expect(refreshConfiguration).not.toHaveBeenCalled();
    expect(server.calls.some((call) => call.path === "/api/location/reload")).toBe(false);

    // A session no provider in this backend registered counts as well.
    server.finishRun(workflowSession);
    expect(await router.reloadMcpConfiguration()).toBe("reloaded");
    const stray = await pipeline.createSession("build", "stray");
    pipeline.releaseSession(stray);
    server.sessions.get(stray)!.running = true;
    expect(await router.reloadMcpConfiguration()).toBe("busy");
    expect(server.calls.filter((call) => call.path === "/api/location/reload")).toHaveLength(1);
  });

  test("a dispatch that arrives during a reload waits for it, on every provider of the server", async () => {
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => (refreshStarted = resolve));
    const refreshConfiguration = mock(
      () =>
        new Promise<void>((resolve) => {
          releaseRefresh = resolve;
          refreshStarted();
        }),
    );
    const { server, router, peer } = setup({ refreshConfiguration });
    const id = await router.createSession("build", "tab");
    const pipeline = peer();
    const workflowSession = await pipeline.createSession("build", "pipeline");

    const reload = router.reloadMcpConfiguration();
    await started;
    // Idle at the reload's check; both prompts arrive while it rewrites the configuration.
    const tabPrompt = router.send(id, "after the reload", { requestId: "req-tab" });
    const pipelinePrompt = pipeline.send(workflowSession, "after the reload too", {
      requestId: "req-pipeline",
    });
    // A second reload while one runs is refused rather than queued behind it.
    expect(await pipeline.reloadMcpConfiguration()).toBe("busy");

    releaseRefresh();
    expect(await reload).toBe("reloaded");
    await Promise.all([tabPrompt, pipelinePrompt]);
    // Both prompts reached the server only after the location was rebuilt:
    // had either slipped past the gate, it would have been sent while the
    // configuration rewrite was still paused, before the reload call.
    const paths = server.calls.map((call) => call.path);
    const reloadAt = paths.indexOf("/api/location/reload");
    expect(reloadAt).toBeGreaterThanOrEqual(0);
    expect(paths.lastIndexOf(`/api/session/${id}/prompt`)).toBeGreaterThan(reloadAt);
    expect(paths.lastIndexOf(`/api/session/${workflowSession}/prompt`)).toBeGreaterThan(reloadAt);
    expect(server.sessions.get(id)!.running).toBe(true);
    expect(openCode2ReloadGateCount()).toBe(0);
  });

  test("a conversation id from OpenCode 1.x reads as missing and is never recreated", async () => {
    // A tab that held a 1.x conversation keeps its id; the 2.x server never had it.
    const { server, router } = setup();
    const v1Id = "ses_1a2b3c4d5e6fV1conversation";
    expect(await router.status(v1Id)).toBe("missing");
    expect(await router.activity(v1Id)).toBe("idle");
    await expect(router.resumeSession(v1Id)).rejects.toBeInstanceOf(PromptRejectedError);
    await expect(router.resumeSession(v1Id)).rejects.toThrow("OpenCode session was not found");
    // Nothing was made under that id, and nothing was imported from 1.x.
    expect(server.sessions.has(v1Id)).toBe(false);
    expect(
      server.calls.some((call) => call.method === "POST" && call.path === "/api/session"),
    ).toBe(false);
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

describe("a run its server never settled", () => {
  const user = (id: string, requestId: string): OpenCode2Message => ({
    id,
    type: "user",
    text: "x",
    time: { created: 1 },
    metadata: { orkestrator: { requestId } },
  });
  const idle = (id: string): OpenCode2Message =>
    ({ id, type: "idle", outcome: "succeeded", time: { created: 1 } }) as OpenCode2Message;

  function unsettled(activity: { value: "idle" | "working" }, rows: OpenCode2Message[]) {
    let now = 1_000_000;
    // Only what `turnTerminalError` reads of the server's provider.
    const stub = {
      messages: async () => rows,
      activity: async () => activity.value,
      registerSession: () => {},
      dispose: async () => {},
    } as unknown as OpenCode2Provider;
    const provider = new OpenCodeEnvironmentProvider({
      connection: async () => ({
        baseUrl: "http://127.0.0.1:1",
        password: "pw",
        directory: "/work",
        generation: "g1",
      }),
      createProvider: () => stub,
      now: () => now,
    });
    peers.push(provider);
    return { provider, advance: (ms: number) => (now += ms) };
  }

  test("an idle server's unsettled run is cut short once the grace has passed", async () => {
    const { provider, advance } = unsettled({ value: "idle" }, [user("a", "r")]);
    await expect(provider.turnTerminalError("s", "r")).rejects.toThrow(ProviderUnavailableError);
    advance(OPENCODE2_UNSETTLED_RUN_GRACE_MS - 1);
    await expect(provider.turnTerminalError("s", "r")).rejects.toThrow(ProviderUnavailableError);
    advance(1);
    expect(await provider.turnTerminalError("s", "r")).toBe(OPENCODE2_RUN_CUT_SHORT_MESSAGE);
  });

  test("a server still running the turn is never given up on", async () => {
    const activity = { value: "working" as "idle" | "working" };
    const { provider, advance } = unsettled(activity, [user("a", "r")]);
    for (let read = 0; read < 3; read += 1) {
      await expect(provider.turnTerminalError("s", "r")).rejects.toThrow(ProviderUnavailableError);
      advance(OPENCODE2_UNSETTLED_RUN_GRACE_MS);
    }
    // Idle from here on: the grace starts again rather than counting the busy time.
    activity.value = "idle";
    await expect(provider.turnTerminalError("s", "r")).rejects.toThrow(ProviderUnavailableError);
    advance(OPENCODE2_UNSETTLED_RUN_GRACE_MS);
    expect(await provider.turnTerminalError("s", "r")).toBe(OPENCODE2_RUN_CUT_SHORT_MESSAGE);
  });

  test("a boundary row that arrives within the grace is read as written", async () => {
    const rows = [user("a", "r")];
    const { provider, advance } = unsettled({ value: "idle" }, rows);
    await expect(provider.turnTerminalError("s", "r")).rejects.toThrow(ProviderUnavailableError);
    advance(1_000);
    rows.push(idle("b"));
    expect(await provider.turnTerminalError("s", "r")).toBeNull();
    // Settled requests are forgotten, so a later unsettled read starts afresh.
    rows.pop();
    advance(OPENCODE2_UNSETTLED_RUN_GRACE_MS);
    await expect(provider.turnTerminalError("s", "r")).rejects.toThrow(ProviderUnavailableError);
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
