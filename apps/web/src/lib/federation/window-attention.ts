/**
 * The window's one attention service (plan item 5001, report §9): every other
 * node's `environment-attention`, from whichever source this window has for
 * that node, each `(nodeId, attentionId)` handed on once.
 *
 * - **Scope.** A leaf this window holds in its own tree (`InTreeWorkspace`,
 *   plan item 4001) whose scope is `warm` or `live` is heard on the scope's
 *   own client: its stream is already open, so the node costs no relay lease.
 * - **Relay.** Every other node in the command node's summaries (the summary
 *   tier, a `suspended` scope, a scope the region no longer holds) is heard
 *   through the command node's relay, `subscribeNodeEvents`.
 * - **Skipped.** The window's own node: the sound service hears it on the
 *   command scope's client (`@/lib/native/events` `listen`), together with its
 *   fallback for backends that predate the event. A node shown by a realm
 *   renderer: that realm alerts for its own node until realms are deleted
 *   (plan item 6002), as plan item 0002 decided.
 *
 * **Moving between sources.** When a node's source changes (a tier change, the
 * region taking or releasing it), the new source is subscribed first and the
 * old one is kept until the new one says it is live (the scope client's
 * `eventStreamReady`, the relay's first `onResync`), or for at most
 * {@link ATTENTION_HANDOVER_TIMEOUT_MS}. Both may deliver the same event in that
 * overlap; the shared `(nodeId, attentionId)` set hands it on once. So there is
 * neither a gap nor a duplicate, provided the old source is still open while
 * the new one starts. That is why a scope the region released (the in-tree
 * grace period, while it is still open) already moves to the relay, and why a
 * lifecycle manager that closes a scope's streams (plan item 4002) should set
 * the tier first and may await {@link attentionHandoff}.
 *
 * Missed attention is never replayed: a resync reads nothing, because a late
 * sound is not state. The dedupe set lives as long as the service, so a node
 * that comes back to a source does not alert again for what it already did.
 *
 * Effect is not used: this is a reconcile loop over existing signals and two
 * subscription primitives, with one timer per handover, all stopped by
 * `stop()` (invariant 15).
 */

import { environmentAttentionEvent } from "@orkestrator/protocol/contract/domains/events";
import {
  ENVIRONMENT_ATTENTION_EVENT,
  isEnvironmentAttentionEvent,
  type EnvironmentAttentionEvent,
} from "@orkestrator/protocol/environment-attention";
import type { BackendId } from "@orkestrator/protocol/federation";

import { BoundedKeySet } from "@/lib/bounded-hydration";
import { subscribeNodeEvents } from "@/lib/federation/node-events";
import type { NodeScope, NodeScopeTier } from "@/lib/node-scope/node-scope";
import type { WindowScope } from "@/lib/node-scope/window-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { environmentStore } from "@/stores/environmentStore";
import { nodesInTree, useInTreeNodesStore } from "@/stores/inTreeNodesStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { uiStore } from "@/stores/uiStore";

/** `(nodeId, attentionId)` pairs remembered so a re-delivered event never alerts twice. */
export const WINDOW_ATTENTION_DEDUPE_LIMIT = 512;
/** How long a node's old source is kept while its new one becomes live. */
export const ATTENTION_HANDOVER_TIMEOUT_MS = 10_000;

/** Where the window hears one node's attention. */
export type AttentionSource = "scope" | "relay";

/** Tiers whose scope has its own open stream (report §8.1). */
const STREAMING_TIERS: ReadonlySet<NodeScopeTier> = new Set(["warm", "live"]);

export interface WindowAttentionOptions {
  readonly windowScope: WindowScope;
  /** Each `(nodeId, attentionId)` once, with the source that delivered it first. */
  readonly onAttention: (
    nodeId: BackendId,
    event: EnvironmentAttentionEvent,
    source: AttentionSource,
  ) => void;
  readonly handoverTimeoutMs?: number;
  /** Arms the bounded handover wait; returns its cancel. Defaults to `setTimeout`. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
}

function scheduleWithTimeout(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

export interface WindowAttention {
  /** The source a node is heard on now (the one it is moving to, during a handover). */
  sourceOf(nodeId: string): AttentionSource | null;
  /** Every source subscribed for a node right now: two during a handover. */
  feedsOf(nodeId: string): readonly AttentionSource[];
  /** Ends every subscription and timer. Idempotent. */
  stop(): void;
}

interface Feed {
  readonly source: AttentionSource;
  ready: boolean;
  stop(): void;
  /** The scope a scope feed listens on; a feed on a disposed scope is replaced. */
  readonly scope?: NodeScope;
}

interface NodeFeeds {
  want: AttentionSource;
  readonly feeds: Map<AttentionSource, Feed>;
  /** Cancels the armed handover wait. */
  timer: (() => void) | null;
  /** Resolved when `want`'s feed is live and the others are gone. */
  settled: Array<() => void>;
}

/** The running service of each window, for {@link attentionHandoff}. */
const running = new WeakMap<WindowScope, WindowAttentionImpl>();

function commandNodeIdOf(windowScope: WindowScope): string | null {
  try {
    return windowScope.commandScope().nodeId;
  } catch {
    return null;
  }
}

/** Nodes a realm renderer shows (not in-tree): their realm alerts for them. */
function realmNodes(): ReadonlySet<string> {
  return new Set(nodesInTree() ? [] : useRemoteWorkspaceStore.getState().realms);
}

class WindowAttentionImpl implements WindowAttention {
  private readonly nodes = new Map<string, NodeFeeds>();
  private readonly seen = new BoundedKeySet(WINDOW_ATTENTION_DEDUPE_LIMIT);
  private readonly stops: Array<() => void> = [];
  private readonly tierStops = new Map<NodeScope, () => void>();
  /** Nodes a caller asked to move to the relay ahead of their scope closing. */
  private readonly handingOff = new Set<string>();
  private readonly handoverMs: number;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  private stopped = false;

  constructor(private readonly options: WindowAttentionOptions) {
    this.handoverMs = options.handoverTimeoutMs ?? ATTENTION_HANDOVER_TIMEOUT_MS;
    this.schedule = options.schedule ?? scheduleWithTimeout;
    const reconcile = () => this.reconcile();
    this.stops.push(
      portalStore.store.subscribe(reconcile),
      useRemoteWorkspaceStore.subscribe(reconcile),
      useInTreeNodesStore.subscribe(reconcile),
      options.windowScope.nodeScopes.subscribe(reconcile),
    );
    this.reconcile();
  }

  sourceOf(nodeId: string): AttentionSource | null {
    return this.nodes.get(nodeId)?.want ?? null;
  }

  feedsOf(nodeId: string): readonly AttentionSource[] {
    return Array.from(this.nodes.get(nodeId)?.feeds.keys() ?? []).sort();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (running.get(this.options.windowScope) === this) running.delete(this.options.windowScope);
    for (const stop of this.stops.splice(0)) stop();
    for (const stop of this.tierStops.values()) stop();
    this.tierStops.clear();
    for (const nodeId of Array.from(this.nodes.keys())) this.drop(nodeId);
    this.handingOff.clear();
  }

  /** Moves `nodeId` to the relay now, resolving once the relay is live (bounded). */
  handoff(nodeId: string): Promise<void> {
    if (this.stopped || this.nodes.get(nodeId)?.want !== "scope") return Promise.resolve();
    this.handingOff.add(nodeId);
    this.reconcile();
    const entry = this.nodes.get(nodeId);
    if (!entry || entry.feeds.size <= 1) return Promise.resolve();
    return new Promise((resolve) => entry.settled.push(resolve));
  }

  private desired(): Map<string, AttentionSource> {
    const { windowScope } = this.options;
    const portal = portalStore.store.getState();
    const own = new Set<string>(
      [portal.selfId, commandNodeIdOf(windowScope)].filter((id): id is BackendId => !!id),
    );
    const realms = realmNodes();
    const held = new Set(useRemoteWorkspaceStore.getState().realms);
    const candidates = new Set<string>(portal.nodes.map((node) => node.nodeId as string));
    const leafScopes = new Map<string, NodeScope>();
    for (const scope of windowScope.nodeScopes.get()) {
      if (scope.role !== "leaf" || scope.disposed) continue;
      leafScopes.set(scope.nodeId, scope);
      candidates.add(scope.nodeId);
    }
    this.watchTiers(leafScopes);
    for (const nodeId of Array.from(this.handingOff)) {
      if (!leafScopes.has(nodeId)) this.handingOff.delete(nodeId);
    }
    const wanted = new Map<string, AttentionSource>();
    for (const nodeId of candidates) {
      if (own.has(nodeId) || realms.has(nodeId)) continue;
      const scope = leafScopes.get(nodeId);
      const onScope =
        scope !== undefined &&
        STREAMING_TIERS.has(scope.tier.get()) &&
        held.has(nodeId) &&
        !this.handingOff.has(nodeId);
      wanted.set(nodeId, onScope ? "scope" : "relay");
    }
    return wanted;
  }

  /** One tier subscription per open leaf scope. */
  private watchTiers(leafScopes: ReadonlyMap<string, NodeScope>): void {
    const open = new Set(leafScopes.values());
    for (const [scope, stop] of Array.from(this.tierStops)) {
      if (open.has(scope)) continue;
      stop();
      this.tierStops.delete(scope);
    }
    for (const scope of open) {
      if (this.tierStops.has(scope)) continue;
      this.tierStops.set(
        scope,
        scope.tier.subscribe(() => {
          // A tier change supersedes an earlier handoff: a resumed scope is heard on itself again.
          this.handingOff.delete(scope.nodeId);
          this.reconcile();
        }),
      );
    }
  }

  private reconcile(): void {
    if (this.stopped) return;
    const wanted = this.desired();
    for (const nodeId of Array.from(this.nodes.keys())) {
      if (!wanted.has(nodeId)) this.drop(nodeId);
    }
    for (const [nodeId, source] of wanted) this.want(nodeId, source);
  }

  private want(nodeId: string, source: AttentionSource): void {
    let entry = this.nodes.get(nodeId);
    if (!entry) {
      entry = { want: source, feeds: new Map(), timer: null, settled: [] };
      this.nodes.set(nodeId, entry);
    }
    entry.want = source;
    const current = entry.feeds.get(source);
    // A scope feed on a scope that was disposed and reopened listens on nothing.
    if (current?.scope && current.scope !== this.options.windowScope.get(nodeId as BackendId)) {
      entry.feeds.delete(source);
      current.stop();
    }
    if (!entry.feeds.has(source)) {
      const feed = this.start(nodeId, source);
      if (!feed) {
        // No scope to listen on after all: the relay hears it.
        if (source === "scope") this.want(nodeId, "relay");
        return;
      }
      entry.feeds.set(source, feed);
    }
    this.settle(nodeId);
  }

  /** Drops every feed but the wanted one once it is live, or arms the bounded wait. */
  private settle(nodeId: string): void {
    const entry = this.nodes.get(nodeId);
    if (!entry) return;
    const feed = entry.feeds.get(entry.want);
    const others = Array.from(entry.feeds.values()).filter((other) => other !== feed);
    if (others.length === 0 || feed?.ready) {
      this.retireOthers(entry);
      return;
    }
    entry.timer ??= this.schedule(() => {
      entry.timer = null;
      if (this.nodes.get(nodeId) === entry) this.retireOthers(entry);
    }, this.handoverMs);
  }

  private retireOthers(entry: NodeFeeds): void {
    entry.timer?.();
    entry.timer = null;
    for (const [source, feed] of Array.from(entry.feeds)) {
      if (source === entry.want) continue;
      entry.feeds.delete(source);
      feed.stop();
    }
    for (const resolve of entry.settled.splice(0)) resolve();
  }

  private drop(nodeId: string): void {
    const entry = this.nodes.get(nodeId);
    if (!entry) return;
    this.nodes.delete(nodeId);
    entry.timer?.();
    entry.timer = null;
    for (const feed of entry.feeds.values()) feed.stop();
    entry.feeds.clear();
    for (const resolve of entry.settled.splice(0)) resolve();
  }

  private deliver(nodeId: string, payload: unknown, source: AttentionSource): void {
    // The payload crosses process boundaries; validate rather than trust.
    if (this.stopped || !isEnvironmentAttentionEvent(payload)) return;
    if (!this.seen.add(`${nodeId}\u0000${payload.attentionId}`)) return;
    this.options.onAttention(nodeId as BackendId, payload, source);
  }

  private ready(nodeId: string, feed: Feed): void {
    if (feed.ready) return;
    feed.ready = true;
    const entry = this.nodes.get(nodeId);
    if (entry?.feeds.get(feed.source) === feed) this.settle(nodeId);
  }

  private start(nodeId: string, source: AttentionSource): Feed | null {
    if (source === "relay") {
      let stopped = false;
      const feed: Feed = {
        source,
        ready: false,
        stop: () => {
          stopped = true;
          release();
        },
      };
      const release = subscribeNodeEvents(nodeId as BackendId, {
        events: [ENVIRONMENT_ATTENTION_EVENT],
        // The first one says the lease is in place; later ones read nothing,
        // because missed attention stays missed.
        onResync: () => {
          if (!stopped) this.ready(nodeId, feed);
        },
        onEvent: (event, payload) => {
          if (!stopped && event === ENVIRONMENT_ATTENTION_EVENT)
            this.deliver(nodeId, payload, "relay");
        },
      });
      return feed;
    }
    const scope = this.options.windowScope.get(nodeId as BackendId);
    if (!scope || scope.disposed) return null;
    let stopped = false;
    const unlisten = scope.client.listen(environmentAttentionEvent, (payload) => {
      if (!stopped) this.deliver(nodeId, payload, "scope");
    });
    const feed: Feed = {
      source,
      ready: false,
      scope,
      stop: () => {
        stopped = true;
        unlisten();
      },
    };
    void scope.client
      .eventStreamReady(ENVIRONMENT_ATTENTION_EVENT)
      .then(() => {
        if (!stopped) this.ready(nodeId, feed);
      })
      // Not live: the bounded handover wait still retires the old source.
      .catch(() => undefined);
    return feed;
  }
}

/**
 * Starts the window's attention service. One per window: starting another for
 * the same window scope stops the first. The caller owns the returned `stop`.
 */
export function startWindowAttention(options: WindowAttentionOptions): WindowAttention {
  running.get(options.windowScope)?.stop();
  const service = new WindowAttentionImpl(options);
  running.set(options.windowScope, service);
  return service;
}

/**
 * For a lifecycle manager about to close a leaf scope's streams (suspend or
 * dispose, plan item 4002): moves the node's attention to the relay while the
 * scope's stream is still open, and resolves once the relay is live (at most
 * {@link ATTENTION_HANDOVER_TIMEOUT_MS}). Resolves at once when the window runs
 * no attention service or does not hear that node on its scope.
 */
export function attentionHandoff(windowScope: WindowScope, nodeId: string): Promise<void> {
  return running.get(windowScope)?.handoff(nodeId) ?? Promise.resolve();
}

/**
 * The environment of `nodeId` on screen in this window's own tree, or `null`
 * when the node is not the one shown. Mirrors `useVisibleEnvironmentId`: a
 * project home counts only on its Home tab.
 */
export function shownEnvironmentOn(windowScope: WindowScope, nodeId: string): string | null {
  if (useRemoteWorkspaceStore.getState().active?.nodeId !== nodeId) return null;
  const selection = windowScope.selection.get();
  if (selection?.nodeId !== nodeId || !selection.environmentId) return null;
  const scope = windowScope.get(nodeId as BackendId);
  if (!scope || scope.disposed) return null;
  const environmentId = selection.environmentId;
  const home =
    selection.projectHome === true ||
    scope
      .store(environmentStore)
      .getState()
      .environments.some(
        (environment) => environment.id === environmentId && environment.projectHome,
      );
  if (home && scope.store(uiStore).getState().projectBoardTab !== "home") return null;
  return environmentId;
}
