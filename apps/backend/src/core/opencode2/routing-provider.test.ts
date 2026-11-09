import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  PromptRejectedError,
  ProviderUnavailableError,
  TURN_STOPPED_BY_USER_MESSAGE,
} from "../agent-provider-contract.js";
import type { OpenCodeProvider } from "../opencode-provider.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import {
  OPENCODE2_CAPABILITY_LIMITS,
  OpenCodeRoutingProvider,
  openCode2TurnTerminalError,
  type OpenCode2RouteConnection,
} from "./routing-provider.js";
import type { OpenCode2Message } from "./types.js";

let server: FakeOpenCode2Server | undefined;
let router: OpenCodeRoutingProvider | undefined;
afterEach(async () => {
  await router?.dispose();
  server?.stop();
  router = undefined;
  server = undefined;
});

function fakeLegacy() {
  let next = 0;
  const legacy = {
    usageMessageLimit: 100,
    messageReadLimit: 100,
    interactions: {
      listPendingInteractions: mock(async () => ({ version: 1, revision: 7, requests: [] })),
      resolveInteraction: mock(async () => ({ status: "applied" })),
    },
    registerSession: mock((_id: string) => {}),
    createSession: mock(async () => `ses_legacy_${++next}`),
    send: mock(async () => {}),
    status: mock(async () => "idle" as const),
    activity: mock(async () => "idle" as const),
    activityBatch: mock(
      async (ids: readonly string[]) => new Map(ids.map((id) => [id, "working" as const])),
    ),
    interactiveSnapshot: mock(async () => ({ status: "idle" as const, messages: ["legacy"] })),
    modelCatalog: mock(async () => [{ platform: "opencode", id: "fixture/fixture" }]),
    observationStreamLive: () => true,
    performSessionAction: mock(async () => ({ outcome: "applied" as const })),
    releaseSession: mock((_id: string) => {}),
    dispose: mock(async () => {}),
  };
  return { legacy, provider: legacy as unknown as OpenCodeProvider };
}

function setup(
  options: {
    persisted?: (sessionId: string) => Promise<"v2" | undefined>;
    running?: boolean;
  } = {},
) {
  server = new FakeOpenCode2Server();
  const fake = server;
  const { legacy, provider } = fakeLegacy();
  const connection: OpenCode2RouteConnection = {
    baseUrl: "http://127.0.0.1:1",
    password: "pw",
    directory: "/work",
    generation: "g1",
  };
  const state = { running: options.running ?? true, generation: "g1" };
  const connections: boolean[] = [];
  const created: OpenCode2Provider[] = [];
  router = new OpenCodeRoutingProvider(provider, {
    connection: async ({ start }) => {
      connections.push(start);
      if (start) state.running = true;
      return state.running ? { ...connection, generation: state.generation } : undefined;
    },
    persistedProtocol: options.persisted ?? (async () => undefined),
    createProvider: () => {
      const created2 = new OpenCode2Provider(fake.client(), {
        monitorEvents: false,
        // Every provider, so the fixture model reaches the picker.
        allowedModelProviders: async () => [],
      });
      created.push(created2);
      return created2;
    },
  });
  return { server: fake, legacy, router, state, connections, created };
}

describe("OpenCodeRoutingProvider", () => {
  test("new sessions go to 1.x unless created with the 2.x marker", async () => {
    const { server, legacy, router } = setup();
    const legacyId = await router.createSession("build", "a");
    expect(legacyId).toBe("ses_legacy_1");
    expect(router.knownLine(legacyId)).toBe("legacy");
    const v2Id = await router.createSession("build", "b", { openCodeProtocol: "v2" });
    expect(server.sessions.has(v2Id)).toBe(true);
    expect(router.knownLine(v2Id)).toBe("v2");
    expect(legacy.createSession).toHaveBeenCalledTimes(1);

    await router.send(v2Id, "hello", { requestId: "req-1" });
    expect(await router.dispatchStatus(v2Id, "req-1")).toBe("dispatched");
    await router.send(legacyId, "hello", { requestId: "req-2" });
    expect(legacy.send).toHaveBeenCalledTimes(1);
  });

  test("an unseen session follows its persisted marker, looked up once", async () => {
    const persisted = mock(async (id: string) => (id === "ses_v2" ? ("v2" as const) : undefined));
    const { legacy, router } = setup({ persisted });
    expect(await router.status("ses_v2")).toBe("idle");
    expect(await router.status("ses_v2")).toBe("idle");
    expect(legacy.status).not.toHaveBeenCalled();
    expect(await router.status("ses_old")).toBe("idle");
    expect(legacy.status).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledTimes(2);
  });

  test("a registration carrying the marker needs no lookup", async () => {
    const persisted = mock(async () => undefined);
    const { legacy, router } = setup({ persisted });
    router.registerSession("ses_x", {
      origin: "interactive-native",
      interactionPolicy: { mode: "interactive" } as never,
      openCodeProtocol: "v2",
    });
    expect(await router.steerSupported("ses_x")).toBe(true);
    expect(persisted).not.toHaveBeenCalled();
    expect(legacy.registerSession).not.toHaveBeenCalled();
  });

  test("a failed lookup is an error, never a 1.x answer", async () => {
    const { legacy, router } = setup({
      persisted: async () => {
        throw new Error("storage unavailable");
      },
    });
    await expect(router.status("ses_unknown")).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(legacy.status).not.toHaveBeenCalled();
  });

  test("observers never start the 2.x server and read a stopped one as idle", async () => {
    const { legacy, router, connections } = setup({
      persisted: async (id) => (id.startsWith("v2") ? "v2" : undefined),
      running: false,
    });
    const batch = await router.activityBatch(["v2-a", "old-a", "v2-b"]);
    expect(Object.fromEntries(batch)).toEqual({
      "v2-a": "idle",
      "old-a": "working",
      "v2-b": "idle",
    });
    expect(await router.activity("v2-a")).toBe("idle");
    expect(connections.every((start) => start === false)).toBe(true);
    expect(legacy.activityBatch).toHaveBeenCalledWith(["old-a"]);
  });

  test("steering is offered to 2.x sessions only", async () => {
    const { router } = setup();
    const legacyId = await router.createSession("build", "a");
    const v2Id = await router.createSession("build", "b", { openCodeProtocol: "v2" });
    expect(await router.steerSupported(legacyId)).toBe(false);
    expect(await router.steerSupported(v2Id)).toBe(true);
    await expect(
      router.performSessionAction(legacyId, {
        kind: "steer",
        text: "x",
        requestId: "r",
        expectedRunId: "run",
      }),
    ).rejects.toBeInstanceOf(PromptRejectedError);
    expect(await router.activeSteerRun(v2Id)).toEqual({ state: "idle" });
  });

  test("a 2.x snapshot narrows capabilities and shows its transcript", async () => {
    const { server, router } = setup();
    const id = await router.createSession("build", "b", { openCodeProtocol: "v2" });
    await router.send(id, "hello there", { requestId: "req-1" });
    server.finishRun(id);
    const snapshot = await router.interactiveSnapshot(id);
    expect(snapshot.capabilityLimits).toEqual(OPENCODE2_CAPABILITY_LIMITS);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]).toMatchObject({ role: "user", content: "hello there" });
    expect(snapshot.messages[1]).toMatchObject({ role: "assistant" });
    // The 2.x server's own catalogue, with its variants as the effort axis.
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
  });

  test("a 2.x session forks, resumes and lists on 2.x, and keeps its line on adoption", async () => {
    const { server, legacy, router } = setup();
    const id = await router.createSession("build", "b", { openCodeProtocol: "v2" });
    await router.send(id, "hello there", { requestId: "req-1" });
    server.finishRun(id);
    const firstUser = server.sessions.get(id)!.rows.find((row) => row.type === "user")!.id;
    const fork = await router.forkSession(id, firstUser);
    expect(server.sessions.has(fork.sessionId)).toBe(true);
    expect(router.knownLine(fork.sessionId)).toBe("v2");
    expect(await router.sessionProtocol(fork.sessionId)).toBe("v2");
    expect(await router.sessionProtocol("ses_legacy_unknown")).toBeUndefined();

    (legacy as { listResumableSessions?: unknown }).listResumableSessions = mock(async () => [
      { sessionId: "ses_legacy_9" },
    ]);
    // Not preferred and running: the running 2.x server is listed.
    const listed = await router.listResumableSessions();
    expect(listed.map((entry) => entry.sessionId)).toContain("ses_legacy_9");
    expect(listed.map((entry) => entry.sessionId)).toContain(`opencode2:${id}`);

    router.releaseSession(id);
    expect(router.knownLine(id)).toBeUndefined();
    // The prefixed id names its line even after the router forgot it.
    expect(await router.resumeSession(`opencode2:${id}`)).toBe(id);
    expect(router.knownLine(id)).toBe("v2");
    await expect(router.resumeSession("opencode2:ses_missing")).rejects.toBeInstanceOf(
      PromptRejectedError,
    );
  });

  test("a 2.x session's cards, rule details, pages and usage come from the 2.x provider", async () => {
    const { server, legacy, router, state } = setup();
    const id = await router.createSession("build", "b", { openCodeProtocol: "v2" });
    const session = server.sessions.get(id)!;
    session.permissions.push({ id: "per_1", sessionID: id, action: "shell", resources: ["ls"] });
    const [card] = (await router.interactions.listPendingInteractions(id)).requests;
    expect(card).toMatchObject({
      kind: "permission",
      presentation: { confirmLabel: "Allow once" },
    });
    expect(legacy.interactions.listPendingInteractions).not.toHaveBeenCalled();
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
    expect(await router.refreshUsage("ses_legacy_x")).toBeUndefined();
    const window = await router.transcriptSnapshot(id, { limit: 10, targetBytes: 1e6 });
    expect(window).toMatchObject({ complete: true, historyPageable: true });
    // An observer never starts the server: with none running, nothing is pending.
    state.running = false;
    session.permissions.push({ id: "per_2", sessionID: id, action: "shell", resources: ["ls"] });
    expect((await router.interactions.listPendingInteractions(id)).requests).toEqual([]);
    expect(
      (await router.interactions.resolveInteraction(id, card!.id, applied as never)).result,
    ).toBe("stale");
  });

  test("a replaced 2.x server gets a new provider and the old one is disposed", async () => {
    const { router, state, created } = setup();
    const id = await router.createSession("build", "b", { openCodeProtocol: "v2" });
    expect(created).toHaveLength(1);
    const dispose = mock(created[0]!.dispose.bind(created[0]!));
    created[0]!.dispose = dispose;
    state.generation = "g2";
    await router.status(id);
    expect(created).toHaveLength(2);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("the observation stream is not trusted while a 2.x session is known", async () => {
    const { router } = setup();
    expect(router.observationStreamLive()).toBe(true);
    await router.createSession("build", "b", { openCodeProtocol: "v2" });
    expect(router.observationStreamLive()).toBe(false);
  });

  test("release forgets the line, and dispose disposes both providers", async () => {
    const { legacy, router } = setup();
    const id = await router.createSession("build", "b", { openCodeProtocol: "v2" });
    router.releaseSession(id);
    expect(router.knownLine(id)).toBeUndefined();
    expect(legacy.releaseSession).not.toHaveBeenCalled();
    await router.dispose();
    expect(legacy.dispose).toHaveBeenCalledTimes(1);
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
