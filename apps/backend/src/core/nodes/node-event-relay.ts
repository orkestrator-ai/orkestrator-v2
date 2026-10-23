import { randomUUID } from "node:crypto";

import { isBackendId, type BackendId } from "@orkestrator/protocol/federation";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import {
  isNodeEventWatchId,
  isRelayableEvent,
  MAX_NODE_EVENT_WATCHES,
  NODE_EVENT_WATCH_TTL_MS,
  parseNodeEventPrefixes,
  RELAYED_NODE_EVENT,
  type NodeEventWatchResult,
  type RelayedNodeEvent,
} from "@orkestrator/protocol/node-events";

import { NodeEventStream } from "./node-event-stream.js";
import type { ReadModelLink } from "./node-read-model.js";

/**
 * The command node's relay of other nodes' events to its own clients.
 *
 * Clients lease watches (`watch_node_events`) naming a node and event
 * prefixes. For each node with at least one live watch the relay keeps one
 * subscription to that node's event stream, for the union of the watched
 * prefixes, and re-emits every matching event as `relayed-node-event`.
 * Nothing is subscribed for a node nobody watches, and a lease that is not
 * renewed expires, so a client that went away costs nothing for long.
 *
 * Every stream open and every gap the node could not replay is relayed as a
 * `resync` frame: the client re-reads what it shows from that node. Changing
 * the watched prefixes replaces the stream, which opens with a resync too.
 */

export interface RelayNodes {
  link(nodeId: BackendId): ReadModelLink | null;
  subscribe(listener: () => void): () => void;
  isLeaf(): boolean;
}

interface Watch {
  watchId: string;
  nodeId: BackendId;
  prefixes: string[];
  expiresAt: number;
}

interface Relay {
  stream: NodeEventStream;
  prefixes: string[];
  key: string;
  epoch: number;
}

const SWEEP_INTERVAL_MS = 15_000;

export class NodeEventRelay {
  private readonly watches = new Map<string, Watch>();
  private readonly relays = new Map<BackendId, Relay>();
  private unsubscribe: (() => void) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly options: {
      nodes: RelayNodes;
      emit: (event: string, payload: unknown) => void;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.options.nodes.subscribe(() => this.sync());
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.watches.clear();
    this.sync();
  }

  /** Create or renew a lease. Renewing may also change the node or its prefixes. */
  watch(args: Record<string, unknown>): NodeEventWatchResult {
    const nodeId = args.nodeId;
    if (!isBackendId(nodeId)) throw new Error("Expected nodeId to be a node identity.");
    const prefixes = parseNodeEventPrefixes(args.prefixes);
    if (args.watchId !== undefined && !isNodeEventWatchId(args.watchId)) {
      throw new Error("Expected watchId to be a watch identity.");
    }
    this.expire();
    const existing = args.watchId === undefined ? undefined : this.watches.get(args.watchId);
    if (!existing && this.watches.size >= MAX_NODE_EVENT_WATCHES) {
      throw new Error("Too many event watches are open on this command node.");
    }
    const watch: Watch = {
      watchId: (args.watchId as string | undefined) ?? randomUUID(),
      nodeId,
      prefixes,
      expiresAt: this.now() + NODE_EVENT_WATCH_TTL_MS,
    };
    this.watches.set(watch.watchId, watch);
    this.sync();
    return { watchId: watch.watchId, expiresAt: watch.expiresAt, renewed: existing !== undefined };
  }

  unwatch(watchId: unknown): { removed: boolean } {
    if (!isNodeEventWatchId(watchId)) throw new Error("Expected watchId to be a watch identity.");
    const removed = this.watches.delete(watchId);
    if (removed) this.sync();
    return { removed };
  }

  /** Content-free counts, for diagnostics and tests. */
  diagnostics(): { watches: number; relays: Array<{ nodeId: BackendId; prefixes: string[] }> } {
    return {
      watches: this.watches.size,
      relays: [...this.relays].map(([nodeId, relay]) => ({ nodeId, prefixes: relay.prefixes })),
    };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private expire(): void {
    const now = this.now();
    for (const [watchId, watch] of this.watches) {
      if (watch.expiresAt <= now) this.watches.delete(watchId);
    }
  }

  /** Bring the node streams in line with the live watches and connections. */
  private sync(): void {
    this.expire();
    const wanted = new Map<BackendId, Set<string>>();
    if (this.started && !this.options.nodes.isLeaf()) {
      for (const watch of this.watches.values()) {
        const prefixes = wanted.get(watch.nodeId) ?? new Set<string>();
        for (const prefix of watch.prefixes) prefixes.add(prefix);
        wanted.set(watch.nodeId, prefixes);
      }
    }
    for (const [nodeId, relay] of this.relays) {
      if (!wanted.has(nodeId)) this.stopRelay(nodeId, relay);
    }
    for (const [nodeId, set] of wanted) {
      const link = this.options.nodes.link(nodeId);
      const current = this.relays.get(nodeId);
      if (!link?.connected) {
        if (current) this.stopRelay(nodeId, current);
        continue;
      }
      const prefixes = [...set].sort();
      const key = prefixes.join(",");
      const epoch = link.view.epoch;
      if (current && current.key === key && current.epoch === epoch) continue;
      if (current) this.stopRelay(nodeId, current);
      this.startRelay(nodeId, link, prefixes, key, epoch);
    }
    this.scheduleSweep();
  }

  private startRelay(
    nodeId: BackendId,
    link: ReadModelLink,
    prefixes: string[],
    key: string,
    epoch: number,
  ): void {
    const relay: Relay = {
      prefixes,
      key,
      epoch,
      stream: new NodeEventStream({
        transport: () => (link.connected && link.view.epoch === epoch ? link.transport() : null),
        prefixes,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        // A fresh or resumed stream may have missed events since the client read.
        onOpen: () => {
          if (this.relays.get(nodeId) === relay) this.relayResync(nodeId);
        },
        onEvent: (event, payload) => {
          if (this.relays.get(nodeId) !== relay) return;
          if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) {
            this.relayResync(nodeId);
            return;
          }
          // The node filters by prefix too; this keeps the relay's promise
          // even if it does not.
          if (!isRelayableEvent(event) || !prefixes.some((prefix) => event.startsWith(prefix))) {
            return;
          }
          const frame: RelayedNodeEvent = { nodeId, kind: "event", event, payload };
          this.options.emit(RELAYED_NODE_EVENT, frame);
        },
      }),
    };
    this.relays.set(nodeId, relay);
    relay.stream.start();
  }

  private stopRelay(nodeId: BackendId, relay: Relay): void {
    relay.stream.stop();
    if (this.relays.get(nodeId) === relay) this.relays.delete(nodeId);
  }

  private relayResync(nodeId: BackendId): void {
    const frame: RelayedNodeEvent = { nodeId, kind: "resync" };
    this.options.emit(RELAYED_NODE_EVENT, frame);
  }

  /** Expired leases are swept while any exist, so a vanished client's stream closes. */
  private scheduleSweep(): void {
    if (this.watches.size === 0 || !this.started) {
      if (this.sweepTimer) clearInterval(this.sweepTimer);
      this.sweepTimer = null;
      return;
    }
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sync(), SWEEP_INTERVAL_MS);
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }
}
