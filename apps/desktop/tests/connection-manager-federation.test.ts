import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKEND_PROFILE_CHANGED_EVENT } from "@orkestrator/protocol/backend-profile";
import type { StoredDesktopConnections } from "@orkestrator/protocol/connections";
import {
  migrateDesktopConnections,
  type DeviceCatalogue,
  type SavedBackend,
} from "@orkestrator/protocol/device-catalogue";
import type { BackendHttpClient } from "../electron/backend-process";
import {
  LocalBackendCatalogueStore,
  NativeDeviceCatalogueStore,
  type ConnectionCatalogueStore,
} from "../electron/connection-catalogue-store";
import { ConnectionManager, type SecureStorage } from "../electron/connection-manager";
import type { RouteFailure, SshTunnelProvider } from "../electron/connection-routes";

const originalFetch = globalThis.fetch;
const token = "gateway-token-123456";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function encrypted(value: string): string {
  return Buffer.from(`protected:${value}`).toString("base64");
}

function secureStorage(): SecureStorage {
  return {
    isAsyncEncryptionAvailable: mock(async () => true),
    encryptStringAsync: mock(async (value: string) => Buffer.from(`protected:${value}`)),
    decryptStringAsync: mock(async (value: Buffer) => ({
      result: value.toString().replace(/^protected:/, ""),
      shouldReEncrypt: false,
    })),
    getSelectedStorageBackend: () => "keychain",
  };
}

function localBackend(): ConstructorParameters<typeof ConnectionManager>[0]["localBackend"] {
  const status = { enabled: true, running: true, url: null, error: null };
  return {
    invoke: mock(async (command: string) => ({ local: true, command })) as never,
    probe: mock(async () => true),
    getWebClientStatus: mock(async () => status),
    setWebClientEnabled: mock(async () => status),
    resetWebClientServe: mock(async () => status),
    getTokenSettings: mock(async () => ({
      token,
      editable: true as const,
      source: "file" as const,
    })),
    setToken: mock(async (next: string) => ({
      token: next,
      editable: true as const,
      source: "file" as const,
    })),
  } as Pick<BackendHttpClient, "invoke"> as never;
}

class MemoryStore implements ConnectionCatalogueStore {
  saves = 0;
  constructor(public value: DeviceCatalogue | null = null) {}
  isDurable() {
    return true;
  }
  async load() {
    return this.value ? structuredClone(this.value) : null;
  }
  async save(catalogue: DeviceCatalogue) {
    this.saves += 1;
    this.value = structuredClone(catalogue);
  }
}

type Host = {
  installationId?: string;
  token?: string;
  role?: "client" | "control";
  down?: boolean;
  colorToken?: string;
};

/** Fake gateways keyed by origin. Events streams hang until aborted. */
function installGateways(hosts: Record<string, Host>) {
  const requests: Array<{ origin: string; path: string; authorization: string | null }> = [];
  const eventSignals = new Map<string, AbortSignal[]>();
  globalThis.fetch = mock(async (input, init) => {
    const url = new URL(String(input));
    const host = hosts[url.origin];
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ origin: url.origin, path: url.pathname, authorization });
    if (!host || host.down) throw new TypeError("fetch failed");
    if (authorization !== `Bearer ${host.token ?? token}`) {
      return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 });
    }
    if (url.pathname === "/__orkestrator/events") {
      const list = eventSignals.get(url.origin) ?? [];
      list.push(init?.signal as AbortSignal);
      eventSignals.set(url.origin, list);
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
      );
    }
    if (url.pathname === "/__orkestrator/hello") {
      if (!host.installationId) return new Response("Not found", { status: 404 });
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          installationId: host.installationId,
          generation: `gen-${host.installationId}`,
          appVersion: "2.25.0",
          clientApi: { minVersion: 1, maxVersion: 1 },
          capabilities: { "backend-profile": 1 },
          profile: {
            revision: 1,
            displayName: `Machine ${host.installationId}`,
            colorToken: host.colorToken ?? "teal",
            updatedAt: "2026-10-21T00:00:00.000Z",
          },
          endpointRole: host.role ?? "client",
        }),
      );
    }
    if (url.pathname === "/__orkestrator/status") return new Response(JSON.stringify({ ok: true }));
    const body = JSON.parse(String(init?.body ?? "{}")) as { command?: string };
    return new Response(JSON.stringify({ result: { origin: url.origin, command: body.command } }));
  }) as unknown as typeof fetch;
  return { requests, eventSignals };
}

function savedBackend(
  id: string,
  origins: string[],
  extra: Partial<SavedBackend> = {},
): SavedBackend {
  const routes = origins.map((origin, index) => ({
    id: `https-${id}-${index}` as never,
    kind: "https" as const,
    origin,
    encryptedToken: encrypted(token),
    enabled: true,
  }));
  return {
    id,
    fallbackName: new URL(origins[0]!).hostname,
    routeOrder: routes.map((route) => route.id),
    routes,
    autoConnect: true,
    ...extra,
  };
}

function catalogue(backends: SavedBackend[]): DeviceCatalogue {
  return {
    version: 2,
    activeConnectionId: "local",
    backends,
    features: { federation: true, sshRoutes: true, routeFallback: true },
  };
}

function manager(
  store: ConnectionCatalogueStore,
  options: Partial<ConstructorParameters<typeof ConnectionManager>[0]> = {},
) {
  return new ConnectionManager({
    localBackend: localBackend(),
    secureStorage: secureStorage(),
    catalogueStore: store,
    onEvent: () => undefined,
    platform: "darwin",
    reconnectDelaysMs: [5, 5, 5],
    ...options,
  });
}

async function until(condition: () => boolean, label = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("device catalogue persistence", () => {
  test("MG-02: the native store works with the local backend stopped", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ork-catalogue-"));
    try {
      const store = new NativeDeviceCatalogueStore(directory);
      installGateways({ "https://a.example": { installationId: "bk_a" } });
      const connections = manager(store, { localBackendAvailable: false });
      await connections.initialize();
      await connections.connect({ address: "https://a.example", token });
      const saved = JSON.parse(
        await readFile(path.join(directory, "device-connections.json"), "utf8"),
      ) as DeviceCatalogue;
      expect(saved.backends[0]?.verifiedInstallationId as string).toBe("bk_a");
      expect(JSON.stringify(saved)).not.toContain(token);
      expect(connections.getList().localAvailable).toBe(false);
      connections.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("restores the backup when the primary file is torn", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ork-catalogue-"));
    try {
      const store = new NativeDeviceCatalogueStore(directory);
      const first = catalogue([savedBackend("one", ["https://one.example"])]);
      await store.save(first);
      await store.save(
        catalogue([...first.backends, savedBackend("two", ["https://two.example"])]),
      );
      await writeFile(path.join(directory, "device-connections.json"), "{torn");
      expect((await store.load())?.backends.map((backend) => backend.id)).toEqual(["one"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("MG-01: migrates the version-1 list once and keeps a snapshot for downgrade", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ork-catalogue-"));
    try {
      const legacy: StoredDesktopConnections = {
        activeConnectionId: "local",
        connections: [
          {
            id: "old-1",
            name: "a.example",
            nickname: "Studio",
            address: "https://a.example",
            encryptedToken: encrypted(token),
            lastConnectedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      };
      const invoke = mock(async () => legacy);
      const legacyBackend = { invoke: invoke as unknown as <T>() => Promise<T> };
      const store = new NativeDeviceCatalogueStore(directory);
      const connections = manager(store, {
        legacyCatalogue: new LocalBackendCatalogueStore(legacyBackend, () => true),
      });
      await connections.initialize();
      expect(connections.getList().connections[1]).toMatchObject({
        id: "old-1",
        name: "Studio",
        identity: "provisional",
      });
      const snapshot = JSON.parse(
        await readFile(path.join(directory, "device-connections.v1-snapshot.json"), "utf8"),
      ) as StoredDesktopConnections;
      expect(snapshot).toEqual(legacy);
      // A second start reads the native store and never re-imports.
      const again = manager(store, {
        legacyCatalogue: new LocalBackendCatalogueStore(legacyBackend, () => true),
      });
      await again.initialize();
      expect(invoke).toHaveBeenCalledTimes(1);
      connections.dispose();
      again.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("identity and routes", () => {
  test("ID-02: a second address proving the same installation joins that machine", async () => {
    installGateways({
      "https://a.example": { installationId: "bk_a" },
      "https://a-ip.example": { installationId: "bk_a" },
    });
    const store = new MemoryStore(catalogue([]));
    const connections = manager(store);
    await connections.initialize();
    await connections.connect({ address: "https://a.example", token });
    await connections.connect({ address: "https://a-ip.example", token });
    const remotes = connections.getList().connections.filter((entry) => entry.kind === "remote");
    expect(remotes).toHaveLength(1);
    expect(remotes[0]?.routes?.map((route) => route.label)).toEqual(["a.example", "a-ip.example"]);
    expect(remotes[0]?.backendId as string).toBe("bk_a");
    connections.dispose();
  });

  test("adding a machine with select:false neither switches nor rebinds the window", async () => {
    installGateways({ "https://b.example": { installationId: "bk_b" } });
    const store = new MemoryStore(catalogue([]));
    const connections = manager(store);
    await connections.initialize();
    await connections.bind("window", "local");
    const list = await connections.connect(
      { address: "https://b.example", token, select: false },
      "window",
    );
    expect(list.activeConnectionId).toBe("local");
    expect(store.value?.activeConnectionId).toBe("local");
    expect(
      list.connections.find((entry) => entry.address === "https://b.example")?.backendId as string,
    ).toBe("bk_b");
    connections.dispose();
  });

  test("ID-02 explicit: an added connection method must prove the same installation", async () => {
    installGateways({
      "https://a.example": { installationId: "bk_a" },
      "https://a-other.example": { installationId: "bk_a" },
      "https://imposter.example": { installationId: "bk_x" },
    });
    const store = new MemoryStore(
      catalogue([
        savedBackend("a", ["https://a.example"], { verifiedInstallationId: "bk_a" as never }),
      ]),
    );
    const connections = manager(store);
    await connections.initialize();
    await expect(
      connections.connect({
        address: "https://imposter.example",
        token,
        connectionId: "a",
        select: false,
      }),
    ).rejects.toThrow("different Orkestrator installation");
    expect(store.value?.backends).toHaveLength(1);
    await connections.connect({
      address: "https://a-other.example",
      token,
      connectionId: "a",
      select: false,
    });
    expect(store.value?.backends).toHaveLength(1);
    expect(
      store.value?.backends[0]?.routes.map((route) => route.kind === "https" && route.origin),
    ).toEqual(["https://a.example", "https://a-other.example"]);
    connections.dispose();
  });

  test("ID-03: an address that now answers as another installation is blocked, not merged", async () => {
    installGateways({ "https://a.example": { installationId: "bk_other" } });
    const store = new MemoryStore(
      catalogue([
        savedBackend("a", ["https://a.example"], { verifiedInstallationId: "bk_a" as never }),
      ]),
    );
    const connections = manager(store);
    await connections.initialize();
    await expect(connections.connect({ address: "https://a.example", token })).rejects.toThrow(
      "different Orkestrator installation",
    );
    expect(store.value?.backends[0]?.verifiedInstallationId as string).toBe("bk_a");
    connections.dispose();
  });

  test("ID-04: two saved entries proving one identity are a visible conflict", async () => {
    installGateways({
      "https://one.example": { installationId: "bk_same" },
      "https://two.example": { installationId: "bk_same" },
    });
    const store = new MemoryStore(
      catalogue([
        savedBackend("one", ["https://one.example"], {
          verifiedInstallationId: "bk_same" as never,
        }),
        savedBackend("two", ["https://two.example"]),
      ]),
    );
    const connections = manager(store);
    await connections.initialize();
    await connections.bind("window", "local");
    connections.observe("window", "two");
    await until(() => connections.getList().connections[2]?.identity === "conflict", "conflict");
    // A conflicting entry never borrows the other entry's identity.
    expect(connections.getList().connections[2]?.backendId).toBeUndefined();
    connections.dispose();
  });

  test("an older backend without hello stays provisional and is never merged", async () => {
    installGateways({ "https://old.example": {} });
    const connections = manager(new MemoryStore(catalogue([])));
    await connections.initialize();
    await connections.connect({ address: "https://old.example", token });
    expect(connections.getList().connections[1]).toMatchObject({ identity: "provisional" });
    expect(connections.getList().connections[1]?.backendId).toBeUndefined();
    connections.dispose();
  });

  test("AU-01/fallback: a verified machine falls back only to a route with the same grant", async () => {
    const hosts: Record<string, Host> = {
      "https://primary.example": { installationId: "bk_a", down: true },
      "https://secondary.example": { installationId: "bk_a" },
    };
    const gateways = installGateways(hosts);
    const store = new MemoryStore(
      catalogue([
        savedBackend("a", ["https://primary.example", "https://secondary.example"], {
          verifiedInstallationId: "bk_a" as never,
        }),
      ]),
    );
    const connections = manager(store);
    await connections.initialize();
    await connections.bind("window", "local");
    connections.observe("window", "a");
    await until(() => connections.getList().connections[1]?.transport === "connected", "fallback");
    expect(connections.getList().connections[1]?.routes?.find((route) => route.active)?.label).toBe(
      "secondary.example",
    );
    await expect(connections.invokeOn("window", "a", "get_projects")).resolves.toMatchObject({
      origin: "https://secondary.example",
    });
    expect(gateways.requests.some((request) => request.origin === "https://primary.example")).toBe(
      true,
    );
    connections.dispose();
  });

  test("an unverified machine never fails over to another presumed route", async () => {
    installGateways({
      "https://primary.example": { down: true },
      "https://secondary.example": {},
    });
    const store = new MemoryStore(
      catalogue([savedBackend("a", ["https://primary.example", "https://secondary.example"])]),
    );
    const connections = manager(store, { reconnectDelaysMs: [60_000] });
    await connections.initialize();
    await connections.bind("window", "local");
    connections.observe("window", "a");
    await until(() => connections.getList().connections[1]?.transport === "unreachable", "fail");
    expect(connections.getList().connections[1]?.routes?.some((route) => route.active)).toBe(false);
    connections.dispose();
  });

  test("AU-02: a trust failure is visible and is never bypassed by another route", async () => {
    installGateways({
      "https://primary.example": { installationId: "bk_imposter" },
      "https://secondary.example": { installationId: "bk_a" },
    });
    const store = new MemoryStore(
      catalogue([
        savedBackend("a", ["https://primary.example", "https://secondary.example"], {
          verifiedInstallationId: "bk_a" as never,
        }),
      ]),
    );
    const connections = manager(store);
    await connections.initialize();
    await connections.bind("window", "local");
    connections.observe("window", "a");
    await until(() => {
      console.log(JSON.stringify(connections.getList().connections[1]));
      return connections.getList().connections[1]?.transport === "trust-blocked";
    }, "block");
    const summary = connections.getList().connections[1];
    expect(summary?.routes?.[0]?.blockedReason).toContain("different Orkestrator installation");
    expect(summary?.routes?.some((route) => route.active)).toBe(false);
    connections.dispose();
  });
});

describe("federated observation", () => {
  test("RT-01: an unreachable machine does not hold up the others", async () => {
    installGateways({
      "https://a.example": { installationId: "bk_a", down: true },
      "https://b.example": { installationId: "bk_b" },
      "https://c.example": { installationId: "bk_c" },
    });
    const store = new MemoryStore(
      catalogue([
        savedBackend("a", ["https://a.example"]),
        savedBackend("b", ["https://b.example"]),
        savedBackend("c", ["https://c.example"]),
      ]),
    );
    const connections = manager(store, { reconnectDelaysMs: [60_000] });
    await connections.initialize();
    await connections.bind("window", "local");
    for (const id of ["a", "b", "c"]) connections.observe("window", id);
    await until(
      () =>
        connections
          .getList()
          .connections.filter((entry) => entry.transport === "connected" && entry.kind === "remote")
          .length === 2,
      "b and c",
    );
    await expect(connections.invokeOn("window", "b", "get_projects")).resolves.toMatchObject({
      origin: "https://b.example",
    });
    expect(connections.getList().connections.find((entry) => entry.id === "a")?.transport).toBe(
      "unreachable",
    );
    connections.dispose();
  });

  test("invokeOn requires the window to be bound to or observe the machine", async () => {
    installGateways({ "https://a.example": { installationId: "bk_a" } });
    const connections = manager(
      new MemoryStore(catalogue([savedBackend("a", ["https://a.example"])])),
    );
    await connections.initialize();
    await connections.bind("window", "local");
    await expect(connections.invokeOn("window", "a", "get_projects")).rejects.toThrow(
      "not connected to that machine",
    );
    await expect(connections.invokeOn("window", "local", "get_projects")).resolves.toMatchObject({
      local: true,
    });
    connections.dispose();
  });

  test("RT-03: observed events carry their machine and epoch and reach only observers", async () => {
    const gateways = installGateways({ "https://a.example": { installationId: "bk_a" } });
    const observed = mock(
      (
        _connectionId: string,
        _epoch: number,
        _event: string,
        _payload: unknown,
        _scopes: readonly string[],
      ) => undefined,
    );
    const connections = manager(
      new MemoryStore(catalogue([savedBackend("a", ["https://a.example"])])),
      {
        onObservedEvent: observed,
      },
    );
    await connections.initialize();
    await connections.bind("window-1", "local");
    await connections.bind("window-2", "local");
    connections.observe("window-1", "a");
    await until(
      () => (gateways.eventSignals.get("https://a.example")?.length ?? 0) === 1,
      "stream",
    );
    connections.handleLocalEvent("environment-updated", { id: "local-env" });
    expect(observed).not.toHaveBeenCalled();
    connections.observe("window-1", "local");
    connections.handleLocalEvent("environment-updated", { id: "local-env" });
    expect(observed).toHaveBeenCalledWith("local", 0, "environment-updated", { id: "local-env" }, [
      "window-1",
    ]);
    connections.dispose();
  });

  test("OP-06/SH-10: releasing the last observer closes only that connection", async () => {
    const gateways = installGateways({
      "https://a.example": { installationId: "bk_a" },
      "https://b.example": { installationId: "bk_b" },
    });
    const connections = manager(
      new MemoryStore(
        catalogue([
          savedBackend("a", ["https://a.example"]),
          savedBackend("b", ["https://b.example"]),
        ]),
      ),
    );
    await connections.initialize();
    await connections.bind("window-1", "local");
    await connections.bind("window-2", "local");
    connections.observe("window-1", "a");
    connections.observe("window-2", "a");
    connections.observe("window-2", "b");
    await until(() => (gateways.eventSignals.get("https://b.example")?.length ?? 0) === 1, "b");
    await until(() => (gateways.eventSignals.get("https://a.example")?.length ?? 0) === 1, "a");
    connections.release("window-1");
    expect(gateways.eventSignals.get("https://a.example")?.[0]?.aborted).toBe(false);
    connections.unobserve("window-2", "a");
    expect(gateways.eventSignals.get("https://a.example")?.[0]?.aborted).toBe(true);
    expect(gateways.eventSignals.get("https://b.example")?.[0]?.aborted).toBe(false);
    connections.dispose();
  });

  test("CL-01: a profile event updates the shared summary and the device cache", async () => {
    installGateways({ "https://a.example": { installationId: "bk_a" } });
    const store = new MemoryStore(catalogue([savedBackend("a", ["https://a.example"])]));
    const changes = mock(() => undefined);
    const connections = manager(store, { onStateChange: changes });
    await connections.initialize();
    await connections.bind("window", "local");
    connections.observe("window", "a");
    await until(
      () => connections.getList().connections[1]?.profile?.colorToken === "teal",
      "hello",
    );
    (
      connections as unknown as {
        handleRemoteEvent(id: string, event: string, payload: unknown): void;
      }
    ).handleRemoteEvent("a", BACKEND_PROFILE_CHANGED_EVENT, {
      revision: 2,
      displayName: "Build box",
      colorToken: "amber",
      updatedAt: "2026-10-21T01:00:00.000Z",
    });
    expect(connections.getList().connections[1]?.profile).toMatchObject({
      displayName: "Build box",
      colorToken: "amber",
      revision: 2,
      cached: false,
    });
    await until(() => store.value?.backends[0]?.profileCache?.colorToken === "amber", "cache");
    // A stale revision never overwrites a newer one.
    (
      connections as unknown as {
        handleRemoteEvent(id: string, event: string, payload: unknown): void;
      }
    ).handleRemoteEvent("a", BACKEND_PROFILE_CHANGED_EVENT, {
      revision: 1,
      displayName: "Old",
      colorToken: "rose",
      updatedAt: "",
    });
    expect(connections.getList().connections[1]?.profile?.colorToken).toBe("amber");
    connections.dispose();
  });

  test("CL-02: the cached profile labels an offline machine without inventing a colour", async () => {
    installGateways({ "https://a.example": { down: true } });
    const store = new MemoryStore(
      catalogue([
        savedBackend("a", ["https://a.example"], {
          verifiedInstallationId: "bk_a" as never,
          profileCache: { displayName: "Mac mini", colorToken: "violet", revision: 4 },
        }),
      ]),
    );
    const connections = manager(store);
    await connections.initialize();
    expect(connections.getList().connections[1]?.profile).toEqual({
      displayName: "Mac mini",
      colorToken: "violet",
      revision: 4,
      cached: true,
    });
    connections.dispose();
  });

  test("MG-04: turning federation off ends observations but never touches bindings", async () => {
    const gateways = installGateways({ "https://a.example": { installationId: "bk_a" } });
    const connections = manager(
      new MemoryStore(catalogue([savedBackend("a", ["https://a.example"])])),
    );
    await connections.initialize();
    await connections.bind("window", "local");
    connections.observe("window", "a");
    await until(() => (gateways.eventSignals.get("https://a.example")?.length ?? 0) === 1, "a");
    await connections.setFeatures({ federation: false }, "window");
    expect(gateways.eventSignals.get("https://a.example")?.[0]?.aborted).toBe(true);
    expect(() => connections.observe("window", "a")).toThrow("turned off");
    expect(connections.getList("window").activeConnectionId).toBe("local");
    connections.dispose();
  });
});

describe("SSH routes", () => {
  function fakeTunnels(origin: string) {
    const closers: Array<(failure: RouteFailure) => void> = [];
    const releases = mock(() => undefined);
    const provider: SshTunnelProvider = {
      acquire: mock(async () => ({
        localOrigin: origin,
        release: releases,
        onClosed: (listener: (failure: RouteFailure) => void) => {
          closers.push(listener);
          return () => undefined;
        },
      })),
    };
    return { provider, closers, releases };
  }

  test("SH-09: refuses a forward that reaches the privileged control listener", async () => {
    installGateways({ "http://127.0.0.1:45001": { installationId: "bk_a", role: "control" } });
    const tunnels = fakeTunnels("http://127.0.0.1:45001");
    const connections = manager(new MemoryStore(catalogue([])), { sshTunnels: tunnels.provider });
    await connections.initialize();
    await expect(
      connections.connectSsh({ destination: "build", remoteGatewayPort: 34121, token }),
    ).rejects.toThrow("privileged control listener");
    expect(tunnels.releases).toHaveBeenCalled();
    connections.dispose();
  });

  test("SH-08: SSH success never bypasses the gateway token", async () => {
    installGateways({
      "http://127.0.0.1:45002": { installationId: "bk_a", token: "other-token-12345678" },
    });
    const tunnels = fakeTunnels("http://127.0.0.1:45002");
    const connections = manager(new MemoryStore(catalogue([])), { sshTunnels: tunnels.provider });
    await connections.initialize();
    await expect(
      connections.connectSsh({ destination: "build", remoteGatewayPort: 34121, token }),
    ).rejects.toThrow("token was rejected");
    connections.dispose();
  });

  test("SH-12: invalid destinations are rejected before any tunnel is opened", async () => {
    const tunnels = fakeTunnels("http://127.0.0.1:45003");
    const connections = manager(new MemoryStore(catalogue([])), { sshTunnels: tunnels.provider });
    await connections.initialize();
    await expect(
      connections.connectSsh({
        destination: "-oProxyCommand=touch /tmp/pwned",
        remoteGatewayPort: 34121,
        token,
      }),
    ).rejects.toThrow("cannot start with '-'");
    expect(tunnels.provider.acquire).not.toHaveBeenCalled();
    connections.dispose();
  });

  test("an SSH machine connects, and a closed tunnel reconnects on a new epoch", async () => {
    const gateways = installGateways({ "http://127.0.0.1:45004": { installationId: "bk_s" } });
    const tunnels = fakeTunnels("http://127.0.0.1:45004");
    const connections = manager(new MemoryStore(catalogue([])), { sshTunnels: tunnels.provider });
    await connections.initialize();
    await connections.bind("window", "local");
    const list = await connections.connectSsh(
      {
        destination: "build-machine",
        remoteGatewayPort: 34121,
        token,
        nickname: "Build",
        select: true,
      },
      "window",
    );
    const machine = list.connections.find((entry) => entry.kind === "remote");
    expect(machine).toMatchObject({ name: "Build", identity: "verified", address: null });
    expect(machine?.routes?.[0]).toMatchObject({ kind: "ssh", label: "ssh build-machine" });
    expect(connections.getGatewayBaseUrl("window")).toBe("http://127.0.0.1:45004");
    const epoch = connections.epochOf(machine!.id);
    tunnels.closers[0]?.({ code: "tunnel-exited", message: "ssh exited" });
    await until(
      () => (tunnels.provider.acquire as ReturnType<typeof mock>).mock.calls.length === 2,
      "re-acquire",
    );
    await until(
      () => connections.getList().connections[1]?.transport === "connected",
      "reconnected",
    );
    expect(connections.epochOf(machine!.id)).toBeGreaterThan(epoch);
    expect(gateways.requests.some((request) => request.path === "/__orkestrator/invoke")).toBe(
      false,
    );
    connections.dispose();
  });

  test("WB-02 analogue: a client without SSH support reports the route unsupported", async () => {
    installGateways({});
    const store = new MemoryStore(
      catalogue([
        {
          id: "ssh-only",
          fallbackName: "build",
          routeOrder: ["ssh-1" as never],
          routes: [
            {
              id: "ssh-1" as never,
              kind: "ssh",
              destination: "build",
              remoteGatewayPort: 34121,
              encryptedToken: encrypted(token),
              enabled: true,
            },
          ],
          autoConnect: true,
        },
      ]),
    );
    const connections = manager(store, { sshTunnels: null });
    await connections.initialize();
    await connections.bind("window", "local");
    expect(connections.getList().supportedRouteKinds).toEqual(["https"]);
    expect(connections.getList().connections[1]?.routes?.[0]?.supported).toBe(false);
    connections.observe("window", "ssh-only");
    await until(() => connections.getList().connections[1]?.transport === "incompatible", "state");
    expect(connections.getList().connections[1]?.transportDetail).toContain("HTTPS route");
    connections.dispose();
  });

  test("keeps migrated entries compatible with the legacy catalogue shape", () => {
    const migrated = migrateDesktopConnections({ activeConnectionId: "local", connections: [] });
    expect(migrated.backends).toEqual([]);
  });
});
