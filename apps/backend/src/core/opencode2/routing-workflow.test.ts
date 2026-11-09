import { afterEach, describe, expect, mock, test } from "bun:test";
import { ProviderUnavailableError } from "../agent-provider-contract.js";
import type { OpenCodeProvider } from "../opencode-provider.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import { OpenCodeRoutingProvider, type OpenCodeRoutingDependencies } from "./routing-provider.js";

/** A workflow provider's router: it picks and records each new session's line itself. */
let server: FakeOpenCode2Server | undefined;
let router: OpenCodeRoutingProvider | undefined;
afterEach(async () => {
  await router?.dispose();
  server?.stop();
  router = undefined;
  server = undefined;
});

function setup(overrides: Partial<OpenCodeRoutingDependencies> = {}) {
  server = new FakeOpenCode2Server();
  const fake = server;
  const recorded = new Set<string>();
  const legacy = {
    interactions: {
      listPendingInteractions: mock(async () => ({ version: 1, revision: 0, requests: [] })),
      resolveInteraction: mock(async () => ({ status: "applied" })),
    },
    createSession: mock(async () => "ses_legacy_1"),
    settleTurn: mock(async () => true),
    structured: mock(async () => null),
    mcpServers: mock(async () => [{ id: "legacy" }]),
    registerSession: mock(() => {}),
    releaseSession: mock(() => {}),
    dispose: mock(async () => {}),
  };
  const deps: OpenCodeRoutingDependencies = {
    connection: async () => ({
      baseUrl: "http://127.0.0.1:1",
      password: "pw",
      directory: "/work",
      generation: "g1",
    }),
    persistedProtocol: async (id) => (recorded.has(id) ? "v2" : undefined),
    newSessionProtocol: async () => "v2",
    recordSession: async (id) => {
      recorded.add(id);
    },
    createProvider: () => new OpenCode2Provider(fake.client(), { monitorEvents: false }),
    ...overrides,
  };
  router = new OpenCodeRoutingProvider(legacy as unknown as OpenCodeProvider, deps);
  return { server: fake, legacy, router, recorded, deps };
}

describe("OpenCodeRoutingProvider for workflows", () => {
  test("a workflow session takes the line its policy picks and is recorded before it is handed out", async () => {
    const { server, legacy, router, recorded, deps } = setup();
    const id = await router.createSession("review", "reviewer", {});
    expect(server.sessions.has(id)).toBe(true);
    expect(recorded.has(id)).toBe(true);
    expect(legacy.createSession).not.toHaveBeenCalled();
    // A recreated provider finds it on 2.x through the record.
    expect(await deps.persistedProtocol(id)).toBe("v2");
    expect(await router.steerSupported(id)).toBe(true);
  });

  test("a session that cannot be recorded is not handed out", async () => {
    const { router } = setup({
      recordSession: async () => {
        throw new Error("full");
      },
    });
    await expect(router.createSession("review", "r", {})).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  test("an explicit marker (the interactive service) is never recorded here", async () => {
    const recordSession = mock(async () => {});
    const { router } = setup({ recordSession });
    await router.createSession("build", "tab", { openCodeProtocol: "v2" });
    expect(recordSession).not.toHaveBeenCalled();
  });

  test("a policy that keeps 1.x, or fails to answer, creates on 1.x", async () => {
    const declined = setup({ newSessionProtocol: async () => undefined });
    expect(await declined.router.createSession("review", "r", {})).toBe("ses_legacy_1");
    await declined.router.dispose();
    server?.stop();
    const failing = setup({
      newSessionProtocol: async () => {
        throw new Error("config unreadable");
      },
    });
    expect(await failing.router.createSession("review", "r", {})).toBe("ses_legacy_1");
  });

  test("results, settlement and MCP reach the 2.x provider for a 2.x session", async () => {
    const { server, legacy, router } = setup();
    const id = await router.createSession("plan", "p", {});
    await router.send(id, "plan", { requestId: "s-1", schema: { type: "object" }, readOnly: true });
    expect(await router.settleTurn(id, "s-1")).toBe(false);
    server.finishRun(id, "succeeded", '{"ok":true}');
    expect(await router.settleTurn(id, "s-1")).toBe(true);
    expect(await router.structured(id, "s-1")).toMatchObject({ ok: true, value: { ok: true } });
    server.mcp.set("github", { config: {}, status: "connected" });
    expect((await router.mcpServers(id)).map((server) => server.id)).toEqual(["github"]);
    expect(legacy.settleTurn).not.toHaveBeenCalled();
    expect(legacy.structured).not.toHaveBeenCalled();
    expect(legacy.mcpServers).not.toHaveBeenCalled();
  });
});
