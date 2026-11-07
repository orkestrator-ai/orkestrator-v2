import { afterEach, describe, expect, test } from "bun:test";
import type { NodeListResult, NodeView } from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  DEFAULT_FLEET_UPDATE_POLICY,
  type FleetUpdatePolicy,
} from "@orkestrator/protocol/fleet-currency";
import type { HostMaintenanceSnapshot } from "@orkestrator/protocol/host-maintenance";
import {
  FleetUpdatePolicyRunner,
  type FleetUpdateLink,
  type FleetUpdateNodes,
} from "./fleet-update-policy.js";

const LEAF = "bk_leaf" as BackendId;
const OTHER = "bk_other" as BackendId;

function snapshot(overrides: Partial<HostMaintenanceSnapshot> = {}): HostMaintenanceSnapshot {
  return {
    revision: 1,
    version: "2.38.0",
    updater: {
      kind: "standalone",
      available: true,
      reason: null,
      latestVersion: null,
      updateAvailable: null,
      checkedAt: null,
      checkError: null,
    },
    checkRequest: null,
    job: null,
    tasks: {},
    nextRelease: null,
    ghChannel: "pinned",
    updateChannel: "stable",
    ...overrides,
  };
}

interface FakeNode {
  nodeId: BackendId;
  state: "connected" | "unavailable";
  appVersion: string;
  maintenance: HostMaintenanceSnapshot;
  calls: Array<{ command: string; args: Record<string, unknown> | undefined }>;
  failRequest?: boolean;
}

function fakeNode(nodeId: BackendId, overrides: Partial<FakeNode> = {}): FakeNode {
  return {
    nodeId,
    state: "connected",
    appVersion: "2.38.0",
    maintenance: snapshot(),
    calls: [],
    ...overrides,
  };
}

function fakeNodes(nodes: FakeNode[], leafMode = false) {
  const listeners = new Set<() => void>();
  const api: FleetUpdateNodes = {
    async listNodes() {
      return {
        revision: 1,
        mode: "command",
        suspended: false,
        pendingDetaches: [],
        nodes: nodes.map(
          (node) =>
            ({ nodeId: node.nodeId, connection: { state: node.state } }) as unknown as NodeView,
        ),
      } as unknown as NodeListResult;
    },
    link(nodeId) {
      const node = nodes.find((entry) => entry.nodeId === nodeId);
      if (!node) return null;
      const link: FleetUpdateLink = {
        connected: node.state === "connected",
        hello: { appVersion: node.appVersion },
        async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
          node.calls.push({ command, args });
          if (command === "get_host_maintenance") return node.maintenance as T;
          if (command === "request_host_update") {
            if (node.failRequest) throw new Error("The host refused");
            return { job: null, snapshot: node.maintenance } as T;
          }
          throw new Error(`unexpected ${command}`);
        },
      };
      return link;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isLeaf: () => leafMode,
  };
  return { api, listeners };
}

function memoryStore(initial: unknown = null) {
  let value: unknown = initial;
  const saves: FleetUpdatePolicy[] = [];
  return {
    saves,
    store: {
      load: async () => value,
      save: async (policy: FleetUpdatePolicy) => {
        saves.push(policy);
        value = policy;
      },
    },
  };
}

const stableOn: FleetUpdatePolicy = {
  version: 1,
  channels: { stable: true, beta: false, unstable: false },
};

const runners: FleetUpdatePolicyRunner[] = [];

function runner(options: ConstructorParameters<typeof FleetUpdatePolicyRunner>[0]) {
  const created = new FleetUpdatePolicyRunner({ debounceMs: 60_000, ...options });
  runners.push(created);
  return created;
}

afterEach(() => {
  for (const created of runners.splice(0)) created.stop();
});

describe("FleetUpdatePolicyRunner", () => {
  for (const disable of [false, true]) {
    test(`concurrent channel edits merge after persistence (disable: ${disable})`, async () => {
      const firstSave = Promise.withResolvers<void>();
      const enteredSave = Promise.withResolvers<void>();
      const { store, saves } = memoryStore(disable ? stableOn : null);
      const policy = runner({
        nodes: fakeNodes([]).api,
        selfVersion: async () => "2.40.0",
        store: {
          load: store.load,
          async save(next) {
            if (saves.length === 0) {
              enteredSave.resolve();
              await firstSave.promise;
            }
            await store.save(next);
          },
        },
      });
      const stable = policy.setChannel("stable", !disable);
      await enteredSave.promise;
      const beta = policy.setChannel("beta", true);
      // No unpersisted preference is visible while the first save is held.
      expect(await policy.policy()).toEqual(disable ? stableOn : DEFAULT_FLEET_UPDATE_POLICY);
      firstSave.resolve();
      const [first, second] = await Promise.all([stable, beta]);
      expect(first.channels).toEqual({ stable: !disable, beta: false, unstable: false });
      const expected: FleetUpdatePolicy = {
        version: 1,
        channels: { stable: !disable, beta: true, unstable: false },
      };
      expect(second).toEqual(expected);
      expect(saves).toEqual([first, expected]);
      expect(await store.load()).toEqual(expected);
      expect(await policy.policy()).toEqual(expected);
    });
  }

  test("a failed save publishes nothing and a queued edit uses the last persisted policy", async () => {
    const failedSave = Promise.withResolvers<void>();
    const enteredSave = Promise.withResolvers<void>();
    const { store, saves } = memoryStore(stableOn);
    let saveCalls = 0;
    const policy = runner({
      nodes: fakeNodes([]).api,
      selfVersion: async () => "2.40.0",
      store: {
        load: store.load,
        async save(next) {
          if (++saveCalls === 1) {
            enteredSave.resolve();
            await failedSave.promise;
          }
          await store.save(next);
        },
      },
    });
    const disable = policy.setChannel("stable", false);
    const rejected = disable.catch((error: unknown) => error);
    await enteredSave.promise;
    const enable = policy.setChannel("beta", true);
    expect(await policy.policy()).toEqual(stableOn);
    failedSave.reject(new Error("save failed"));
    expect(await rejected).toMatchObject({ message: "save failed" });
    const expected: FleetUpdatePolicy = {
      version: 1,
      channels: { stable: true, beta: true, unstable: false },
    };
    expect(await enable).toEqual(expected);
    expect(saves).toEqual([expected]);
    expect(await policy.policy()).toEqual(expected);
    expect(await store.load()).toEqual(expected);
  });

  test("is off by default and touches no node", async () => {
    const leaf = fakeNode(LEAF);
    const policy = runner({
      nodes: fakeNodes([leaf]).api,
      selfVersion: async () => "2.40.0",
    });
    await policy.start();
    expect(await policy.policy()).toEqual(DEFAULT_FLEET_UPDATE_POLICY);
    expect(await policy.pass()).toEqual([]);
    expect(leaf.calls).toEqual([]);
  });

  test("asks an older leaf on an enabled channel to install the command node's version when idle", async () => {
    const leaf = fakeNode(LEAF);
    const current = fakeNode(OTHER, { appVersion: "2.40.0" });
    const offline = fakeNode("bk_off" as BackendId, { state: "unavailable" });
    const { store } = memoryStore(stableOn);
    const policy = runner({
      nodes: fakeNodes([leaf, current, offline]).api,
      store,
      selfVersion: async () => "2.40.0",
    });
    await policy.start();
    expect(await policy.pass()).toEqual([
      { nodeId: LEAF, decision: { action: "update", version: "2.40.0" } },
    ]);
    expect(leaf.calls.map((call) => call.command)).toEqual([
      "get_host_maintenance",
      "request_host_update",
    ]);
    expect(leaf.calls[1]!.args).toEqual({
      version: "2.40.0",
      drain: "when-idle",
      maxWaitSeconds: 86_400,
    });
    // The current node is left alone from its hello; the offline one is not reached.
    expect(current.calls).toEqual([]);
    expect(offline.calls).toEqual([]);
  });

  test("never asks twice for the same version within the retry window, even after a failure", async () => {
    let now = 1_000;
    const leaf = fakeNode(LEAF, { failRequest: true });
    const { store } = memoryStore(stableOn);
    const policy = runner({
      nodes: fakeNodes([leaf]).api,
      store,
      selfVersion: async () => "2.40.0",
      now: () => now,
      retryMs: 10_000,
    });
    await policy.start();
    expect((await policy.pass())[0]!.decision).toEqual({ action: "error" });
    expect(await policy.pass()).toEqual([]);
    now += 10_000;
    leaf.failRequest = false;
    expect((await policy.pass())[0]!.decision).toEqual({ action: "update", version: "2.40.0" });
  });

  test("leaves a leaf on another channel, and a leaf mode command node does nothing", async () => {
    const beta = fakeNode(LEAF, { maintenance: snapshot({ updateChannel: "beta" }) });
    const { store } = memoryStore(stableOn);
    const policy = runner({
      nodes: fakeNodes([beta]).api,
      store,
      selfVersion: async () => "2.40.0",
    });
    await policy.start();
    expect(await policy.pass()).toEqual([
      { nodeId: LEAF, decision: { action: "skip", reason: "policy-off" } },
    ]);

    const leaf = fakeNode(LEAF);
    const suspended = runner({
      nodes: fakeNodes([leaf], true).api,
      store: memoryStore(stableOn).store,
      selfVersion: async () => "2.40.0",
    });
    await suspended.start();
    expect(await suspended.pass()).toEqual([]);
    expect(leaf.calls).toEqual([]);
  });

  test("a policy change is saved, and turning a channel on runs a pass", async () => {
    const leaf = fakeNode(LEAF);
    const { store, saves } = memoryStore();
    const policy = runner({
      nodes: fakeNodes([leaf]).api,
      store,
      selfVersion: async () => "2.40.0",
      debounceMs: 0,
    });
    await policy.start();
    expect(await policy.setChannel("stable", true)).toEqual(stableOn);
    expect(saves).toEqual([stableOn]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await policy.pass();
    expect(leaf.calls.some((call) => call.command === "request_host_update")).toBe(true);
    expect((await policy.setChannel("stable", false)).channels.stable).toBe(false);
  });
});
