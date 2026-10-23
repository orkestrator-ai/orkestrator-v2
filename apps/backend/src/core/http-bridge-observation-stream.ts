import {
  GATEWAY_EVENT_CURSOR_PARAM,
  readSseStream,
  type SseFrame,
} from "@orkestrator/protocol/gateway-event-stream";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";
import type { BridgeConnection } from "./agent-provider-contract.js";
import { bridgeEventStreamFetch } from "./http-bridge-transport.js";

/**
 * The backend's subscription to an HTTP bridge's own event stream, as the
 * idle wakeup for the activity observer (0049 code item 1).
 *
 * The activity sweep reads every HTTP-bridge group every 2 s. A stably idle
 * group may read less often only while something reports work started by
 * anyone else (`NativeAgentObservationCapabilities.idleBackoffWakeup`). The
 * Claude and Codex bridges already publish every session change on
 * `GET /event/subscribe`, with a bounded replay ring and a cursor, so this
 * subscribes once per bridge connection and turns frames into content-free
 * hints. Hints only make a group due; they are never applied as activity, and
 * the sweep's no-touch read stays the only source of truth.
 *
 * - **Live** only between a `connected` frame and the next gap, and only while
 *   some frame (a keepalive at worst) arrived within
 *   {@link BRIDGE_OBSERVATION_STREAM_SILENCE_MS}. A half-open connection
 *   therefore stops qualifying the group for backoff and is reconnected.
 * - **Replay.** Reconnects resume from the last frame id (`?since=`). Every
 *   connect, a `replay.required` (Claude) and a `session.reconcile-required`
 *   without a session (Codex, cursor expired) hint every session: whatever
 *   was missed is re-read by the next sweep. A bridge restart ends the
 *   stream and reads the same way.
 * - **Observation mode.** The stream is opened with `?observe=1`: the bridge
 *   sends each event's type, cursor and session id, never its payload, and
 *   does not keep its replay ring alive for this subscriber. A bridge that
 *   does not confirm the mode in its `connected` frame predates it; the
 *   subscription is closed for good rather than pulling every full message
 *   snapshot, and the group keeps the full sweep cadence.
 * - **Bounds.** One connection per bridge, frames bounded by the shared SSE
 *   decoder, reconnects backed off with jitter, and only a session id read
 *   from each frame's prefix: no payload is parsed or retained.
 *
 * Cursor, Pi and Grok bridges publish no event stream; their groups keep the
 * full sweep cadence.
 */

/** Bridges whose `/event/subscribe` this backend consumes. */
export const BRIDGE_OBSERVATION_STREAM_AGENTS: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * Longest silence a live stream may have. Both bridges send a keepalive at
 * least every 30 s (Codex every 5 s while a session is active), so 2.5 of
 * the longest interval means the connection is gone, not quiet.
 */
export const BRIDGE_OBSERVATION_STREAM_SILENCE_MS = 75_000;

/** Frames that change nothing a session observer reads. */
const TRANSPORT_EVENTS: ReadonlySet<string> = new Set(["keepalive", "bridge.cursor"]);

/** Frames that mean the stream lost continuity for every session. */
const GAP_EVENTS: ReadonlySet<string> = new Set(["replay.required"]);

/** Bytes of a frame's data searched for its session id. */
const SESSION_ID_PREFIX_BYTES = 2_048;
const SESSION_ID_PREFIX = /^\{"sessionId":"((?:[^"\\]|\\.){1,1024})"/;

export interface HttpBridgeObservationStreamOptions {
  connection: BridgeConnection;
  fetchImpl?: typeof fetch;
  /** A session (`sessionId`) or every session (`undefined`) may have changed. */
  hint?: (sessionId: string | undefined) => void;
  now?: () => number;
  random?: () => number;
  /** Reconnect ladder; the defaults match the backend's other stream clients. */
  retryInitialMs?: number;
  retryMaxMs?: number;
  silenceMs?: number;
}

export class HttpBridgeObservationStream {
  private live = false;
  private closed = false;
  private started = false;
  private lastFrameAt = 0;
  private cursor: string | null = null;
  private connection: AbortController | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly backoff: ReconnectBackoff;
  private readonly now: () => number;
  private readonly silenceMs: number;
  private connects = 0;
  private gaps = 0;
  private unsupported = false;

  constructor(private readonly options: HttpBridgeObservationStreamOptions) {
    this.now = options.now ?? Date.now;
    this.silenceMs = Math.max(1, options.silenceMs ?? BRIDGE_OBSERVATION_STREAM_SILENCE_MS);
    this.backoff = new ReconnectBackoff(
      {
        initialDelayMs: Math.max(1, options.retryInitialMs ?? 1_000),
        maxDelayMs: Math.max(1, options.retryMaxMs ?? 30_000),
        healthyAfterMs: 30_000,
      },
      { now: this.now, ...(options.random ? { random: options.random } : {}) },
    );
  }

  /** Connected, not reset since, and heard from recently. */
  get isLive(): boolean {
    return this.live && !this.closed && this.now() - this.lastFrameAt <= this.silenceMs;
  }

  /** Content-free counters for tests and diagnostics. */
  stats(): { connects: number; gaps: number; cursor: string | null; unsupported: boolean } {
    return {
      connects: this.connects,
      gaps: this.gaps,
      cursor: this.cursor,
      unsupported: this.unsupported,
    };
  }

  /** Start the subscription once; later calls are no-ops. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.run().catch(() => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.live = false;
    this.connection?.abort();
    this.connection = null;
    this.stopWatchdog();
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      const connection = new AbortController();
      this.connection = connection;
      try {
        const path =
          "/event/subscribe?observe=1" +
          (this.cursor ? `&${GATEWAY_EVENT_CURSOR_PARAM}=${encodeURIComponent(this.cursor)}` : "");
        const response = await bridgeEventStreamFetch(
          this.options.connection,
          path,
          connection.signal,
          this.options.fetchImpl,
        );
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`bridge event stream answered HTTP ${response.status}`);
        }
        this.lastFrameAt = this.now();
        this.startWatchdog(connection);
        await readSseStream(response.body, connection.signal, (frame) =>
          this.accept(frame, connection),
        );
      } catch {
        // Every failure reads the same: not live, and reconnect.
      }
      if (this.connection === connection) this.connection = null;
      this.lost();
      if (this.closed) return;
      await this.delay(this.backoff.nextDelayMs());
    }
  }

  private accept(frame: SseFrame, connection: AbortController): void {
    if (this.closed || this.connection !== connection) return;
    this.lastFrameAt = this.now();
    if (frame.id) this.cursor = frame.id;
    const event = frame.event ?? "message";
    if (event === "connected") {
      if (!frame.data?.includes('"observe":true')) {
        // An older bridge would stream every full payload to this observer.
        this.unsupported = true;
        this.close();
        return;
      }
      this.live = true;
      this.connects += 1;
      this.backoff.connected();
      // Whatever happened while disconnected is re-read once.
      this.notify(undefined);
      return;
    }
    if (TRANSPORT_EVENTS.has(event)) return;
    const sessionId = frameSessionId(frame.data);
    if (GAP_EVENTS.has(event) || (event === "session.reconcile-required" && !sessionId)) {
      this.gaps += 1;
      this.notify(undefined);
      return;
    }
    this.notify(sessionId);
  }

  private lost(): void {
    const wasLive = this.live;
    this.live = false;
    this.stopWatchdog();
    if (wasLive && !this.closed) this.notify(undefined);
  }

  /**
   * Abort a connection that has gone silent, so `run` reconnects it. One
   * interval per connection rather than a timer re-armed on every frame: a
   * streaming turn can emit hundreds of frames a second.
   */
  private startWatchdog(connection: AbortController): void {
    this.stopWatchdog();
    this.watchdog = setInterval(
      () => {
        if (this.connection !== connection) return;
        if (this.now() - this.lastFrameAt > this.silenceMs) connection.abort();
      },
      Math.max(1, Math.floor(this.silenceMs / 3)),
    );
    (this.watchdog as { unref?: () => void }).unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private notify(sessionId: string | undefined): void {
    if (this.closed || !this.options.hint) return;
    try {
      this.options.hint(sessionId);
    } catch {
      // A failed hint only costs latency; the sweep still runs.
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as { unref?: () => void }).unref?.();
    });
  }
}

/**
 * One HTTP bridge provider's idle wakeup. The stream opens on the activity
 * observer's first ask, so only a provider the sweep reads holds a
 * subscription, and never after the provider was disposed (a sweep may still
 * hold a retired provider). Only Claude and Codex bridges, and only with a
 * hint sink to report to.
 */
export class HttpBridgeObservationWakeup {
  private stream: HttpBridgeObservationStream | null = null;
  private closed = false;

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
    private readonly hint?: (sessionId: string | undefined) => void,
  ) {}

  /** Whether the group may back off now; opens the stream on first ask. */
  live(): boolean {
    if (this.closed || !this.hint || !BRIDGE_OBSERVATION_STREAM_AGENTS.has(this.connection.agent)) {
      return false;
    }
    if (!this.stream) {
      this.stream = new HttpBridgeObservationStream({
        connection: this.connection,
        fetchImpl: this.fetchImpl,
        hint: this.hint,
      });
      this.stream.start();
    }
    return this.stream.isLive;
  }

  close(): void {
    this.closed = true;
    this.stream?.close();
  }
}

/**
 * The session a frame names. Both bridges serialize `sessionId` first, so
 * only a bounded prefix is searched; a frame without one (or a larger,
 * differently shaped one) hints every session instead of being parsed.
 */
export function frameSessionId(data: string | null): string | undefined {
  if (!data) return undefined;
  const match = SESSION_ID_PREFIX.exec(data.slice(0, SESSION_ID_PREFIX_BYTES));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}
