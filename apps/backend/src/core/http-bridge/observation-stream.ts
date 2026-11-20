import {
  GATEWAY_EVENT_CURSOR_PARAM,
  readSseStream,
  type SseFrame,
} from "@orkestrator/protocol/gateway-event-stream";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";
import { unrefTimers, type IntervalTimers } from "@orkestrator/protocol/timers";
import { abortableSleep } from "../abortable-timing.js";
import type { BridgeConnection } from "../agent-provider-contract.js";
import { bridgeEventStreamFetch } from "./transport.js";
import {
  bridgeObservationRevisionVersion,
  parseBridgeObservationFrame,
} from "@orkestrator/protocol/bridge-state-revision";

/**
 * The backend's subscription to an HTTP bridge's own event stream: the idle
 * wakeup for the activity observer (0049 code item 1) and the change signal
 * of the push layer's `native-session` observer (to-do 8102 task 2, D7).
 *
 * Every managed bridge (Claude, Codex, Cursor, Pi, ACP/Grok) publishes its
 * session changes on `GET /event/subscribe?observe=1`, with a cursor, so this
 * subscribes once per bridge connection and turns frames into content-free,
 * per-session hints. Hints only make a read due; they are never applied as
 * activity or state, and the reads stay the only source of truth.
 *
 * - **Revisions.** A bridge that advertises `"revisions": 1` in its
 *   `connected` frame carries `stateRevision` and `transcriptRevision` on each
 *   frame (`@orkestrator/protocol/bridge-state-revision`). The hint names the
 *   parts that moved since the last frame for that session, and a frame that
 *   moved neither is dropped. Only such a stream is {@link revisionsLive}: the
 *   push observer then stops polling a subscribed session on a timer and reads
 *   it on these hints (with a backstop). An older bridge's frames still hint,
 *   without parts.
 * - **Live** only between a `connected` frame and the next gap, and only while
 *   some frame (a keepalive at worst) arrived within
 *   {@link BRIDGE_OBSERVATION_STREAM_SILENCE_MS}. A half-open connection
 *   therefore stops qualifying and is reconnected.
 * - **Gaps.** Reconnects send the last frame id (`?since=`). The bridges keep
 *   no replay, so a cursor that is not current gets a `replay.required`
 *   (Claude, Cursor, Pi, ACP) or a `session.reconcile-required` without a
 *   session (Codex). That, and every connect, hint every session: whatever was
 *   missed is re-read. A bridge restart ends the stream and reads the same way.
 * - **Older bridges.** A Cursor, Pi or ACP bridge that predates the stream
 *   answers 404 (or 405): the stream stops for this connection, and its
 *   sessions keep their full cadence. A bridge restart is a new connection.
 * - **Observation mode.** The stream is opened with `?observe=1`: the bridge
 *   sends each event's type, cursor, session id and revisions, never its
 *   payload, and refuses a subscription without it.
 * - **Bounds.** One connection per bridge, frames bounded by the shared SSE
 *   decoder, reconnects backed off with jitter, only a bounded prefix of each
 *   frame parsed, and the last revisions of at most
 *   {@link BRIDGE_OBSERVATION_STREAM_MAX_SESSIONS} sessions kept.
 */
/** Bridges whose `/event/subscribe` this backend consumes. */
export const BRIDGE_OBSERVATION_STREAM_AGENTS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "cursor",
  "pi",
  "grok",
]);

/** Sessions whose last frame revisions the stream remembers, to drop repeats. */
export const BRIDGE_OBSERVATION_STREAM_MAX_SESSIONS = 4_096;

/** The parts of a session a frame says moved. */
export type BridgeObservationPart = "state" | "transcript";

/**
 * A session (`sessionId`) or every session (`undefined`) may have changed.
 * `parts` names what moved, from a bridge that carries revisions; absent
 * means unknown (any part may have).
 */
export type BridgeObservationHint = (
  sessionId: string | undefined,
  parts?: readonly BridgeObservationPart[],
) => void;

/**
 * Longest silence a live stream may have. Both bridges send a keepalive
 * every 30 s, so 2.5 intervals means the connection is gone, not quiet.
 */
export const BRIDGE_OBSERVATION_STREAM_SILENCE_MS = 75_000;

/** Frames that change nothing a session observer reads. */
const TRANSPORT_EVENTS: ReadonlySet<string> = new Set(["keepalive", "bridge.cursor"]);

/** Frames that mean the stream lost continuity for every session. */
const GAP_EVENTS: ReadonlySet<string> = new Set(["replay.required"]);

export interface HttpBridgeObservationStreamOptions {
  connection: BridgeConnection;
  fetchImpl?: typeof fetch;
  hint?: BridgeObservationHint;
  now?: () => number;
  random?: () => number;
  /** Reconnect ladder; the defaults match the backend's other stream clients. */
  retryInitialMs?: number;
  retryMaxMs?: number;
  silenceMs?: number;
  /**
   * The silence watchdog's interval. Defaults to the global timers, unref'd;
   * tests pass a manual clock (with `now` read from it) and advance it.
   */
  timers?: IntervalTimers;
}

export class HttpBridgeObservationStream {
  private live = false;
  private closed = false;
  private started = false;
  private lastFrameAt = 0;
  private cursor: string | null = null;
  private connection: AbortController | null = null;
  /** Aborted by `close()`, so a pending reconnect delay ends at once. */
  private readonly stopping = new AbortController();
  private running: Promise<void> = Promise.resolve();
  private watchdog: unknown = null;
  private readonly timers: IntervalTimers;
  private readonly backoff: ReconnectBackoff;
  private readonly now: () => number;
  private readonly silenceMs: number;
  private connects = 0;
  private gaps = 0;
  private dropped = 0;
  /** The connected frame advertised revisions on every frame. */
  private revisions = false;
  /** A bridge that predates the stream: stop asking. */
  private unsupported = false;
  private readonly lastRevisions = new Map<
    string,
    { stateRevision?: string; transcriptRevision?: string }
  >();

  constructor(private readonly options: HttpBridgeObservationStreamOptions) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? unrefTimers;
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

  /** Live, and every frame carries the session's state and transcript revisions. */
  get revisionsLive(): boolean {
    return this.revisions && this.isLive;
  }

  /** The bridge answered that it serves no observe stream. */
  get isUnsupported(): boolean {
    return this.unsupported;
  }

  /** Content-free counters for tests and diagnostics. */
  stats(): {
    connects: number;
    gaps: number;
    cursor: string | null;
    revisions: boolean;
    dropped: number;
  } {
    return {
      connects: this.connects,
      gaps: this.gaps,
      cursor: this.cursor,
      revisions: this.revisions,
      dropped: this.dropped,
    };
  }

  /** Start the subscription once; later calls are no-ops. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.running = this.run().catch(() => undefined);
  }

  /** Settles once the subscription loop has exited after `close()`. */
  stopped(): Promise<void> {
    return this.running;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.live = false;
    this.connection?.abort();
    this.connection = null;
    this.stopWatchdog();
    this.stopping.abort();
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
          if (response.status === 404 || response.status === 405) {
            // An older bridge without the route: its sessions keep the cadence.
            this.unsupported = true;
            return;
          }
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
      if (this.closed || this.unsupported) return;
      await abortableSleep(this.backoff.nextDelayMs(), this.stopping.signal);
    }
  }

  private accept(frame: SseFrame, connection: AbortController): void {
    if (this.closed || this.connection !== connection) return;
    this.lastFrameAt = this.now();
    if (frame.id) this.cursor = frame.id;
    const event = frame.event ?? "message";
    if (event === "connected") {
      this.live = true;
      this.connects += 1;
      this.revisions = bridgeObservationRevisionVersion(frame.data) >= 1;
      this.lastRevisions.clear();
      this.backoff.connected();
      // Whatever happened while disconnected is re-read once.
      this.notify(undefined);
      return;
    }
    if (TRANSPORT_EVENTS.has(event)) return;
    const parsed = parseBridgeObservationFrame(frame.data);
    const sessionId = parsed.sessionId;
    if (GAP_EVENTS.has(event) || (event === "session.reconcile-required" && !sessionId)) {
      this.gaps += 1;
      this.lastRevisions.clear();
      this.notify(undefined);
      return;
    }
    if (sessionId === undefined || !this.revisions) {
      this.notify(sessionId);
      return;
    }
    const parts = this.movedParts(sessionId, parsed);
    if (parts && parts.length === 0) {
      this.dropped += 1;
      return;
    }
    this.notify(sessionId, parts);
  }

  /**
   * The parts a frame moved against the last frame for its session; `[]` when
   * neither revision moved, `undefined` when the frame carries none to compare.
   */
  private movedParts(
    sessionId: string,
    frame: { stateRevision?: string; transcriptRevision?: string },
  ): BridgeObservationPart[] | undefined {
    if (frame.stateRevision === undefined && frame.transcriptRevision === undefined) {
      this.lastRevisions.delete(sessionId);
      return undefined;
    }
    const last = this.lastRevisions.get(sessionId);
    this.lastRevisions.delete(sessionId);
    this.lastRevisions.set(sessionId, {
      ...(frame.stateRevision === undefined ? {} : { stateRevision: frame.stateRevision }),
      ...(frame.transcriptRevision === undefined
        ? {}
        : { transcriptRevision: frame.transcriptRevision }),
    });
    while (this.lastRevisions.size > BRIDGE_OBSERVATION_STREAM_MAX_SESSIONS) {
      const oldest = this.lastRevisions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.lastRevisions.delete(oldest);
    }
    if (!last) return undefined;
    const parts: BridgeObservationPart[] = [];
    if (frame.stateRevision !== last.stateRevision) parts.push("state");
    if (frame.transcriptRevision !== last.transcriptRevision) parts.push("transcript");
    return parts;
  }

  private lost(): void {
    const wasLive = this.live;
    this.live = false;
    this.revisions = false;
    this.lastRevisions.clear();
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
    this.watchdog = this.timers.setInterval(
      () => {
        if (this.connection !== connection) return;
        if (this.now() - this.lastFrameAt > this.silenceMs) connection.abort();
      },
      Math.max(1, Math.floor(this.silenceMs / 3)),
    );
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) this.timers.clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private notify(sessionId: string | undefined, parts?: readonly BridgeObservationPart[]): void {
    if (this.closed || !this.options.hint) return;
    try {
      if (parts) this.options.hint(sessionId, parts);
      else this.options.hint(sessionId);
    } catch {
      // A failed hint only costs latency; the sweep still runs.
    }
  }
}

/**
 * One HTTP bridge provider's observe stream. It opens on the first ask (the
 * activity observer's, or the push observer's), so only a provider something
 * reads holds a subscription, and never after the provider was disposed (a
 * sweep may still hold a retired provider). Only with a hint sink to report
 * to.
 */
export class HttpBridgeObservationWakeup {
  private stream: HttpBridgeObservationStream | null = null;
  private closed = false;

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
    private readonly hint?: BridgeObservationHint,
  ) {}

  /** Whether the stream is live (the activity sweep's idle backoff); opens it on first ask. */
  live(): boolean {
    return this.open()?.isLive === true;
  }

  /** Whether the stream is live and carries revisions (the push observer's signal). */
  revisionsLive(): boolean {
    return this.open()?.revisionsLive === true;
  }

  close(): void {
    this.closed = true;
    this.stream?.close();
  }

  private open(): HttpBridgeObservationStream | null {
    if (this.closed || !this.hint || !BRIDGE_OBSERVATION_STREAM_AGENTS.has(this.connection.agent)) {
      return null;
    }
    if (!this.stream) {
      this.stream = new HttpBridgeObservationStream({
        connection: this.connection,
        fetchImpl: this.fetchImpl,
        hint: this.hint,
      });
      this.stream.start();
    }
    return this.stream;
  }
}

/**
 * The session a frame names. Every bridge serializes `sessionId` first, so
 * only a bounded prefix is searched; a frame without one (or a larger,
 * differently shaped one) hints every session instead of being parsed.
 */
export function frameSessionId(data: string | null): string | undefined {
  return parseBridgeObservationFrame(data).sessionId;
}
