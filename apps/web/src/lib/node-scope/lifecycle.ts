/**
 * The window's node-scope lifecycle (report §8.1, plan item 4002): which
 * tier each node scope is in, and the byte and memory budgets that move them.
 *
 * | Tier      | What exists                                  | Streams             |
 * |-----------|----------------------------------------------|---------------------|
 * | summary   | no scope (the sidebar's summaries only)      | none of its own     |
 * | warm      | the scope, light stores, warm services       | main stream         |
 * | live      | warm, and shown                              | + terminals, previews |
 * | suspended | the scope's light store data; services stopped | none; cursor kept |
 *
 * Transitions:
 *
 * - **Open** (`manage`): summary → warm, then live when it is the shown node.
 * - **Switch away**: live → warm. Its heavy data (transcript pages, artifact
 *   and image bytes) stays reserved in the window's byte budgets, least
 *   recently used first, and goes when a budget or the pressure path wants
 *   the room back: eviction is per entry (one environment's transcript), not
 *   per node.
 * - **Hidden past `suspendAfterMs`** (`NODE_SUSPEND_AFTER_MS`, per host):
 *   warm → suspended. Its services stop, its client closes its streams but
 *   keeps their cursors (`NodeClient.suspend`), and its reads are told the
 *   scope is hidden. Work on the node keeps running (invariant 2, §8.4).
 * - **Switch back** (or any resume): suspended → warm/live. The client
 *   reopens from its cursors, the services start again, and the scope
 *   resyncs: the change feed re-reads its manifest on attach and the reads
 *   reconcile as after a reconnect, so stores re-read authoritative snapshots
 *   instead of trusting the events they missed (invariants 3, 4, 7, 8).
 * - **Pressure** (`checkPressure`, a memory warning): one step at a time,
 *   (1) drop the heavy data of the least recently shown hidden scope that
 *   holds any, (2) suspend the least recently shown warm scope, (3) dispose
 *   the least recently shown suspended scope back to summary. The shown node
 *   is never touched. A scope is never disposed in the pass that suspended
 *   it, so its views have unmounted before its stores go.
 *
 * Only scopes handed to `manage` move: the command scope stays live for the
 * window's life (the window's own chrome reads it) and is never managed.
 * Nothing here runs (no timer, listener or subscription) while no scope is
 * managed, so a window with only its command node behaves as before.
 *
 * Effect: the timers are plain, injectable clock timers rather than an
 * Effect `Schedule` or fibers, because each is a single one-shot delay that a
 * switch re-arms and tests drive with a fake clock. Their cleanup is tied to
 * the Effect-backed lifetimes: each managed scope's entry is torn down by a
 * finalizer on its scope (`scope.onDispose`), and the window disposes the
 * lifecycle from its own lifetime.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import { createLogger } from "@orkestrator/protocol/logger";
import type { ReadableSignal, Unlisten } from "@orkestrator/protocol/node-client";
import type { ByteBudget, ByteBudgetEntry, WindowByteBudgets } from "./byte-budget";
import { pageHeapReader, type HeapReader, type LifecycleConfig } from "./lifecycle-config";
import type { NodeScope, NodeScopeTier } from "./node-scope";
import { createSignal, type WritableSignal } from "./signal";
import type { NodeSelection } from "./window-scope";

const log = createLogger("web.node-scope");

/** How soon a pressure pass that could not finish (a scope it just suspended) looks again. */
export const PRESSURE_RECHECK_MS = 1_000;

/** The window event the iOS app raises on `didReceiveMemoryWarning`. */
export const MEMORY_WARNING_EVENT = "orkestrator:memory-warning";

/** What one managed scope needs from its owner. */
export interface ManagedScopeHooks {
  /** Starts the scope's warm services and returns their stop. Runs on open and on every resume. */
  startServices(scope: NodeScope): () => void;
  /** The scope is not shown (or is suspended): its automatic reads pause. `false` resumes them. */
  setHidden?(scope: NodeScope, hidden: boolean): void;
  /** After a resume: re-read authoritative state, as after a reconnect. */
  resync?(scope: NodeScope): void;
  /**
   * Called before the scope's streams close (suspend), before its tier
   * changes. Whatever listens on the scope's client may move elsewhere first
   * (plan item 5001's `attentionHandoff`: attention moves to the command
   * node's relay); the client suspends once the returned promise settles,
   * unless the scope was resumed meanwhile.
   */
  handoff?(scope: NodeScope): Promise<void> | void;
  /**
   * Pressure moved the scope to summary. The default disposes it; an owner
   * that did not open the scope gives it back instead. Runs after the
   * lifecycle let go of it.
   */
  toSummary?(scope: NodeScope): void;
}

export interface ManagedScope {
  readonly scope: NodeScope;
  /**
   * Stops managing the scope without disposing it: its services stop and
   * its client resumes, as it was before `manage`. Idempotent.
   */
  release(): void;
}

export type TierChangeReason =
  | "open"
  | "shown"
  | "hidden"
  | "suspend-timer"
  | "document-hidden"
  | "pressure"
  | "memory-warning"
  | "resume"
  | "released";

export interface TierChange {
  readonly nodeId: BackendId;
  readonly scope: NodeScope;
  readonly from: NodeScopeTier;
  readonly to: NodeScopeTier;
  readonly reason: TierChangeReason;
}

export interface LifecycleClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The window's document visibility, as the lifecycle reads it. */
export interface LifecycleVisibility {
  isHidden(): boolean;
  subscribe(listener: () => void): Unlisten;
}

/** A source of memory warnings (the iOS app's WebView). */
export interface LifecycleMemoryWarnings {
  subscribe(listener: () => void): Unlisten;
}

export interface ScopeLifecycleDeps {
  readonly clock?: LifecycleClock;
  /** A renderer heap reading for the `measured` source; defaults to the page's. */
  readonly readHeap?: HeapReader;
  /** Defaults to `document`'s Page Visibility; `null` ignores visibility. */
  readonly visibility?: LifecycleVisibility | null;
  /** Defaults to `MEMORY_WARNING_EVENT` on `window`; `null` ignores warnings. */
  readonly memoryWarnings?: LifecycleMemoryWarnings | null;
}

/** What the lifecycle reads from its window (a `WindowScope`). */
export interface LifecycleWindow {
  readonly budgets: WindowByteBudgets;
  readonly selection: ReadableSignal<NodeSelection | null>;
  readonly nodeScopes: ReadableSignal<readonly NodeScope[]>;
  get(nodeId: BackendId): NodeScope | null;
}

export interface MemoryReading {
  readonly bytes: number;
  readonly source: "measured" | "estimate";
  readonly budgetBytes: number;
}

export interface PressureResult {
  readonly reading: MemoryReading;
  /** Steps taken, in order. */
  readonly steps: readonly PressureStep[];
}

export type PressureStep =
  | { readonly kind: "drop-heavy-data"; readonly nodeId: BackendId; readonly bytes: number }
  | { readonly kind: "suspend"; readonly nodeId: BackendId }
  | { readonly kind: "dispose"; readonly nodeId: BackendId };

interface Entry {
  readonly scope: NodeScope;
  readonly hooks: ManagedScopeHooks;
  tier: NodeScopeTier;
  lastShown: number | null;
  readonly openedAt: number;
  stopServices: (() => void) | null;
  suspendTimer: unknown;
  hiddenReported: boolean | null;
  /** The pressure pass that suspended it, so the same pass does not dispose it. */
  suspendedInPass: number | null;
  /** `client.suspend()` ran and no `resume()` since. */
  streamsClosed: boolean;
}

const BUDGET_KINDS = ["transcripts", "artifacts", "images"] as const;

export const realLifecycleClock: LifecycleClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

function documentVisibility(): LifecycleVisibility | null {
  if (typeof document === "undefined") return null;
  return {
    isHidden: () => document.visibilityState === "hidden",
    subscribe(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

function windowMemoryWarnings(): LifecycleMemoryWarnings | null {
  if (typeof window === "undefined") return null;
  return {
    subscribe(listener) {
      window.addEventListener(MEMORY_WARNING_EVENT, listener);
      return () => window.removeEventListener(MEMORY_WARNING_EVENT, listener);
    },
  };
}

/** The settings `configure` may change while the window runs (not the host or byte-budget totals). */
export type LifecycleRuntimeSettings = Partial<Omit<LifecycleConfig, "host" | "byteBudgets">>;

export class ScopeLifecycle {
  /** Every managed node's tier; a node that is not in it is `summary` (or the command node). */
  readonly tiers: ReadableSignal<ReadonlyMap<BackendId, NodeScopeTier>>;

  private settings: LifecycleConfig;
  private readonly window: LifecycleWindow;
  private readonly clock: LifecycleClock;
  private readonly readHeap: HeapReader;
  private readonly visibility: LifecycleVisibility | null;
  private readonly memoryWarnings: LifecycleMemoryWarnings | null;
  private readonly entries = new Map<NodeScope, Entry>();
  private readonly lastShownByNode = new Map<BackendId, number>();
  private readonly transitionListeners = new Set<(change: TierChange) => void>();
  private readonly tiersSignal: WritableSignal<ReadonlyMap<BackendId, NodeScopeTier>>;
  private shownNode: BackendId | null = null;
  private active: Unlisten[] = [];
  private pressureInterval: unknown = null;
  private recheckTimer: unknown = null;
  private pressureRunning: Promise<PressureResult> | null = null;
  /** A check was asked for while a pass ran: the pass reads again before it ends. */
  private pressureAgain = false;
  private pass = 0;
  private disposed = false;

  constructor(window: LifecycleWindow, config: LifecycleConfig, deps: ScopeLifecycleDeps = {}) {
    this.window = window;
    this.settings = config;
    this.clock = deps.clock ?? realLifecycleClock;
    this.readHeap = deps.readHeap ?? pageHeapReader();
    this.visibility = deps.visibility === undefined ? documentVisibility() : deps.visibility;
    this.memoryWarnings =
      deps.memoryWarnings === undefined ? windowMemoryWarnings() : deps.memoryWarnings;
    this.tiersSignal = createSignal<ReadonlyMap<BackendId, NodeScopeTier>>(new Map());
    this.tiers = this.tiersSignal;
  }

  /** The window's lifecycle settings (report §8.2's per-host defaults, with overrides). */
  get config(): LifecycleConfig {
    return this.settings;
  }

  /**
   * Changes settings while the window runs (a measured budget arriving, a
   * user setting). A new `suspendAfterMs` applies to timers armed from now
   * on; a new budget is checked at once.
   */
  configure(settings: LifecycleRuntimeSettings): void {
    this.settings = { ...this.settings, ...settings };
    if (this.entries.size > 0) void this.checkPressure();
  }

  /** The node the window shows (its selection's, else the command node's), while any scope is managed. */
  get shownNodeId(): BackendId | null {
    return this.shownNode;
  }

  /** How many scopes are managed. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * `nodeId`'s tier: a managed scope's own, `live` for any other open scope
   * (the command scope), `summary` for a node with no scope.
   */
  tierOf(nodeId: BackendId): NodeScopeTier {
    const scope = this.window.get(nodeId);
    if (!scope || scope.disposed) return "summary";
    return this.entries.get(scope)?.tier ?? scope.tier.get();
  }

  /** When `nodeId` was last the shown node (the clock's time), or `null` if never. */
  lastShown(nodeId: BackendId): number | null {
    const scope = this.window.get(nodeId);
    const entry = scope ? this.entries.get(scope) : undefined;
    return entry?.lastShown ?? this.lastShownByNode.get(nodeId) ?? null;
  }

  /** Every tier change of a managed scope, after it happened. */
  onTransition(listener: (change: TierChange) => void): Unlisten {
    this.transitionListeners.add(listener);
    return () => {
      this.transitionListeners.delete(listener);
    };
  }

  /**
   * A scope was opened into the lifecycle (summary → warm), before its warm
   * services start: the hook point for snapshot-first hydration (plan item
   * 4003), which paints from a stored snapshot before the first
   * authoritative read lands.
   */
  onScopeOpen(listener: (scope: NodeScope) => void): Unlisten {
    return this.onTransition((change) => {
      if (change.from === "summary") listener(change.scope);
    });
  }

  /**
   * Takes `scope` into the lifecycle: summary → warm (→ live when shown). Its
   * warm services start now. Managing a managed scope again returns the
   * existing handle.
   */
  manage(scope: NodeScope, hooks: ManagedScopeHooks): ManagedScope {
    if (this.disposed) throw new Error("This window's node-scope lifecycle is disposed.");
    if (scope.disposed) throw new Error(`The scope for ${scope.nodeId} is disposed.`);
    const existing = this.entries.get(scope);
    if (existing) return this.handleFor(existing);
    const entry: Entry = {
      scope,
      hooks,
      tier: "summary",
      lastShown: this.lastShownByNode.get(scope.nodeId) ?? null,
      openedAt: this.clock.now(),
      stopServices: null,
      suspendTimer: null,
      hiddenReported: null,
      suspendedInPass: null,
      streamsClosed: false,
    };
    this.entries.set(scope, entry);
    // The scope's own lifetime (Effect-backed) ends the entry: a scope
    // disposed elsewhere stops its timer and leaves the lifecycle.
    scope.onDispose("node-lifecycle", () => this.forget(entry, "released"));
    if (this.entries.size === 1) this.activate();
    this.move(entry, "warm", "open");
    entry.stopServices = hooks.startServices(scope);
    this.applyShown();
    if (entry.tier !== "live") this.hide(entry);
    void this.checkPressure();
    return this.handleFor(entry);
  }

  /**
   * Resumes a suspended scope now (something needs it while it is hidden):
   * suspended → warm, with a resync. Does nothing for any other tier.
   */
  resume(nodeId: BackendId): void {
    const entry = this.entryOf(nodeId);
    if (!entry || entry.tier !== "suspended") return;
    const shown = entry.scope.nodeId === this.shownNode;
    this.wake(entry, shown ? "live" : "warm");
    if (!shown) this.armSuspendTimer(entry);
  }

  /**
   * A memory reading for the configured source: the renderer heap where it
   * can be measured, else the estimate (byte-budget reservations plus a fixed
   * cost per open scope by tier).
   */
  async readMemory(): Promise<MemoryReading> {
    const budgetBytes = this.settings.memoryBudgetBytes;
    if (this.settings.memorySource === "measured") {
      const bytes = await this.readHeap().catch(() => null);
      if (bytes !== null) return { bytes, source: "measured", budgetBytes };
    }
    return { bytes: this.estimateBytes(), source: "estimate", budgetBytes };
  }

  /** The estimate `readMemory` falls back to. */
  estimateBytes(): number {
    let bytes = 0;
    for (const kind of BUDGET_KINDS) bytes += this.window.budgets[kind].usedBytes;
    for (const scope of this.window.nodeScopes.get()) {
      if (scope.disposed) continue;
      const tier = this.entries.get(scope)?.tier ?? scope.tier.get();
      bytes +=
        tier === "suspended"
          ? this.settings.suspendedEstimateBytes
          : this.settings.scopeEstimateBytes;
    }
    return bytes;
  }

  /**
   * Reads memory and, while it is over budget, takes one pressure step at a
   * time (reading again after each) until it fits or nothing is left to
   * relieve. One pass runs at a time; a call during a pass joins it, and
   * the pass then reads once more before it ends, so the caller's view of
   * memory is the one that counts.
   */
  checkPressure(): Promise<PressureResult> {
    if (this.pressureRunning) {
      this.pressureAgain = true;
      return this.pressureRunning;
    }
    const running = this.runPressure().finally(() => {
      if (this.pressureRunning === running) this.pressureRunning = null;
    });
    this.pressureRunning = running;
    return running;
  }

  /**
   * The OS warned of memory pressure (the iOS app's `didReceiveMemoryWarning`):
   * every hidden scope drops its heavy data and suspends at once, every scope
   * suspended before this warning goes back to summary, and the budget is
   * read again shortly after. The shown node is never touched.
   */
  relieveMemoryWarning(): readonly PressureStep[] {
    if (this.disposed) return [];
    const pass = ++this.pass;
    const steps: PressureStep[] = [];
    const hidden = this.hiddenByRecency();
    for (const entry of hidden) {
      if (entry.tier === "suspended" && entry.suspendedInPass !== pass) {
        steps.push(this.toSummary(entry, "memory-warning"));
        continue;
      }
      const bytes = this.dropHeavyData(entry);
      if (bytes > 0) steps.push({ kind: "drop-heavy-data", nodeId: entry.scope.nodeId, bytes });
      if (entry.tier === "warm") {
        this.suspend(entry, "memory-warning", pass);
        steps.push({ kind: "suspend", nodeId: entry.scope.nodeId });
      }
    }
    this.logPressure("memory-warning", null, steps);
    this.scheduleRecheck();
    return steps;
  }

  /** Stops every timer and listener and lets go of every scope without disposing it. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    for (const entry of Array.from(this.entries.values())) this.forget(entry, "released");
    this.deactivate();
    this.transitionListeners.clear();
    this.disposed = true;
  }

  // ---------------------------------------------------------------------

  private handleFor(entry: Entry): ManagedScope {
    return {
      scope: entry.scope,
      release: () => {
        if (this.entries.get(entry.scope) !== entry) return;
        this.forget(entry, "released");
        if (!entry.scope.disposed) {
          if (entry.streamsClosed) entry.scope.client.resume();
          entry.streamsClosed = false;
          entry.hooks.setHidden?.(entry.scope, false);
        }
      },
    };
  }

  private entryOf(nodeId: BackendId): Entry | undefined {
    const scope = this.window.get(nodeId);
    return scope ? this.entries.get(scope) : undefined;
  }

  /** Subscriptions and the pressure interval, from the first managed scope on. */
  private activate(): void {
    this.active.push(this.window.selection.subscribe(() => this.applyShown()));
    this.active.push(this.window.nodeScopes.subscribe(() => this.applyShown()));
    if (this.visibility) {
      const visibility = this.visibility;
      this.active.push(visibility.subscribe(() => this.onVisibility(visibility.isHidden())));
    }
    if (this.memoryWarnings) {
      this.active.push(this.memoryWarnings.subscribe(() => this.relieveMemoryWarning()));
    }
    if (this.settings.pressureCheckMs !== null) {
      this.pressureInterval = this.clock.setInterval(() => {
        void this.checkPressure();
      }, this.settings.pressureCheckMs);
    }
  }

  /** The last managed scope went: nothing of the lifecycle keeps running. */
  private deactivate(): void {
    for (const stop of this.active.splice(0)) stop();
    if (this.pressureInterval !== null) this.clock.clearInterval(this.pressureInterval);
    this.pressureInterval = null;
    if (this.recheckTimer !== null) this.clock.clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
    if (this.shownNode !== null) {
      // Budgets go back to protecting no node, as before any scope was managed.
      for (const kind of BUDGET_KINDS) this.window.budgets[kind].setShownNode(null);
    }
    this.shownNode = null;
  }

  /** The shown node: the selection's node when the window has a scope for it, else the command node's. */
  private currentShownNode(): BackendId | null {
    const selection = this.window.selection.get();
    if (selection) return this.window.get(selection.nodeId)?.nodeId ?? selection.nodeId;
    for (const scope of this.window.nodeScopes.get()) {
      if (scope.role === "command" && !scope.disposed) return scope.nodeId;
    }
    return null;
  }

  private applyShown(): void {
    if (this.disposed || this.entries.size === 0) return;
    const shown = this.currentShownNode();
    const changed = shown !== this.shownNode;
    const previous = this.shownNode;
    this.shownNode = shown;
    if (changed) {
      for (const kind of BUDGET_KINDS) this.window.budgets[kind].setShownNode(shown);
      const now = this.clock.now();
      if (previous) this.lastShownByNode.set(previous, now);
      if (shown) this.lastShownByNode.set(shown, now);
    }
    for (const entry of this.entries.values()) {
      const isShown = entry.scope.nodeId === shown;
      if (isShown) {
        entry.lastShown = this.clock.now();
        this.show(entry);
      } else if (entry.tier === "live") {
        entry.lastShown = this.lastShownByNode.get(entry.scope.nodeId) ?? entry.lastShown;
        this.move(entry, "warm", "hidden");
        this.hide(entry);
      }
    }
    if (changed) void this.checkPressure();
  }

  private show(entry: Entry): void {
    this.clearSuspendTimer(entry);
    if (entry.tier === "suspended") {
      // On iOS a hidden document keeps even the shown node suspended until it is visible.
      if (this.settings.suspendWhenDocumentHidden && this.visibility?.isHidden()) return;
      this.wake(entry, "live");
      return;
    }
    this.reportHidden(entry, false);
    if (entry.tier !== "live") this.move(entry, "live", "shown");
  }

  /** A warm scope that is not shown: reads pause and the suspend timer runs. */
  private hide(entry: Entry): void {
    this.reportHidden(entry, true);
    if (this.settings.suspendWhenDocumentHidden && this.visibility?.isHidden()) {
      this.suspend(entry, "document-hidden", null);
      return;
    }
    this.armSuspendTimer(entry);
  }

  private armSuspendTimer(entry: Entry): void {
    this.clearSuspendTimer(entry);
    entry.suspendTimer = this.clock.setTimeout(() => {
      entry.suspendTimer = null;
      if (this.entries.get(entry.scope) !== entry) return;
      if (entry.tier === "warm" && entry.scope.nodeId !== this.shownNode) {
        this.suspend(entry, "suspend-timer", null);
      }
    }, this.settings.suspendAfterMs);
  }

  private clearSuspendTimer(entry: Entry): void {
    if (entry.suspendTimer === null) return;
    this.clock.clearTimeout(entry.suspendTimer);
    entry.suspendTimer = null;
  }

  private reportHidden(entry: Entry, hidden: boolean): void {
    if (entry.hiddenReported === hidden || entry.scope.disposed) return;
    entry.hiddenReported = hidden;
    entry.hooks.setHidden?.(entry.scope, hidden);
  }

  /**
   * warm/live → suspended: services stop, streams close with their cursors
   * kept. Listeners on the scope's client are handed off first (`handoff`,
   * before the tier changes, so attention subscribes its next source while
   * this one still delivers), and the client suspends only once that settled.
   */
  private suspend(entry: Entry, reason: TierChangeReason, pass: number | null): void {
    if (entry.tier === "suspended" || entry.scope.disposed) return;
    this.clearSuspendTimer(entry);
    const handoff = entry.hooks.handoff?.(entry.scope);
    entry.suspendedInPass = pass;
    this.move(entry, "suspended", reason);
    const stop = entry.stopServices;
    entry.stopServices = null;
    stop?.();
    this.reportHidden(entry, true);
    const closeStreams = () => {
      if (this.entries.get(entry.scope) !== entry || entry.tier !== "suspended") return;
      if (entry.scope.disposed || entry.streamsClosed) return;
      entry.streamsClosed = true;
      entry.scope.client.suspend();
    };
    if (handoff && typeof handoff.then === "function") handoff.then(closeStreams, closeStreams);
    else closeStreams();
  }

  /** suspended → warm/live: streams reopen from their cursors, services start, the scope resyncs. */
  private wake(entry: Entry, tier: "warm" | "live"): void {
    if (entry.scope.disposed) return;
    if (entry.streamsClosed) entry.scope.client.resume();
    entry.streamsClosed = false;
    this.reportHidden(entry, tier !== "live");
    entry.suspendedInPass = null;
    this.move(entry, tier, "resume");
    entry.stopServices ??= entry.hooks.startServices(entry.scope);
    entry.hooks.resync?.(entry.scope);
  }

  private onVisibility(hidden: boolean): void {
    if (!this.settings.suspendWhenDocumentHidden) return;
    for (const entry of Array.from(this.entries.values())) {
      if (hidden) this.suspend(entry, "document-hidden", null);
      else if (entry.scope.nodeId === this.shownNode) this.show(entry);
    }
  }

  /** Hidden managed scopes, least recently shown first (never shown counts as oldest, by opening). */
  private hiddenByRecency(): Entry[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.scope.nodeId !== this.shownNode && !entry.scope.disposed)
      .sort(
        (a, b) =>
          (a.lastShown ?? Number.NEGATIVE_INFINITY) - (b.lastShown ?? Number.NEGATIVE_INFINITY) ||
          a.openedAt - b.openedAt,
      );
  }

  private heavyBytes(entry: Entry): number {
    let bytes = 0;
    for (const kind of BUDGET_KINDS) {
      bytes += this.window.budgets[kind].usedBytesFor(entry.scope.nodeId);
    }
    return bytes;
  }

  /** Evicts every byte-budget entry of the scope's node; owners hear through `onEvict`. */
  private dropHeavyData(entry: Entry): number {
    if (entry.scope.nodeId === this.shownNode) return 0;
    let bytes = 0;
    for (const kind of BUDGET_KINDS) {
      const budget: ByteBudget = this.window.budgets[kind];
      const evicted: readonly ByteBudgetEntry[] = budget.evictNode(entry.scope.nodeId);
      for (const item of evicted) bytes += item.bytes;
    }
    return bytes;
  }

  private toSummary(entry: Entry, reason: TierChangeReason): PressureStep {
    const scope = entry.scope;
    this.move(entry, "summary", reason);
    this.forget(entry, reason);
    if (!scope.disposed) {
      if (entry.hooks.toSummary) entry.hooks.toSummary(scope);
      else scope.dispose();
    }
    // Handed back open: outside the lifecycle a scope reads `live`, as the command scope does.
    if (!scope.disposed) scope.setTier("live");
    return { kind: "dispose", nodeId: scope.nodeId };
  }

  /** One step of the pressure order, or `null` when nothing (more) may be relieved now. */
  private pressureStep(pass: number): PressureStep | null {
    const hidden = this.hiddenByRecency();
    for (const entry of hidden) {
      const bytes = this.heavyBytes(entry);
      if (bytes > 0) {
        const dropped = this.dropHeavyData(entry);
        if (dropped > 0) return { kind: "drop-heavy-data", nodeId: entry.scope.nodeId, bytes };
      }
    }
    for (const entry of hidden) {
      if (entry.tier === "warm") {
        this.suspend(entry, "pressure", pass);
        return { kind: "suspend", nodeId: entry.scope.nodeId };
      }
    }
    for (const entry of hidden) {
      if (entry.tier === "suspended" && entry.suspendedInPass !== pass) {
        return this.toSummary(entry, "pressure");
      }
    }
    return null;
  }

  private async runPressure(): Promise<PressureResult> {
    const pass = ++this.pass;
    const steps: PressureStep[] = [];
    let reading: MemoryReading;
    do {
      this.pressureAgain = false;
      reading = await this.readMemory();
      // Bounded: each step lowers some scope's tier or empties its budgets.
      const limit = steps.length + this.entries.size * 3 + 1;
      while (!this.disposed && reading.bytes > reading.budgetBytes && steps.length < limit) {
        const step = this.pressureStep(pass);
        if (!step) {
          // Scopes suspended in this pass may go to summary on the next one.
          if (this.hiddenByRecency().some((entry) => entry.tier === "suspended")) {
            this.scheduleRecheck();
          }
          break;
        }
        steps.push(step);
        reading = await this.readMemory();
      }
    } while (this.pressureAgain && !this.disposed);
    if (steps.length > 0) this.logPressure("budget", reading, steps);
    return { reading, steps };
  }

  private scheduleRecheck(): void {
    if (this.disposed || this.entries.size === 0 || this.recheckTimer !== null) return;
    this.recheckTimer = this.clock.setTimeout(() => {
      this.recheckTimer = null;
      void this.checkPressure();
    }, PRESSURE_RECHECK_MS);
  }

  private logPressure(
    reason: "budget" | "memory-warning",
    reading: MemoryReading | null,
    steps: readonly PressureStep[],
  ): void {
    if (steps.length === 0) return;
    log.info("lifecycle.pressure", {
      reason,
      source: reading?.source ?? "warning",
      bytes: reading?.bytes ?? null,
      budgetBytes: this.settings.memoryBudgetBytes,
      dropped: steps.filter((step) => step.kind === "drop-heavy-data").length,
      suspended: steps.filter((step) => step.kind === "suspend").length,
      disposed: steps.filter((step) => step.kind === "dispose").length,
    });
  }

  private move(entry: Entry, to: NodeScopeTier, reason: TierChangeReason): void {
    const from = entry.tier;
    if (from === to) return;
    entry.tier = to;
    if (!entry.scope.disposed) entry.scope.setTier(to);
    this.publishTiers();
    const change: TierChange = { nodeId: entry.scope.nodeId, scope: entry.scope, from, to, reason };
    for (const listener of Array.from(this.transitionListeners)) {
      try {
        listener(change);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  /** Drops the entry: its timer and services stop. Does not dispose the scope. */
  private forget(entry: Entry, reason: TierChangeReason): void {
    if (this.entries.get(entry.scope) !== entry) return;
    this.clearSuspendTimer(entry);
    const stop = entry.stopServices;
    entry.stopServices = null;
    stop?.();
    if (entry.lastShown !== null) this.lastShownByNode.set(entry.scope.nodeId, entry.lastShown);
    this.entries.delete(entry.scope);
    // A scope disposed elsewhere (its node removed, the window closing) is
    // back to summary; listeners hear it like any other change.
    if (entry.scope.disposed && entry.tier !== "summary") this.move(entry, "summary", reason);
    else this.publishTiers();
    if (this.entries.size === 0) this.deactivate();
  }

  private publishTiers(): void {
    const tiers = new Map<BackendId, NodeScopeTier>();
    for (const entry of this.entries.values()) tiers.set(entry.scope.nodeId, entry.tier);
    this.tiersSignal.set(tiers);
  }
}
