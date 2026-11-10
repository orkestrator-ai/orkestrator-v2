import { Duplex } from "node:stream";

import {
  PREVIEW_TUNNEL_CLIENT_PING_MS,
  PREVIEW_TUNNEL_CLOSE,
} from "@orkestrator/protocol/preview-access";
import {
  decodePreviewTunnelMuxData,
  encodePreviewTunnelMuxData,
  encodePreviewTunnelMuxFrame,
  parsePreviewTunnelMuxServerFrame,
  PREVIEW_TUNNEL_MUX,
  PREVIEW_TUNNEL_MUX_DATA_MAX_BYTES,
  PREVIEW_TUNNEL_MUX_VERSION,
  PREVIEW_TUNNEL_OFFERED_SUBPROTOCOLS,
  PREVIEW_TUNNEL_SUBPROTOCOL_V2,
  type PreviewTunnelMuxClientFrame,
} from "@orkestrator/protocol/preview-tunnel-mux";
import { PREVIEW_LIMITS, previewFailure } from "@orkestrator/protocol/preview-services";
import type { PreviewWebSocket } from "@orkestrator/protocol/node/preview-websocket";

import {
  CATEGORY_FOR_CLOSE,
  connectPreviewTunnelSocket,
  openPreviewTunnel,
  startV1Tunnel,
  type PreviewTunnelOpenOptions,
} from "./preview-tunnel-client.js";

/** A tunnelled upstream connection, on either protocol version. */
export type PreviewTunnelConnection = Duplex & { readonly openMs: number };

const WINDOW = PREVIEW_TUNNEL_MUX.windowBytes;
/**
 * Unanswered pings after which a session is dead: about 30 s at the 15 s
 * client ping, the same bound the server applies to a silent client.
 */
export const PREVIEW_TUNNEL_SESSION_MISSED_PINGS = 2;
/** Credit is returned in quarter-window batches rather than per message. */
const CREDIT_BATCH = WINDOW / 4;

function closeFailure(code: number): Error {
  return previewFailure(CATEGORY_FOR_CLOSE[code] ?? "backend-unavailable");
}

/**
 * One upstream connection on a v2 session. Writes wait for the backend's
 * credit and the shared WebSocket's drain; reads return credit once the
 * consumer has taken the bytes, so a reader that stopped (paused media)
 * stalls only this stream. `end()` half-closes; `destroy()` cancels.
 */
export class PreviewTunnelMuxStream extends Duplex {
  private sendCredit = WINDOW;
  private received = 0;
  private credited = 0;
  private closedByPeer = false;
  private pendingWrite: {
    chunk: Buffer;
    offset: number;
    callback: (error?: Error | null) => void;
  } | null = null;

  constructor(
    private readonly session: PreviewTunnelSession,
    readonly id: number,
    /** Milliseconds from asking for the connection to `OPEN_OK`, a session connect included. */
    readonly openMs: number,
  ) {
    super({ allowHalfOpen: true });
  }

  /** @internal Data from the backend. */
  receive(data: Buffer): void {
    if (this.closedByPeer || this.destroyed) return;
    if (this.received + data.length - this.credited > WINDOW) {
      this.session.violation();
      return;
    }
    this.received += data.length;
    this.push(data);
    this.returnCredit();
  }

  /** @internal */
  addCredit(bytes: number): void {
    if (this.sendCredit + bytes > WINDOW) {
      this.session.violation();
      return;
    }
    this.sendCredit += bytes;
    this.flushWrite();
  }

  /** @internal The backend half-closed its direction. */
  peerEnded(): void {
    this.push(null);
  }

  /**
   * @internal The backend released the stream. Unread bytes still drain to
   * the reader; the stream destroys itself once both sides have ended.
   */
  peerClosed(): void {
    if (this.closedByPeer) return;
    this.closedByPeer = true;
    this.session.forget(this.id);
    this.push(null);
    this.flushWrite();
    if (!this.writableEnded) this.end();
  }

  /** @internal Resume a write waiting for the WebSocket to drain. */
  flushWrite(): void {
    const write = this.pendingWrite;
    if (!write) return;
    if (this.closedByPeer) {
      // The upstream is gone, as for a socket whose peer closed: drop it.
      this.pendingWrite = null;
      write.callback();
      return;
    }
    if (!this.session.isOpen) {
      this.pendingWrite = null;
      write.callback(
        previewFailure("backend-unavailable", { message: "The preview tunnel closed." }),
      );
      return;
    }
    while (write.offset < write.chunk.length) {
      if (this.sendCredit <= 0 || this.session.blocked) return;
      const size = Math.min(
        PREVIEW_TUNNEL_MUX_DATA_MAX_BYTES,
        this.sendCredit,
        write.chunk.length - write.offset,
      );
      this.session.sendData(this.id, write.chunk.subarray(write.offset, write.offset + size));
      this.sendCredit -= size;
      write.offset += size;
    }
    this.pendingWrite = null;
    write.callback();
  }

  private returnCredit(): void {
    if (this.closedByPeer || this.destroyed) return;
    const bytes = this.received - this.readableLength - this.credited;
    if (bytes < CREDIT_BATCH) return;
    this.credited += bytes;
    this.session.sendFrame({ type: "credit", stream: this.id, bytes });
  }

  override read(size?: number): Buffer | null {
    const chunk = super.read(size) as Buffer | null;
    // Node calls _read before removing buffered bytes. Check again afterwards
    // so pull readers replenish the window even when no more pushes can arrive.
    this.returnCredit();
    return chunk;
  }

  override _read(): void {
    this.returnCredit();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.pendingWrite = { chunk, offset: 0, callback };
    this.flushWrite();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.closedByPeer && this.session.isOpen) {
      this.session.sendFrame({ type: "eof", stream: this.id });
    }
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.pendingWrite = null;
    if (!this.closedByPeer) {
      this.closedByPeer = true;
      this.session.cancel(this.id);
    }
    callback(error);
  }
}

interface PendingOpen {
  resolve(stream: PreviewTunnelMuxStream): void;
  reject(error: Error): void;
  started: number;
}

export interface PreviewTunnelSessionOptions {
  attachmentId: string;
  credential: string;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  /** Close the session this long after its last stream ends. */
  idleMs: number;
  onClosed(session: PreviewTunnelSession): void;
}

/**
 * One authenticated v2 WebSocket carrying many upstream connections
 * (`preview-tunnel-mux.ts` has the wire contract). HELLO is sent once; each
 * connection after that costs one OPEN and its OPEN_OK.
 */
export class PreviewTunnelSession {
  readonly ready: Promise<void>;
  private readonly streams = new Map<number, PreviewTunnelMuxStream>();
  private readonly opening = new Map<number, PendingOpen>();
  private nextId = 1;
  private authenticated = false;
  private retiring = false;
  private failure: Error | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  /** Whether any frame (a pong included) arrived since the last ping. */
  private heardSincePing = true;
  /** Consecutive pings that nothing answered. */
  private missedPings = 0;
  /** The WebSocket refused more bytes until it drains. */
  blocked = false;

  constructor(
    private readonly ws: PreviewWebSocket,
    private readonly options: PreviewTunnelSessionOptions,
  ) {
    this.heartbeat = setInterval(
      () => this.onHeartbeat(),
      options.pingIntervalMs ?? PREVIEW_TUNNEL_CLIENT_PING_MS,
    );
    this.heartbeat.unref?.();
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(previewFailure("connect-timeout"), PREVIEW_TUNNEL_CLOSE.timeout),
        (options.handshakeTimeoutMs ?? PREVIEW_LIMITS.connectTimeoutMs) * 2,
      );
      this.onReady = (error) => {
        clearTimeout(timer);
        this.onReady = null;
        if (error) reject(error);
        else resolve();
      };
    });
    // Observed so a refused HELLO never surfaces as an unhandled rejection.
    this.ready.catch(() => undefined);
    // The session never pauses its socket (each stream has its own credit
    // window), so every pong and frame is read as it arrives.
    ws.on("pong", () => this.heard());
    ws.on("message", (data, binary) => {
      this.heard();
      this.onMessage(data, binary);
    });
    ws.on("close", (code) => this.onClose(code));
    ws.on("drain", () => {
      this.blocked = false;
      for (const stream of Array.from(this.streams.values())) stream.flushWrite();
    });
    ws.start();
    this.sendFrame({
      type: "hello",
      version: PREVIEW_TUNNEL_MUX_VERSION,
      attachmentId: options.attachmentId,
      credential: options.credential,
    });
  }

  private onReady: ((error: Error | null) => void) | null = null;

  get isOpen(): boolean {
    return this.failure === null && this.ws.isOpen;
  }

  /** Streams open or opening on this session. */
  get size(): number {
    return this.streams.size + this.opening.size;
  }

  /** Whether a new connection may be opened here now. */
  get canOpen(): boolean {
    return (
      this.authenticated &&
      !this.retiring &&
      this.isOpen &&
      this.size < PREVIEW_TUNNEL_MUX.maxStreams
    );
  }

  /** Take no new streams, and close once the current ones end. */
  retire(): void {
    this.retiring = true;
    if (this.size === 0) this.close();
  }

  /** Open one upstream connection. Rejects with the backend's category on refusal. */
  openStream(signal: AbortSignal | undefined, started: number): Promise<PreviewTunnelMuxStream> {
    if (!this.canOpen) return Promise.reject(this.failure ?? previewFailure("backend-unavailable"));
    if (signal?.aborted) return Promise.reject(cancelled());
    const id = this.nextId++;
    this.clearIdle();
    return new Promise<PreviewTunnelMuxStream>((resolve, reject) => {
      const timeoutMs = PREVIEW_LIMITS.connectTimeoutMs * 2;
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.opening.delete(id);
      };
      const abandon = (error: Error) => {
        if (!this.opening.has(id)) return;
        settle();
        if (this.isOpen) this.sendFrame({ type: "cancel", stream: id });
        this.becameIdle();
        reject(error);
      };
      const onAbort = () => abandon(cancelled());
      const timer = setTimeout(() => abandon(previewFailure("connect-timeout")), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.opening.set(id, {
        started,
        resolve: (stream) => {
          settle();
          resolve(stream);
        },
        reject: (error) => {
          settle();
          this.becameIdle();
          reject(error);
        },
      });
      this.sendFrame({ type: "open", stream: id });
    });
  }

  /** @internal */
  sendFrame(frame: PreviewTunnelMuxClientFrame): void {
    if (this.ws.isOpen) this.ws.send(encodePreviewTunnelMuxFrame(frame), false);
  }

  /** @internal */
  sendData(stream: number, data: Buffer): void {
    if (!this.ws.send(encodePreviewTunnelMuxData(stream, data), true)) this.blocked = true;
  }

  /** @internal A stream the backend released, or that ended on its own. */
  forget(id: number): void {
    if (this.streams.delete(id)) this.becameIdle();
  }

  /** @internal A stream this side tore down. */
  cancel(id: number): void {
    if (!this.streams.delete(id)) return;
    if (this.isOpen) this.sendFrame({ type: "cancel", stream: id });
    this.becameIdle();
  }

  /** @internal The backend broke the contract; end the session. */
  violation(): void {
    this.fail(
      previewFailure("internal", { message: "Malformed tunnel frame." }),
      PREVIEW_TUNNEL_CLOSE.protocol,
    );
  }

  /** Close normally. Open streams end as though the backend closed them. */
  close(): void {
    this.clearIdle();
    if (this.ws.isOpen) this.ws.close(PREVIEW_TUNNEL_CLOSE.normal);
  }

  /** Close and fail every stream on it. */
  terminate(error: Error): void {
    this.fail(error, PREVIEW_TUNNEL_CLOSE.normal);
  }

  private fail(error: Error, code: number): void {
    if (this.failure) return;
    this.failure = error;
    this.onReady?.(error);
    for (const pending of Array.from(this.opening.values())) pending.reject(error);
    for (const stream of Array.from(this.streams.values())) stream.destroy(error);
    this.ws.close(code);
  }

  private heard(): void {
    this.heardSincePing = true;
    this.missedPings = 0;
  }

  /**
   * Ping, and retire a session that answered none of its last
   * {@link PREVIEW_TUNNEL_SESSION_MISSED_PINGS} pings: a half-open socket
   * would otherwise stay selectable, and every stream opened on it would
   * wait out its whole open timeout (#1940). The socket is
   * destroyed rather than closed, since a dead peer never answers the close
   * frame, so the connector drops the session and the next open connects a
   * new one.
   */
  private onHeartbeat(): void {
    if (!this.ws.isOpen) return;
    if (!this.heardSincePing) this.missedPings += 1;
    if (this.missedPings >= PREVIEW_TUNNEL_SESSION_MISSED_PINGS) {
      this.fail(previewFailure("backend-unavailable"), PREVIEW_TUNNEL_CLOSE.timeout);
      this.ws.terminate();
      return;
    }
    this.heardSincePing = false;
    this.ws.ping();
  }

  private becameIdle(): void {
    if (this.size > 0 || this.idleTimer || !this.isOpen) return;
    if (this.retiring) {
      this.close();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.size === 0) this.close();
    }, this.options.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private onMessage(data: Buffer, binary: boolean): void {
    if (this.failure) return;
    if (binary) {
      const decoded = this.authenticated ? decodePreviewTunnelMuxData(data) : null;
      if (!decoded) return this.violation();
      const stream = this.streams.get(decoded.stream);
      if (stream) stream.receive(decoded.data);
      else if (decoded.stream >= this.nextId) this.violation();
      return;
    }
    const frame = parsePreviewTunnelMuxServerFrame(data.toString("utf8"));
    if (!frame) return this.violation();
    if (frame.type === "ready") {
      if (this.authenticated) return this.violation();
      this.authenticated = true;
      this.onReady?.(null);
      this.becameIdle();
      return;
    }
    if (frame.type === "error" && frame.stream === undefined) {
      // The session is ending; its close frame follows with the code. That code
      // fails every stream anyway, so fail them now: until then a pooled stream
      // would look reusable while any write to it can only fail.
      this.failure = previewFailure(frame.error.category, { message: frame.error.message });
      this.onReady?.(this.failure);
      for (const pending of Array.from(this.opening.values())) pending.reject(this.failure);
      for (const stream of Array.from(this.streams.values())) stream.destroy(this.failure);
      return;
    }
    if (!this.authenticated) return this.violation();
    const id = frame.stream!;
    const pending = this.opening.get(id);
    if (pending) {
      if (frame.type === "open-ok") {
        const stream = new PreviewTunnelMuxStream(this, id, performance.now() - pending.started);
        this.streams.set(id, stream);
        pending.resolve(stream);
      } else if (frame.type === "open-failed" || frame.type === "error") {
        const failure = previewFailure(frame.error.category, { message: frame.error.message });
        if (
          failure.preview.category === "access-expired" ||
          failure.preview.category === "generation-changed"
        )
          this.retire();
        pending.reject(failure);
      } else this.violation();
      return;
    }
    const stream = this.streams.get(id);
    if (!stream) {
      // A stream this side released already; only one never opened is a violation.
      if (id >= this.nextId) this.violation();
      return;
    }
    switch (frame.type) {
      case "eof":
        return stream.peerEnded();
      case "closed":
        return stream.peerClosed();
      case "credit":
        return stream.addCredit(frame.bytes);
      case "error":
        stream.destroy(previewFailure(frame.error.category, { message: frame.error.message }));
        return;
      default:
        this.violation();
    }
  }

  private onClose(code: number): void {
    clearInterval(this.heartbeat);
    this.clearIdle();
    const normal = code === PREVIEW_TUNNEL_CLOSE.normal || code === 1005;
    const failure = this.failure ?? closeFailure(code);
    this.failure = failure;
    this.onReady?.(failure);
    for (const pending of Array.from(this.opening.values())) pending.reject(failure);
    for (const stream of Array.from(this.streams.values())) {
      if (normal) stream.peerClosed();
      else stream.destroy(failure);
    }
    this.options.onClosed(this);
  }
}

function cancelled(): Error {
  return previewFailure("access-expired", { message: "The preview request was cancelled." });
}

export interface PreviewTunnelConnectorOptions {
  /** Close a session this long after its last stream ends; defaults to 30 s. */
  sessionIdleMs?: number;
  pingIntervalMs?: number;
}

/**
 * Opens tunnelled upstream connections for one preview service. Against a
 * backend that speaks v2 it keeps one authenticated WebSocket per attachment
 * and opens every connection as a stream on it, so a page's first burst of
 * parallel requests pays one handshake and one HELLO. Against an older
 * backend it falls back to v1, one WebSocket per connection.
 */
export class PreviewTunnelConnector {
  private readonly sessions = new Map<string, PreviewTunnelSession[]>();
  private readonly connecting = new Map<string, Promise<PreviewTunnelSession | null>>();
  /** Tunnel URLs whose backend advertised v2 and still answered v1. */
  private readonly legacy = new Set<string>();
  private closed = false;

  constructor(private readonly options: PreviewTunnelConnectorOptions = {}) {}

  /**
   * Open one upstream connection. `multiplex` says the attachment advertised
   * v2; without it this opens a v1 socket, as for a backend that predates v2.
   */
  async open(
    options: PreviewTunnelOpenOptions,
    multiplex = true,
  ): Promise<PreviewTunnelConnection> {
    const started = performance.now();
    if (!multiplex || this.legacy.has(options.url)) return openPreviewTunnel(options);
    const key = `${options.url}\u0000${options.attachmentId}`;
    // A session can fill up between connecting and opening; then use another.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (this.closed) throw previewFailure("backend-unavailable");
      let session = this.sessions.get(key)?.find((candidate) => candidate.canOpen);
      if (!session) {
        const joined = this.connecting.get(key);
        if (joined) {
          const result = await withSignal(joined, options.signal);
          if (!result) return openPreviewTunnel(options);
          continue;
        }
        const connected = await this.connect(key, options, started);
        if (!(connected instanceof PreviewTunnelSession)) return connected;
        session = connected;
        if (!session.canOpen) continue;
      }
      return session.openStream(options.signal, started);
    }
    throw previewFailure("capacity-exceeded");
  }

  /** Stop putting new connections on the current sessions; they close once idle. */
  retireSessions(): void {
    for (const list of this.sessions.values()) for (const session of list) session.retire();
  }

  /** Close every session and fail every connection on it. */
  close(): void {
    this.closed = true;
    const error = previewFailure("backend-unavailable");
    for (const list of Array.from(this.sessions.values()))
      for (const session of Array.from(list)) session.terminate(error);
    this.sessions.clear();
  }

  stats(): { sessions: number; streams: number } {
    let sessions = 0;
    let streams = 0;
    for (const list of this.sessions.values()) {
      sessions += list.length;
      for (const session of list) streams += session.size;
    }
    return { sessions, streams };
  }

  /**
   * Connect a session that concurrent openers join. The session outlives the
   * request that started it, so the request's signal does not cancel it.
   */
  private async connect(
    key: string,
    options: PreviewTunnelOpenOptions,
    started: number,
  ): Promise<PreviewTunnelSession | PreviewTunnelConnection> {
    let settle!: (session: PreviewTunnelSession | null) => void;
    let refuse!: (error: unknown) => void;
    const shared = new Promise<PreviewTunnelSession | null>((resolve, reject) => {
      settle = resolve;
      refuse = reject;
    });
    shared.catch(() => undefined);
    this.connecting.set(key, shared);
    try {
      const ws = await connectPreviewTunnelSocket(
        { ...options, signal: undefined },
        PREVIEW_TUNNEL_OFFERED_SUBPROTOCOLS,
      );
      if (ws.protocol !== PREVIEW_TUNNEL_SUBPROTOCOL_V2) {
        this.legacy.add(options.url);
        settle(null);
        if (options.signal?.aborted) {
          ws.terminate();
          throw cancelled();
        }
        return await startV1Tunnel(ws, options, started);
      }
      const session = new PreviewTunnelSession(ws, {
        attachmentId: options.attachmentId,
        credential: options.credential,
        handshakeTimeoutMs: options.handshakeTimeoutMs,
        pingIntervalMs: options.pingIntervalMs ?? this.options.pingIntervalMs,
        idleMs: this.options.sessionIdleMs ?? 30_000,
        onClosed: (closed) => this.remove(key, closed),
      });
      const list = this.sessions.get(key) ?? [];
      list.push(session);
      this.sessions.set(key, list);
      if (this.closed) session.terminate(previewFailure("backend-unavailable"));
      await session.ready;
      settle(session);
      return session;
    } catch (error) {
      refuse(error);
      throw error;
    } finally {
      if (this.connecting.get(key) === shared) this.connecting.delete(key);
    }
  }

  private remove(key: string, session: PreviewTunnelSession): void {
    const list = this.sessions.get(key);
    if (!list) return;
    const index = list.indexOf(session);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.sessions.delete(key);
  }
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
