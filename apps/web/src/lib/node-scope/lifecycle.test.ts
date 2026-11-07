import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { Unlisten } from "@orkestrator/protocol/node-client";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { DEFAULT_WINDOW_BYTE_BUDGETS } from "./byte-budget";
import type { ManagedScope, TierChange } from "./lifecycle";
import {
  detectLifecycleHost,
  HOST_LIFECYCLE_DEFAULTS,
  lifecycleConfigFor,
  type LifecycleConfigOverrides,
} from "./lifecycle-config";
import { FakeLifecycleClock, FakeMemoryWarnings, FakeVisibility } from "./lifecycle.test-support";
import { createListenerFanout } from "./listener-fanout";
import type { NodeScope } from "./node-scope";
import { WindowScope } from "./window-scope";

const MIB = 1024 * 1024;
const SUSPEND_MS = 10_000;
const COMMAND = "bk_command" as BackendId;
const node = (index: number) => `bk_leaf-${index}` as BackendId;

let clock: FakeLifecycleClock;
let visibility: FakeVisibility;
let warnings: FakeMemoryWarnings;
let windowScope: WindowScope;
let calls: string[];
let transitions: TierChange[];
let stopTransitions: Unlisten;

function makeWindow(overrides: LifecycleConfigOverrides = {}, heap?: () => number | null) {
  windowScope?.dispose();
  windowScope = new WindowScope({
    lifecycle: {
      host: "browser",
      suspendAfterMs: SUSPEND_MS,
      memorySource: "estimate",
      memoryBudgetBytes: 1024 * MIB,
      scopeEstimateBytes: 10 * MIB,
      suspendedEstimateBytes: 1 * MIB,
      pressureCheckMs: null,
      ...overrides,
    },
    lifecycleDeps: {
      clock,
      visibility,
      memoryWarnings: warnings,
      readHeap: async () => heap?.() ?? null,
    },
  });
  windowScope.open({ role: "command", client: new FakeNodeClient({ nodeId: COMMAND }) });
  stopTransitions = windowScope.lifecycle.onTransition((change) => transitions.push(change));
  return windowScope;
}

function open(nodeId: BackendId, client: FakeNodeClient = new FakeNodeClient({ nodeId })) {
  const scope = windowScope.open({ role: "leaf", client });
  const managed = windowScope.lifecycle.manage(scope, {
    startServices: (started) => {
      calls.push(`start ${started.nodeId}`);
      return () => calls.push(`stop ${started.nodeId}`);
    },
    setHidden: (target, hidden) => calls.push(`${hidden ? "hide" : "unhide"} ${target.nodeId}`),
    resync: (target) => calls.push(`resync ${target.nodeId}`),
  });
  return { scope, client, managed };
}

function show(nodeId: BackendId | null) {
  windowScope.select(nodeId ? { nodeId, projectId: null, environmentId: null } : null);
}

const tierOf = (nodeId: BackendId) => windowScope.lifecycle.tierOf(nodeId);

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

beforeEach(() => {
  clock = new FakeLifecycleClock();
  visibility = new FakeVisibility();
  warnings = new FakeMemoryWarnings();
  calls = [];
  transitions = [];
  makeWindow();
});

afterEach(() => {
  stopTransitions();
  windowScope.dispose();
  // Invariant 15: nothing the lifecycle scheduled outlives its window.
  expect(clock.pending).toBe(0);
  expect(visibility.listenerCount).toBe(0);
  expect(warnings.listenerCount).toBe(0);
});

describe("tier state machine", () => {
  test("open: summary → warm for a hidden node, its services start, its reads are told it is hidden", () => {
    const opened: string[] = [];
    const stop = windowScope.lifecycle.onScopeOpen((scope) => {
      // 4003's hook point runs before the warm services start.
      opened.push(`${scope.nodeId} ${calls.length}`);
    });
    const { scope } = open(node(1));
    stop();
    expect(opened).toEqual([`${node(1)} 0`]);
    expect(scope.tier.get()).toBe("warm");
    expect(tierOf(node(1))).toBe("warm");
    expect(windowScope.lifecycle.tiers.get().get(node(1))).toBe("warm");
    expect(calls).toEqual([`start ${node(1)}`, `hide ${node(1)}`]);
    expect(transitions.map((change) => `${change.from}→${change.to} ${change.reason}`)).toEqual([
      "summary→warm open",
    ]);
    // Unmanaged: the command scope is always live, an unknown node summary.
    expect(tierOf(COMMAND)).toBe("live");
    expect(tierOf(node(9))).toBe("summary");
  });

  test("open while shown goes on to live; switching away is live → warm and the budgets follow", () => {
    show(node(1));
    const { scope } = open(node(1));
    expect(scope.tier.get()).toBe("live");
    expect(windowScope.lifecycle.shownNodeId).toBe(node(1));
    const shownAt = clock.now();
    expect(windowScope.lifecycle.lastShown(node(1))).toBe(shownAt);

    // The shown node's heavy data is protected from another node's reservation.
    windowScope.budgets.transcripts.reserve(node(1), "session", 10);
    expect(windowScope.budgets.transcripts.has(node(1), "session")).toBe(true);

    clock.time += 500;
    show(null);
    expect(scope.tier.get()).toBe("warm");
    expect(windowScope.lifecycle.shownNodeId).toBe(COMMAND);
    expect(windowScope.lifecycle.lastShown(node(1))).toBe(shownAt + 500);
    // Heavy data stays reserved after switching away; it goes on demand.
    expect(windowScope.budgets.transcripts.usedBytesFor(node(1))).toBe(10);
    expect(calls).toEqual([`start ${node(1)}`, `unhide ${node(1)}`, `hide ${node(1)}`]);
    expect(transitions.map((change) => `${change.to} ${change.reason}`)).toEqual([
      "warm open",
      "live shown",
      "warm hidden",
    ]);
  });

  test("warm and hidden past suspendAfterMs suspends: services stop, streams close, cursor kept", async () => {
    const { scope, client } = open(node(1));
    calls = [];
    await clock.advance(SUSPEND_MS - 1);
    expect(scope.tier.get()).toBe("warm");
    await clock.advance(1);
    expect(scope.tier.get()).toBe("suspended");
    expect(client.suspended).toBe(true);
    expect(client.disposed).toBe(false);
    expect(calls).toEqual([`stop ${node(1)}`]);
    expect(transitions.at(-1)).toMatchObject({
      from: "warm",
      to: "suspended",
      reason: "suspend-timer",
    });
  });

  test("streams close only after the scope's listeners were handed off, and the tier changes first", async () => {
    const client = new FakeNodeClient({ nodeId: node(1) });
    const scope = windowScope.open({ role: "leaf", client });
    const seen: string[] = [];
    let settle: () => void = () => undefined;
    windowScope.lifecycle.manage(scope, {
      startServices: () => () => undefined,
      handoff: (target) => {
        // 5001's attention moves to the relay while this client still delivers.
        seen.push(`handoff tier=${target.tier.get()} suspended=${client.suspended}`);
        return new Promise<void>((resolve) => {
          settle = resolve;
        });
      },
    });
    await clock.advance(SUSPEND_MS);
    expect(seen).toEqual(["handoff tier=warm suspended=false"]);
    expect(scope.tier.get()).toBe("suspended");
    expect(client.suspended).toBe(false);
    settle();
    await flush();
    expect(client.suspended).toBe(true);

    // Resumed while a handoff is pending: the late settle closes nothing.
    show(node(1));
    expect(client.suspended).toBe(false);
    show(null);
    await clock.advance(SUSPEND_MS);
    show(node(1));
    settle();
    await flush();
    expect(scope.tier.get()).toBe("live");
    expect(client.suspended).toBe(false);
  });

  test("switching back before the timer cancels it; the shown node is never suspended by it", async () => {
    const { scope } = open(node(1));
    await clock.advance(SUSPEND_MS / 2);
    show(node(1));
    await clock.advance(SUSPEND_MS * 3);
    expect(scope.tier.get()).toBe("live");
    show(null);
    await clock.advance(SUSPEND_MS - 1);
    expect(scope.tier.get()).toBe("warm");
    await clock.advance(1);
    expect(scope.tier.get()).toBe("suspended");
  });

  test("switching back to a suspended node resumes it from its cursor with a resync", async () => {
    const { scope, client } = open(node(1));
    await clock.advance(SUSPEND_MS);
    expect(scope.tier.get()).toBe("suspended");
    calls = [];
    show(node(1));
    expect(scope.tier.get()).toBe("live");
    expect(client.suspended).toBe(false);
    expect(calls).toEqual([`unhide ${node(1)}`, `start ${node(1)}`, `resync ${node(1)}`]);
    expect(transitions.at(-1)).toMatchObject({ from: "suspended", to: "live", reason: "resume" });
  });

  test("resume(nodeId) wakes a hidden suspended node to warm and re-arms its timer", async () => {
    const { scope } = open(node(1));
    await clock.advance(SUSPEND_MS);
    windowScope.lifecycle.resume(node(1));
    expect(scope.tier.get()).toBe("warm");
    await clock.advance(SUSPEND_MS);
    expect(scope.tier.get()).toBe("suspended");
  });

  test("releasing a managed scope gives it back unsuspended, with its services stopped", async () => {
    const { scope, client, managed } = open(node(1));
    await clock.advance(SUSPEND_MS);
    managed.release();
    managed.release();
    expect(scope.disposed).toBe(false);
    expect(client.suspended).toBe(false);
    expect(windowScope.lifecycle.size).toBe(0);
    expect(windowScope.lifecycle.tiers.get().size).toBe(0);
    // The last managed scope went: no timer, listener or interval is left.
    expect(clock.pending).toBe(0);
    expect(visibility.listenerCount).toBe(0);
  });
});

describe("resume after a gap", () => {
  /** A fake whose subscriptions go through the clients' real listener table. */
  class StreamClient extends FakeNodeClient {
    private readonly fanout = createListenerFanout((event, deliver) =>
      super.listenRaw(event, deliver),
    );
    override listenRaw<T = unknown>(event: string, handler: (payload: T) => void): Unlisten {
      return this.fanout.add(event, handler as (payload: unknown) => void);
    }
    override suspend(): void {
      super.suspend();
      this.fanout.suspend();
    }
    override resume(): void {
      super.resume();
      this.fanout.resume();
    }
  }

  test("events missed while suspended are never replayed; the scope re-reads its snapshot", async () => {
    let revision = 1;
    const client = new StreamClient({
      nodeId: node(1),
      invoke: { get_snapshot: () => ({ revision }) },
    });
    const scope = windowScope.open({ role: "leaf", client });
    const applied: string[] = [];
    let resynced = 0;
    windowScope.lifecycle.manage(scope, {
      // A warm service in miniature: read the snapshot, then apply events.
      startServices(target) {
        void target.client
          .invokeRaw<{ revision: number }>("get_snapshot")
          .then((snapshot) => applied.push(`snapshot ${snapshot.revision}`));
        const stop = target.client.listenRaw<{ revision: number }>("resource-changed", (event) =>
          applied.push(`event ${event.revision}`),
        );
        return stop;
      },
      resync: () => {
        resynced += 1;
      },
    });
    await flush();
    client.emit("resource-changed", { revision: 2 });
    expect(applied).toEqual(["snapshot 1", "event 2"]);

    await clock.advance(SUSPEND_MS);
    expect(scope.tier.get()).toBe("suspended");
    // The node keeps working while this window is away; these never arrive.
    for (revision = 3; revision <= 5; revision += 1) {
      client.emit("resource-changed", { revision });
    }
    revision = 5;
    expect(applied).toEqual(["snapshot 1", "event 2"]);

    show(node(1));
    await flush();
    expect(resynced).toBe(1);
    // The authoritative read replaces what was missed; nothing stale replays.
    expect(applied).toEqual(["snapshot 1", "event 2", "snapshot 5"]);
    client.emit("resource-changed", { revision: 6 });
    expect(applied.at(-1)).toBe("event 6");
    expect(client.calls("get_snapshot")).toHaveLength(2);
  });
});

describe("pressure", () => {
  function budgetOver(nodes: number, warmBytes = 10 * MIB) {
    // The command scope plus `nodes` warm scopes, minus a little.
    makeWindow({ memoryBudgetBytes: (nodes + 1) * warmBytes - 1, scopeEstimateBytes: warmBytes });
  }

  test("drops heavy data of the least recently shown first, then suspends, then disposes; never the shown node", async () => {
    makeWindow({ memoryBudgetBytes: 1024 * MIB });
    const a = open(node(1));
    const b = open(node(2));
    const c = open(node(3));
    const evicted: string[] = [];
    const onEvict = (entry: { nodeId: BackendId; key: string }) =>
      evicted.push(`${entry.nodeId}/${entry.key}`);
    // Shown order: 1, then 2, then 3 (shown now).
    for (const { scope } of [a, b, c]) {
      show(scope.nodeId);
      windowScope.budgets.transcripts.reserve(scope.nodeId, "history", 5 * MIB, { onEvict });
      clock.time += 100;
    }
    expect(windowScope.lifecycle.shownNodeId).toBe(node(3));

    expect((await windowScope.lifecycle.checkPressure()).steps).toEqual([]);

    // Tighten the budget below what is open now (4 scopes + 15 MiB of history).
    windowScope.lifecycle.configure({ memoryBudgetBytes: 20 * MIB });
    const result = await windowScope.lifecycle.checkPressure();
    expect(result.steps.map((step) => `${step.kind} ${step.nodeId}`)).toEqual([
      `drop-heavy-data ${node(1)}`,
      `drop-heavy-data ${node(2)}`,
      `suspend ${node(1)}`,
      `suspend ${node(2)}`,
    ]);
    expect(evicted).toEqual([`${node(1)}/history`, `${node(2)}/history`]);
    // The pass never disposes what it suspended; the recheck does.
    expect(a.scope.disposed).toBe(false);
    await clock.advance(1_000);
    expect(a.scope.disposed).toBe(true);
    expect(tierOf(node(1))).toBe("summary");
    // The shown node keeps everything.
    expect(c.scope.tier.get()).toBe("live");
    expect(windowScope.budgets.transcripts.has(node(3), "history")).toBe(true);
    expect(transitions.filter((change) => change.nodeId === node(3)).at(-1)?.to).toBe("live");
  });

  test("a scope going back to summary is disposed by default, or handed back through toSummary", async () => {
    budgetOver(1);
    const kept: string[] = [];
    const first = windowScope.open({
      role: "leaf",
      client: new FakeNodeClient({ nodeId: node(1) }),
    });
    windowScope.lifecycle.manage(first, {
      startServices: () => () => undefined,
      toSummary: (scope) => kept.push(scope.nodeId),
    });
    const second = open(node(2));
    show(node(2));
    await windowScope.lifecycle.checkPressure();
    await clock.advance(1_000);
    expect(kept).toEqual([node(1)]);
    expect(first.disposed).toBe(false);
    // Handed back open, it reads live again outside the lifecycle.
    expect(first.tier.get()).toBe("live");
    expect(tierOf(node(1))).toBe("live");
    expect(second.scope.tier.get()).toBe("live");
  });

  test("under budget nothing moves", async () => {
    open(node(1));
    const result = await windowScope.lifecycle.checkPressure();
    expect(result.steps).toEqual([]);
    expect(result.reading.source).toBe("estimate");
    expect(result.reading.bytes).toBe(20 * MIB);
  });

  test("a measured heap reading is used where the page can take one, else the estimate", async () => {
    let heap: number | null = 100 * MIB;
    makeWindow({ memorySource: "measured", memoryBudgetBytes: 512 * MIB }, () => heap);
    const a = open(node(1));
    expect((await windowScope.lifecycle.checkPressure()).steps).toEqual([]);
    heap = 700 * MIB;
    const reading = await windowScope.lifecycle.readMemory();
    expect(reading).toEqual({ bytes: 700 * MIB, source: "measured", budgetBytes: 512 * MIB });
    heap = null;
    expect((await windowScope.lifecycle.readMemory()).source).toBe("estimate");
    heap = 700 * MIB;
    const result = await windowScope.lifecycle.checkPressure();
    // The heap stays high, so every hidden scope goes as far as one pass allows.
    expect(result.steps.map((step) => step.kind)).toEqual(["suspend"]);
    expect(a.scope.tier.get()).toBe("suspended");
    await clock.advance(1_000);
    expect(a.scope.disposed).toBe(true);
  });

  test("a memory warning drops heavy data and suspends every hidden scope, then disposes on the next", async () => {
    const a = open(node(1));
    const b = open(node(2));
    show(node(2));
    windowScope.budgets.images.reserve(node(1), "image", 4 * MIB);
    windowScope.budgets.images.reserve(node(2), "image", 4 * MIB);
    warnings.warn();
    expect(a.scope.tier.get()).toBe("suspended");
    expect(windowScope.budgets.images.usedBytesFor(node(1))).toBe(0);
    expect(b.scope.tier.get()).toBe("live");
    expect(windowScope.budgets.images.usedBytesFor(node(2))).toBe(4 * MIB);
    warnings.warn();
    expect(a.scope.disposed).toBe(true);
    expect(b.scope.disposed).toBe(false);
  });

  test("periodic checks run only while a scope is managed", async () => {
    makeWindow({ pressureCheckMs: 5_000 });
    expect(clock.pending).toBe(0);
    const { managed } = open(node(1));
    show(node(1));
    expect(clock.pending).toBe(1);
    managed.release();
    expect(clock.pending).toBe(0);
  });
});

describe("iOS", () => {
  test("a hidden document suspends every managed scope at once; visible again resumes the shown one", () => {
    makeWindow({ host: "ios", suspendWhenDocumentHidden: true });
    const a = open(node(1));
    const b = open(node(2));
    show(node(2));
    visibility.set(true);
    expect(a.scope.tier.get()).toBe("suspended");
    expect(b.scope.tier.get()).toBe("suspended");
    expect(b.client.suspended).toBe(true);
    visibility.set(false);
    expect(b.scope.tier.get()).toBe("live");
    expect(b.client.suspended).toBe(false);
    expect(a.scope.tier.get()).toBe("suspended");
  });

  test("elsewhere a hidden document changes no tier", () => {
    const a = open(node(1));
    visibility.set(true);
    expect(a.scope.tier.get()).toBe("warm");
  });
});

describe("timers stop on dispose", () => {
  test("disposing a managed scope clears its suspend timer and reports it back to summary", () => {
    const { scope } = open(node(1));
    expect(clock.pending).toBe(1);
    scope.dispose();
    expect(clock.pending).toBe(0);
    expect(windowScope.lifecycle.size).toBe(0);
    expect(tierOf(node(1))).toBe("summary");
    expect(transitions.at(-1)).toMatchObject({ nodeId: node(1), to: "summary" });
  });

  test("disposing the window stops every timer, listener and the pressure interval", () => {
    makeWindow({ pressureCheckMs: 5_000 });
    open(node(1));
    open(node(2));
    expect(clock.pending).toBe(3);
    expect(visibility.listenerCount).toBe(1);
    windowScope.dispose();
    expect(clock.pending).toBe(0);
    expect(visibility.listenerCount).toBe(0);
    expect(warnings.listenerCount).toBe(0);
    expect(() => windowScope.lifecycle).toThrow("disposed");
  });
});

describe("per-host defaults", () => {
  test("report §8.2's placeholders: desktop 15 min, browser 5 min, iOS 2 min and on hidden", () => {
    expect(HOST_LIFECYCLE_DEFAULTS.desktop.suspendAfterMs).toBe(15 * 60_000);
    expect(HOST_LIFECYCLE_DEFAULTS.browser.suspendAfterMs).toBe(5 * 60_000);
    expect(HOST_LIFECYCLE_DEFAULTS.ios.suspendAfterMs).toBe(2 * 60_000);
    expect(HOST_LIFECYCLE_DEFAULTS.ios.suspendWhenDocumentHidden).toBe(true);
    expect(HOST_LIFECYCLE_DEFAULTS.desktop.suspendWhenDocumentHidden).toBe(false);
    expect(HOST_LIFECYCLE_DEFAULTS.browser.memorySource).toBe("measured");
    expect(HOST_LIFECYCLE_DEFAULTS.ios.memorySource).toBe("estimate");
    expect(HOST_LIFECYCLE_DEFAULTS.browser.byteBudgets).toEqual(DEFAULT_WINDOW_BYTE_BUDGETS);
    expect(HOST_LIFECYCLE_DEFAULTS.ios.byteBudgets.transcripts).toBeLessThan(
      DEFAULT_WINDOW_BYTE_BUDGETS.transcripts,
    );
  });

  test("the host is detected from the page", () => {
    expect(detectLifecycleHost({} as Window)).toBe("browser");
    expect(
      detectLifecycleHost({ __orkestratorClientPlatform: "ipad-wkwebview" } as unknown as Window),
    ).toBe("ios");
    expect(
      detectLifecycleHost({
        orkestratorGateway: { enabled: true, desktop: true },
      } as unknown as Window),
    ).toBe("desktop");
  });

  test("every setting and budget is configurable per window", () => {
    const config = lifecycleConfigFor({
      host: "ios",
      suspendAfterMs: 42,
      byteBudgets: { images: 7 },
    });
    expect(config.suspendAfterMs).toBe(42);
    expect(config.byteBudgets.images).toBe(7);
    expect(config.byteBudgets.transcripts).toBe(
      HOST_LIFECYCLE_DEFAULTS.ios.byteBudgets.transcripts,
    );
    expect(() => lifecycleConfigFor({ host: "browser", memoryBudgetBytes: -1 })).toThrow(
      "non-negative",
    );

    const ios = new WindowScope({ lifecycle: { host: "ios" } });
    expect(ios.lifecycleConfig.host).toBe("ios");
    expect(ios.budgets.transcripts.totalBytes).toBe(
      HOST_LIFECYCLE_DEFAULTS.ios.byteBudgets.transcripts,
    );
    const explicit = new WindowScope({ lifecycle: { host: "ios" }, budgets: { transcripts: 5 } });
    expect(explicit.budgets.transcripts.totalBytes).toBe(5);
    ios.dispose();
    explicit.dispose();
  });
});

describe("done when", () => {
  test("six fake nodes cycle through switching with bounded memory", async () => {
    const TRANSCRIPTS = 24 * MIB;
    const BUDGET = 48 * MIB;
    const SCOPE = 12 * MIB;
    makeWindow({
      memoryBudgetBytes: BUDGET,
      scopeEstimateBytes: SCOPE,
      suspendedEstimateBytes: 4 * MIB,
      byteBudgets: { transcripts: TRANSCRIPTS },
    });
    const nodes = [1, 2, 3, 4, 5, 6].map(node);
    const managed = new Map<BackendId, ManagedScope>();
    const reopened = new Map<BackendId, number>();
    const dropped = new Map<BackendId, number>();

    /** What `InTreeWorkspace` does: a node with no scope is opened when shown. */
    const ensureOpen = (nodeId: BackendId): NodeScope => {
      const existing = windowScope.get(nodeId);
      if (existing && !existing.disposed) return existing;
      if (managed.has(nodeId)) reopened.set(nodeId, (reopened.get(nodeId) ?? 0) + 1);
      const { scope, managed: handle } = open(nodeId);
      managed.set(nodeId, handle);
      return scope;
    };

    let peakEstimate = 0;
    let peakTranscripts = 0;
    let peakWarm = 0;
    for (let round = 0; round < 6; round += 1) {
      for (const nodeId of nodes) {
        const scope = ensureOpen(nodeId);
        show(nodeId);
        expect(scope.tier.get()).toBe("live");
        // The shown environment's transcript: heavy data, per session.
        const granted = windowScope.budgets.transcripts.reserve(
          nodeId,
          `session-${round}`,
          6 * MIB,
          { onEvict: (entry) => dropped.set(entry.nodeId, (dropped.get(entry.nodeId) ?? 0) + 1) },
        );
        expect(granted.granted).toBe(true);
        await windowScope.lifecycle.checkPressure();
        await clock.advance(SUSPEND_MS / 3);

        const estimate = windowScope.lifecycle.estimateBytes();
        peakEstimate = Math.max(peakEstimate, estimate);
        peakTranscripts = Math.max(peakTranscripts, windowScope.budgets.transcripts.usedBytes);
        peakWarm = Math.max(
          peakWarm,
          nodes.filter((id) => ["warm", "live"].includes(windowScope.lifecycle.tierOf(id))).length,
        );
        // The shown node is never touched: live, with this round's transcript.
        expect(windowScope.lifecycle.tierOf(nodeId)).toBe("live");
        expect(windowScope.budgets.transcripts.has(nodeId, `session-${round}`)).toBe(true);
        expect(estimate).toBeLessThanOrEqual(BUDGET);
      }
    }

    expect(peakTranscripts).toBeLessThanOrEqual(TRANSCRIPTS);
    expect(peakEstimate).toBeLessThanOrEqual(BUDGET);
    // Memory stayed bounded by moving data and tiers, not by refusing nodes:
    // heavy data was dropped, scopes suspended, and some went to summary and
    // were reopened when shown again.
    expect([...dropped.values()].reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    expect(transitions.some((change) => change.to === "suspended")).toBe(true);
    expect([...reopened.values()].reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    // The budget, not a count, bounded the warm scopes (the command scope aside).
    expect(peakWarm).toBeLessThanOrEqual(Math.floor((BUDGET - SCOPE) / SCOPE));
  });
});
