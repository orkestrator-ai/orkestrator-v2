import { GatewayEventStreamState } from "./gateway-event-stream.js";
import { relayedNodeEventNodeId, type RelayedNodeEvent } from "./node-events.js";
import type { ReconnectBackoff } from "./reconnect-backoff.js";

/** How long a filter narrowing waits for its siblings. */
export const RELAYED_FILTER_NARROW_DELAY_MS = 50;

export interface RelayedEventConnection {
  close(): void;
}

export interface RelayedEventConnectionHandlers {
  onOpen: () => void;
  onMessage: (data: string, lastEventId: string | null) => void;
  /** The connection failed or ended by itself; `close()` reports nothing. */
  onError: () => void;
}

export interface RelayedEventStreamOptions {
  open(
    events: readonly string[],
    since: string | null,
    handlers: RelayedEventConnectionHandlers,
  ): RelayedEventConnection;
  deliver(event: string, payload: unknown): void;
  backoff: ReconnectBackoff;
}

interface RelayedEventEntry {
  ready: Promise<void>;
  resolveReady: () => void;
}

/**
 * The one stream carrying the relayed events of every node this client watches:
 * a renderer on the gateway transport, or the desktop's main process for the
 * windows it relays to.
 *
 * It has its own cursor over the gateway's relayed window, so changing the filter
 * costs nothing but the reopen: the replacement resumes from that cursor and
 * replays whatever arrived during the swap. When the window cannot cover a gap
 * the gateway says so, and each watched node gets the same `resync` frame the
 * relay itself sends: nothing else in the client has to reconcile.
 */
export class RelayedEventStream {
  private readonly entries = new Map<string, RelayedEventEntry>();
  private state = new GatewayEventStreamState();
  private connection: RelayedEventConnection | null = null;
  private subscribed: string[] | null = null;
  /** What the last connection was opened for, kept across its failure. */
  private carried: ReadonlySet<string> = new Set();
  private connectionOpen = false;
  private refreshQueued = false;
  private narrowTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: RelayedEventStreamOptions) {}

  add(event: string): void {
    if (this.entries.has(event)) return;
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.entries.set(event, { ready, resolveReady });
    this.refresh();
  }

  remove(event: string): void {
    const entry = this.entries.get(event);
    if (!entry) return;
    entry.resolveReady();
    this.entries.delete(event);
    this.refresh({ defer: true });
  }

  /** Settles once the stream carrying this event is open. */
  ready(event: string): Promise<void> {
    return this.entries.get(event)?.ready ?? Promise.resolve();
  }

  /** The link dropped without telling anyone. */
  dropConnection(): void {
    if (!this.connection) return;
    this.closeConnection();
    this.scheduleReconnect();
  }

  /** The gateway is reachable again, so an attempt still unanswered is on a dead link. */
  retryUnanswered(): void {
    if (!this.connection || this.connectionOpen) return;
    this.closeConnection();
    this.refresh();
  }

  /** Something says the gateway may be back: stop waiting out the backoff. */
  retryWaiting(): void {
    if (!this.reconnectTimer) return;
    this.clearReconnect();
    this.refresh();
  }

  /**
   * Replace the connection now (the client's credential changed): the open
   * one, or one waiting out its backoff. The replacement resumes from the
   * cursor, and the swap counts as no failure.
   */
  reopen(): void {
    if (this.disposed) return;
    if (!this.connection && !this.reconnectTimer) return;
    this.clearReconnect();
    if (this.connection) {
      this.options.backoff.disconnected();
      this.closeConnection();
    }
    this.refresh();
  }

  /** The backend may not be the same process: the next open starts fresh and resyncs. */
  forgetCursor(): void {
    this.state = new GatewayEventStreamState();
  }

  dispose(): void {
    this.disposed = true;
    if (this.narrowTimer) clearTimeout(this.narrowTimer);
    this.narrowTimer = null;
    this.clearReconnect();
    this.closeConnection();
    for (const entry of this.entries.values()) entry.resolveReady();
    this.entries.clear();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private closeConnection(): void {
    this.connection?.close();
    this.connection = null;
    this.subscribed = null;
    this.connectionOpen = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.refresh();
    }, this.options.backoff.nextDelayMs());
  }

  private latchReady(): void {
    for (const entry of this.entries.values()) entry.resolveReady();
  }

  /** Widening is urgent, since a new node has no events until the stream carries it. */
  private refresh(refresh: { defer?: boolean } = {}): void {
    if (this.disposed) return;
    if (refresh.defer) {
      if (this.refreshQueued || this.narrowTimer) return;
      this.narrowTimer = setTimeout(() => {
        this.narrowTimer = null;
        this.refresh();
      }, RELAYED_FILTER_NARROW_DELAY_MS);
      this.narrowTimer.unref?.();
      return;
    }
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    if (this.narrowTimer) {
      clearTimeout(this.narrowTimer);
      this.narrowTimer = null;
    }
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (!this.disposed) this.applyFilter();
    });
  }

  private applyFilter(): void {
    const events = [...this.entries.keys()].sort();
    if (
      this.connection &&
      this.subscribed?.length === events.length &&
      this.subscribed.every((event, index) => event === events[index])
    ) {
      if (this.connectionOpen) this.latchReady();
      return;
    }
    // A dead stream waiting out its backoff is rebuilt early only for a node it
    // did not carry: narrowing, or repeating the filter, waits for the ladder.
    if (
      !this.connection &&
      this.reconnectTimer &&
      events.length > 0 &&
      events.every((event) => this.carried.has(event))
    ) {
      return;
    }

    this.clearReconnect();
    if (this.connection) {
      this.options.backoff.disconnected();
      this.closeConnection();
    }
    if (events.length === 0) {
      // A later watch starts a fresh stream, not the tail of this one.
      this.options.backoff.reset();
      this.state = new GatewayEventStreamState();
      this.carried = new Set();
      return;
    }

    const connection: RelayedEventConnection = this.options.open(events, this.state.cursor, {
      onOpen: () => {
        if (this.connection !== connection) return;
        this.connectionOpen = true;
        this.options.backoff.connected();
        this.latchReady();
      },
      onMessage: (data, lastEventId) => {
        if (this.connection === connection) this.acceptFrame(data, lastEventId);
      },
      onError: () => {
        if (this.connection !== connection) return;
        this.closeConnection();
        this.scheduleReconnect();
      },
    });
    this.connection = connection;
    this.subscribed = events;
    this.carried = new Set(events);
  }

  private acceptFrame(data: string, lastEventId: string | null): void {
    const message = this.state.accept(data, lastEventId);
    if (message.kind === "event") {
      this.options.deliver(message.event, message.payload);
    } else if (message.kind === "resync") {
      // A fresh stream counts too. A view that gave up waiting for it read before
      // it opened, so what happened in between is only recovered this way.
      for (const event of Array.from(this.entries.keys())) {
        const nodeId = relayedNodeEventNodeId(event);
        if (!nodeId) continue;
        const frame: RelayedNodeEvent = { nodeId, kind: "resync" };
        this.options.deliver(event, frame);
      }
    }
  }
}
