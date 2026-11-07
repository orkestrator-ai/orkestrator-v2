import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { buildPipelineCompletionNotesService } from "@/lib/build-pipeline-completion-notes";
import { dataSavingReadPolicyService } from "@/lib/data-saving";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import {
  defineScopedService,
  type ScopedServiceDef,
  type ScopedServiceInstance,
} from "@/lib/node-scope/scoped-service";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { paneLayoutPersistenceService } from "@/lib/pane-layout-persistence";
import { readCoordinatorFor } from "@/lib/read-coordinator";
import {
  createReadWindowPolicy,
  resetReadWindowPolicyForTests,
  type ReadWindowPolicy,
} from "@/lib/read-window-policy";
import {
  dispatchResourceChange,
  onResourceChanged,
  onResourceResync,
  requestResourceResync,
} from "@/lib/resource-sync";
import {
  COMMAND_SCOPE_SERVICES,
  resourceSyncService,
  startScopeServices,
  WARM_SCOPE_SERVICES,
} from "@/lib/scope-services";
import {
  defineStoreResourceHandlers,
  startStoreResourceSync,
  storeResourceHandlersFor,
  STORE_RESOURCE_HANDLERS,
  storeResourceSyncService,
} from "@/lib/store-resource-sync";
import { getNodeConnectivity, transportConnectivityService } from "@/lib/transport-connectivity";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";

const COMMAND_NODE = "bk_command-node" as BackendId;
const LEAF_NODE = "bk_leaf-node" as BackendId;
const GENERATION = "a".repeat(32);

/** A manifest that reports no change, so a leaf's boot resync reads nothing else. */
const EMPTY_SCOPED_MANIFEST = {
  generation: GENERATION,
  cursor: 0,
  highWater: 0,
  reset: false,
  resetResources: [],
  changes: [],
  revisions: {},
  hasMore: false,
};

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

type Subscribe = (listener: (state: unknown, previous: unknown) => void) => () => void;

/**
 * Everything a service could leave behind: timers (a timeout counts until it
 * fires or is cleared), DOM listeners, zustand subscriptions on the stores the
 * services watch, and the fake clients' event and connection listeners.
 */
class LeftoverTracker {
  readonly timers = new Set<unknown>();
  readonly domListeners = new Map<string, number>();
  readonly storeSubscriptions = new Map<string, number>();
  readonly connectionSubscriptions = new Map<FakeNodeClient, number>();
  private readonly restores: Array<() => void> = [];

  install(clients: FakeNodeClient[]): void {
    const timers = this.timers;
    globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
      const handle = realSetTimeout(
        () => {
          timers.delete(handle);
          callback();
        },
        ms,
        ...args,
      );
      timers.add(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout;
    globalThis.setInterval = ((callback: () => void, ms?: number) => {
      const handle = realSetInterval(callback, ms);
      timers.add(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      timers.delete(handle);
      realClearInterval(handle);
    }) as typeof clearInterval;
    this.restores.push(() => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    });

    for (const [label, target] of [
      ["document", document],
      ["window", window],
    ] as const) {
      const originalAdd = target.addEventListener;
      const originalRemove = target.removeEventListener;
      const add = originalAdd.bind(target);
      const remove = originalRemove.bind(target);
      const seen = new Set<unknown>();
      target.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
        const key = `${label}:${type}`;
        if (!seen.has(listener)) {
          seen.add(listener);
          this.domListeners.set(key, (this.domListeners.get(key) ?? 0) + 1);
        }
        add(type, listener as EventListener, options as AddEventListenerOptions);
      }) as typeof target.addEventListener;
      target.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
        const key = `${label}:${type}`;
        if (seen.delete(listener)) {
          this.domListeners.set(key, (this.domListeners.get(key) ?? 0) - 1);
        }
        remove(type, listener as EventListener, options as EventListenerOptions);
      }) as typeof target.removeEventListener;
      this.restores.push(() => {
        target.addEventListener = originalAdd;
        target.removeEventListener = originalRemove;
      });
    }

    for (const [name, store] of [
      ["ui-chrome", useUIChromeStore as unknown as { subscribe: Subscribe }],
    ] as const) {
      this.trackStore(name, store);
    }

    for (const client of clients) {
      const subscribe = client.connection.subscribe;
      client.connection.subscribe = (listener) => {
        this.connectionSubscriptions.set(
          client,
          (this.connectionSubscriptions.get(client) ?? 0) + 1,
        );
        const unsubscribe = subscribe(listener);
        let active = true;
        return () => {
          if (active) {
            this.connectionSubscriptions.set(client, this.connectionSubscriptions.get(client)! - 1);
          }
          active = false;
          unsubscribe();
        };
      };
    }
  }

  /** Counts subscriptions to `store` (a scope's instance). */
  trackStore(name: string, store: { subscribe: Subscribe }): void {
    const subscribe = store.subscribe;
    store.subscribe = ((listener: Parameters<Subscribe>[0]) => {
      this.storeSubscriptions.set(name, (this.storeSubscriptions.get(name) ?? 0) + 1);
      const unsubscribe = subscribe(listener);
      let active = true;
      return () => {
        if (active) this.storeSubscriptions.set(name, this.storeSubscriptions.get(name)! - 1);
        active = false;
        unsubscribe();
      };
    }) as typeof subscribe;
    this.restores.push(() => {
      store.subscribe = subscribe;
    });
  }

  restore(): void {
    for (const restore of this.restores.splice(0).reverse()) restore();
  }

  /** What is still live, by kind, with zero counts left out. */
  live(clients: FakeNodeClient[]): Record<string, number> {
    const live: Record<string, number> = {};
    if (this.timers.size > 0) live.timers = this.timers.size;
    for (const [key, count] of this.domListeners) if (count !== 0) live[key] = count;
    for (const [key, count] of this.storeSubscriptions)
      if (count !== 0) live[`store:${key}`] = count;
    for (const client of clients) {
      const events = client.listenerCount();
      if (events !== 0) live[`events:${client.nodeId}`] = events;
      const connection = this.connectionSubscriptions.get(client) ?? 0;
      if (connection !== 0) live[`connection:${client.nodeId}`] = connection;
    }
    return live;
  }
}

/** Lets listen promises and zero-delay boot tasks settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise((resolve) => realSetTimeout(resolve, 5));
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

let windowScope: WindowScope;
let commandClient: FakeNodeClient;
let leafClient: FakeNodeClient;
let command: NodeScope;
let leaf: NodeScope;
let policy: ReadWindowPolicy;
let tracker: LeftoverTracker;
let logs: LogCapture;

const logged = (area: string, event: string) =>
  logs.records().filter((record) => record.area === area && record.event === event);

beforeEach(() => {
  logs = captureLogs();
  // A policy with no document or window, so creating it registers nothing.
  policy = createReadWindowPolicy({ document: null, window: null });
  resetReadWindowPolicyForTests(policy);
  commandClient = new FakeNodeClient({ nodeId: COMMAND_NODE });
  leafClient = new FakeNodeClient({
    nodeId: LEAF_NODE,
    invoke: { get_scoped_resource_revision_manifest: EMPTY_SCOPED_MANIFEST },
  });
  tracker = new LeftoverTracker();
  tracker.install([commandClient, leafClient]);
  windowScope = new WindowScope();
  command = windowScope.open({ role: "command", client: commandClient });
  leaf = windowScope.open({ role: "leaf", client: leafClient });
  // Completion notes watch their own scope's pipelines (plan item 3011) and
  // open the notes in its own pane layout, which its persistence and store
  // bindings watch too (plan item 3013).
  for (const scope of [command, leaf]) {
    tracker.trackStore(
      "build-pipeline",
      scope.store(buildPipelineStore) as unknown as { subscribe: Subscribe },
    );
    tracker.trackStore(
      "pane-layout",
      scope.store(paneLayoutStore) as unknown as { subscribe: Subscribe },
    );
  }
});

afterEach(async () => {
  windowScope.dispose();
  await settle();
  const live = tracker.live([commandClient, leafClient]);
  tracker.restore();
  resetReadWindowPolicyForTests();
  logs.restore();
  // Invariant 15: nothing a scope started outlives its window.
  expect(live).toEqual({});
});

describe("scoped services: start, stop and restart", () => {
  const cases: Array<{
    def: ScopedServiceDef;
    on: "command" | "leaf";
    /** Proves the tracker sees what the service starts. */
    expectsWhileRunning: (live: Record<string, number>) => void;
  }> = [
    {
      def: resourceSyncService,
      on: "leaf",
      expectsWhileRunning: (live) => {
        expect(live[`events:${LEAF_NODE}`]).toBe(2);
        expect(live.timers).toBeGreaterThanOrEqual(1);
      },
    },
    {
      def: storeResourceSyncService,
      on: "command",
      expectsWhileRunning: (live) => {
        expect(live[`events:${COMMAND_NODE}`]).toBe(1);
        expect(live["document:visibilitychange"]).toBe(1);
        expect(live["store:pane-layout"]).toBe(1);
      },
    },
    {
      def: transportConnectivityService,
      on: "leaf",
      expectsWhileRunning: (live) => expect(live[`connection:${LEAF_NODE}`]).toBe(1),
    },
    {
      def: dataSavingReadPolicyService,
      on: "command",
      expectsWhileRunning: (live) => expect(live["store:ui-chrome"]).toBe(1),
    },
    {
      def: paneLayoutPersistenceService,
      on: "leaf",
      expectsWhileRunning: (live) => {
        expect(live["store:pane-layout"]).toBe(1);
        expect(live["window:pagehide"]).toBe(1);
      },
    },
    {
      def: buildPipelineCompletionNotesService,
      on: "leaf",
      expectsWhileRunning: (live) => {
        expect(live["store:build-pipeline"]).toBe(1);
        expect(live["store:pane-layout"]).toBe(1);
      },
    },
  ];

  for (const { def, on, expectsWhileRunning } of cases) {
    test(`${def.name} leaves nothing behind after stop, and restarts`, async () => {
      const scope = on === "command" ? command : leaf;
      const clients = [commandClient, leafClient];

      const first = scope.service(def);
      expect(first.status).toBe("running");
      await settle();
      expectsWhileRunning(tracker.live(clients));

      first.stop();
      await settle();
      expect(first.status).toBe("stopped");
      expect(first.signal.aborted).toBe(true);
      expect(tracker.live(clients)).toEqual({});

      const again = scope.service(def);
      expect(again).not.toBe(first);
      expect(again.status).toBe("running");
      await settle();
      expectsWhileRunning(tracker.live(clients));

      again.stop();
      await settle();
      expect(tracker.live(clients)).toEqual({});
      expect(scope.health.get()).toEqual({ state: "ok" });
    });
  }

  test("disposing the scope stops every service it runs", async () => {
    startScopeServices(command, COMMAND_SCOPE_SERVICES);
    startScopeServices(leaf, WARM_SCOPE_SERVICES);
    await settle();
    expect(Object.keys(tracker.live([commandClient, leafClient])).length).toBeGreaterThan(0);
    command.dispose();
    leaf.dispose();
    await settle();
    expect(tracker.live([commandClient, leafClient])).toEqual({});
  });

  test("startScopeServices starts in order, reuses a running one and stops in reverse", () => {
    const order: string[] = [];
    const record = (name: string) =>
      defineScopedService(name, () => {
        order.push(`start ${name}`);
        return { stop: () => order.push(`stop ${name}`) };
      });
    const a = record("a");
    const b = record("b");
    const running = command.service(a);
    const stop = startScopeServices(command, [a, b]);
    expect(command.service(a)).toBe(running);
    stop();
    stop();
    expect(order).toEqual(["start a", "start b", "stop b", "stop a"]);
  });
});

describe("failure isolation", () => {
  test("a command-only service started on a leaf fails only the leaf", () => {
    startScopeServices(command, COMMAND_SCOPE_SERVICES);
    const stopLeaf = startScopeServices(leaf, [
      ...WARM_SCOPE_SERVICES,
      dataSavingReadPolicyService,
    ]);

    expect(leaf.health.get()).toEqual({
      state: "failed",
      failedServices: ["data-saving-read-policy"],
    });
    expect(command.health.get()).toEqual({ state: "ok" });
    // The leaf's other services kept starting and running.
    expect(leaf.service(resourceSyncService).status).toBe("running");
    expect(leaf.service(transportConnectivityService).status).toBe("running");
    expect(logged("web.node-scope", "service.failed")[0]?.fields).toEqual({
      service: "data-saving-read-policy",
      role: "leaf",
      error: "Error",
    });
    stopLeaf();
  });

  test("a service whose work rejects fails its scope and leaves the others running", async () => {
    let reject!: (error: unknown) => void;
    const flaky = defineScopedService<ScopedServiceInstance>("flaky", () => ({
      stop: () => undefined,
      done: new Promise((_resolve, rejectDone) => {
        reject = rejectDone;
      }),
    }));
    startScopeServices(command, WARM_SCOPE_SERVICES);
    startScopeServices(leaf, [...WARM_SCOPE_SERVICES, flaky]);
    reject(new TypeError("boom"));
    await settle();
    expect(leaf.health.get()).toEqual({ state: "failed", failedServices: ["flaky"] });
    expect(command.health.get()).toEqual({ state: "ok" });
    expect(command.service(resourceSyncService).status).toBe("running");
    // Retryable: starting it again clears the failure.
    expect(leaf.service(flaky).status).toBe("running");
    expect(leaf.health.get()).toEqual({ state: "ok" });
  });
});

describe("per-node change feeds", () => {
  const change = (overrides: Partial<ResourceChange> = {}): ResourceChange => ({
    resource: "kanban",
    id: "project-1",
    revision: 1,
    ...overrides,
  });

  test("a change on one node's feed reaches only that node's handlers", async () => {
    const seen: string[] = [];
    onResourceChanged("kanban", () => void seen.push("command"), command);
    onResourceChanged("kanban", () => void seen.push("leaf"), leaf);
    dispatchResourceChange(change(), leaf);
    await new Promise((resolve) => realSetTimeout(resolve, 80));
    expect(seen).toEqual(["leaf"]);
  });

  test("a leaf's main-stream events feed only the leaf", async () => {
    leaf.service(resourceSyncService);
    await settle();
    const seen: string[] = [];
    onResourceChanged("kanban", () => void seen.push("command"), command);
    onResourceChanged("kanban", () => void seen.push("leaf"), leaf);
    leafClient.emit("resource-changed", change());
    await new Promise((resolve) => realSetTimeout(resolve, 80));
    expect(seen).toEqual(["leaf"]);
    // The leaf's boot resync read its own node's manifest.
    expect(leafClient.calls("get_scoped_resource_revision_manifest").length).toBeGreaterThan(0);
    expect(commandClient.invocations).toEqual([]);
  });

  test("disposing a scope drops its queued dispatches", async () => {
    const seen: string[] = [];
    onResourceChanged("kanban", () => void seen.push("leaf"), leaf);
    dispatchResourceChange(change(), leaf);
    expect(tracker.timers.size).toBe(1);
    leaf.dispose();
    expect(tracker.timers.size).toBe(0);
    await new Promise((resolve) => realSetTimeout(resolve, 80));
    expect(seen).toEqual([]);
  });
});

describe("store resource handler registrations", () => {
  test("a non-command scope runs only every-scope registrations", () => {
    expect(storeResourceHandlersFor(command)).toEqual([...STORE_RESOURCE_HANDLERS]);
    const everyScope = STORE_RESOURCE_HANDLERS.filter(({ runsOn }) => runsOn === "every-scope");
    expect(storeResourceHandlersFor(leaf)).toEqual(everyScope);
    // Converted stores' bindings (plan item 3004: projects and environments).
    expect(everyScope.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["projects", "environments"]),
    );
    const scoped = defineStoreResourceHandlers("scoped-test", "every-scope", () => undefined);
    expect(storeResourceHandlersFor(leaf, [...STORE_RESOURCE_HANDLERS, scoped])).toEqual([
      ...everyScope,
      scoped,
    ]);
  });

  test("registrations join the resync in phase order and can requeue", async () => {
    const order: string[] = [];
    let requeued = false;
    const phases = (name: string) =>
      defineStoreResourceHandlers(name, "every-scope", (context) => {
        for (const phase of ["layouts", "dependents", "environments", "projects"] as const) {
          context.onResync(phase, async (pass) => {
            order.push(`${name}:${phase}`);
            if (phase === "projects" && name === "a" && !requeued && pass.includes("project")) {
              requeued = true;
              pass.requeue("project");
            }
            await Promise.resolve();
          });
        }
      });
    const stop = startStoreResourceSync({}, { scope: leaf, handlers: [phases("a"), phases("b")] });
    // Through the leaf's feed, as its manifest does; the command scope's sees nothing.
    requestResourceResync(leaf);
    await settle();
    expect(order).toEqual([
      "a:projects",
      "b:projects",
      "a:environments",
      "b:environments",
      "a:dependents",
      "b:dependents",
      "a:layouts",
      "b:layouts",
      // The requeued project read runs another pass in the same loop.
      "a:projects",
      "b:projects",
      "a:environments",
      "b:environments",
      "a:dependents",
      "b:dependents",
      "a:layouts",
      "b:layouts",
    ]);
    stop();
  });

  test("each failed read is logged under its phase and fails the pass", async () => {
    const failing = defineStoreResourceHandlers("failing", "every-scope", (context) => {
      context.onResync("projects", () => Promise.reject(new Error("projects failed")));
      context.onResync("dependents", () => [
        Promise.reject(new Error("first failed")),
        Promise.resolve(),
        Promise.reject(new Error("second failed")),
      ]);
    });
    const handled: string[] = [];
    const stop = startStoreResourceSync({}, { scope: leaf, handlers: [failing] });
    // The manifest awaits the resync handlers; a failure keeps its revision unacknowledged.
    onResourceResync(() => void handled.push("resync"), leaf);
    requestResourceResync(leaf);
    await settle();
    expect(handled).toEqual(["resync"]);
    expect(logged("web.resource-sync", "resync.project-failed")).toHaveLength(1);
    expect(logged("web.resource-sync", "resync.read-failed")).toHaveLength(2);
    expect(logged("web.resource-sync", "resync-handler.threw")).toHaveLength(1);
    stop();
  });
});

describe("per-node read coordinators", () => {
  test("each scope has its own coordinator, all following the window policy", () => {
    const commandReads = readCoordinatorFor(command);
    const leafReads = readCoordinatorFor(leaf);
    expect(commandReads).not.toBe(leafReads);
    expect(readCoordinatorFor(leaf)).toBe(leafReads);

    leafReads.setDisconnected(true);
    expect(leafReads.getDiagnostics().paused).toBe(true);
    expect(commandReads.getDiagnostics().paused).toBe(false);

    policy.setHostHidden(true);
    expect(commandReads.getDiagnostics().paused).toBe(true);
    policy.setHostHidden(false);
    policy.setDataSaving(true);
    expect(commandReads.getDiagnostics().dataSaving).toBe(true);
    expect(leafReads.getDiagnostics().dataSaving).toBe(true);
  });

  test("a node's outage pauses only that node's reads", () => {
    leafClient.connection.set("live");
    leaf.service(transportConnectivityService);
    leafClient.connection.set("lapsed");
    expect(getNodeConnectivity(leaf).disconnected).toBe(true);
    expect(getNodeConnectivity(command).disconnected).toBe(false);
    expect(readCoordinatorFor(leaf).getDiagnostics().disconnected).toBe(true);
    expect(readCoordinatorFor(command).getDiagnostics().disconnected).toBe(false);
    leafClient.connection.set("live");
    expect(readCoordinatorFor(leaf).getDiagnostics().disconnected).toBe(false);
  });

  test("disposing a scope disposes its coordinator", () => {
    const leafReads = readCoordinatorFor(leaf);
    const reads: number[] = [];
    leafReads.subscribe({
      key: { resource: "test", target: "leaf" },
      demand: { intervalMs: 60_000 },
      readOnSubscribe: false,
      read: () => void reads.push(1),
    });
    expect(tracker.timers.size).toBe(1);
    leaf.dispose();
    expect(tracker.timers.size).toBe(0);
    expect(() => readCoordinatorFor(leaf)).toThrow(/disposed/);
  });
});
