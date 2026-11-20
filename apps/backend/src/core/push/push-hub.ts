import { randomBytes } from "node:crypto";
import {
  PUSH_BACKPRESSURE_RETRY_MS,
  PUSH_CHANGED_EVENT,
  PUSH_COALESCE_MS,
  PUSH_KEY_THROTTLE_MS,
  PUSH_LIMITS,
  NATIVE_SESSION_PUSH_TOPIC,
  formatPushFrame,
  PUSH_RESYNC_EVENT,
  isPushNodeId,
  pushSubscriptionId,
  pushUtf8Bytes,
  type PushChange,
  type PushChangedPayload,
  type PushLimits,
  type PushResyncPayload,
  type PushSetSubscriptionsArgs,
  type PushSetSubscriptionsResult,
  type PushStamp,
  type PushSubscriptionAnswer,
  type PushSubscriptionRequest,
} from "@orkestrator/protocol/push-events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("push");

/**
 * The push event layer's backend half (docs/architecture/push-events.md).
 *
 * One {@link PushHub} per backend. The gateway opens a connection here for
 * every authoritative event stream and writes this connection's frames to it.
 * Topic providers own their keys' stamps and announce changes with
 * {@link PushHub.publish}; the hub fans each change out to the connections
 * subscribed to that key only.
 *
 * Bounds (design D6), all per connection:
 *
 * - at most {@link PUSH_LIMITS.maxSubscriptions} subscriptions over
 *   {@link PUSH_LIMITS.maxTopics} topics, keys at most `maxKeyBytes`;
 * - pending changes are a coalescing map keyed by subscription, holding the
 *   latest stamp and the union of parts, so its size follows the subscription
 *   count rather than the change rate. Past its entry or byte bound it is
 *   replaced by one `push.resync`;
 * - a frame carries at most `maxFrameChanges` changes and `maxFrameBytes`.
 *
 * Throttle: the first change of a key after a quiet period is sent within
 * {@link PUSH_COALESCE_MS}; later changes of the same key wait until
 * {@link PUSH_KEY_THROTTLE_MS} after its previous frame, and go out at that
 * deadline (no coalescing window on top). A connection whose
 * socket is over its soft write limit holds changes in the map (which only
 * coalesces) and retries.
 *
 * Nothing here logs a key, id or revision (invariant 12).
 */

export interface PushConnectionSink {
  /** Writes one frame. `false` means the connection is gone (it was dropped). */
  write(event: string, payload: unknown): boolean;
  /** Over the socket's soft write limit: hold frames and retry later. */
  backpressured(): boolean;
}

export type PushResolveAnswer =
  ({ status: "ok" } & PushStamp) | { status: "missing" } | { status: "denied" };

/** A topic's owner: validates keys, answers stamps and observes retained keys. */
export interface PushTopicProvider {
  readonly topic: string;
  /** Syntactic check; a key this refuses is answered `denied` / `invalid-key`. */
  validKey(key: string): boolean;
  /** The key's current stamp, read after the subscription is registered. */
  resolve(key: string): Promise<PushResolveAnswer>;
  /** The first connection subscribed to `key`: start observing it. */
  retain(key: string): void;
  /** The last connection let go of `key`: stop observing it. */
  release(key: string): void;
  /**
   * Parts that can carry a decision the user must see (an approval, a
   * question): a change naming one goes out within the coalescing window even
   * while the key's throttle runs, and a change naming only these does not
   * spend the throttle. Absent: every change of the topic is throttled.
   * (`native-session` keeps its own rule: `state` is urgent, `transcript`
   * spends the throttle.)
   */
  readonly urgentParts?: readonly string[];
}

/**
 * The command node's subscription controller for the nodes it relays
 * (design D10, `core/nodes/node-push-subscriptions.ts`). The hub keeps each
 * connection's per-node `setRevision` order, numbering and coalescing; the
 * controller owns which leaf keys a connection holds and the leaf's answers.
 */
export interface PushNodeSubscriptions {
  /**
   * Replace `streamId`'s set for `nodeId` with `subscriptions` (already
   * deduplicated and syntactically valid). The registration happens before
   * this returns, so a leaf change after it is published to the connection;
   * the promise answers each key once the leaf answered the union, or `null`
   * when the node cannot take push subscriptions now (not connected, no
   * offer on its stream, the call failed).
   */
  apply(
    streamId: string,
    nodeId: string,
    subscriptions: readonly PushSubscriptionRequest[],
  ): Promise<PushSubscriptionAnswer[] | null>;
  /** The connection closed: drop every node set it held. */
  connectionClosed(streamId: string): void;
  /** Content-free counters for the push metrics block (no keys, ids or revisions). */
  metrics?(): Record<string, number>;
}

/** A connection holds sets for at most this many nodes (invariant 11). */
export const PUSH_MAX_NODE_NAMESPACES = 64;

/** A node key's map id; the leading U+0001 keeps it apart from every local id. */
function nodeSubscriptionId(nodeId: string, topic: string, key: string): string {
  return `\u0001${nodeId}\u0000${pushSubscriptionId(topic, key)}`;
}

function nodeNamespacePrefix(nodeId: string): string {
  return `\u0001${nodeId}\u0000`;
}

export interface PushHubTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PushHubOptions {
  timers?: PushHubTimers;
  now?: () => number;
  limits?: Partial<PushLimits>;
  coalesceMs?: number;
  keyThrottleMs?: number;
}

interface Subscription {
  id: string;
  topic: string;
  key: string;
}

interface PendingChange {
  topic: string;
  key: string;
  generation: string;
  revision: number;
  parts: Set<string> | null;
  bytes: number;
  /** A relayed node's key (design D10); absent for this backend's own. */
  nodeId?: string;
}

interface Connection {
  streamId: string;
  owner: string;
  sink: PushConnectionSink;
  seq: number;
  setRevision: number;
  subscriptions: Map<string, Subscription>;
  pending: Map<string, PendingChange>;
  pendingBytes: number;
  pendingResync: { reason: PushResyncPayload["reason"]; topics: Set<string> } | null;
  /** Per relayed node: the newest applied `setRevision` (design D10). */
  nodeRevisions: Map<string, number>;
  retiredNodeRevisions: Map<string, number>;
  retiredNodeFloor: number;
  /** Relayed nodes owed a `node-reset` resync, written before any change. */
  pendingNodeResyncs: Set<string>;
  /** When each subscription last went out in a frame; bounded by the set. */
  lastSentAt: Map<string, number>;
  flushTimer: unknown;
  flushAt: number | null;
  closed: boolean;
}

export interface PushMetricsSnapshot {
  connections: number;
  connectionsWithSubscriptions: number;
  subscriptionsByTopic: Record<string, number>;
  observedKeysByTopic: Record<string, number>;
  framesSent: number;
  changesSent: number;
  frameBytes: number;
  changesPublished: number;
  changesCoalesced: number;
  backpressureHolds: number;
  resyncsByReason: Record<string, number>;
  deniedByReason: Record<string, number>;
  setCalls: number;
  setRefusals: number;
  setSuperseded: number;
  pendingEntries: number;
  pendingBytes: number;
  /** Relayed-node sets held across connections (design D10). */
  nodeSets: number;
}

const defaultTimers: PushHubTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Estimated overhead for a pending entry in memory, beyond its strings. */
const CHANGE_OVERHEAD_BYTES = 96;

function changeBytes(
  topic: string,
  key: string,
  generation: string,
  parts: Iterable<string> | null,
) {
  let bytes =
    CHANGE_OVERHEAD_BYTES + pushUtf8Bytes(topic) + pushUtf8Bytes(key) + pushUtf8Bytes(generation);
  if (parts) for (const part of parts) bytes += pushUtf8Bytes(part) + 3;
  return bytes;
}

export class PushHub {
  private readonly providers = new Map<string, PushTopicProvider>();
  private readonly connections = new Map<string, Connection>();
  /** Subscription id → the connections subscribed to it. */
  private readonly index = new Map<string, Set<Connection>>();
  private readonly timers: PushHubTimers;
  private readonly now: () => number;
  private readonly limits: Readonly<PushLimits>;
  private readonly coalesceMs: number;
  private readonly keyThrottleMs: number;
  private disposed = false;
  private nodeSubscriptions: PushNodeSubscriptions | null = null;
  private readonly counters = {
    framesSent: 0,
    changesSent: 0,
    frameBytes: 0,
    changesPublished: 0,
    changesCoalesced: 0,
    backpressureHolds: 0,
    setCalls: 0,
    setRefusals: 0,
    setSuperseded: 0,
  };
  private readonly resyncsByReason = new Map<string, number>();
  private readonly deniedByReason = new Map<string, number>();

  constructor(options: PushHubOptions = {}) {
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => performance.now());
    this.limits = { ...PUSH_LIMITS, ...options.limits };
    this.coalesceMs = options.coalesceMs ?? PUSH_COALESCE_MS;
    this.keyThrottleMs = options.keyThrottleMs ?? PUSH_KEY_THROTTLE_MS;
  }

  /**
   * The command node's controller for relayed nodes (design D10). While one
   * is attached, connections accept `nodeId` sets and their offer says
   * `nodes: true`.
   */
  attachNodeSubscriptions(nodes: PushNodeSubscriptions | null): void {
    this.nodeSubscriptions = nodes;
  }

  /** Whether `nodeId` sets are accepted (the offer's `nodes`). */
  get acceptsNodeSets(): boolean {
    return this.nodeSubscriptions !== null;
  }

  registerTopic(provider: PushTopicProvider): void {
    if (this.providers.has(provider.topic)) {
      throw new Error(`Push topic ${provider.topic} is already registered`);
    }
    this.providers.set(provider.topic, provider);
  }

  /**
   * A new authoritative stream. `owner` identifies the credential that opened
   * it; only a call made with the same credential may set its subscriptions.
   */
  openConnection(owner: string, sink: PushConnectionSink): string {
    if (this.disposed) throw new Error("Push hub is disposed");
    const streamId = randomBytes(18).toString("base64url");
    this.connections.set(streamId, {
      streamId,
      owner,
      sink,
      seq: 0,
      setRevision: -1,
      subscriptions: new Map(),
      pending: new Map(),
      pendingBytes: 0,
      pendingResync: null,
      nodeRevisions: new Map(),
      retiredNodeRevisions: new Map(),
      retiredNodeFloor: -1,
      pendingNodeResyncs: new Set(),
      lastSentAt: new Map(),
      flushTimer: null,
      flushAt: null,
      closed: false,
    });
    return streamId;
  }

  /** The stream closed: forget its subscriptions and release unobserved keys. */
  closeConnection(streamId: string): void {
    const connection = this.connections.get(streamId);
    if (!connection) return;
    this.connections.delete(streamId);
    connection.closed = true;
    this.cancelFlush(connection);
    for (const subscription of Array.from(connection.subscriptions.values())) {
      this.unindex(connection, subscription);
    }
    connection.subscriptions.clear();
    connection.pending.clear();
    connection.pendingResync = null;
    connection.pendingNodeResyncs.clear();
    connection.pendingBytes = 0;
    connection.lastSentAt.clear();
    if (connection.nodeRevisions.size > 0) {
      connection.nodeRevisions.clear();
      try {
        this.nodeSubscriptions?.connectionClosed(streamId);
      } catch (error) {
        log.warn("node-subscriptions.close-failed", { error: formatLogError(error) });
      }
    }
  }

  async setSubscriptions(
    owner: string,
    args: PushSetSubscriptionsArgs,
  ): Promise<PushSetSubscriptionsResult> {
    this.counters.setCalls += 1;
    const connection = this.connections.get(args.streamId);
    if (!connection || connection.owner !== owner || connection.closed) {
      this.counters.setRefusals += 1;
      return { status: "refused", reason: "stream-unknown" };
    }
    if (!Number.isSafeInteger(args.setRevision) || args.setRevision < 0) {
      throw new Error("setRevision must be a non-negative integer");
    }
    if (args.nodeId !== undefined) return this.setNodeSubscriptions(connection, args);
    if (args.setRevision <= connection.setRevision) {
      this.counters.setSuperseded += 1;
      return { status: "superseded", setRevision: connection.setRevision };
    }
    connection.setRevision = args.setRevision;

    const answers: PushSubscriptionAnswer[] = [];
    const accepted = new Map<string, Subscription>();
    const topics = new Set<string>();
    const deny = (
      topic: string,
      key: string,
      reason: "limit" | "unknown-topic" | "invalid-key",
    ) => {
      this.deniedByReason.set(reason, (this.deniedByReason.get(reason) ?? 0) + 1);
      answers.push({ topic, key, status: "denied", reason });
    };
    for (const request of args.subscriptions) {
      const topic = typeof request?.topic === "string" ? request.topic : "";
      const key = typeof request?.key === "string" ? request.key : "";
      const id = pushSubscriptionId(topic, key);
      if (accepted.has(id)) continue;
      const provider = this.providers.get(topic);
      if (!provider) {
        deny(topic, key, "unknown-topic");
        continue;
      }
      if (
        key.length === 0 ||
        pushUtf8Bytes(key) > this.limits.maxKeyBytes ||
        !provider.validKey(key)
      ) {
        deny(topic, key, "invalid-key");
        continue;
      }
      if (
        accepted.size >= this.limits.maxSubscriptions ||
        (!topics.has(topic) && topics.size >= this.limits.maxTopics)
      ) {
        deny(topic, key, "limit");
        continue;
      }
      topics.add(topic);
      accepted.set(id, { id, topic, key });
    }

    // Register first, then read stamps (invariant 7): a change after this
    // point is pending for this connection and goes out with `seq > seqBase`.
    for (const previous of Array.from(connection.subscriptions.values())) {
      if (accepted.has(previous.id)) continue;
      connection.subscriptions.delete(previous.id);
      this.dropPending(connection, previous.id);
      connection.lastSentAt.delete(previous.id);
      this.unindex(connection, previous);
    }
    for (const subscription of accepted.values()) {
      if (connection.subscriptions.has(subscription.id)) continue;
      connection.subscriptions.set(subscription.id, subscription);
      this.reindex(connection, subscription);
    }
    const seqBase = connection.seq;

    const resolved = await Promise.all(
      Array.from(accepted.values()).map(async (subscription) => {
        const provider = this.providers.get(subscription.topic)!;
        try {
          return { subscription, answer: await provider.resolve(subscription.key) };
        } catch (error) {
          log.warn("subscription.resolve-failed", {
            topic: subscription.topic,
            error: formatLogError(error),
          });
          return { subscription, answer: { status: "missing" } as PushResolveAnswer };
        }
      }),
    );
    if (connection.closed) return { status: "refused", reason: "stream-unknown" };
    if (connection.setRevision !== args.setRevision) {
      this.counters.setSuperseded += 1;
      return { status: "superseded", setRevision: connection.setRevision };
    }
    for (const { subscription, answer } of resolved) {
      if (answer.status === "ok") {
        answers.push({
          topic: subscription.topic,
          key: subscription.key,
          status: "ok",
          generation: answer.generation,
          revision: answer.revision,
        });
        continue;
      }
      // A key the caller cannot read is not observed for it: its view keeps
      // polling, so observing it here too would only double the work.
      if (connection.subscriptions.has(subscription.id)) {
        connection.subscriptions.delete(subscription.id);
        this.dropPending(connection, subscription.id);
        connection.lastSentAt.delete(subscription.id);
        this.unindex(connection, subscription);
      }
      if (answer.status === "denied") {
        this.deniedByReason.set("denied", (this.deniedByReason.get("denied") ?? 0) + 1);
        answers.push({
          topic: subscription.topic,
          key: subscription.key,
          status: "denied",
          reason: "invalid-key",
        });
      } else {
        answers.push({ topic: subscription.topic, key: subscription.key, status: "missing" });
      }
    }
    return { status: "applied", setRevision: args.setRevision, seqBase, subscriptions: answers };
  }

  /**
   * A topic owner's key moved. Only connections subscribed to it are touched;
   * an unsubscribed key costs one map lookup.
   */
  publish(topic: string, key: string, stamp: PushStamp, parts: readonly string[] | null): void {
    const id = pushSubscriptionId(topic, key);
    const subscribers = this.index.get(id);
    if (!subscribers || subscribers.size === 0) return;
    this.counters.changesPublished += 1;
    for (const connection of Array.from(subscribers)) {
      this.enqueue(connection, id, topic, key, stamp, parts);
    }
  }

  /** Every subscriber of `topic` must re-read all of its keys (an owner lost track). */
  resyncTopic(topic: string): void {
    for (const connection of Array.from(this.connections.values())) {
      const has = Array.from(connection.subscriptions.values()).some((s) => s.topic === topic);
      if (!has) continue;
      for (const id of Array.from(connection.pending.keys())) {
        if (connection.pending.get(id)?.topic === topic) this.dropPending(connection, id);
      }
      this.enqueueResync(connection, "topic-reset", [topic]);
    }
  }

  metrics(): PushMetricsSnapshot {
    const subscriptionsByTopic: Record<string, number> = {};
    let connectionsWithSubscriptions = 0;
    let pendingEntries = 0;
    let pendingBytes = 0;
    let nodeSets = 0;
    for (const connection of this.connections.values()) {
      nodeSets += connection.nodeRevisions.size;
      if (connection.subscriptions.size > 0) connectionsWithSubscriptions += 1;
      for (const subscription of connection.subscriptions.values()) {
        subscriptionsByTopic[subscription.topic] =
          (subscriptionsByTopic[subscription.topic] ?? 0) + 1;
      }
      pendingEntries += connection.pending.size;
      pendingBytes += connection.pendingBytes;
    }
    const observedKeysByTopic: Record<string, number> = {};
    for (const id of this.index.keys()) {
      const topic = id.slice(0, id.indexOf("\u0000"));
      observedKeysByTopic[topic] = (observedKeysByTopic[topic] ?? 0) + 1;
    }
    return {
      connections: this.connections.size,
      connectionsWithSubscriptions,
      subscriptionsByTopic,
      observedKeysByTopic,
      ...this.counters,
      resyncsByReason: Object.fromEntries(this.resyncsByReason),
      deniedByReason: Object.fromEntries(this.deniedByReason),
      pendingEntries,
      pendingBytes,
      nodeSets,
    };
  }

  /**
   * A relayed node's key moved (design D10): the controller names the one
   * connection subscribed to it for that node. Coalesced, throttled and
   * numbered like a local change; the change carries `nodeId`.
   */
  publishToNode(
    streamId: string,
    nodeId: string,
    topic: string,
    key: string,
    stamp: PushStamp,
    parts: readonly string[] | null,
  ): void {
    const connection = this.connections.get(streamId);
    if (!connection || !connection.nodeRevisions.has(nodeId)) return;
    if (connection.pendingNodeResyncs.has(nodeId)) return;
    this.counters.changesPublished += 1;
    this.enqueue(
      connection,
      nodeSubscriptionId(nodeId, topic, key),
      topic,
      key,
      stamp,
      parts,
      nodeId,
    );
  }

  /**
   * Everything the connection holds for `nodeId` must be re-read: the
   * controller lost frames from that node. One `push.resync` with `nodeId`
   * replaces the node's pending changes; other namespaces are untouched.
   */
  resyncNode(streamId: string, nodeId: string): void {
    const connection = this.connections.get(streamId);
    if (!connection || connection.closed || !connection.nodeRevisions.has(nodeId)) return;
    this.dropNodePending(connection, nodeId, null);
    connection.pendingNodeResyncs.add(nodeId);
    this.scheduleFlush(connection, 0);
  }

  /** A `nodeId` set: per-node `setRevision` order, the controller answers the keys. */
  private async setNodeSubscriptions(
    connection: Connection,
    args: PushSetSubscriptionsArgs,
  ): Promise<PushSetSubscriptionsResult> {
    const nodes = this.nodeSubscriptions;
    const nodeId = args.nodeId;
    if (!nodes || !isPushNodeId(nodeId)) {
      this.counters.setRefusals += 1;
      return { status: "refused", reason: "unavailable" };
    }
    const wasActive = connection.nodeRevisions.has(nodeId);
    const held = this.nodeRevision(connection, nodeId);
    if (args.setRevision <= held) {
      this.counters.setSuperseded += 1;
      return { status: "superseded", setRevision: held };
    }

    const answers: PushSubscriptionAnswer[] = [];
    const accepted = new Map<string, PushSubscriptionRequest>();
    const topics = new Set<string>();
    const deny = (topic: string, key: string, reason: "limit" | "invalid-key") => {
      this.deniedByReason.set(reason, (this.deniedByReason.get(reason) ?? 0) + 1);
      answers.push({ topic, key, status: "denied", reason });
    };
    // The leaf validates its own topics and keys; here only the bounds this
    // connection would hold are checked.
    for (const request of args.subscriptions) {
      const topic = typeof request?.topic === "string" ? request.topic : "";
      const key = typeof request?.key === "string" ? request.key : "";
      const id = pushSubscriptionId(topic, key);
      if (accepted.has(id)) continue;
      if (
        topic.length === 0 ||
        topic.length > 64 ||
        key.length === 0 ||
        pushUtf8Bytes(key) > this.limits.maxKeyBytes
      ) {
        deny(topic, key, "invalid-key");
        continue;
      }
      if (
        accepted.size >= this.limits.maxSubscriptions ||
        (!topics.has(topic) && topics.size >= this.limits.maxTopics)
      ) {
        deny(topic, key, "limit");
        continue;
      }
      topics.add(topic);
      accepted.set(id, { topic, key });
    }
    if (accepted.size > 0) {
      if (
        !connection.nodeRevisions.has(nodeId) &&
        connection.nodeRevisions.size >= PUSH_MAX_NODE_NAMESPACES
      ) {
        this.counters.setRefusals += 1;
        return { status: "refused", reason: "unavailable" };
      }
      connection.retiredNodeRevisions.delete(nodeId);
      connection.nodeRevisions.set(nodeId, args.setRevision);
    } else {
      this.retireNodeNamespace(connection, nodeId, args.setRevision);
    }
    const kept = new Set(
      Array.from(accepted.values(), ({ topic, key }) => nodeSubscriptionId(nodeId, topic, key)),
    );
    this.dropNodePending(connection, nodeId, kept);

    // The controller registers before it asks the leaf (invariant 7): a leaf
    // change after this point is pending here and goes out with `seq > seqBase`.
    let answered: Promise<PushSubscriptionAnswer[] | null>;
    try {
      answered = nodes.apply(connection.streamId, nodeId, Array.from(accepted.values()));
    } catch (error) {
      log.warn("node-subscriptions.apply-failed", { error: formatLogError(error) });
      answered = Promise.resolve(null);
    }
    const seqBase = connection.seq;
    const leafAnswers = await answered.catch(() => null);
    if (connection.closed) return { status: "refused", reason: "stream-unknown" };
    const current = this.nodeRevision(connection, nodeId);
    if (current !== args.setRevision) {
      this.counters.setSuperseded += 1;
      return { status: "superseded", setRevision: current };
    }
    if (leafAnswers === null) {
      if (!wasActive && accepted.size > 0) {
        this.retireNodeNamespace(connection, nodeId, args.setRevision);
        try {
          void nodes.apply(connection.streamId, nodeId, []).catch(() => null);
        } catch (error) {
          log.warn("node-subscriptions.apply-failed", { error: formatLogError(error) });
        }
      }
      this.counters.setRefusals += 1;
      return { status: "refused", reason: "unavailable" };
    }
    for (const answer of leafAnswers) {
      if (answer.status === "denied") {
        this.deniedByReason.set(answer.reason, (this.deniedByReason.get(answer.reason) ?? 0) + 1);
      }
      answers.push(answer);
    }
    if (accepted.size > 0 && !leafAnswers.some((entry) => entry.status === "ok")) {
      this.retireNodeNamespace(connection, nodeId, args.setRevision);
    }
    return { status: "applied", setRevision: args.setRevision, seqBase, subscriptions: answers };
  }

  private nodeRevision(connection: Connection, nodeId: string): number {
    return (
      connection.nodeRevisions.get(nodeId) ??
      connection.retiredNodeRevisions.get(nodeId) ??
      connection.retiredNodeFloor
    );
  }

  private retireNodeNamespace(connection: Connection, nodeId: string, revision: number): void {
    connection.nodeRevisions.delete(nodeId);
    connection.pendingNodeResyncs.delete(nodeId);
    this.dropNodePending(connection, nodeId, null);
    connection.retiredNodeRevisions.delete(nodeId);
    connection.retiredNodeRevisions.set(nodeId, revision);
    if (connection.retiredNodeRevisions.size <= PUSH_MAX_NODE_NAMESPACES) return;
    const oldest = connection.retiredNodeRevisions.entries().next().value;
    if (!oldest) return;
    connection.retiredNodeRevisions.delete(oldest[0]);
    // A forgotten namespace still fences old requests. A client opening an
    // unrelated namespace below this floor can advance from "superseded".
    connection.retiredNodeFloor = Math.max(connection.retiredNodeFloor, oldest[1]);
  }

  /** Drops `nodeId`'s pending changes and throttle marks, except the ids in `keep`. */
  private dropNodePending(connection: Connection, nodeId: string, keep: Set<string> | null): void {
    const prefix = nodeNamespacePrefix(nodeId);
    for (const id of Array.from(connection.pending.keys())) {
      if (id.startsWith(prefix) && !keep?.has(id)) this.dropPending(connection, id);
    }
    for (const id of Array.from(connection.lastSentAt.keys())) {
      if (id.startsWith(prefix) && !keep?.has(id)) connection.lastSentAt.delete(id);
    }
  }

  /** Whether any connection is subscribed to the key. */
  isObserved(topic: string, key: string): boolean {
    return (this.index.get(pushSubscriptionId(topic, key))?.size ?? 0) > 0;
  }

  dispose(): void {
    this.disposed = true;
    for (const streamId of Array.from(this.connections.keys())) this.closeConnection(streamId);
  }

  // -------------------------------------------------------------------------

  private reindex(connection: Connection, subscription: Subscription): void {
    let subscribers = this.index.get(subscription.id);
    if (!subscribers) {
      subscribers = new Set();
      this.index.set(subscription.id, subscribers);
    }
    const first = subscribers.size === 0;
    subscribers.add(connection);
    if (first) {
      try {
        this.providers.get(subscription.topic)?.retain(subscription.key);
      } catch (error) {
        log.warn("topic.retain-failed", {
          topic: subscription.topic,
          error: formatLogError(error),
        });
      }
    }
  }

  private unindex(connection: Connection, subscription: Subscription): void {
    const subscribers = this.index.get(subscription.id);
    if (!subscribers?.delete(connection)) return;
    if (subscribers.size > 0) return;
    this.index.delete(subscription.id);
    try {
      this.providers.get(subscription.topic)?.release(subscription.key);
    } catch (error) {
      log.warn("topic.release-failed", { topic: subscription.topic, error: formatLogError(error) });
    }
  }

  private dropPending(connection: Connection, id: string): void {
    const pending = connection.pending.get(id);
    if (!pending) return;
    connection.pending.delete(id);
    connection.pendingBytes -= pending.bytes;
  }

  private enqueue(
    connection: Connection,
    id: string,
    topic: string,
    key: string,
    stamp: PushStamp,
    parts: readonly string[] | null,
    nodeId?: string,
  ): void {
    if (connection.closed) return;
    if (connection.pendingResync?.topics.has(topic)) return;
    // `"nodeId":"…",` on the wire.
    const nodeBytes = nodeId === undefined ? 0 : pushUtf8Bytes(nodeId) + 12;
    const boundedParts =
      parts === null || parts.length === 0
        ? null
        : parts
            .filter((part) => part.length > 0 && pushUtf8Bytes(part) <= this.limits.maxPartBytes)
            .slice(0, this.limits.maxParts);
    const existing = connection.pending.get(id);
    if (existing) {
      this.counters.changesCoalesced += 1;
      if (existing.generation !== stamp.generation || stamp.revision > existing.revision) {
        existing.generation = stamp.generation;
        existing.revision = stamp.revision;
      }
      if (existing.parts !== null) {
        if (boundedParts === null) existing.parts = null;
        else for (const part of boundedParts) existing.parts.add(part);
        if (existing.parts && existing.parts.size > this.limits.maxParts) existing.parts = null;
      }
      const bytes = changeBytes(topic, key, existing.generation, existing.parts) + nodeBytes;
      connection.pendingBytes += bytes - existing.bytes;
      existing.bytes = bytes;
    } else {
      const partSet = boundedParts === null ? null : new Set(boundedParts);
      const bytes = changeBytes(topic, key, stamp.generation, partSet) + nodeBytes;
      connection.pending.set(id, {
        topic,
        key,
        generation: stamp.generation,
        revision: stamp.revision,
        parts: partSet,
        bytes,
        ...(nodeId === undefined ? {} : { nodeId }),
      });
      connection.pendingBytes += bytes;
    }
    if (
      connection.pending.size > this.limits.maxPendingEntries ||
      connection.pendingBytes > this.limits.maxPendingBytes
    ) {
      // The map could not hold this connection's changes: one resync replaces
      // them (invariants 5, 6 and 11), never a silent drop.
      const topics = Array.from(new Set(Array.from(connection.pending.values(), (p) => p.topic)));
      connection.pending.clear();
      connection.pendingBytes = 0;
      this.enqueueResync(connection, "pending-bound", topics);
      return;
    }
    this.scheduleFlush(connection);
  }

  private readyAt(connection: Connection, id: string, change: PendingChange, now: number): number {
    // A state invalidation can carry an approval or completion. Only transcript
    // traffic spends this key's transcript throttle.
    const urgent =
      change.topic === NATIVE_SESSION_PUSH_TOPIC
        ? change.parts === null || change.parts.has("state")
        : this.namesUrgentPart(change.topic, change.parts);
    const last = connection.lastSentAt.get(id);
    return urgent || last === undefined ? now : Math.max(now, last + this.keyThrottleMs);
  }

  /** A change of a topic with `urgentParts` that names one (or everything). */
  private namesUrgentPart(topic: string, parts: Iterable<string> | null): boolean {
    const urgentParts = this.providers.get(topic)?.urgentParts;
    if (!urgentParts || urgentParts.length === 0) return false;
    if (parts === null) return true;
    for (const part of parts) if (urgentParts.includes(part)) return true;
    return false;
  }

  /** Whether a sent change starts its key's throttle window. */
  private spendsThrottle(change: PushChange): boolean {
    if (change.parts.length === 0) return true;
    if (change.topic === NATIVE_SESSION_PUSH_TOPIC) return change.parts.includes("transcript");
    const urgentParts = this.providers.get(change.topic)?.urgentParts;
    return !urgentParts || change.parts.some((part) => !urgentParts.includes(part));
  }

  /**
   * Arms the connection's flush. `minDelayMs` is the coalescing window on a
   * leading edge (a change ready now, or a resync); a change waiting for its
   * key's throttle goes out at that deadline, with no window added on top, so
   * a streaming key is announced once per throttle and no later. Under
   * back-pressure (`deadlinesWait` false) every change waits at least the
   * retry interval.
   */
  private scheduleFlush(
    connection: Connection,
    minDelayMs = this.coalesceMs,
    deadlinesWait = true,
  ): void {
    if (connection.closed) return;
    const now = this.now();
    let at =
      connection.pendingResync || connection.pendingNodeResyncs.size > 0
        ? now + minDelayMs
        : Number.POSITIVE_INFINITY;
    for (const [id, change] of connection.pending) {
      const ready = this.readyAt(connection, id, change, now);
      at = Math.min(at, deadlinesWait && ready > now ? ready : Math.max(now + minDelayMs, ready));
    }
    if (!Number.isFinite(at)) return;
    if (connection.flushTimer !== null && connection.flushAt !== null && connection.flushAt <= at) {
      return;
    }
    this.cancelFlush(connection);
    connection.flushAt = at;
    connection.flushTimer = this.timers.setTimeout(
      () => {
        connection.flushTimer = null;
        connection.flushAt = null;
        this.flush(connection);
      },
      Math.max(0, at - now),
    );
  }

  private cancelFlush(connection: Connection): void {
    if (connection.flushTimer !== null) this.timers.clearTimeout(connection.flushTimer);
    connection.flushTimer = null;
    connection.flushAt = null;
  }

  private holdFrames(connection: Connection): boolean {
    if (!connection.sink.backpressured()) return false;
    this.counters.backpressureHolds += 1;
    this.scheduleFlush(connection, PUSH_BACKPRESSURE_RETRY_MS, false);
    return true;
  }

  private flush(connection: Connection): void {
    if (connection.closed || this.holdFrames(connection)) return;
    const recovery = connection.pendingResync;
    if (recovery) {
      connection.pendingResync = null;
      const written = this.writeFrame(connection, PUSH_RESYNC_EVENT, (seq): PushResyncPayload => ({
        seq,
        reason: recovery.reason,
        topics: Array.from(recovery.topics),
      }));
      if (!written) return;
      this.resyncsByReason.set(
        recovery.reason,
        (this.resyncsByReason.get(recovery.reason) ?? 0) + 1,
      );
      if (connection.pending.size > 0 && this.holdFrames(connection)) return;
    }
    // A relayed node's resync (design D10): only that node's namespace re-reads.
    for (const nodeId of Array.from(connection.pendingNodeResyncs)) {
      connection.pendingNodeResyncs.delete(nodeId);
      const written = this.writeFrame(connection, PUSH_RESYNC_EVENT, (seq): PushResyncPayload => ({
        seq,
        reason: "node-reset",
        topics: "all",
        nodeId,
      }));
      if (!written) return;
      this.resyncsByReason.set("node-reset", (this.resyncsByReason.get("node-reset") ?? 0) + 1);
      if (this.holdFrames(connection)) return;
    }
    const now = this.now();
    let batch: Array<{ id: string; change: PushChange }> = [];
    const emptyFrameBytes = () =>
      pushUtf8Bytes(formatPushFrame(PUSH_CHANGED_EVENT, { seq: connection.seq + 1, changes: [] }));
    let bytes = emptyFrameBytes();
    const writeBatch = (): boolean => {
      if (batch.length === 0) return true;
      if (this.holdFrames(connection)) return false;
      const ok = this.writeFrame(connection, PUSH_CHANGED_EVENT, (seq): PushChangedPayload => ({
        seq,
        changes: batch.map(({ change }) => change),
      }));
      if (!ok) return false;
      for (const { id, change } of batch) {
        this.dropPending(connection, id);
        if (this.spendsThrottle(change)) connection.lastSentAt.set(id, now);
      }
      this.counters.changesSent += batch.length;
      batch = [];
      bytes = emptyFrameBytes();
      return true;
    };
    for (const [id, pending] of connection.pending) {
      if (this.readyAt(connection, id, pending, now) > now) continue;
      const change: PushChange = {
        topic: pending.topic,
        key: pending.key,
        generation: pending.generation,
        revision: pending.revision,
        parts: pending.parts === null ? [] : Array.from(pending.parts),
        ...(pending.nodeId === undefined ? {} : { nodeId: pending.nodeId }),
      };
      const changeSize = pushUtf8Bytes(JSON.stringify(change));
      if (
        batch.length >= this.limits.maxFrameChanges ||
        bytes + changeSize + Number(batch.length > 0) > this.limits.maxFrameBytes
      ) {
        if (!writeBatch()) return;
      }
      if (bytes + changeSize > this.limits.maxFrameBytes) {
        this.dropPending(connection, id);
        this.enqueueResync(connection, "pending-bound", [pending.topic]);
        return;
      }
      bytes += changeSize + Number(batch.length > 0);
      batch.push({ id, change });
    }
    if (!writeBatch()) return;
    this.scheduleFlush(connection, 0);
  }

  private enqueueResync(
    connection: Connection,
    reason: PushResyncPayload["reason"],
    topics: string[],
  ): void {
    if (!connection.pendingResync) connection.pendingResync = { reason, topics: new Set() };
    for (const topic of topics) connection.pendingResync.topics.add(topic);
    for (const [id, pending] of Array.from(connection.pending)) {
      if (connection.pendingResync.topics.has(pending.topic)) this.dropPending(connection, id);
    }
    this.scheduleFlush(connection, 0);
  }

  /** Numbers and writes one frame; a refused write means the connection is gone. */
  private writeFrame(connection: Connection, event: string, build: (seq: number) => unknown) {
    if (connection.closed) return false;
    const seq = connection.seq + 1;
    let written = false;
    const payload = build(seq);
    try {
      written = connection.sink.write(event, payload);
    } catch (error) {
      log.warn("frame.write-failed", { error: formatLogError(error) });
    }
    // The number is spent either way: a frame that may have reached the
    // socket must not be reused, and a gap is what tells the client.
    connection.seq = seq;
    if (!written) {
      this.closeConnection(connection.streamId);
      return false;
    }
    this.counters.framesSent += 1;
    this.counters.frameBytes += pushUtf8Bytes(formatPushFrame(event, payload));
    return true;
  }
}
