import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackendId } from "@orkestrator/protocol/federation";
import { previewCommandHandover } from "../electron/command-handover";
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
import { NodeWorkspaceScopes, WORKSPACE_DIRECT_RETRY_MS } from "../electron/node-workspaces";
import {
  setDesktopWorkspaceTarget,
  type WorkspaceContext,
} from "../electron/window-workspace-target";
import { refreshWorkspaceRealm } from "../electron/realm-contexts";
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
  eventsUnauthorized?: boolean;
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
      if (host.eventsUnauthorized) return new Response("{}", { status: 401 });
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
  test("ID-02/ID-04: a second address joins a machine only through an explicit add-method", async () => {
    installGateways({
      "https://a.example": { installationId: "bk_a" },
      "https://a-ip.example": { installationId: "bk_a" },
    });
    const store = new MemoryStore(catalogue([]));
    const connections = manager(store);
    await connections.initialize();
    await connections.connect({ address: "https://a.example", token });
    // An unqualified add that proves the same installation is refused, not merged.
    await expect(connections.connect({ address: "https://a-ip.example", token })).rejects.toThrow(
      "already saved",
    );
    const machineId = connections
      .getList()
      .connections.find((entry) => entry.kind === "remote")!.id;
    await connections.connect({ address: "https://a-ip.example", token, connectionId: machineId });
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
    void connections.bind("probe-two", "two").catch(() => undefined);
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
    void connections.bind("probe-a", "a").catch(() => undefined);
    await until(() => connections.getList().connections[1]?.transport === "connected", "fallback");
    expect(connections.getList().connections[1]?.routes?.find((route) => route.active)?.label).toBe(
      "secondary.example",
    );
    await expect(connections.invoke("get_projects", {}, "probe-a")).resolves.toMatchObject({
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
    void connections.bind("probe-a", "a").catch(() => undefined);
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
    void connections.bind("probe-a", "a").catch(() => undefined);
    await until(() => connections.getList().connections[1]?.transport === "trust-blocked", "block");
    const summary = connections.getList().connections[1];
    expect(summary?.routes?.[0]?.blockedReason).toContain("different Orkestrator installation");
    expect(summary?.routes?.some((route) => route.active)).toBe(false);
    connections.dispose();
  });
});

describe("machine profiles", () => {
  test("CL-01: a profile event updates the shared summary and the device cache", async () => {
    installGateways({ "https://a.example": { installationId: "bk_a" } });
    const store = new MemoryStore(catalogue([savedBackend("a", ["https://a.example"])]));
    const changes = mock(() => undefined);
    const connections = manager(store, { onStateChange: changes });
    await connections.initialize();
    await connections.bind("window", "local");
    void connections.bind("probe-a", "a").catch(() => undefined);
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
    await expect(connections.invoke("get_projects", {}, "window")).resolves.toMatchObject({
      origin: "http://127.0.0.1:45004",
    });
    connections.dispose();
  });

  test("a lost tunnel fences its old loopback origin after non-retryable handover failure", async () => {
    const host = { installationId: "bk_s" };
    const gateways = installGateways({ "http://127.0.0.1:45014": host });
    const tunnels = fakeTunnels("http://127.0.0.1:45014");
    const connections = manager(new MemoryStore(catalogue([])), { sshTunnels: tunnels.provider });
    try {
      await connections.initialize();
      await connections.bind("window", "local");
      const list = await connections.connectSsh(
        { destination: "leaf", remoteGatewayPort: 34121, token, select: true },
        "window",
      );
      const machine = list.connections.find((entry) => entry.kind === "remote")!;
      host.installationId = "bk_wrong";
      tunnels.closers[0]?.({ code: "tunnel-exited", message: "closed" });
      await until(
        () =>
          connections.getList("window").connections.find((entry) => entry.id === machine.id)
            ?.transport === "trust-blocked",
      );
      const before = gateways.requests.length;
      expect(await connections.probe(machine.id)).toBe(false);
      await expect(connections.invoke("create_environment", {}, "window")).rejects.toThrow();
      expect(gateways.requests).toHaveLength(before);
      expect(
        connections.getRendererRequestAuthorization(
          "http://127.0.0.1:45014/__orkestrator/invoke",
          "window",
        ),
      ).toBeNull();
      expect(tunnels.releases).toHaveBeenCalled();
    } finally {
      connections.dispose();
    }
  });

  test("CT-02: two tunnels on one loopback host never share a credential", async () => {
    installGateways({
      "http://127.0.0.1:45011": { installationId: "bk_one", token: "token-for-machine-one" },
      "http://127.0.0.1:45012": { installationId: "bk_two", token: "token-for-machine-two" },
    });
    const origins = ["http://127.0.0.1:45011", "http://127.0.0.1:45012"];
    let next = 0;
    const provider: SshTunnelProvider = {
      acquire: mock(async () => ({
        localOrigin: origins[next++]!,
        release: () => undefined,
        onClosed: () => () => undefined,
      })),
    };
    const connections = manager(new MemoryStore(catalogue([])), { sshTunnels: provider });
    await connections.initialize();
    await connections.bind("window-one", "local");
    await connections.bind("window-two", "local");
    await connections.connectSsh(
      {
        destination: "one",
        remoteGatewayPort: 34125,
        token: "token-for-machine-one",
        select: true,
      },
      "window-one",
    );
    await connections.connectSsh(
      {
        destination: "two",
        remoteGatewayPort: 34125,
        token: "token-for-machine-two",
        select: true,
      },
      "window-two",
    );
    const path = "/__orkestrator/proxy/loopback/3000/";
    expect(connections.getRendererRequestAuthorization(`${origins[0]}${path}`, "window-one")).toBe(
      "Bearer token-for-machine-one",
    );
    // Same host, other port: no credential crosses between the machines.
    expect(
      connections.getRendererRequestAuthorization(`${origins[1]}${path}`, "window-one"),
    ).toBeNull();
    expect(
      connections.getRendererRequestAuthorization(`${origins[0]}${path}`, "window-two"),
    ).toBeNull();
    expect(connections.getRendererRequestAuthorization(`${origins[1]}${path}`, "window-two")).toBe(
      "Bearer token-for-machine-two",
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
    void connections.bind("probe-ssh-only", "ssh-only").catch(() => undefined);
    await until(() => connections.getList().connections[1]?.transport === "incompatible", "state");
    expect(connections.getList().connections[1]?.transportDetail).toContain("HTTPS route");
    connections.dispose();
  });

  test("keeps migrated entries compatible with the legacy catalogue shape", () => {
    const migrated = migrateDesktopConnections({ activeConnectionId: "local", connections: [] });
    expect(migrated.backends).toEqual([]);
  });
});

describe("late catalogue migration", () => {
  test("MG-02/MG-01: entries saved while Local was down are kept and the old list is imported later", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ork-catalogue-"));
    try {
      const store = new NativeDeviceCatalogueStore(directory);
      installGateways({ "https://new.example": { installationId: "bk_new" } });
      // First start: Local is down, so nothing can be migrated yet.
      const first = manager(store, { localBackendAvailable: false });
      await first.initialize();
      await first.connect({ address: "https://new.example", token, select: false });
      first.dispose();
      // Next start: Local is back; the old list is imported once.
      const legacy: StoredDesktopConnections = {
        activeConnectionId: "local",
        connections: [
          {
            id: "old-1",
            name: "old.example",
            address: "https://old.example",
            encryptedToken: encrypted(token),
            lastConnectedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      };
      const invoke = mock(async () => legacy);
      const legacyStore = new LocalBackendCatalogueStore(
        { invoke: invoke as unknown as <T>() => Promise<T> },
        () => true,
      );
      const second = manager(store, { legacyCatalogue: legacyStore });
      await second.initialize();
      expect(
        second
          .getList()
          .connections.map((entry) => entry.name)
          .sort(),
      ).toEqual(["Local", "new.example", "old.example"]);
      second.dispose();
      const third = manager(store, { legacyCatalogue: legacyStore });
      await third.initialize();
      expect(invoke).toHaveBeenCalledTimes(1);
      third.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("disabling an active route fences requests when every alternative is unreachable", async () => {
  const hosts = {
    "https://a.example": { installationId: "bk_a" },
    "https://b.example": { installationId: "bk_a", down: true },
  };
  const gateways = installGateways(hosts);
  const connections = manager(
    new MemoryStore(
      catalogue([
        savedBackend("a", Object.keys(hosts), { verifiedInstallationId: "bk_a" as never }),
      ]),
    ),
  );
  try {
    await connections.initialize();
    await connections.bind("window", "a");
    await connections.setRouteEnabled("a", "https-a-0", false, "window");
    await until(
      () =>
        connections.getList("window").connections.find((entry) => entry.id === "a")?.transport !==
        "connected",
    );
    const count = gateways.requests.filter(
      (request) => request.origin === "https://a.example",
    ).length;
    await expect(connections.invoke("create_environment", {}, "window")).rejects.toThrow();
    expect(
      connections.getRendererRequestAuthorization(
        "https://a.example/__orkestrator/invoke",
        "window",
      ),
    ).toBeNull();
    expect(
      gateways.requests.filter((request) => request.origin === "https://a.example"),
    ).toHaveLength(count);
  } finally {
    connections.dispose();
  }
});

test("useRoute releases a transport if its requesting scope closes while dialing", async () => {
  const gateways = installGateways({
    "https://a.example": { installationId: "bk_a" },
    "http://127.0.0.1:45500": { installationId: "bk_a" },
  });
  let releaseDial!: () => void;
  let dialStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    dialStarted = resolve;
  });
  const released = mock(() => {});
  const backend = savedBackend("a", ["https://a.example"], {
    verifiedInstallationId: "bk_a" as never,
  });
  backend.routes.push({
    id: "ssh" as never,
    kind: "ssh",
    enabled: true,
    destination: "leaf",
    remoteGatewayPort: 34121,
    encryptedToken: encrypted(token),
  });
  backend.routeOrder.push("ssh" as never);
  const connections = manager(new MemoryStore(catalogue([backend])), {
    sshTunnels: {
      acquire: async () => {
        dialStarted();
        await new Promise<void>((resolve) => {
          releaseDial = resolve;
        });
        return {
          localOrigin: "http://127.0.0.1:45500",
          release: released,
          onClosed: () => () => {},
        };
      },
    },
  });
  try {
    await connections.initialize();
    await connections.bind("window", "a");
    const selected = connections.useRoute("a", "ssh", "window");
    await started;
    connections.release("window");
    releaseDial();
    await expect(selected).rejects.toThrow("window");
    expect(released).toHaveBeenCalledTimes(1);
    expect(gateways.requests.some((request) => request.origin.includes("45500"))).toBe(true);
  } finally {
    connections.dispose();
  }
});

test("a window points at a leaf workspace and back to its command node", async () => {
  const gateways = installGateways({ "https://leaf.example": { installationId: "bk_leaf" } });
  const connections = manager(new MemoryStore(catalogue([])));
  try {
    await connections.initialize();
    await connections.bind("window", "local");
    await connections.bind("window:portal", connections.getConnectionId("window"));
    connections.retargetScopeToWorkspace("window", {
      workspaceId: "w1",
      nodeId: "bk_leaf",
      baseUrl: "https://leaf.example",
      token,
    });
    expect(connections.getConnectionId("window")).toBe("workspace:w1");
    expect(connections.getConnectionId("window:portal")).toBe("local");
    expect(connections.getGatewayBaseUrl("window")).toBe("https://leaf.example");
    expect(connections.getBackendIdentity("window").backendId).toBe("bk_leaf");
    await connections.invoke("get_projects", {}, "window");
    expect(gateways.requests.at(-1)?.origin).toBe("https://leaf.example");
    expect(() =>
      connections.retargetScopeToWorkspace("other", {
        workspaceId: "w2",
        baseUrl: "https://leaf.example",
        token,
      }),
    ).toThrow();

    connections.restoreScopeFrom("window", "window:portal");
    expect(connections.getConnectionId("window")).toBe("local");
    expect(connections.getGatewayBaseUrl("window")).toBeNull();
    expect(connections.backendForConnection("workspace:w1")).toBeNull();
  } finally {
    connections.dispose();
  }
});

test("workspace retargeting preserves machine identity and confines relay credentials", async () => {
  const gateways = installGateways({ "https://b.example": { installationId: "bk_b" } });
  const connections = manager(new MemoryStore(catalogue([])));
  try {
    await connections.initialize();
    await connections.bind("panel", "local");
    connections.retargetScopeToWorkspace("panel", {
      workspaceId: "one",
      nodeId: "bk_c",
      baseUrl: "https://b.example/__orkestrator/nodes/bk_c",
      token,
    });
    expect(connections.getBackendIdentity("panel").backendId).toBe("bk_c");
    expect(
      connections.getRendererRequestAuthorization(
        "https://b.example/__orkestrator/invoke",
        "panel",
      ),
    ).toBeNull();
    expect(
      connections.getRendererRequestAuthorization(
        "https://b.example/__orkestrator/nodes/bk_c/__orkestrator/invoke",
        "panel",
      ),
    ).toBe(`Bearer ${token}`);
    connections.rebindWorkspace("panel", {
      baseUrl: "https://b.example/__orkestrator/nodes/bk_c",
      token,
    });
    await connections.invoke("get_projects", {}, "panel");
    expect(gateways.requests.at(-1)?.path).toBe("/__orkestrator/nodes/bk_c/__orkestrator/invoke");
    expect(connections.getBackendIdentity("panel").backendId).toBe("bk_c");
  } finally {
    connections.dispose();
  }
});

describe("handover connection-manager integration", () => {
  test("saved identity lookup prefers a credentialed alias and rejects provisional identities", async () => {
    const store = new MemoryStore(
      catalogue([
        savedBackend("empty", ["https://empty.test"], {
          verifiedInstallationId: "bk_same" as BackendId,
          routes: [
            {
              id: "empty" as never,
              kind: "https",
              enabled: true,
              origin: "https://empty.test",
              encryptedToken: "",
            },
          ],
        }),
        savedBackend("ready", ["https://ready.test"], {
          verifiedInstallationId: "bk_same" as BackendId,
        }),
        savedBackend("provisional", ["https://unknown.test"], {
          verifiedInstallationId: "provisional:unknown" as BackendId,
        }),
      ]),
    );
    const connections = manager(store);
    await connections.initialize();
    try {
      expect(connections.installationIdOf("ready")).toBe("bk_same" as BackendId);
      expect(connections.installationIdOf("provisional")).toBeNull();
      expect(connections.installationIdOf("missing")).toBeNull();
      expect(connections.connectionIdOf("bk_same" as BackendId)).toBe("ready");
      expect(connections.connectionIdOf("bk_missing" as BackendId)).toBeNull();
    } finally {
      connections.dispose();
    }
  });

  test("a leaf's saved but non-live controller reports the connect-first error through the real manager", async () => {
    const local = localBackend();
    local.invoke = mock(async (command: string) =>
      command === "get_node_status"
        ? {
            mode: "leaf",
            controllers: [{ controllerId: "bk_source", displayName: "Source" }],
            mostRecentControllerId: "bk_source",
          }
        : {},
    ) as never;
    const connections = manager(
      new MemoryStore(
        catalogue([
          savedBackend("source", ["https://source.test"], {
            verifiedInstallationId: "bk_source" as BackendId,
          }),
          savedBackend("target", ["https://target.test"], {
            verifiedInstallationId: "bk_target" as BackendId,
          }),
        ]),
      ),
      { localBackend: local },
    );
    await connections.initialize();
    try {
      await expect(
        previewCommandHandover(
          {
            currentConnectionId: "local",
            invokeOn: connections.invokeOn.bind(connections),
            installationIdOf: connections.installationIdOf.bind(connections),
            connectionIdOf: connections.connectionIdOf.bind(connections),
            machineImportEntry: connections.machineImportEntry.bind(connections),
          },
          "target",
        ),
      ).rejects.toThrow("Connect to it first");
    } finally {
      connections.dispose();
    }
  });

  test("machine imports resolve tokens across routes and remove device-local SSH key paths", async () => {
    const backend = savedBackend("remote", ["https://first.test"], {
      verifiedInstallationId: "bk_remote" as BackendId,
      localAlias: "Remote alias",
      routes: [
        {
          id: "empty" as never,
          kind: "https",
          enabled: true,
          origin: "https://first.test",
          encryptedToken: "",
        },
        {
          id: "ssh" as never,
          kind: "ssh",
          enabled: true,
          destination: "user@remote",
          remoteGatewayPort: 4000,
          identityFile: "/device/private-key",
          encryptedToken: encrypted(token),
        },
      ],
      routeOrder: ["empty" as never, "ssh" as never],
    });
    const store = new MemoryStore(catalogue([backend]));
    const connections = manager(store);
    await connections.initialize();
    try {
      expect(await connections.machineImportEntry("remote")).toMatchObject({
        importedFrom: "device:remote",
        fallbackName: "Remote alias",
        verifiedNodeId: "bk_remote",
        enabled: true,
        token,
        routeOrder: ["empty", "ssh"],
        routes: [
          { id: "empty", kind: "https", enabled: true, origin: "https://first.test" },
          {
            id: "ssh",
            kind: "ssh",
            enabled: true,
            destination: "user@remote",
            remoteGatewayPort: 4000,
          },
        ],
      });
      expect((await connections.machineImportEntry("remote"))?.routes[1]).not.toHaveProperty(
        "identityFile",
      );
      expect(await connections.machineImportEntry("missing")).toBeNull();
      expect(store.saves).toBe(0);
      expect(JSON.stringify(store.value)).not.toContain(`"token":"${token}"`);
    } finally {
      connections.dispose();
    }
  });

  test("imports Local only with its verified identity, remote web address, and gateway token", async () => {
    installGateways({ "https://local.test": { installationId: "bk_local" } });
    const local = localBackend();
    local.hello = async () =>
      (
        await fetch("https://local.test/__orkestrator/hello", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json() as never;
    local.getWebClientStatus = async () => ({
      enabled: true,
      running: true,
      url: "https://local.test/path",
      error: null,
    });
    const connections = manager(new MemoryStore(catalogue([])), { localBackend: local });
    await connections.initialize();
    try {
      expect(connections.installationIdOf("local")).toBe("bk_local" as BackendId);
      expect(connections.connectionIdOf("bk_local" as BackendId)).toBe("local");
      expect(await connections.machineImportEntry("local")).toMatchObject({
        importedFrom: "device:local",
        verifiedNodeId: "bk_local",
        token,
        routes: [{ id: "web", kind: "https", enabled: true, origin: "https://local.test" }],
      });
      local.getWebClientStatus = async () => ({
        enabled: true,
        running: false,
        url: null,
        error: null,
      });
      expect(await connections.machineImportEntry("local")).toBeNull();
    } finally {
      connections.dispose();
    }
  });
});

test("a realm's existing relay-origin preview is replaced by an authorized direct-origin preview", async () => {
  setSystemTime(new Date("2026-10-25T00:00:00Z"));
  const relay = "https://relay.example";
  const direct = "https://direct.example";
  installGateways({
    [relay]: { installationId: "bk_leaf", token: "client-grant" },
    [direct]: { installationId: "bk_leaf", token: "client-grant" },
  });
  let opens = 0;
  const revoked: string[] = [];
  const local = localBackend();
  const connections = manager(new MemoryStore(), {
    localBackend: {
      ...local,
      invoke: (async (command: string, args: Record<string, unknown>) => {
        if (command === "open_node_workspace") {
          opens++;
          return {
            workspaceId: `grant-${opens}`,
            nodeId: "bk_leaf",
            nodeName: "Leaf",
            grant: { token: "client-grant", expiresAt: Date.now() + 900_000 },
            directOrigins: opens === 1 ? [] : [direct],
            loopbackOrigin: relay,
            relayBase: "/relay",
          };
        }
        if (command === "close_node_workspace") revoked.push(String(args.workspaceId));
        return local.invoke(command, args);
      }) as typeof local.invoke,
    },
  });
  const scopes = new NodeWorkspaceScopes(async () => ({}));
  const binding: WorkspaceContext = {
    scope: "realm",
    portalScope: null,
    target: null,
    window: { isDestroyed: () => false },
  };
  let registered:
    | {
        target: WorkspaceContext["target"];
        contents: { isDestroyed(): boolean; reload(): void };
        previewConnectionId: string;
        browserPreviewManager: { destroyAll(): void };
        previewTransport: { disposeAll(): Promise<void> };
      }
    | undefined;
  let previewUrl = "";
  let oldDocumentClosed = false;
  let reloaded = false;
  try {
    await connections.initialize();
    await connections.bind("realm", "local");
    await setDesktopWorkspaceTarget(
      binding,
      { nodeId: "bk_leaf" },
      {
        manager: connections,
        scopes,
        committed: (updated) => {
          if (registered)
            refreshWorkspaceRealm(registered, updated.target, () => ({
              manager: { destroyAll: () => undefined },
              previewTransport: { disposeAll: async () => undefined },
            }));
        },
      },
    );
    previewUrl = `${connections.getGatewayBaseUrl("realm")}/__orkestrator/browser/loopback/3000/`;
    expect(new URL(previewUrl).origin).toBe(relay);
    expect(connections.getRendererRequestAuthorization(previewUrl, "realm")).toBe(
      "Bearer client-grant",
    );
    registered = {
      target: binding.target,
      previewConnectionId: connections.getConnectionId("realm"),
      browserPreviewManager: {
        destroyAll: () => {
          oldDocumentClosed = true;
        },
      },
      previewTransport: { disposeAll: async () => undefined },
      contents: {
        isDestroyed: () => false,
        reload: () => {
          expect(oldDocumentClosed).toBe(true);
          expect(registered?.target?.path).toBe("direct");
          // A remount resolves the persisted canonical localhost address again.
          previewUrl = `${connections.getGatewayBaseUrl("realm")}/__orkestrator/browser/loopback/3000/`;
          expect(new URL(previewUrl).origin).toBe(direct);
          expect(connections.getRendererRequestAuthorization(previewUrl, "realm")).toBe(
            "Bearer client-grant",
          );
          reloaded = true;
        },
      },
    };
    setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
    scopes.noteUse("realm");
    await until(() => reloaded, "direct realm refresh");
    expect(revoked).toContain("grant-1");
    expect(registered.target?.path).toBe("direct");
  } finally {
    scopes.releaseAll();
    connections.dispose();
    setSystemTime();
  }
});

test("a refused event stream marks the machine authentication-required without route fallback", async () => {
  installGateways({ "https://a.example": { installationId: "bk_a", eventsUnauthorized: true } });
  const connections = manager(
    new MemoryStore(catalogue([savedBackend("a", ["https://a.example"])])),
  );
  try {
    await connections.initialize();
    await connections.bind("window", "a");
    await until(
      () => connections.getList().connections[1]?.transport === "authentication-required",
      "stream authentication failure",
    );
    expect(connections.getList().connections[1]?.transport).toBe("authentication-required");
  } finally {
    connections.dispose();
  }
});
