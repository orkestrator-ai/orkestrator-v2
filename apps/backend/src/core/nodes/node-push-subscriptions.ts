import type { BackendId } from "@orkestrator/protocol/federation";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  PUSH_CHANGED_EVENT,
  PUSH_LIMITS,
  PUSH_RESYNC_EVENT,
  PUSH_SET_SUBSCRIPTIONS_COMMAND,
  parsePushChangedPayload,
  parsePushResyncPayload,
  parsePushSetSubscriptionsResult,
  pushSubscriptionId,
  type PushSetSubscriptionsResult,
  type PushStamp,
  type PushStreamOffer,
  type PushSubscriptionAnswer,
  type PushSubscriptionRequest,
} from "@orkestrator/protocol/push-events";

import type { PushNodeSubscriptions } from "../push/push-hub.js";
import type { RelayPushSink } from "./node-event-relay.js";

const log = createLogger("push");

/**
 * The command node's push subscription controller for the nodes it relays
 * (design D10 in to-do 8102; docs/architecture/push-events.md, "Relayed
 * nodes").
 *
 * A window sends its set for another node to this command node, on its own
 * stream, as `push_set_subscriptions` with `nodeId`. The hub keeps that set's
 * `setRevision` order per (connection, node) and hands the keys here. For
 * each node this controller:
 *
 * - reference-counts every (topic, key) across the downstream connections
 *   that hold it, and sends the node the union with its own `setRevision`
 *   counter, on the push connection of the relay's shared stream to that
 *   node (`NodeEventRelay`, which keeps the stream open while a key is held
 *   here). One writer per upstream `streamId`, so revisions never collide;
 * - copies the node's answer stamps into each downstream answer. A set that
 *   adds no key to the union and finds every key answered is answered from
 *   those stamps without a call, so a second viewer adds no node traffic;
 * - fans each node `push.changed` change out to every downstream connection
 *   subscribed to that key (`publishToNode`, which coalesces and numbers it
 *   in that connection's own `seq`). Downstream clients never see the node's
 *   `seq`; this checks it;
 * - on a node `seq` gap, a node `push.resync`, a new upstream `streamId` or
 *   the relay's resync hint, sends the union again and gives every affected
 *   downstream connection a `push.resync` for that node, so each window
 *   re-reads what it holds there. A stream that ends does the same, so the
 *   windows fall back to polling until it returns;
 * - drops a key from the union when its last downstream subscriber
 *   unsubscribes or disconnects, and lets the node stream go once nothing is
 *   held.
 *
 * The union is bounded by the node's own limits (`PUSH_LIMITS`): a key that
 * would exceed them answers `denied` / `limit`. The node call is made with
 * this command node's own node credential, the one that opened the stream.
 * Nothing here logs a key, id or revision (invariant 12). `stop()` ends
 * everything explicitly (invariant 15).
 */

/** What the controller needs from the relay (`NodeEventRelay`). */
export interface NodePushLeafPort {
  /** Keep the node's stream open while keys are held there. */
  holdForPush(nodeId: BackendId): () => void;
  /** The node's link while the relay may use it. */
  link(nodeId: BackendId): {
    invoke<T>(
      command: string,
      args?: Record<string, unknown>,
      options?: { timeoutMs?: number },
    ): Promise<T>;
  } | null;
}

/** Where relayed changes go: the hub's per-connection, per-node path. */
export interface NodePushDownstream {
  publishToNode(
    streamId: string,
    nodeId: string,
    topic: string,
    key: string,
    stamp: PushStamp,
    parts: readonly string[] | null,
  ): void;
  resyncNode(streamId: string, nodeId: string): void;
}

export interface NodePushControllerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface NodePushSubscriptionControllerOptions {
  leaf: NodePushLeafPort;
  /** The node's bounds; its union never exceeds them. */
  limits?: { maxSubscriptions?: number; maxTopics?: number };
  /** How long a downstream set waits for the node's stream and answer. */
  answerTimeoutMs?: number;
  /** The node call's own deadline. */
  leafCallTimeoutMs?: number;
  timers?: NodePushControllerTimers;
}

export type NodePushControllerMetrics = {
  nodes: number;
  heldKeys: number;
  downstreamSets: number;
  leafSetCalls: number;
  leafSetFailures: number;
  answeredFromCache: number;
  changesFannedOut: number;
  resyncs: number;
  seqGaps: number;
  limitDenials: number;
};

/** Under the client's own 10 s set deadline, so a slow node answers `unavailable` first. */
export const NODE_PUSH_ANSWER_TIMEOUT_MS = 8_000;
const LEAF_CALL_TIMEOUT_MS = 7_000;

const defaultTimers: NodePushControllerTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface HeldKey {
  topic: string;
  key: string;
  /** Downstream connections holding the key. */
  streams: Set<string>;
  /** The node's newest answer for it, stamps advanced by its frames. */
  answer: PushSubscriptionAnswer | null;
}

interface Upstream {
  streamId: string;
  /** The node's last `seq` on this connection. */
  seq: number;
  /** This controller's set counter for the connection: its only writer. */
  setRevision: number;
  /** The node has answered a union on this connection. */
  answered: boolean;
}

interface Waiter {
  generation: number;
  resolve(ok: boolean): void;
  timer: unknown;
}

interface NodeState {
  nodeId: BackendId;
  keys: Map<string, HeldKey>;
  topics: Map<string, number>;
  /** Each downstream connection's set: subscription ids in the union. */
  sets: Map<string, Set<string>>;
  /** Bumped by every change to the union, and by every resync. */
  generation: number;
  /** The newest generation the node answered. */
  applied: number;
  dirty: boolean;
  sending: boolean;
  /** The last call failed; active unions retry on their next trigger. */
  failed: boolean;
  waiters: Waiter[];
  cleanupRetry: unknown;
  cleanupDelay: number;
  release: () => void;
}

export class NodePushSubscriptionController implements PushNodeSubscriptions, RelayPushSink {
  private readonly nodes = new Map<string, NodeState>();
  /** The relay's current push connection per node, whether or not keys are held. */
  private readonly upstreams = new Map<string, Upstream>();
  /** Downstream connection → the nodes it holds sets for. */
  private readonly connections = new Map<string, Set<string>>();
  private downstream: NodePushDownstream | null = null;
  private readonly timers: NodePushControllerTimers;
  private readonly maxSubscriptions: number;
  private readonly maxTopics: number;
  private readonly answerTimeoutMs: number;
  private readonly leafCallTimeoutMs: number;
  private stopped = false;
  private readonly counters = {
    leafSetCalls: 0,
    leafSetFailures: 0,
    answeredFromCache: 0,
    changesFannedOut: 0,
    resyncs: 0,
    seqGaps: 0,
    limitDenials: 0,
  };

  constructor(private readonly options: NodePushSubscriptionControllerOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.maxSubscriptions = options.limits?.maxSubscriptions ?? PUSH_LIMITS.maxSubscriptions;
    this.maxTopics = options.limits?.maxTopics ?? PUSH_LIMITS.maxTopics;
    this.answerTimeoutMs = options.answerTimeoutMs ?? NODE_PUSH_ANSWER_TIMEOUT_MS;
    this.leafCallTimeoutMs = options.leafCallTimeoutMs ?? LEAF_CALL_TIMEOUT_MS;
  }

  /** The hub's per-connection path for relayed changes. */
  attachDownstream(downstream: NodePushDownstream | null): void {
    this.downstream = downstream;
  }

  // ---------------------------------------------------------------------------
  // Downstream: the hub
  // ---------------------------------------------------------------------------

  apply(
    streamId: string,
    nodeId: string,
    subscriptions: readonly PushSubscriptionRequest[],
  ): Promise<PushSubscriptionAnswer[] | null> {
    if (this.stopped) return Promise.resolve(null);
    const requested = new Map<string, PushSubscriptionRequest>();
    for (const request of subscriptions) {
      requested.set(pushSubscriptionId(request.topic, request.key), request);
    }
    const existing = this.nodes.get(nodeId);
    if (!existing && requested.size === 0) {
      this.dropSet(streamId, nodeId);
      return Promise.resolve([]);
    }
    const node = existing ?? this.openNode(nodeId as BackendId);
    this.cancelCleanupRetry(node);
    // Each apply owns a distinct set, even when the union did not change.
    const previous = new Set(node.sets.get(streamId));
    let unionChanged = false;

    // Removals first, so a key let go frees room for one added in the same set.
    for (const id of previous) {
      if (requested.has(id)) continue;
      previous.delete(id);
      if (this.unref(node, id, streamId)) unionChanged = true;
    }
    const denied = new Map<string, PushSubscriptionAnswer>();
    for (const [id, request] of requested) {
      if (previous.has(id)) continue;
      const held = node.keys.get(id);
      if (held) {
        held.streams.add(streamId);
        previous.add(id);
        continue;
      }
      if (
        node.keys.size >= this.maxSubscriptions ||
        (!node.topics.has(request.topic) && node.topics.size >= this.maxTopics)
      ) {
        this.counters.limitDenials += 1;
        denied.set(id, {
          topic: request.topic,
          key: request.key,
          status: "denied",
          reason: "limit",
        });
        continue;
      }
      node.keys.set(id, {
        topic: request.topic,
        key: request.key,
        streams: new Set([streamId]),
        answer: null,
      });
      node.topics.set(request.topic, (node.topics.get(request.topic) ?? 0) + 1);
      previous.add(id);
      unionChanged = true;
    }
    if (previous.size > 0) {
      node.sets.set(streamId, previous);
      let held = this.connections.get(streamId);
      if (!held) {
        held = new Set();
        this.connections.set(streamId, held);
      }
      held.add(nodeId);
    } else {
      node.sets.delete(streamId);
      this.connections.get(streamId)?.delete(nodeId);
      if (this.connections.get(streamId)?.size === 0) this.connections.delete(streamId);
    }

    const answer = (): PushSubscriptionAnswer[] => {
      const answers: PushSubscriptionAnswer[] = [];
      for (const [id, request] of requested) {
        const refused = denied.get(id);
        if (refused) {
          answers.push(refused);
          continue;
        }
        const held = node.keys.get(id);
        answers.push(held?.answer ?? { topic: request.topic, key: request.key, status: "missing" });
      }
      // A key the node cannot read is not held for this connection: its view
      // polls, as the hub does for a local key.
      const set = node.sets.get(streamId);
      if (set !== previous) return answers;
      for (const entry of answers) {
        if (entry.status === "ok") continue;
        const id = pushSubscriptionId(entry.topic, entry.key);
        if (!set?.delete(id)) continue;
        this.unref(node, id, streamId);
      }
      if (set && set.size === 0) this.dropSet(streamId, nodeId);
      return answers;
    };

    const upstream = this.upstreams.get(nodeId);
    const cached =
      !unionChanged &&
      !node.dirty &&
      !node.sending &&
      upstream !== undefined &&
      node.applied === node.generation &&
      Array.from(requested.keys()).every(
        (id) => denied.has(id) || node.keys.get(id)?.answer !== null,
      );
    if (cached) {
      this.counters.answeredFromCache += 1;
      const answers = answer();
      this.maybeRetire(node);
      return Promise.resolve(answers);
    }
    node.generation += 1;
    node.dirty = true;
    if (requested.size === 0) {
      // Nothing to answer: the smaller union goes to the node in the background.
      this.pump(node);
      return Promise.resolve([]);
    }
    const generation = node.generation;
    const answered = this.waitFor(node, generation).then((ok) => (ok ? answer() : null));
    this.pump(node);
    return answered;
  }

  connectionClosed(streamId: string): void {
    const held = this.connections.get(streamId);
    if (!held) return;
    this.connections.delete(streamId);
    for (const nodeId of held) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      const set = node.sets.get(streamId);
      node.sets.delete(streamId);
      let changed = false;
      for (const id of set ?? []) if (this.unref(node, id, streamId)) changed = true;
      if (changed) {
        node.generation += 1;
        node.dirty = true;
        this.pump(node);
      } else {
        this.maybeRetire(node);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Upstream: the relay's stream to each node
  // ---------------------------------------------------------------------------

  upstreamConnected(nodeId: BackendId, offer: PushStreamOffer | null): void {
    if (this.stopped) return;
    const current = this.upstreams.get(nodeId);
    if (!offer) {
      // The node offers no push on this stream (an older node).
      if (current) this.upstreamClosed(nodeId);
      return;
    }
    if (current?.streamId === offer.streamId) return;
    // A new connection: a new `seq` space and an empty set at the node.
    this.upstreams.set(nodeId, {
      streamId: offer.streamId,
      seq: 0,
      setRevision: 0,
      answered: false,
    });
    const node = this.nodes.get(nodeId);
    if (node) {
      this.cancelCleanupRetry(node);
      this.resync(node);
    }
  }

  upstreamClosed(nodeId: BackendId): void {
    if (!this.upstreams.delete(nodeId)) return;
    const node = this.nodes.get(nodeId);
    if (!node) return;
    // The windows fall back to polling until a new stream answers them.
    node.dirty = true;
    node.generation += 1;
    this.failWaiters(node);
    this.resyncDownstream(node);
    this.maybeRetire(node);
  }

  upstreamFrame(nodeId: BackendId, event: string, payload: unknown): void {
    if (this.stopped) return;
    const upstream = this.upstreams.get(nodeId);
    if (!upstream) return;
    const frame =
      event === PUSH_CHANGED_EVENT
        ? parsePushChangedPayload(payload)
        : event === PUSH_RESYNC_EVENT
          ? parsePushResyncPayload(payload)
          : null;
    if (!frame || frame.seq <= upstream.seq) return;
    const gap = frame.seq > upstream.seq + 1;
    upstream.seq = frame.seq;
    const node = this.nodes.get(nodeId);
    if (!node) return;
    if ("changes" in frame) {
      for (const change of frame.changes) {
        // A change the node relays from yet another node is not its own key.
        if (change.nodeId !== undefined) continue;
        const held = node.keys.get(pushSubscriptionId(change.topic, change.key));
        if (!held) continue;
        const stamp = { generation: change.generation, revision: change.revision };
        if (held.answer?.status === "ok") {
          const moved =
            held.answer.generation !== stamp.generation || stamp.revision > held.answer.revision;
          if (moved) held.answer = { ...held.answer, ...stamp };
        }
        const parts = change.parts.length > 0 ? change.parts : null;
        for (const streamId of held.streams) {
          this.counters.changesFannedOut += 1;
          this.downstream?.publishToNode(streamId, nodeId, held.topic, held.key, stamp, parts);
        }
      }
    }
    if (gap) this.counters.seqGaps += 1;
    if (gap || event === PUSH_RESYNC_EVENT) this.resync(node);
  }

  upstreamResync(nodeId: BackendId): void {
    const node = this.nodes.get(nodeId);
    // A connection the node has not answered yet is already being sent the
    // union (the hint that comes with every fresh connection).
    if (node && this.upstreams.get(nodeId)?.answered) this.resync(node);
  }

  // ---------------------------------------------------------------------------

  metrics(): NodePushControllerMetrics {
    let heldKeys = 0;
    let downstreamSets = 0;
    for (const node of this.nodes.values()) {
      heldKeys += node.keys.size;
      downstreamSets += node.sets.size;
    }
    return { nodes: this.nodes.size, heldKeys, downstreamSets, ...this.counters };
  }

  /** Content-free view for tests: what the union holds per node. */
  diagnostics(): Array<{ nodeId: string; keys: number; sets: number; upstream: boolean }> {
    return Array.from(this.nodes.values(), (node) => ({
      nodeId: node.nodeId,
      keys: node.keys.size,
      sets: node.sets.size,
      upstream: this.upstreams.has(node.nodeId),
    }));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const nodes = Array.from(this.nodes.values());
    this.nodes.clear();
    this.upstreams.clear();
    this.connections.clear();
    for (const node of nodes) {
      this.failWaiters(node);
      this.cancelCleanupRetry(node);
      node.release();
    }
  }

  // ---------------------------------------------------------------------------

  private openNode(nodeId: BackendId): NodeState {
    const node: NodeState = {
      nodeId,
      keys: new Map(),
      topics: new Map(),
      sets: new Map(),
      generation: 0,
      applied: 0,
      dirty: false,
      sending: false,
      failed: false,
      waiters: [],
      cleanupRetry: null,
      cleanupDelay: 250,
      release: () => undefined,
    };
    this.nodes.set(nodeId, node);
    node.release = this.options.leaf.holdForPush(nodeId);
    return node;
  }

  /** Drops one downstream reference; true when the key left the union. */
  private unref(node: NodeState, id: string, streamId: string): boolean {
    const held = node.keys.get(id);
    if (!held) return false;
    held.streams.delete(streamId);
    if (held.streams.size > 0) return false;
    node.keys.delete(id);
    const count = (node.topics.get(held.topic) ?? 1) - 1;
    if (count > 0) node.topics.set(held.topic, count);
    else node.topics.delete(held.topic);
    return true;
  }

  private dropSet(streamId: string, nodeId: string): void {
    this.nodes.get(nodeId)?.sets.delete(streamId);
    const held = this.connections.get(streamId);
    held?.delete(nodeId);
    if (held?.size === 0) this.connections.delete(streamId);
  }

  /** The node lost track: send the union again and resync every window holding it. */
  private resync(node: NodeState): void {
    this.counters.resyncs += 1;
    node.generation += 1;
    node.dirty = true;
    this.resyncDownstream(node);
    this.pump(node);
  }

  private resyncDownstream(node: NodeState): void {
    for (const streamId of node.sets.keys()) this.downstream?.resyncNode(streamId, node.nodeId);
  }

  private waitFor(node: NodeState, generation: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { generation, resolve, timer: null };
      waiter.timer = this.timers.setTimeout(() => {
        const index = node.waiters.indexOf(waiter);
        if (index >= 0) node.waiters.splice(index, 1);
        resolve(false);
      }, this.answerTimeoutMs);
      node.waiters.push(waiter);
    });
  }

  private settleWaiters(node: NodeState, generation: number): void {
    for (const waiter of node.waiters.slice()) {
      if (waiter.generation > generation) continue;
      node.waiters.splice(node.waiters.indexOf(waiter), 1);
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
  }

  private failWaiters(node: NodeState): void {
    for (const waiter of node.waiters.splice(0)) {
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
  }

  /** Sends the union while it is dirty; one call in flight per node. */
  private pump(node: NodeState): void {
    if (node.sending || this.stopped) return;
    node.sending = true;
    void this.drain(node).finally(() => {
      node.sending = false;
      if (this.stopped || this.nodes.get(node.nodeId) !== node) return;
      // A stream that arrived while the loop was ending found it still
      // running: take its work now. After a failure the next trigger retries.
      if (
        node.dirty &&
        !node.failed &&
        this.upstreams.has(node.nodeId) &&
        this.options.leaf.link(node.nodeId)
      ) {
        this.pump(node);
        return;
      }
      this.maybeRetire(node);
    });
  }

  private async drain(node: NodeState): Promise<void> {
    while (node.dirty && !this.stopped && this.nodes.get(node.nodeId) === node) {
      const upstream = this.upstreams.get(node.nodeId);
      const link = upstream ? this.options.leaf.link(node.nodeId) : null;
      // No stream yet: `upstreamConnected` pumps again; waiters time out.
      if (!upstream || !link) return;
      node.dirty = false;
      const generation = node.generation;
      upstream.setRevision += 1;
      const setRevision = upstream.setRevision;
      const subscriptions = Array.from(node.keys.values(), ({ topic, key }) => ({ topic, key }));
      this.counters.leafSetCalls += 1;
      let result: PushSetSubscriptionsResult | null = null;
      try {
        result = parsePushSetSubscriptionsResult(
          await link.invoke<unknown>(
            PUSH_SET_SUBSCRIPTIONS_COMMAND,
            { streamId: upstream.streamId, setRevision, subscriptions },
            { timeoutMs: this.leafCallTimeoutMs },
          ),
        );
      } catch (error) {
        log.warn("node-subscriptions.leaf-set-failed", { error: formatLogError(error) });
      }
      if (this.stopped || this.nodes.get(node.nodeId) !== node) return;
      if (this.upstreams.get(node.nodeId) !== upstream) {
        // The stream was replaced while the call was out: send to the new one.
        node.dirty = true;
        continue;
      }
      if (
        !result ||
        result.status === "refused" ||
        (result.status === "applied" && result.setRevision !== setRevision) ||
        (result.status === "superseded" && result.setRevision < setRevision)
      ) {
        this.counters.leafSetFailures += 1;
        node.dirty = true;
        node.failed = true;
        this.failWaiters(node);
        return;
      }
      node.failed = false;
      if (result.status === "superseded") {
        upstream.setRevision = Math.max(upstream.setRevision, result.setRevision);
        node.dirty = true;
        continue;
      }
      const answered = new Map(
        result.subscriptions.map((entry) => [pushSubscriptionId(entry.topic, entry.key), entry]),
      );
      // A reply for a superseded union must not replace stamps for keys
      // added since the call started.
      if (generation !== node.generation) continue;
      for (const [id, held] of node.keys) {
        const entry = answered.get(id);
        if (!entry) {
          held.answer ??= { topic: held.topic, key: held.key, status: "missing" };
          continue;
        }
        // A frame may already have advanced the stamp past the answer's.
        if (
          entry.status === "ok" &&
          held.answer?.status === "ok" &&
          held.answer.generation === entry.generation &&
          held.answer.revision > entry.revision
        ) {
          continue;
        }
        held.answer = entry;
      }
      upstream.answered = true;
      node.applied = Math.max(node.applied, generation);
      this.settleWaiters(node, generation);
    }
  }

  private cancelCleanupRetry(node: NodeState): void {
    if (node.cleanupRetry !== null) this.timers.clearTimeout(node.cleanupRetry);
    node.cleanupRetry = null;
    node.cleanupDelay = 250;
  }

  /** Nothing held for the node and nothing left to tell it: let its stream go. */
  private maybeRetire(node: NodeState): void {
    if (node.sets.size > 0 || node.keys.size > 0 || node.sending || node.waiters.length > 0) return;
    // The node still holds the last non-empty union: send it the empty one first.
    if (node.dirty && this.upstreams.has(node.nodeId)) {
      if (!node.failed && this.options.leaf.link(node.nodeId)) this.pump(node);
      else if (node.cleanupRetry === null) {
        node.cleanupRetry = this.timers.setTimeout(() => {
          node.cleanupRetry = null;
          this.pump(node);
        }, node.cleanupDelay);
        node.cleanupDelay = Math.min(node.cleanupDelay * 2, 5_000);
      }
      return;
    }
    this.cancelCleanupRetry(node);
    if (this.nodes.get(node.nodeId) === node) this.nodes.delete(node.nodeId);
    node.release();
  }
}
