/**
 * Client controller for the push event layer, shared by every client that
 * reads a gateway event stream (docs/architecture/push-events.md).
 *
 * It owns one connection's subscription set and turns frames into change
 * notifications for the views that subscribed. It never reads data itself:
 * a listener is told that a key moved (and which parts) and reads through its
 * own conditional read.
 *
 * States:
 *
 * - `connecting`: no `gateway.connected` frame yet.
 * - `unavailable`: the stream offers no push (an older backend, a transport
 *   that cannot carry it) or the backend refused the stream. Views poll.
 * - `snapshotting`: a set was sent for this stream and has not been answered.
 * - `live`: the newest set was answered and no frame was lost since.
 * - `recovering`: the stream dropped, a `seq` gap or `push.resync` arrived, or
 *   the set call failed. Views poll at their old cadence until `live` again.
 * - `closed`: disposed.
 *
 * A key is healthy only while the client is `live` and the newest answer said
 * `ok` for it. An unhealthy key's view keeps its pre-push cadence, so a broken
 * channel degrades to the old behaviour, never worse. Nothing here infers
 * that work completed from a transport closing: a closed stream only makes a
 * key unhealthy.
 *
 * Relayed nodes (design D10): a client built with `nodeId` holds a window's
 * set for that node on its command node's stream. It sends its set with
 * `nodeId` only to a stream whose offer says `nodes: true` (otherwise it is
 * `unavailable`), acts only on changes and resyncs naming its node, and
 * still checks every frame's `seq`, since the stream's numbering is shared
 * by every namespace on it. Its keys are healthy only while the command node
 * answers them; a command node that cannot reach the node now answers
 * `refused` / `unavailable`, which this client retries with backoff.
 *
 * Browser-safe.
 */
import {
  PUSH_CHANGED_EVENT,
  PUSH_RESYNC_EVENT,
  parsePushChangedPayload,
  parsePushResyncPayload,
  pushSubscriptionId,
  type PushSetSubscriptionsArgs,
  type PushSetSubscriptionsResult,
  type PushStamp,
  type PushStreamOffer,
} from "./push-events.js";

export type PushClientState =
  "connecting" | "unavailable" | "snapshotting" | "live" | "recovering" | "closed";

export type PushChangeReason =
  /** A `push.changed` frame named the key. */
  | "frame"
  /** The first answer for a new subscription: read once, it covers the mount read's race. */
  | "subscribed"
  /** A later answer's stamp moved past what the client held (reconnect, gap, restart). */
  | "resubscribed"
  /** `push.resync` named the key's topic. */
  | "resync";

export interface PushKeyChange {
  topic: string;
  key: string;
  /** The parts that moved, or `null` for "read everything". */
  parts: readonly string[] | null;
  reason: PushChangeReason;
}

export type PushKeyListener = (change: PushKeyChange) => void;

export interface PushClientDiagnostics {
  state: PushClientState;
  subscriptions: number;
  framesReceived: number;
  changesReceived: number;
  changesIgnored: number;
  duplicateFrames: number;
  seqGaps: number;
  resyncs: number;
  setCalls: number;
  setFailures: number;
  frameProcessingMs: number;
  observationSamples: number;
  observationMs: number;
  maxObservationMs: number;
  refusals: number;
  /** A recovery read found a change no frame announced, by topic. */
  recoveryFoundChange: Record<string, number>;
}

export interface PushClientTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PushSubscriptionClientOptions {
  setSubscriptions(
    args: PushSetSubscriptionsArgs,
    signal: AbortSignal,
  ): Promise<PushSetSubscriptionsResult>;
  timers?: PushClientTimers;
  /** Delay that batches several mounts into one set call. */
  batchMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  /** First retry after a failed set call; doubles to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Reports listener failures; the controller never throws into a transport. */
  onListenerError?: (error: unknown) => void;
  /**
   * The relayed node this set is for (design D10); the stream is the command
   * node's. Absent: the stream's own backend.
   */
  nodeId?: string;
  /** Shares revision ordering with a replacement client on the same stream. */
  nextSetRevision?: (previous: number) => number;
}

interface Entry {
  topic: string;
  key: string;
  listeners: Set<PushKeyListener>;
  stamp: PushStamp | null;
  /** The newest applied answer's verdict for this key, on the current stream. */
  status: "pending" | "ok" | "denied" | "missing";
}

const defaultTimers: PushClientTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PushSubscriptionClient {
  private readonly entries = new Map<string, Entry>();
  private readonly healthListeners = new Set<() => void>();
  private readonly timers: PushClientTimers;
  private readonly batchMs: number;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private stateValue: PushClientState = "connecting";
  private streamId: string | null = null;
  private lastSeq = 0;
  private setRevision = 0;
  private inFlight: AbortController | null = null;
  private missingRetryTimer: unknown = null;
  private missingRetryDelay: number;
  private dirty = false;
  private paused = false;
  private sendTimer: unknown = null;
  private retryDelay: number;
  private readonly counters = {
    framesReceived: 0,
    changesReceived: 0,
    changesIgnored: 0,
    duplicateFrames: 0,
    seqGaps: 0,
    resyncs: 0,
    setCalls: 0,
    setFailures: 0,
    frameProcessingMs: 0,
    observationSamples: 0,
    observationMs: 0,
    maxObservationMs: 0,
    refusals: 0,
  };
  private readonly recoveryFoundChange = new Map<string, number>();

  constructor(private readonly options: PushSubscriptionClientOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.batchMs = options.batchMs ?? 0;
    this.now = options.now ?? (() => performance.now());
    this.retryMs = options.retryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
    this.retryDelay = this.retryMs;
    this.missingRetryDelay = this.retryMs;
  }

  state(): PushClientState {
    return this.stateValue;
  }

  /** The stream this controller's set belongs to, if push is offered. */
  currentStreamId(): string | null {
    return this.streamId;
  }

  /**
   * Subscribe to one key. The listener hears every change of it until the
   * returned stop is called; the last stop removes the key from the set.
   */
  subscribe(topic: string, key: string, listener: PushKeyListener): () => void {
    if (this.stateValue === "closed") return () => undefined;
    const id = pushSubscriptionId(topic, key);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { topic, key, listeners: new Set(), stamp: null, status: "pending" };
      this.entries.set(id, entry);
      this.markDirty();
    }
    entry.listeners.add(listener);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const current = this.entries.get(id);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      this.entries.delete(id);
      this.markDirty();
      this.notifyHealth();
    };
  }

  /** Whether a view of this key may rely on frames and use the recovery poll. */
  isHealthy(topic: string, key: string): boolean {
    if (this.stateValue !== "live" || this.paused) return false;
    return this.entries.get(pushSubscriptionId(topic, key))?.status === "ok";
  }

  onHealthChange(listener: () => void): () => void {
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  /**
   * A new connection opened (every `gateway.connected`, fresh or resumed).
   * A new stream starts a new `seq` space; the whole set is sent again.
   */
  streamConnected(streamOffer: PushStreamOffer | null): void {
    if (this.stateValue === "closed") return;
    this.resetRequest();
    // A node set goes only to a backend that says it takes one.
    const offer = this.options.nodeId !== undefined && !streamOffer?.nodes ? null : streamOffer;
    if (!offer) {
      this.streamId = null;
      this.lastSeq = 0;
      this.resetStatuses();
      this.setState("unavailable");
      return;
    }
    const replaced = offer.streamId !== this.streamId;
    this.streamId = offer.streamId;
    if (replaced) {
      this.lastSeq = 0;
      this.resetStatuses();
    }
    this.retryDelay = this.retryMs;
    if (this.entries.size === 0 && !this.paused) this.setState("live");
    else if (this.stateValue !== "recovering") this.setState("snapshotting");
    this.dirty = true;
    this.scheduleSend(0);
  }

  /** The stream dropped. Keys stay subscribed locally; views fall back until it returns. */
  streamDisconnected(): void {
    if (this.stateValue === "closed" || this.stateValue === "unavailable") return;
    if (this.streamId === null) return;
    this.streamId = null;
    this.resetRequest();
    this.setState("recovering");
  }

  /**
   * While paused (a hidden document) the set sent is empty, so the backend
   * observes nothing for this window. Resuming sends the set again; the
   * answer's stamps say what moved meanwhile.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused || this.stateValue === "closed") return;
    this.paused = paused;
    if (!paused) {
      for (const entry of this.entries.values()) entry.status = "pending";
      if (this.streamId && this.stateValue !== "unavailable") this.setState("snapshotting");
    }
    this.markDirty();
    this.notifyHealth();
  }

  /** A frame from the stream. Returns whether it was a push frame. */
  accept(event: string, payload: unknown): boolean {
    if (event === PUSH_CHANGED_EVENT) {
      const started = this.now();
      const frame = parsePushChangedPayload(payload);
      if (!frame || !this.acceptSeq(frame.seq)) return true;
      this.counters.framesReceived += 1;
      for (const change of frame.changes) {
        // Another namespace's change on the shared stream (design D10).
        if (change.nodeId !== this.options.nodeId) continue;
        this.counters.changesReceived += 1;
        const entry = this.entries.get(pushSubscriptionId(change.topic, change.key));
        if (!entry || !this.advanceStamp(entry, change)) {
          this.counters.changesIgnored += 1;
          continue;
        }
        this.emit(entry, {
          topic: entry.topic,
          key: entry.key,
          parts: change.parts.length > 0 ? change.parts : null,
          reason: "frame",
        });
      }
      this.counters.frameProcessingMs += this.now() - started;
      return true;
    }
    if (event === PUSH_RESYNC_EVENT) {
      const started = this.now();
      const frame = parsePushResyncPayload(payload);
      if (!frame || !this.acceptSeq(frame.seq)) return true;
      // Another node's resync: only its `seq` concerns this client.
      if (frame.nodeId !== undefined && frame.nodeId !== this.options.nodeId) return true;
      if (frame.nodeId !== undefined && !this.inFlight) {
        // The command node's view of the node changed (it came back, or its
        // stream was replaced): try now rather than after the backoff.
        this.cancelSend();
        this.retryDelay = this.retryMs;
      }
      this.counters.resyncs += 1;
      for (const entry of Array.from(this.entries.values())) {
        if (frame.topics !== "all" && !frame.topics.includes(entry.topic)) continue;
        this.emit(entry, { topic: entry.topic, key: entry.key, parts: null, reason: "resync" });
      }
      this.recover();
      this.counters.frameProcessingMs += this.now() - started;
      return true;
    }
    return false;
  }

  /** A view's recovery-poll read found a change no frame announced (design D8). */
  noteRecoveryReadFoundChange(topic: string): void {
    this.recoveryFoundChange.set(topic, (this.recoveryFoundChange.get(topic) ?? 0) + 1);
  }

  /** A frame-triggered local read ran through projection application. */
  noteObservationApplied(elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.counters.observationSamples += 1;
    this.counters.observationMs += elapsedMs;
    this.counters.maxObservationMs = Math.max(this.counters.maxObservationMs, elapsedMs);
  }

  diagnostics(): PushClientDiagnostics {
    return {
      state: this.stateValue,
      subscriptions: this.entries.size,
      ...this.counters,
      recoveryFoundChange: Object.fromEntries(this.recoveryFoundChange),
    };
  }

  dispose(): void {
    if (this.stateValue === "closed") return;
    const streamId = this.streamId;
    const nodeId = this.options.nodeId;
    this.resetRequest();
    if (nodeId !== undefined && streamId !== null && this.setRevision > 0) {
      // This stream belongs to the command scope and can outlive this client.
      // The replacement shares the allocator, so this release cannot clear it.
      const setRevision = this.nextSetRevision();
      void this.options
        .setSubscriptions(
          { streamId, nodeId, setRevision, subscriptions: [] },
          AbortSignal.timeout(10_000),
        )
        .catch(() => undefined);
    }
    this.streamId = null;
    this.entries.clear();
    this.setState("closed");
    this.healthListeners.clear();
  }

  // -------------------------------------------------------------------------

  /** Checks contiguity. Returns false for a duplicate that must be ignored. */
  private acceptSeq(seq: number): boolean {
    if (this.streamId === null) return false;
    if (seq <= this.lastSeq) {
      this.counters.duplicateFrames += 1;
      return false;
    }
    const gap = seq > this.lastSeq + 1;
    this.lastSeq = seq;
    if (gap) {
      this.counters.seqGaps += 1;
      this.recover();
      // The next partial frame can advance the same key to the stamp the
      // replacement set returns. Invalidate every part before applying it.
      for (const entry of Array.from(this.entries.values())) {
        this.emit(entry, { topic: entry.topic, key: entry.key, parts: null, reason: "resync" });
      }
    }
    return true;
  }

  /** Whether a change is news for this entry; advances its stamp when it is. */
  private advanceStamp(entry: Entry, stamp: PushStamp): boolean {
    const held = entry.stamp;
    if (held && held.generation === stamp.generation && stamp.revision <= held.revision) {
      return false;
    }
    entry.stamp = { generation: stamp.generation, revision: stamp.revision };
    return true;
  }

  private recover(): void {
    if (this.stateValue !== "unavailable" && this.stateValue !== "closed") {
      this.setState("recovering");
    }
    this.dirty = true;
    this.scheduleSend(0);
  }

  private resetStatuses(): void {
    for (const entry of this.entries.values()) entry.status = "pending";
    this.notifyHealth();
  }

  private markDirty(): void {
    this.dirty = true;
    this.scheduleSend(this.batchMs);
  }

  private scheduleSend(delayMs: number): void {
    if (this.streamId === null || this.stateValue === "unavailable") return;
    if (this.stateValue === "closed" || this.inFlight || this.sendTimer !== null) return;
    this.sendTimer = this.timers.setTimeout(() => {
      this.sendTimer = null;
      void this.send();
    }, delayMs);
  }

  private cancelSend(): void {
    if (this.sendTimer !== null) this.timers.clearTimeout(this.sendTimer);
    this.sendTimer = null;
  }

  private resetRequest(): void {
    this.cancelSend();
    if (this.missingRetryTimer !== null) this.timers.clearTimeout(this.missingRetryTimer);
    this.missingRetryTimer = null;
    this.missingRetryDelay = this.retryMs;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private retryMissing(): void {
    if (this.missingRetryTimer !== null || this.paused) return;
    if (!Array.from(this.entries.values()).some((entry) => entry.status === "missing")) {
      this.missingRetryDelay = this.retryMs;
      return;
    }
    this.missingRetryTimer = this.timers.setTimeout(() => {
      this.missingRetryTimer = null;
      if (
        !this.paused &&
        Array.from(this.entries.values()).some((entry) => entry.status === "missing")
      ) {
        this.markDirty();
      }
    }, this.missingRetryDelay);
    this.missingRetryDelay = Math.min(this.maxRetryMs, this.missingRetryDelay * 2);
  }

  private nextSetRevision(): number {
    this.setRevision = this.options.nextSetRevision?.(this.setRevision) ?? this.setRevision + 1;
    return this.setRevision;
  }

  private async send(): Promise<void> {
    const streamId = this.streamId;
    if (!streamId || !this.dirty || this.inFlight || this.stateValue === "closed") return;
    this.dirty = false;
    const request = new AbortController();
    this.inFlight = request;
    const setRevision = this.nextSetRevision();
    const sent = this.paused ? [] : Array.from(this.entries.values());
    this.counters.setCalls += 1;
    let result: PushSetSubscriptionsResult | null = null;
    let finishCancelled: () => void = () => undefined;
    const cancelled = new Promise<null>((resolve) => {
      finishCancelled = () => resolve(null);
      request.signal.addEventListener("abort", finishCancelled, { once: true });
    });
    const timeout = this.timers.setTimeout(
      () => request.abort(),
      this.options.requestTimeoutMs ?? 10_000,
    );
    try {
      result = await Promise.race([
        this.options.setSubscriptions(
          {
            streamId,
            setRevision,
            subscriptions: sent.map((entry) => ({ topic: entry.topic, key: entry.key })),
            ...(this.options.nodeId === undefined ? {} : { nodeId: this.options.nodeId }),
          },
          request.signal,
        ),
        cancelled,
      ]);
    } catch {
      // The current request will retry below.
    } finally {
      this.timers.clearTimeout(timeout);
      request.signal.removeEventListener("abort", finishCancelled);
    }
    if (this.inFlight !== request) return;
    this.inFlight = null;
    if (!result) {
      this.counters.setFailures += 1;
      this.setState("recovering");
      this.dirty = true;
      const delay = this.retryDelay;
      this.retryDelay = Math.min(this.maxRetryMs, this.retryDelay * 2);
      this.scheduleSend(delay);
      return;
    }
    if (result.status === "refused") {
      this.counters.refusals += 1;
      this.resetStatuses();
      if (this.options.nodeId !== undefined && result.reason === "unavailable") {
        // The command node cannot reach the node's push now (not connected,
        // an older node). Views poll; the set is tried again with backoff.
        this.setState("recovering");
        this.dirty = true;
        const delay = this.retryDelay;
        this.retryDelay = Math.min(this.maxRetryMs, this.retryDelay * 2);
        this.scheduleSend(delay);
        return;
      }
      this.retryDelay = this.retryMs;
      this.setState("unavailable");
      return;
    }
    this.retryDelay = this.retryMs;
    if (result.status === "superseded") {
      // Only this controller writes the set, so a newer revision means a
      // previous process of ours did; send again with one past it.
      this.setRevision = Math.max(this.setRevision, result.setRevision);
      this.dirty = true;
      this.scheduleSend(0);
      return;
    }
    if (result.setRevision !== setRevision) return;
    const answered = new Map(
      result.subscriptions.map((answer) => [pushSubscriptionId(answer.topic, answer.key), answer]),
    );
    for (const entry of Array.from(this.entries.values())) {
      const answer = answered.get(pushSubscriptionId(entry.topic, entry.key));
      if (!answer) continue;
      if (answer.status !== "ok") {
        entry.status = answer.status;
        continue;
      }
      const first = entry.stamp === null;
      const moved = this.advanceStamp(entry, answer);
      entry.status = "ok";
      if (first || moved) {
        this.emit(entry, {
          topic: entry.topic,
          key: entry.key,
          parts: null,
          reason: first ? "subscribed" : "resubscribed",
        });
      }
    }
    if (this.dirty) {
      this.scheduleSend(0);
      return;
    }
    this.setState("live");
    this.notifyHealth();
    this.retryMissing();
  }

  private emit(entry: Entry, change: PushKeyChange): void {
    for (const listener of Array.from(entry.listeners)) {
      try {
        listener(change);
      } catch (error) {
        this.options.onListenerError?.(error);
      }
    }
  }

  private setState(next: PushClientState): void {
    if (this.stateValue === next) return;
    this.stateValue = next;
    this.notifyHealth();
  }

  private notifyHealth(): void {
    for (const listener of Array.from(this.healthListeners)) {
      try {
        listener();
      } catch (error) {
        this.options.onListenerError?.(error);
      }
    }
  }
}
