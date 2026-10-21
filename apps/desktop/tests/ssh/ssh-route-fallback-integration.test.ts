/**
 * ID-02 and live route fallback with real OpenSSH and a real ConnectionManager.
 * One fake Orkestrator backend (installation `bk_live`) answers on two
 * listeners: D, reached directly over loopback HTTP (the "HTTPS route"), and
 * S, reached only through an SSH forward to a disposable sshd. Opt in with
 * ORKESTRATOR_SSH_INTEGRATION=1.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import type { DeviceCatalogue } from "@orkestrator/protocol/device-catalogue";
import type { ConnectionCatalogueStore } from "../../electron/connection-catalogue-store";
import { ConnectionManager, type SecureStorage } from "../../electron/connection-manager";
import type { SshTunnelSupervisor } from "@orkestrator/protocol/node/ssh/tunnel-supervisor";
import { FAKE_INSTALLATION_ID, FakeOrkestratorGateway } from "./fake-orkestrator-gateway";
import {
  INTEGRATION_TIMEOUT_MS,
  SSH_INTEGRATION_ENABLED,
  SshFixture,
  isAlive,
  realSshTest,
  waitUntil,
  type RunningSshd,
} from "./sshd-harness";

const TOKEN = "live-gateway-token-0123456789";
const SCOPE = "window-live";
const FAILOVER_TIMEOUT_MS = 60_000;

class MemoryStore implements ConnectionCatalogueStore {
  constructor(public value: DeviceCatalogue) {}
  isDurable() {
    return true;
  }
  async load() {
    return structuredClone(this.value);
  }
  async save(catalogue: DeviceCatalogue) {
    this.value = structuredClone(catalogue);
  }
}

const secureStorage: SecureStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (value: string) => Buffer.from(`protected:${value}`),
  decryptStringAsync: async (value: Buffer) => ({
    result: value.toString().replace(/^protected:/, ""),
    shouldReEncrypt: false,
  }),
  getSelectedStorageBackend: () => "keychain",
};

const unavailableLocal = {
  invoke: async () => {
    throw new Error("Local backend is not used by this test.");
  },
} as never;

let fx: SshFixture;
let sshd: RunningSshd;
let direct: FakeOrkestratorGateway;
let forwarded: FakeOrkestratorGateway;
let supervisor: SshTunnelSupervisor;
let manager: ConnectionManager;
let machineId = "";
let spawnedBeforeManager = 0;

describe("live SSH route fallback (ID-02, OP-01)", () => {
  beforeAll(async () => {
    if (!SSH_INTEGRATION_ENABLED) return;
    fx = new SshFixture("ork-ssh-fb-");
    const hostKey = fx.keygen("host_key");
    const clientKey = fx.clientKey("client_key");
    sshd = await fx.startSshd("live", hostKey);
    fx.writeClientConfig({ "live-machine": fx.hostBlock(sshd.port, clientKey) });
    direct = await FakeOrkestratorGateway.start("D", TOKEN);
    forwarded = await FakeOrkestratorGateway.start("S", TOKEN);
    supervisor = fx.supervisor();
    spawnedBeforeManager = fx.spawned.length;
    manager = new ConnectionManager({
      localBackend: unavailableLocal,
      localBackendAvailable: false,
      secureStorage,
      catalogueStore: new MemoryStore({
        version: 2,
        activeConnectionId: "local",
        backends: [],
        features: { federation: true, sshRoutes: true, routeFallback: true },
      }),
      sshTunnels: supervisor,
      platform: process.platform === "linux" ? "linux" : "darwin",
      connectionTimeoutMs: 5_000,
      reconnectDelaysMs: [50, 100, 200],
      onEvent: () => undefined,
    });
    await manager.initialize();
  }, INTEGRATION_TIMEOUT_MS);

  afterAll(async () => {
    if (!SSH_INTEGRATION_ENABLED) return;
    manager?.dispose();
    await fx.cleanup();
    await direct?.destroy().catch(() => undefined);
    await forwarded?.destroy().catch(() => undefined);
  }, INTEGRATION_TIMEOUT_MS);

  realSshTest(
    "ID-02: an HTTPS route and an SSH route proving the same installation form one machine",
    async () => {
      // First-use host-key approval through the manager, as the UI does it.
      const probe = await manager.probeSshHostKey({ destination: "live-machine" });
      await manager.trustSshHostKey(probe.probeId);

      const added = await manager.connect({ address: direct.origin, token: TOKEN, select: false });
      const machine = added.connections.find((entry) => entry.kind === "remote")!;
      machineId = machine.id;
      expect(machine.backendId as string).toBe(FAKE_INSTALLATION_ID);

      const list = await manager.connectSsh({
        destination: "live-machine",
        remoteGatewayPort: forwarded.port,
        token: TOKEN,
        connectionId: machineId,
      });
      const remotes = list.connections.filter((entry) => entry.kind === "remote");
      expect(remotes).toHaveLength(1);
      expect(remotes[0]!.id).toBe(machineId);
      expect(remotes[0]!.identity).toBe("verified");
      expect(remotes[0]!.backendId as string).toBe(FAKE_INSTALLATION_ID);
      expect(remotes[0]!.routes?.map((route) => route.kind)).toEqual(["https", "ssh"]);
      // The SSH hello really travelled through the forward to listener S.
      expect(forwarded.unauthorized).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  realSshTest(
    "fallback: losing the direct route moves to the SSH route without resending a lost mutation",
    async () => {
      expect(machineId).not.toBe("");
      await manager.bind(SCOPE, machineId);
      expect(manager.getGatewayBaseUrl(SCOPE)).toBe(direct.origin);
      await waitUntil(() => direct.eventStreams >= 1, "the direct event stream");

      const read = await manager.invoke<{ listener: string }>("list_projects", {}, SCOPE);
      expect(read.listener).toBe("D");
      const epochBefore = manager.epochOf(machineId);

      // OP-01: a mutation whose response never arrives, then the route dies.
      direct.holdCommands.add("create_environment");
      const mutation = manager.invoke("create_environment", { projectId: "p1" }, SCOPE);
      const mutationOutcome = mutation.then(
        () => "resolved",
        () => "rejected",
      );
      await waitUntil(() => direct.count("create_environment") === 1, "the held mutation");
      await direct.destroy();
      expect(await mutationOutcome).toBe("rejected");

      // Three consecutive stream drops (backoff starts at 500 ms), then the
      // approved SSH route with the same grant takes over.
      await waitUntil(
        () => manager.getGatewayBaseUrl(SCOPE) !== direct.origin,
        "failover to the SSH route",
        FAILOVER_TIMEOUT_MS - 10_000,
      );
      const tunnel = supervisor.snapshot().find((entry) => entry.state === "ready");
      expect(tunnel?.localOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(manager.getGatewayBaseUrl(SCOPE)).toBe(tunnel!.localOrigin!);
      expect(manager.epochOf(machineId)).toBeGreaterThan(epochBefore);
      const active = manager
        .getList(SCOPE)
        .connections.find((entry) => entry.id === machineId)
        ?.routes?.find((route) => route.active);
      expect(active?.kind).toBe("ssh");

      const after = await manager.invoke<{ listener: string }>("list_projects", {}, SCOPE);
      expect(after.listener).toBe("S");
      await waitUntil(() => forwarded.eventStreams >= 1, "the forwarded event stream");
      // The ambiguous mutation was never replayed on the new route.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(forwarded.count("create_environment")).toBe(0);
      expect(direct.count("create_environment")).toBe(1);
    },
    FAILOVER_TIMEOUT_MS,
  );

  realSshTest(
    "dispose stops the owned ssh child only; sshd and the remote backend keep running",
    async () => {
      const tunnels = fx.tunnelsSince(spawnedBeforeManager);
      expect(tunnels.length).toBeGreaterThan(0);
      manager.dispose();
      await waitUntil(
        () => tunnels.every((tunnel) => !isAlive(tunnel.pid)),
        "the ssh children to exit",
      );
      expect(supervisor.snapshot()).toEqual([]);
      expect(isAlive(sshd.pid)).toBe(true);
      // The backend behind the forward is untouched by tunnel cleanup.
      const response = await fetch(`${forwarded.origin}/__orkestrator/status`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
      await forwarded.destroy();
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
