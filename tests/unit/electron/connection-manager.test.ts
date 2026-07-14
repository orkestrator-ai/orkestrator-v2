import { afterEach, describe, expect, mock, test } from "bun:test";
import type { StoredDesktopConnections } from "@orkestrator/protocol/connections";
import { ConnectionManager, type SecureStorage } from "../../../apps/desktop/electron/connection-manager";

const originalFetch = globalThis.fetch;
const token = "gateway-token-123456";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function secureStorage(available = true): SecureStorage {
  return {
    isAsyncEncryptionAvailable: mock(async () => available),
    encryptStringAsync: mock(async (value: string) => Buffer.from(`protected:${value}`)),
    decryptStringAsync: mock(async (value: Buffer) => ({
      result: value.toString().replace(/^protected:/, ""),
      shouldReEncrypt: false,
    })),
    getSelectedStorageBackend: () => "gnome_libsecret",
  };
}

function localBackendHarness(initial?: StoredDesktopConnections) {
  let stored = initial ?? { activeConnectionId: "local", connections: [] };
  const invoke = mock(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_desktop_connections") return stored;
    if (command === "save_desktop_connections") {
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
      getTokenSettings: mock(async () => ({ token, editable: true as const, source: "file" as const })),
      setToken: mock(async (nextToken: string) => ({ token: nextToken, editable: true as const, source: "file" as const })),
    },
    getStored: () => stored,
  };
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

    const manager = new ConnectionManager({
      localBackend: local.backend,
      secureStorage: secureStorage(),
      onEvent: mock(() => undefined),
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

    await expect(manager.invoke("get_projects")).resolves.toEqual([{ id: "remote-project" }]);
    expect(remoteRequests.some((request) => request.authorization === `Bearer ${token}`)).toBe(true);

    await manager.use("local");
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
});
