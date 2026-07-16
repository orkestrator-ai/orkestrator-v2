import { afterEach, describe, expect, mock, test } from "bun:test";
import type { StoredDesktopConnections } from "@orkestrator/protocol/connections";
import { ConnectionManager, type SecureStorage } from "../../../apps/desktop/electron/connection-manager";

const originalFetch = globalThis.fetch;
const token = "gateway-token-123456";

function encrypted(value: string): string {
  return Buffer.from(`protected:${value}`).toString("base64");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function secureStorage(available = true, shouldReEncrypt = false): SecureStorage {
  return {
    isAsyncEncryptionAvailable: mock(async () => available),
    encryptStringAsync: mock(async (value: string) => Buffer.from(`protected:${value}`)),
    decryptStringAsync: mock(async (value: Buffer) => ({
      result: value.toString().replace(/^protected:/, ""),
      shouldReEncrypt,
    })),
    getSelectedStorageBackend: () => "gnome_libsecret",
  };
}

function localBackendHarness(initial?: StoredDesktopConnections) {
  let stored = initial ?? { activeConnectionId: "local", connections: [] };
  let nextSaveError: Error | null = null;
  const invoke = mock(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_desktop_connections") return stored;
    if (command === "save_desktop_connections") {
      if (nextSaveError) {
        const error = nextSaveError;
        nextSaveError = null;
        throw error;
      }
      stored = args.desktopConnections as StoredDesktopConnections;
      return undefined;
    }
    return { local: true, command };
  });
  return {
    backend: {
      invoke,
      getWebClientStatus: mock(async () => ({ enabled: true, running: true, url: null, error: null })),
      setWebClientEnabled: mock(async () => ({ enabled: true, running: true, url: null, error: null })),
      resetWebClientServe: mock(async () => ({ enabled: true, running: true, url: null, error: null })),
      getTokenSettings: mock(async () => ({ token, editable: true as const, source: "file" as const })),
      setToken: mock(async (nextToken: string) => ({ token: nextToken, editable: true as const, source: "file" as const })),
    },
    getStored: () => stored,
    failNextSave: (error = new Error("config disk full")) => {
      nextSaveError = error;
    },
  };
}

function installHealthyRemoteFetch(): void {
  globalThis.fetch = mock(async (input, init) => {
    if (String(input).endsWith("/__orkestrator/events")) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
}

describe("Electron connection manager", () => {
  test("encrypts remote credentials, routes commands, and returns to Local", async () => {
    const local = localBackendHarness();
    const remoteRequests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = mock(async (input, init) => {
      const url = String(input);
      remoteRequests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/__orkestrator/events")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      if (url.endsWith("/__orkestrator/status")) {
        return new Response(JSON.stringify({ ok: true }));
      }
      const body = JSON.parse(String(init?.body)) as { command?: string };
      return new Response(JSON.stringify({ result: body.command === "get_projects" ? [{ id: "remote-project" }] : {} }));
    }) as unknown as typeof fetch;

    const onEvent = mock(() => undefined);
    const manager = new ConnectionManager({
      localBackend: local.backend,
      secureStorage: secureStorage(),
      onEvent,
      platform: "darwin",
    });
    await manager.initialize();
    await manager.connect({ address: "desk.tailnet.ts.net", token });

    const saved = local.getStored();
    expect(saved.activeConnectionId).not.toBe("local");
    expect(saved.connections).toHaveLength(1);
    expect(saved.connections[0]?.encryptedToken).not.toContain(token);
    expect(JSON.stringify(saved)).not.toContain(`\"token\":\"${token}\"`);
    expect(manager.getList().connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Local", active: false }),
      expect.objectContaining({ name: "desk.tailnet.ts.net", active: true }),
    ]));
    expect(manager.getRendererRequestAuthorization("https://desk.tailnet.ts.net/__orkestrator/proxy/loopback/3000")).toBe(`Bearer ${token}`);
    expect(manager.getRendererRequestAuthorization("https://desk.tailnet.ts.net/unrelated")).toBeNull();
    manager.handleLocalEvent("local-event", { ignored: true });
    expect(onEvent).not.toHaveBeenCalled();

    await expect(manager.invoke("get_projects")).resolves.toEqual([{ id: "remote-project" }]);
    expect(remoteRequests.some((request) => request.authorization === `Bearer ${token}`)).toBe(true);

    await manager.use("local");
    manager.handleLocalEvent("local-event", { ignored: false });
    expect(onEvent).toHaveBeenCalledWith("local-event", { ignored: false });
    await expect(manager.invoke("get_projects")).resolves.toEqual({ local: true, command: "get_projects" });
    expect(manager.getRendererRequestAuthorization("https://desk.tailnet.ts.net/__orkestrator/status")).toBeNull();
  });

  test("requires HTTPS and falls back to a session-only token when secure storage is unavailable", async () => {
    const local = localBackendHarness();
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).endsWith("/__orkestrator/events")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const manager = new ConnectionManager({
      localBackend: local.backend,
      secureStorage: secureStorage(false),
      onEvent: mock(() => undefined),
      platform: "darwin",
    });
    await manager.initialize();
    await expect(manager.connect({ address: "http://desk.tailnet.ts.net", token })).rejects.toThrow("must use HTTPS");
    await manager.connect({ address: "https://desk.tailnet.ts.net", token });
    expect(local.getStored().connections[0]?.encryptedToken).toBe("");
    expect(manager.getList().credentialStorage).toBe("session-only");
    await manager.use("local");
    await expect(manager.use(local.getStored().connections[0]?.id ?? "missing")).rejects.toThrow("Enter the gateway token");
  });

  test("does not persist credentials with Linux plaintext fallback storage", async () => {
    const local = localBackendHarness();
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).endsWith("/__orkestrator/events")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const storage = secureStorage();
    storage.getSelectedStorageBackend = () => "basic_text";
    const manager = new ConnectionManager({
      localBackend: local.backend,
      secureStorage: storage,
      onEvent: mock(() => undefined),
      platform: "linux",
    });
    await manager.initialize();
    await manager.connect({ address: "https://desk.tailnet.ts.net", token });
    expect(local.getStored().connections[0]?.encryptedToken).toBe("");
    expect(manager.getList().credentialStorage).toBe("session-only");
    await manager.use("local");
  });

  test("restores and re-encrypts a saved remote connection", async () => {
    const initial = {
      activeConnectionId: "remote-1",
      connections: [{
        id: "remote-1",
        name: "desk.example",
        address: "https://desk.example",
        encryptedToken: encrypted(token),
        lastConnectedAt: "2026-07-14T00:00:00.000Z",
      }],
    };
    const local = localBackendHarness(initial);
    const storage = secureStorage(true, true);
    installHealthyRemoteFetch();
    const manager = new ConnectionManager({ localBackend: local.backend, secureStorage: storage, onEvent: mock(() => undefined) });

    await manager.initialize();

    expect(manager.getList().activeConnectionId).toBe("remote-1");
    expect(storage.decryptStringAsync).toHaveBeenCalledTimes(1);
    expect(storage.encryptStringAsync).toHaveBeenCalledWith(token);
    expect(local.getStored().activeConnectionId).toBe("remote-1");
  });

  test("falls back to Local when restoring a saved remote fails", async () => {
    const local = localBackendHarness({
      activeConnectionId: "remote-1",
      connections: [{
        id: "remote-1",
        name: "desk.example",
        address: "https://desk.example",
        encryptedToken: encrypted(token),
        lastConnectedAt: "2026-07-14T00:00:00.000Z",
      }],
    });
    globalThis.fetch = mock(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const originalWarn = console.warn;
    console.warn = mock(() => undefined) as typeof console.warn;
    try {
      const manager = new ConnectionManager({ localBackend: local.backend, secureStorage: secureStorage(), onEvent: mock(() => undefined) });
      await manager.initialize();
      expect(manager.getList().activeConnectionId).toBe("local");
      expect(local.getStored().activeConnectionId).toBe("local");
      expect(local.getStored().connections).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("keeps runtime and persisted state unchanged when connect, use, or forget persistence fails", async () => {
    const local = localBackendHarness();
    installHealthyRemoteFetch();
    const manager = new ConnectionManager({ localBackend: local.backend, secureStorage: secureStorage(), onEvent: mock(() => undefined) });
    await manager.initialize();

    local.failNextSave();
    await expect(manager.connect({ address: "https://one.example", token })).rejects.toThrow("disk full");
    expect(manager.getList().activeConnectionId).toBe("local");
    expect(local.getStored().connections).toEqual([]);

    await manager.connect({ address: "https://one.example", token });
    const remoteId = manager.getList().activeConnectionId;
    local.failNextSave();
    await expect(manager.use("local")).rejects.toThrow("disk full");
    expect(manager.getList().activeConnectionId).toBe(remoteId);
    expect(manager.getRendererRequestAuthorization("https://one.example/__orkestrator/status")).toBe(`Bearer ${token}`);

    local.failNextSave();
    await expect(manager.forget(remoteId)).rejects.toThrow("disk full");
    expect(manager.getList().activeConnectionId).toBe(remoteId);
    expect(manager.getList().connections.some((connection) => connection.id === remoteId)).toBe(true);
    await manager.forget(remoteId);
    expect(manager.getList().activeConnectionId).toBe("local");
    expect(local.getStored().connections).toEqual([]);
  });

  test("serializes token rotation with switching so credentials stay with their server", async () => {
    const tokenA = "gateway-token-server-a";
    const rotatedA = "gateway-token-server-a-rotated";
    const tokenB = "gateway-token-server-b";
    const local = localBackendHarness({
      activeConnectionId: "remote-a",
      connections: [
        { id: "remote-a", name: "a.example", address: "https://a.example", encryptedToken: encrypted(tokenA), lastConnectedAt: "2026-07-14T00:00:00.000Z" },
        { id: "remote-b", name: "b.example", address: "https://b.example", encryptedToken: encrypted(tokenB), lastConnectedAt: "2026-07-14T00:00:00.000Z" },
      ],
    });
    let resolveRotation: ((response: Response) => void) | null = null;
    globalThis.fetch = mock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/__orkestrator/events")) {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
      }
      if (url.endsWith("/__orkestrator/gateway-settings")) {
        return new Promise<Response>((resolve) => { resolveRotation = resolve; });
      }
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const manager = new ConnectionManager({ localBackend: local.backend, secureStorage: secureStorage(), onEvent: mock(() => undefined) });
    await manager.initialize();

    const rotation = manager.setGatewayToken(rotatedA);
    while (!resolveRotation) await Promise.resolve();
    const switching = manager.use("remote-b");
    resolveRotation(new Response(JSON.stringify({ token: rotatedA, editable: true, source: "file" })));
    await Promise.all([rotation, switching]);

    expect(manager.getList().activeConnectionId).toBe("remote-b");
    expect(manager.getRendererRequestAuthorization("https://b.example/__orkestrator/status")).toBe(`Bearer ${tokenB}`);
    expect(local.getStored().connections.find((connection) => connection.id === "remote-a")?.encryptedToken).toBe(encrypted(rotatedA));
    expect(local.getStored().connections.find((connection) => connection.id === "remote-b")?.encryptedToken).toBe(encrypted(tokenB));
  });

  test("serializes simultaneous connection attempts and leaves the last requested server active", async () => {
    const local = localBackendHarness();
    const statusRequests: string[] = [];
    let resolveFirst: ((response: Response) => void) | null = null;
    let resolveSecond: ((response: Response) => void) | null = null;
    globalThis.fetch = mock(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/__orkestrator/events") {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
      }
      statusRequests.push(url.origin);
      return new Promise<Response>((resolve) => {
        if (url.hostname === "a.example") resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    }) as unknown as typeof fetch;
    const manager = new ConnectionManager({ localBackend: local.backend, secureStorage: secureStorage(), onEvent: mock(() => undefined) });
    await manager.initialize();

    const first = manager.connect({ address: "https://a.example", token: "gateway-token-server-a" });
    while (!resolveFirst) await Promise.resolve();
    const second = manager.connect({ address: "https://b.example", token: "gateway-token-server-b" });
    await Promise.resolve();
    expect(statusRequests).toEqual(["https://a.example"]);

    resolveFirst(new Response(JSON.stringify({ ok: true })));
    while (!resolveSecond) await Promise.resolve();
    expect(statusRequests).toEqual(["https://a.example", "https://b.example"]);
    resolveSecond(new Response(JSON.stringify({ ok: true })));
    await Promise.all([first, second]);

    expect(manager.getList().connections.find((connection) => connection.address === "https://b.example")?.active).toBe(true);
    expect(local.getStored().activeConnectionId).toBe(manager.getList().activeConnectionId);
    expect(manager.getRendererRequestAuthorization("https://a.example/__orkestrator/status")).toBeNull();
    expect(manager.getRendererRequestAuthorization("https://b.example/__orkestrator/status")).toBe("Bearer gateway-token-server-b");
  });

  test("keeps a rotated remote token session-only when saving the credential fails", async () => {
    const local = localBackendHarness();
    globalThis.fetch = mock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/__orkestrator/events")) {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
      }
      if (url.endsWith("/__orkestrator/gateway-settings")) {
        const body = JSON.parse(String(init?.body)) as { token: string };
        return new Response(JSON.stringify({ token: body.token, editable: true, source: "file" }));
      }
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const manager = new ConnectionManager({ localBackend: local.backend, secureStorage: secureStorage(), onEvent: mock(() => undefined) });
    await manager.initialize();
    await manager.connect({ address: "https://desk.example", token });
    const remoteId = manager.getList().activeConnectionId;

    local.failNextSave();
    await expect(manager.setGatewayToken("rotated-gateway-token-123456")).rejects.toThrow("disk full");
    expect(manager.getRendererRequestAuthorization("https://desk.example/__orkestrator/status")).toBe("Bearer rotated-gateway-token-123456");

    await manager.use("local");
    expect(local.getStored().connections.find((connection) => connection.id === remoteId)?.encryptedToken).toBe("");
    await expect(manager.use(remoteId)).rejects.toThrow("Enter the gateway token");
  });

  test("forwards active remote events and stops them after returning to Local", async () => {
    const local = localBackendHarness();
    const onEvent = mock(() => undefined);
    globalThis.fetch = mock(async (input, init) => {
      if (!String(input).endsWith("/__orkestrator/events")) return new Response(JSON.stringify({ ok: true }));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"event":"remote-updated","payload":{"id":"env-remote"}}\n\n'));
          init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
        },
      });
      return new Response(stream);
    }) as unknown as typeof fetch;
    const manager = new ConnectionManager({ localBackend: local.backend, secureStorage: secureStorage(), onEvent });
    await manager.initialize();
    await manager.connect({ address: "https://desk.example", token });
    for (let attempt = 0; attempt < 20 && onEvent.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    expect(onEvent).toHaveBeenCalledWith("remote-updated", { id: "env-remote" });

    await manager.use("local");
    const callCount = onEvent.mock.calls.length;
    await Promise.resolve();
    expect(onEvent).toHaveBeenCalledTimes(callCount);
  });

  test("forwards local controls and local events and validates removal boundaries", async () => {
    const local = localBackendHarness();
    const onEvent = mock(() => undefined);
    const manager = new ConnectionManager({ localBackend: local.backend, secureStorage: secureStorage(), onEvent });
    await manager.initialize();
    manager.handleLocalEvent("environment-updated", { id: "env-1" });
    expect(onEvent).toHaveBeenCalledWith("environment-updated", { id: "env-1" });
    await expect(manager.getWebClientStatus()).resolves.toMatchObject({ running: true });
    await expect(manager.setWebClientEnabled(false)).resolves.toMatchObject({ enabled: true });
    await expect(manager.resetWebClientServe()).resolves.toMatchObject({ running: true });
    await expect(manager.getGatewayTokenSettings()).resolves.toMatchObject({ token });
    await expect(manager.setToken("replacement-token-123456")).resolves.toMatchObject({ token: "replacement-token-123456" });
    await expect(manager.forget("local")).rejects.toThrow("cannot be removed");
    await expect(manager.forget("missing")).rejects.toThrow("no longer exists");
  });

  test("reports address, authentication, network, malformed response, and timeout errors", async () => {
    const local = localBackendHarness();
    const manager = new ConnectionManager({
      localBackend: local.backend,
      secureStorage: secureStorage(),
      onEvent: mock(() => undefined),
      connectionTimeoutMs: 1,
    });
    await manager.initialize();
    await expect(manager.connect({ address: "https://user@example.com", token })).rejects.toThrow("token field");
    await expect(manager.connect({ address: "https://example.com/path", token })).rejects.toThrow("origin only");

    globalThis.fetch = mock(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(manager.connect({ address: "https://example.com", token })).rejects.toThrow("token was rejected");
    globalThis.fetch = mock(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;
    await expect(manager.connect({ address: "https://example.com", token })).rejects.toThrow("HTTP 200");
    globalThis.fetch = mock(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    await expect(manager.connect({ address: "https://example.com", token })).rejects.toThrow("Could not reach");
    globalThis.fetch = mock((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    await expect(manager.connect({ address: "https://example.com", token })).rejects.toThrow("0.001 seconds");
    expect(() => new ConnectionManager({ localBackend: local.backend, secureStorage: secureStorage(), onEvent: mock(() => undefined), connectionTimeoutMs: 0 })).toThrow("positive number");
  });
});
