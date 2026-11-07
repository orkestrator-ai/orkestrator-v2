import { afterEach, describe, expect, mock, test } from "bun:test";
import type { DeviceCatalogue } from "@orkestrator/protocol/device-catalogue";
import type { ConnectionCatalogueStore } from "../electron/connection-catalogue-store";
import { ConnectionManager, type SecureStorage } from "../electron/connection-manager";
import { installRemoteGatewayRequestAuth } from "../electron/remote-gateway-request-auth";
import {
  createWindowRequestAuthorization,
  resolveWindowRequestAuthorization,
  type RequestAuthorizationManager,
} from "../electron/window-request-authorization";

/**
 * Scopes bound the way `ConnectionManager` binds them: a bearer confined to
 * one origin and `<base path>/__orkestrator/`, or Local (no bearer).
 */
function fakeManager() {
  const scopes = new Map<string, { baseUrl: string; token: string } | "local">();
  const manager: RequestAuthorizationManager = {
    getBoundConnectionId: (scope) => {
      const bound = scopes.get(scope);
      return bound === undefined ? null : bound === "local" ? "local" : `remote:${scope}`;
    },
    getGatewayBaseUrl: (scope) => {
      const bound = scopes.get(scope ?? "");
      if (bound === undefined) throw new Error("The requesting window is no longer available.");
      return bound === "local" ? null : bound.baseUrl;
    },
    getRendererRequestAuthorization: (url, scope) => {
      const bound = scopes.get(scope ?? "");
      if (!bound || bound === "local") return null;
      const base = new URL(bound.baseUrl);
      const target = new URL(url);
      return target.origin === base.origin &&
        target.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/__orkestrator/`)
        ? `Bearer ${bound.token}`
        : null;
    },
  };
  return { scopes, manager };
}

describe("resolveWindowRequestAuthorization", () => {
  test("a relay node scope on the command origin: its paths get its bearer, others the command's", () => {
    const { scopes, manager } = fakeManager();
    scopes.set("w", { baseUrl: "https://command.example", token: "command" });
    scopes.set("w:node:bk_leaf", {
      baseUrl: "https://command.example/__orkestrator/nodes/bk_leaf",
      token: "leaf",
    });
    const context = { scope: "w", nodes: new Map([["bk_leaf", { scope: "w:node:bk_leaf" }]]) };
    const resolve = (url: string) => resolveWindowRequestAuthorization(manager, context, url);

    expect(
      resolve("https://command.example/__orkestrator/nodes/bk_leaf/__orkestrator/files/a.png"),
    ).toBe("Bearer leaf");
    expect(resolve("https://command.example/__orkestrator/files/a.png")).toBe("Bearer command");
    expect(resolve("https://command.example/__orkestrator/invoke")).toBe("Bearer command");
    // Under the relay prefix but outside the node's own gateway path.
    expect(resolve("https://command.example/__orkestrator/nodes/bk_leaf/other")).toBe(
      "Bearer command",
    );
    // The order of the node map does not matter; the longest prefix does.
    const reversed = {
      scope: "w:node:bk_leaf",
      nodes: new Map([["command", { scope: "w" }]]),
    };
    expect(
      resolveWindowRequestAuthorization(
        manager,
        reversed,
        "https://command.example/__orkestrator/nodes/bk_leaf/__orkestrator/files/a.png",
      ),
    ).toBe("Bearer leaf");
    expect(resolve("https://elsewhere.example/__orkestrator/files/a.png")).toBeNull();
  });

  test("two direct nodes on different origins; a removed scope stops matching", () => {
    const { scopes, manager } = fakeManager();
    scopes.set("w", { baseUrl: "https://command.example", token: "command" });
    scopes.set("w:node:bk_a", { baseUrl: "https://a.example", token: "a" });
    scopes.set("w:node:bk_b", { baseUrl: "https://b.example:8443", token: "b" });
    const nodes = new Map([
      ["bk_a", { scope: "w:node:bk_a" }],
      ["bk_b", { scope: "w:node:bk_b" }],
    ]);
    const context = { scope: "w", nodes };
    const resolve = (url: string) => resolveWindowRequestAuthorization(manager, context, url);
    expect(resolve("https://a.example/__orkestrator/files/x.png")).toBe("Bearer a");
    expect(resolve("https://b.example:8443/__orkestrator/files/x.png")).toBe("Bearer b");
    expect(resolve("https://b.example/__orkestrator/files/x.png")).toBeNull();
    expect(resolve("https://command.example/__orkestrator/files/x.png")).toBe("Bearer command");

    // Released: gone from the window's map and from the manager.
    nodes.delete("bk_a");
    scopes.delete("w:node:bk_a");
    expect(resolve("https://a.example/__orkestrator/files/x.png")).toBeNull();
    expect(resolve("https://b.example:8443/__orkestrator/files/x.png")).toBe("Bearer b");
    // A scope still in the map but already released by the manager matches nothing.
    scopes.delete("w:node:bk_b");
    expect(resolve("https://b.example:8443/__orkestrator/files/x.png")).toBeNull();
  });
});

describe("createWindowRequestAuthorization", () => {
  test("the local direct transport answers only while the window is on Local", () => {
    const { scopes, manager } = fakeManager();
    scopes.set("w", "local");
    scopes.set("w:node:bk_a", { baseUrl: "https://a.example", token: "a" });
    const local = mock((url: string) =>
      url.startsWith("http://127.0.0.1:34999/") ? "Bearer local" : null,
    );
    const auth = createWindowRequestAuthorization(
      manager,
      { scope: "w", nodes: new Map([["bk_a", { scope: "w:node:bk_a" }]]) },
      local,
    );
    expect(auth.authorization("http://127.0.0.1:34999/__orkestrator/invoke")).toBe("Bearer local");
    expect(auth.requestOrigin("http://127.0.0.1:34999/__orkestrator/invoke")).toBe(
      "http://127.0.0.1:34999",
    );
    // A node scope of a Local window still gets its own bearer, never the local one.
    expect(auth.authorization("https://a.example/__orkestrator/files/x.png")).toBe("Bearer a");
    expect(auth.requestOrigin("https://a.example/__orkestrator/files/x.png")).toBeNull();

    scopes.set("w", { baseUrl: "https://command.example", token: "command" });
    expect(auth.authorization("http://127.0.0.1:34999/__orkestrator/invoke")).toBeNull();
    expect(auth.requestOrigin("http://127.0.0.1:34999/__orkestrator/invoke")).toBeNull();
  });

  test("a released window authorizes nothing and never throws", () => {
    const { scopes, manager } = fakeManager();
    scopes.set("w", { baseUrl: "https://command.example", token: "command" });
    const auth = createWindowRequestAuthorization(
      manager,
      { scope: "w", nodes: new Map() },
      () => "Bearer local",
    );
    expect(auth.authorization("https://command.example/__orkestrator/invoke")).toBe(
      "Bearer command",
    );
    scopes.delete("w");
    expect(auth.authorization("https://command.example/__orkestrator/invoke")).toBeNull();
    expect(auth.requestOrigin("https://command.example/__orkestrator/invoke")).toBeNull();
  });
});

// The real connection manager and webRequest hook, as a window's session uses them.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

class MemoryStore implements ConnectionCatalogueStore {
  constructor(public value: DeviceCatalogue | null) {}
  isDurable() {
    return true;
  }
  async load() {
    return this.value ? structuredClone(this.value) : null;
  }
  async save(catalogue: DeviceCatalogue) {
    this.value = structuredClone(catalogue);
  }
}

function secureStorage(): SecureStorage {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(`protected:${value}`),
    decryptStringAsync: async (value: Buffer) => ({
      result: value.toString().replace(/^protected:/, ""),
      shouldReEncrypt: false,
    }),
    getSelectedStorageBackend: () => "keychain",
  };
}

/** Event streams hang until aborted; nothing else is asked for here. */
function installHangingGateways() {
  globalThis.fetch = mock(
    async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        }),
      ),
  ) as unknown as typeof fetch;
}

function connectionManager() {
  const status = { enabled: true, running: true, url: null, error: null };
  return new ConnectionManager({
    localBackend: {
      invoke: async () => ({}),
      probe: async () => true,
      getWebClientStatus: async () => status,
      setWebClientEnabled: async () => status,
      resetWebClientServe: async () => status,
      getTokenSettings: async () => ({ token: "local", editable: true, source: "file" }),
      setToken: async (token: string) => ({ token, editable: true, source: "file" }),
    } as never,
    secureStorage: secureStorage(),
    catalogueStore: new MemoryStore({
      version: 2,
      activeConnectionId: "local",
      backends: [],
      features: { federation: true, sshRoutes: true, routeFallback: true },
    }),
    onEvent: () => undefined,
    platform: "darwin",
    reconnectDelaysMs: [5, 5, 5],
  });
}

function hookedSession(authorization: (url: string) => string | null) {
  let beforeSend: ((details: unknown, callback: (response: unknown) => void) => void) | null = null;
  installRemoteGatewayRequestAuth(
    {
      onBeforeSendHeaders: (_filter: unknown, listener: typeof beforeSend) => {
        beforeSend = listener;
      },
      onHeadersReceived: () => undefined,
    } as never,
    authorization,
  );
  /** The headers the window renderer's image request is sent with. */
  return (url: string) => {
    let headers: Record<string, string> | undefined;
    beforeSend!(
      {
        url,
        resourceType: "image",
        frame: { url: "file:///app/web/index.html", parent: null },
        referrer: "",
        webContentsId: 1,
        requestHeaders: { Accept: "image/*" },
      },
      (response) => {
        headers = (response as { requestHeaders: Record<string, string> }).requestHeaders;
      },
    );
    return headers!;
  };
}

test("an image a leaf serves through the relay loads in the window with the leaf's grant", async () => {
  installHangingGateways();
  const connections = connectionManager();
  try {
    await connections.initialize();
    // The window's command scope and its node scope, each on its own gateway grant.
    await connections.bind("window", "local");
    connections.retargetScopeToWorkspace("window", {
      workspaceId: "command",
      baseUrl: "https://command.example",
      token: "command-grant-123456",
    });
    await connections.bind("window:node:bk_leaf", "local");
    connections.retargetScopeToWorkspace("window:node:bk_leaf", {
      workspaceId: "leaf",
      nodeId: "bk_leaf",
      baseUrl: "https://command.example/__orkestrator/nodes/bk_leaf",
      token: "leaf-grant-123456",
    });
    const nodes = new Map([["bk_leaf", { scope: "window:node:bk_leaf" }]]);
    const auth = createWindowRequestAuthorization(connections, { scope: "window", nodes }, null);
    const send = hookedSession(auth.authorization);

    const image =
      "https://command.example/__orkestrator/nodes/bk_leaf/__orkestrator/files/screenshot.png";
    expect(send(image)).toMatchObject({ Authorization: "Bearer leaf-grant-123456" });
    expect(send("https://command.example/__orkestrator/files/logo.png")).toMatchObject({
      Authorization: "Bearer command-grant-123456",
    });

    // Released: the leaf's paths fall back to the command scope's prefix.
    nodes.delete("bk_leaf");
    connections.release("window:node:bk_leaf");
    expect(send(image)).toMatchObject({ Authorization: "Bearer command-grant-123456" });
    connections.release("window");
    expect(send(image).Authorization).toBeUndefined();
  } finally {
    connections.dispose();
  }
});
