import { afterEach, describe, expect, mock, test } from "bun:test";
import type { DeviceCatalogue } from "@orkestrator/protocol/device-catalogue";
import type { BackendHttpClient } from "../electron/backend-process";
import type { ConnectionCatalogueStore } from "../electron/connection-catalogue-store";
import { ConnectionManager, type SecureStorage } from "../electron/connection-manager";
import { DesktopNodeScopes, type NodeScopeWindow } from "../electron/node-scopes";
import { NodeWorkspaceScopes } from "../electron/node-workspaces";

/**
 * 4006 Finding 2: on the desktop, after the command node revoked a window's
 * grant for a leaf, main reopened a grant but no terminal input reached the
 * leaf's shell again. The first write after the revoke was refused (or held
 * back while the route was parked), the terminal input sequencer fenced the
 * terminal as if part of it might have landed, and nothing re-armed it.
 *
 * These run the real connection manager, node scopes and grant tracking
 * against a fake leaf gateway whose accepted bearer is the current grant.
 */

const LEAF = "https://leaf.example";
const originalFetch = globalThis.fetch;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  globalThis.fetch = originalFetch;
});

class MemoryStore implements ConnectionCatalogueStore {
  value: DeviceCatalogue | null = null;
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
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({
      result: value.toString(),
      shouldReEncrypt: false,
    }),
    getSelectedStorageBackend: () => "keychain",
  };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * A leaf gateway that accepts only the current grant, and a command node
 * (the local backend) that opens and revokes grants for it. `dropStreamsOnRevoke`
 * ends the open event streams of a revoked grant, as the live leaf does.
 */
function topology(options: { dropStreamsOnRevoke: boolean }) {
  const leaf = { grant: "none" };
  const written: Array<{ data: string; authorization: string | null }> = [];
  const streams = new Set<(error: unknown) => void>();
  let opens = 0;
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== LEAF) throw new TypeError("fetch failed");
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization !== `Bearer ${leaf.grant}`)
      return Response.json({ error: "Authentication required" }, { status: 401 });
    if (url.pathname === "/__orkestrator/events") {
      return new Promise<Response>((_resolve, reject) => {
        const end = (error: unknown) => {
          streams.delete(end);
          reject(error);
        };
        streams.add(end);
        init?.signal?.addEventListener("abort", () => end(init.signal?.reason), { once: true });
      });
    }
    if (url.pathname === "/__orkestrator/hello") {
      return Response.json({
        schemaVersion: 1,
        installationId: "bk_leaf",
        generation: "gen-leaf",
        appVersion: "2.25.0",
        clientApi: { minVersion: 1, maxVersion: 1 },
        capabilities: {},
        profile: {
          revision: 1,
          displayName: "Leaf",
          colorToken: "teal",
          updatedAt: "2026-11-07T00:00:00.000Z",
        },
        endpointRole: "client",
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      command: string;
      args: { data?: string };
    };
    if (body.command === "terminal_write") {
      written.push({ data: String(body.args.data), authorization });
      return Response.json({ result: { delivered: true } });
    }
    return Response.json({ result: { command: body.command } });
  }) as unknown as typeof fetch;

  const revoke = () => {
    leaf.grant = "revoked";
    if (options.dropStreamsOnRevoke)
      for (const end of Array.from(streams)) end(new TypeError("stream ended"));
  };
  const status = { enabled: true, running: true, url: null, error: null };
  const localBackend = {
    invoke: async (command: string) => {
      if (command === "open_node_workspace") {
        opens += 1;
        leaf.grant = `grant-${opens}`;
        return {
          workspaceId: `w-${opens}`,
          nodeId: "bk_leaf",
          nodeName: "Leaf",
          grant: { token: leaf.grant, expiresAt: Date.now() + 900_000 },
          directOrigins: [LEAF],
          relayBase: "/__orkestrator/nodes/bk_leaf",
        };
      }
      if (command === "get_backend_profile") return { displayName: "Command" };
      if (command === "list_nodes") return { nodes: [{ nodeId: "bk_leaf" }] };
      return {};
    },
    probe: async () => true,
    getWebClientStatus: async () => status,
    setWebClientEnabled: async () => status,
    resetWebClientServe: async () => status,
    getTokenSettings: async () => ({
      token: "t",
      editable: true as const,
      source: "file" as const,
    }),
    setToken: async (token: string) => ({
      token,
      editable: true as const,
      source: "file" as const,
    }),
  } as Pick<BackendHttpClient, "invoke"> as never;
  const manager = new ConnectionManager({
    localBackend,
    secureStorage: secureStorage(),
    catalogueStore: new MemoryStore(),
    onEvent: () => undefined,
    platform: "darwin",
    reconnectDelaysMs: [5, 5, 5],
  });
  const grants = new NodeWorkspaceScopes((command, args) => manager.invoke(command, args));
  const nodeScopes = new DesktopNodeScopes({ manager: () => manager, scopes: () => grants });
  const context: NodeScopeWindow = {
    scope: "window",
    window: { isDestroyed: () => false },
    contents: { isDestroyed: () => false, send: () => undefined },
    nodes: new Map(),
  };
  cleanups.push(() => {
    nodeScopes.dispose();
    grants.releaseAll();
    manager.dispose();
  });
  return {
    manager,
    context,
    nodeScopes,
    written,
    revoke,
    opens: () => opens,
    async start() {
      await manager.initialize();
      await manager.bind("window", "local");
      return nodeScopes.ensureNodeScope(context, "bk_leaf");
    },
  };
}

const write = (manager: ConnectionManager, scope: string, data: string) =>
  manager.invoke<{ delivered?: boolean }>("terminal_write", { sessionId: "s1", data }, scope);

describe("4006 Finding 2: terminal input after a grant lapse, without a reload", () => {
  for (const dropStreamsOnRevoke of [true, false]) {
    test(`input typed after the revoke reaches the leaf on the reopened grant (${
      dropStreamsOnRevoke ? "the leaf ends the stream" : "only the write is refused"
    })`, async () => {
      const leaf = topology({ dropStreamsOnRevoke });
      const record = await leaf.start();
      expect(await write(leaf.manager, record.scope, "before\r")).toEqual({ delivered: true });
      expect(leaf.opens()).toBe(1);

      // The command node revokes the window's grant (close_node_workspace).
      leaf.revoke();
      // Typed straight after, while main may still be parked on the dropped stream.
      expect(await write(leaf.manager, record.scope, "lapse\r")).toEqual({ delivered: true });
      expect(leaf.opens()).toBe(2);
      // And the terminal is not fenced: later input is delivered too.
      expect(await write(leaf.manager, record.scope, "relapse\r")).toEqual({ delivered: true });

      expect(leaf.written.map((entry) => entry.data)).toEqual(["before\r", "lapse\r", "relapse\r"]);
      // Each delivered write carried the grant current at the time; none was
      // accepted on the revoked one.
      expect(leaf.written.map((entry) => entry.authorization)).toEqual([
        "Bearer grant-1",
        "Bearer grant-2",
        "Bearer grant-2",
      ]);
      // Same connection: the window's event mapping for the node stays valid.
      expect(leaf.manager.getConnectionId(record.scope)).toBe("workspace:w-1");
    });
  }

  test("a refused non-terminal command fails, but opens a new grant at once", async () => {
    const leaf = topology({ dropStreamsOnRevoke: false });
    const record = await leaf.start();
    leaf.revoke();
    await expect(leaf.manager.invoke("get_projects", {}, record.scope)).rejects.toThrow(
      "Authentication required",
    );
    await until(() => leaf.opens() === 2, "a reopened grant");
    await until(
      () => !(leaf.manager.backendForConnection("workspace:w-1") as BackendHttpClient).isSuspended,
      "the client retargeted to the new grant",
    );
    expect(await leaf.manager.invoke("get_projects", {}, record.scope)).toEqual({
      command: "get_projects",
    });
  });
});
