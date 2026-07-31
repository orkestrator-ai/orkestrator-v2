import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  parseTerminalWebSocketClientControlFrame,
  TERMINAL_BINARY_FRAME_TYPE,
  TERMINAL_WEBSOCKET_CHANNEL_HARD_BUFFER_BYTES,
  TERMINAL_WEBSOCKET_CHANNEL_SOFT_BUFFER_BYTES,
  TERMINAL_WEBSOCKET_CLOSE,
  TERMINAL_WEBSOCKET_MAX_BINARY_BYTES,
  TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES,
  TERMINAL_WEBSOCKET_PATH,
  TERMINAL_WEBSOCKET_SOCKET_HARD_BUFFER_BYTES,
  TERMINAL_WEBSOCKET_SOCKET_SOFT_BUFFER_BYTES,
  TERMINAL_WEBSOCKET_SUBPROTOCOL,
  TERMINAL_WEBSOCKET_PROTOCOL_VERSION,
  TerminalWebSocketControlFrameError,
  type TerminalWebSocketServerControlFrame,
} from "@orkestrator/protocol/terminal-websocket";

type BackendInvoker = {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown> | unknown;
};

type TerminalSnapshot = {
  mode?: "full" | "delta";
  output: string;
  revision: number;
  generation: number;
  deltas?: Array<{ revision: number; text: string }>;
};

type TerminalEvent = {
  generation: number;
  revision: number;
  bytes: Uint8Array;
};

export const TERMINAL_WEBSOCKET_MAX_PENDING_OPERATION_SESSIONS = 4_096;
export const TERMINAL_WEBSOCKET_MAX_PENDING_OPERATIONS_PER_SESSION = 256;
export const TERMINAL_WEBSOCKET_MAX_PENDING_OPERATION_BYTES_PER_SESSION = 1024 * 1024;
export const TERMINAL_WEBSOCKET_MAX_PENDING_OPERATIONS = 4_096;
export const TERMINAL_WEBSOCKET_MAX_PENDING_OPERATION_BYTES = 8 * 1024 * 1024;

type QueuedFrame = { data: string | Uint8Array; bytes: number };

/** Header bytes charged to a buffered event when projecting queue growth. */
const FRAME_OVERHEAD_BYTES = 16;

type Channel = {
  id: number;
  sessionId: string;
  generation: number;
  revision: number;
  inputSequence: number;
  queue: QueuedFrame[];
  queuedBytes: number;
  desynced: boolean;
  reconciling: boolean;
  bufferedLive: TerminalEvent[];
  /** Running total of `bufferedLive`; re-summing it per event is quadratic. */
  bufferedLiveBytes: number;
  pendingDesync: {
    reason: "revision-gap" | "generation-changed" | "slow-consumer";
    generation: number;
    revision: number;
  } | null;
};

type OperationSequence = {
  tail: Promise<void>;
  count: number;
  bytes: number;
};

type SocketState = {
  ws: WebSocket;
  authenticated: boolean;
  authTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  channels: Map<number, Channel>;
  sessions: Map<string, Channel>;
  controlQueue: QueuedFrame[];
  queuedBytes: number;
  nextChannelId: number;
  roundRobinCursor: number;
  flushScheduled: boolean;
  invalidChannelFrames: number;
};

export type TerminalWebSocketServerOptions = {
  backend: BackendInvoker;
  tokenMatches(request: IncomingMessage, suppliedToken?: string): boolean;
  originAllowed(request: IncomingMessage): boolean;
  logger: Pick<Console, "debug" | "warn" | "error">;
  authTimeoutMs?: number;
};

function rawDataBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const sharedEncoder = new TextEncoder();

function terminalEvent(payload: unknown): TerminalEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as { text?: unknown; generation?: unknown; revision?: unknown };
  if (
    typeof value.text !== "string"
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 0
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
  ) return null;
  return {
    generation: value.generation as number,
    revision: value.revision as number,
    bytes: sharedEncoder.encode(value.text),
  };
}

/**
 * A backend command that could not reach its terminal process reports the
 * refusal in band rather than throwing. Acknowledging it as delivered would
 * tell the user a keystroke landed in a shell that is no longer running.
 */
function operationRefusal(result: unknown): string | null {
  if (
    result
    && typeof result === "object"
    && (result as { delivered?: unknown }).delivered === false
  ) {
    return "Terminal session is not running";
  }
  return null;
}

function validSnapshot(value: unknown): value is TerminalSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<TerminalSnapshot>;
  return typeof snapshot.output === "string"
    && Number.isSafeInteger(snapshot.revision) && snapshot.revision! >= 0
    && Number.isSafeInteger(snapshot.generation) && snapshot.generation! >= 0;
}

export class TerminalWebSocketGateway {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: TERMINAL_WEBSOCKET_MAX_BINARY_BYTES,
    handleProtocols: (protocols) => protocols.has(TERMINAL_WEBSOCKET_SUBPROTOCOL)
      ? TERMINAL_WEBSOCKET_SUBPROTOCOL
      : false,
  });
  private readonly sockets = new Set<SocketState>();
  private readonly upgradeSockets = new Set<Duplex>();
  private readonly sessionOperations = new Map<string, OperationSequence>();
  private pendingOperationCount = 0;
  private pendingOperationBytes = 0;
  private readonly encoder = new TextEncoder();
  private readonly authTimeoutMs: number;

  constructor(private readonly options: TerminalWebSocketServerOptions) {
    this.authTimeoutMs = options.authTimeoutMs ?? 5_000;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://orkestrator.local");
    } catch {
      this.rejectUpgrade(socket, 400, "Bad Request");
      return true;
    }
    if (url.pathname !== TERMINAL_WEBSOCKET_PATH) return false;
    // Browsers always send Origin. A non-browser/direct client may omit it, but
    // then it must authenticate in-band; accepting a cookie-authenticated
    // origin-less upgrade would bypass the browser CSWSH check.
    if (
      (request.headers.origin && !this.options.originAllowed(request))
      || (!request.headers.origin && this.options.tokenMatches(request))
    ) {
      this.rejectUpgrade(socket, 403, "Origin not allowed");
      return true;
    }
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",").map((value) => value.trim());
    if (!protocols.includes(TERMINAL_WEBSOCKET_SUBPROTOCOL)) {
      this.rejectUpgrade(socket, 426, "Terminal WebSocket protocol required", {
        "Sec-WebSocket-Protocol": TERMINAL_WEBSOCKET_SUBPROTOCOL,
      });
      return true;
    }
    this.upgradeSockets.add(socket);
    socket.once("close", () => this.upgradeSockets.delete(socket));
    try {
      this.server.handleUpgrade(request, socket, head, (ws) => {
        this.accept(ws, request);
      });
    } catch {
      this.upgradeSockets.delete(socket);
      this.options.logger.debug("[TerminalWebSocket] Upgrade rejected");
      if (!socket.destroyed) this.rejectUpgrade(socket, 400, "Bad Request");
    }
    return true;
  }

  emit(event: string, payload: unknown): void {
    // Terminal output is the highest-volume event in the system and this runs
    // for every one of them. Decide there is nothing to do before paying for a
    // UTF-8 encode whose result would only be discarded — the transport is
    // opt-in, so no socket at all is the common case.
    if (this.sockets.size === 0 || !event.startsWith("terminal-output-")) return;
    const sessionId = event.slice("terminal-output-".length);
    let output: TerminalEvent | null = null;
    for (const state of this.sockets) {
      const channel = state.sessions.get(sessionId);
      if (!channel || channel.desynced || channel.pendingDesync) continue;
      output ??= terminalEvent(payload);
      if (!output) return;
      if (channel.reconciling) {
        const frameBytes = output.bytes.byteLength + FRAME_OVERHEAD_BYTES;
        const projected = channel.queuedBytes + channel.bufferedLiveBytes + frameBytes;
        if (projected > TERMINAL_WEBSOCKET_CHANNEL_SOFT_BUFFER_BYTES) {
          channel.bufferedLive = [];
          channel.bufferedLiveBytes = 0;
          // The client cannot interpret a channel-scoped frame until it has
          // received `subscribed`. Defer the desync until that mapping exists.
          channel.pendingDesync = {
            reason: "slow-consumer",
            generation: output.generation,
            revision: output.revision,
          };
        } else {
          channel.bufferedLive.push(output);
          channel.bufferedLiveBytes += frameBytes;
        }
        continue;
      }
      this.enqueueOutput(state, channel, output);
    }
  }

  close(): void {
    // Shutdown must not wait for a peer to answer the WebSocket close handshake;
    // the backend HTTP listener cannot finish closing while an upgraded socket
    // remains attached. Reconnect recovery is snapshot-authoritative anyway.
    this.revokeConnections();
    this.server.close();
  }

  /** Revoke every credential latched by an existing or in-flight upgrade. */
  revokeConnections(): void {
    for (const state of [...this.sockets]) state.ws.terminate();
    for (const socket of [...this.upgradeSockets]) socket.destroy();
    this.upgradeSockets.clear();
  }

  private accept(ws: WebSocket, request: IncomingMessage): void {
    const authenticated = this.options.tokenMatches(request);
    const state: SocketState = {
      ws,
      authenticated,
      authTimer: null,
      closeTimer: null,
      channels: new Map(),
      sessions: new Map(),
      controlQueue: [],
      queuedBytes: 0,
      nextChannelId: 1,
      roundRobinCursor: 0,
      flushScheduled: false,
      invalidChannelFrames: 0,
    };
    this.sockets.add(state);
    ws.binaryType = "arraybuffer";
    ws.on("message", (data, isBinary) => this.onMessage(state, request, data, isBinary));
    ws.on("error", (error) => this.options.logger.debug("[TerminalWebSocket] Socket error", error));
    ws.once("close", () => this.dispose(state));
    if (authenticated) {
      this.ready(state);
    } else {
      state.authTimer = setTimeout(() => {
        this.closeSocket(state, TERMINAL_WEBSOCKET_CLOSE.authenticationRequired, "Authentication required");
      }, this.authTimeoutMs);
      state.authTimer.unref?.();
    }
  }

  private onMessage(
    state: SocketState,
    request: IncomingMessage,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (state.ws.readyState !== WebSocket.OPEN) return;
    if (isBinary) {
      if (!state.authenticated) {
        this.fatal(state, "authentication-required", "Authenticate before sending terminal data", TERMINAL_WEBSOCKET_CLOSE.authenticationRequired);
        return;
      }
      this.onBinary(state, rawDataBytes(data));
      return;
    }
    const bytes = rawDataBytes(data);
    if (bytes.byteLength > TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES) {
      this.fatal(state, "frame-too-large", "Terminal control frame is too large", TERMINAL_WEBSOCKET_CLOSE.messageTooLarge);
      return;
    }
    let frame;
    try {
      frame = parseTerminalWebSocketClientControlFrame(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      const code = error instanceof TerminalWebSocketControlFrameError ? error.code : "malformed-frame";
      const closeCode = code === "unsupported-version"
        ? TERMINAL_WEBSOCKET_CLOSE.unsupportedVersion
        : code === "frame-too-large"
          ? TERMINAL_WEBSOCKET_CLOSE.messageTooLarge
          : TERMINAL_WEBSOCKET_CLOSE.protocolError;
      this.fatal(state, code, "Invalid terminal control frame", closeCode);
      return;
    }
    if (!state.authenticated) {
      if (frame.type !== "authenticate" || !this.options.tokenMatches(request, frame.token)) {
        this.fatal(state, "authentication-required", "Authentication required", TERMINAL_WEBSOCKET_CLOSE.authenticationRequired);
        return;
      }
      state.authenticated = true;
      if (state.authTimer) clearTimeout(state.authTimer);
      state.authTimer = null;
      this.ready(state);
      return;
    }
    if (frame.type === "authenticate") {
      this.fatal(state, "malformed-frame", "Socket is already authenticated", TERMINAL_WEBSOCKET_CLOSE.protocolError);
      return;
    }
    switch (frame.type) {
      case "subscribe":
        void this.subscribe(state, frame);
        break;
      case "unsubscribe":
        this.unsubscribe(state, frame.channelId);
        break;
      case "resize": {
        const channel = this.channel(state, frame.channelId);
        if (!channel) {
          this.operationResult(state, frame.channelId, frame.operationId, "resize", false, "Unknown terminal channel");
          break;
        }
        this.enqueueOperation({
          state,
          channelId: channel.id,
          sessionId: channel.sessionId,
          operationId: frame.operationId,
          operation: "resize",
          bytes: 16,
          invoke: () => this.options.backend.invoke("terminal_resize", {
            sessionId: channel.sessionId,
            cols: frame.cols,
            rows: frame.rows,
          }),
        });
        break;
      }
      case "ack": {
        const channel = this.channel(state, frame.channelId);
        if (channel && frame.generation === channel.generation && frame.revision <= channel.revision) {
          state.invalidChannelFrames = 0;
        }
        break;
      }
    }
  }

  private onBinary(state: SocketState, bytes: Uint8Array): void {
    let frame;
    try {
      frame = decodeTerminalBinaryFrame(bytes);
    } catch {
      this.fatal(state, "malformed-frame", "Invalid terminal binary frame", TERMINAL_WEBSOCKET_CLOSE.protocolError);
      return;
    }
    if (frame.type !== TERMINAL_BINARY_FRAME_TYPE.input) {
      this.fatal(state, "malformed-frame", "Clients may only send input frames", TERMINAL_WEBSOCKET_CLOSE.protocolError);
      return;
    }
    const channel = this.channel(state, frame.channelId);
    if (!channel) {
      this.operationResult(state, frame.channelId, frame.revision, "input", false, "Unknown terminal channel");
      return;
    }
    // Neither of these is a protocol violation, so neither may close the socket:
    // that would tear down every *other* terminal multiplexed onto it. A client
    // legitimately adopts a newer generation from an authoritative snapshot
    // before this channel has heard about the restart, and a stale sequence is
    // at worst a duplicate. Both are answered per channel.
    if (frame.generation !== channel.generation) {
      this.operationResult(
        state, channel.id, frame.revision, "input", false, "Terminal generation changed",
      );
      this.desync(state, channel, "generation-changed", frame.generation, channel.revision);
      return;
    }
    if (frame.revision <= channel.inputSequence) {
      this.operationResult(
        state, channel.id, frame.revision, "input", false, "Terminal input sequence is not increasing",
      );
      return;
    }
    channel.inputSequence = frame.revision;
    const data = new TextDecoder().decode(frame.bytes);
    this.enqueueOperation({
      state,
      channelId: channel.id,
      sessionId: channel.sessionId,
      operationId: frame.revision,
      operation: "input",
      bytes: frame.bytes.byteLength,
      invoke: () => this.options.backend.invoke("terminal_write", {
        sessionId: channel.sessionId,
        data,
      }),
    });
  }

  private async subscribe(
    state: SocketState,
    frame: Extract<ReturnType<typeof parseTerminalWebSocketClientControlFrame>, { type: "subscribe" }>,
  ): Promise<void> {
    if (state.sessions.has(frame.sessionId)) {
      this.sendControl(state, {
        type: "error", code: "subscription-denied", message: "Terminal is already subscribed", requestId: frame.requestId,
      });
      return;
    }
    const channelId = this.allocateChannelId(state);
    if (channelId === null) {
      this.sendControl(state, { type: "error", code: "internal-error", message: "No terminal channels available", requestId: frame.requestId });
      return;
    }
    const channel: Channel = {
      id: channelId,
      sessionId: frame.sessionId,
      generation: 0,
      revision: 0,
      inputSequence: 0,
      queue: [],
      queuedBytes: 0,
      desynced: false,
      reconciling: true,
      bufferedLive: [],
      bufferedLiveBytes: 0,
      pendingDesync: null,
    };
    // Register before reading the snapshot so concurrent terminal output is
    // buffered and can never fall between reconciliation and live delivery.
    state.channels.set(channel.id, channel);
    state.sessions.set(channel.sessionId, channel);
    try {
      const [statusValue, snapshotValue] = await Promise.all([
        this.options.backend.invoke("get_terminal_session", { sessionId: frame.sessionId }),
        this.options.backend.invoke("get_terminal_output_snapshot", {
          sessionId: frame.sessionId,
          ...("knownGeneration" in frame
            ? { sinceGeneration: frame.knownGeneration, sinceRevision: frame.knownRevision }
            : {}),
        }),
      ]);
      if (!validSnapshot(snapshotValue)) throw new Error("Invalid terminal snapshot");
      const running = Boolean(statusValue && typeof statusValue === "object" && (statusValue as { running?: unknown }).running);
      // Remembered but not-yet-started sessions have generation 1. Unknown ids
      // have neither a running process nor retained/configured generation.
      if (!running && snapshotValue.generation === 0) {
        this.retireChannel(state, channel);
        this.sendControl(state, { type: "error", code: "subscription-denied", message: "Terminal session is unavailable", requestId: frame.requestId });
        return;
      }
      if (state.channels.get(channel.id) !== channel) return;
      const hasCursor = frame.knownGeneration !== undefined && frame.knownRevision !== undefined;
      const knownGeneration = frame.knownGeneration ?? 0;
      const knownRevision = frame.knownRevision ?? 0;
      channel.generation = snapshotValue.generation;
      channel.revision = hasCursor ? knownRevision : 0;
      const cursorMatches = hasCursor && knownGeneration === snapshotValue.generation;
      const recovery = !cursorMatches || snapshotValue.mode !== "delta"
        ? "snapshot-required"
        : knownRevision === snapshotValue.revision
          ? "current"
          : "delta";
      this.sendControl(state, recovery === "snapshot-required" ? {
        type: "subscribed",
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        channelId: channel.id,
        baseGeneration: null,
        baseRevision: null,
        targetGeneration: snapshotValue.generation,
        targetRevision: snapshotValue.revision,
        recovery,
      } : {
        type: "subscribed",
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        channelId: channel.id,
        baseGeneration: knownGeneration,
        baseRevision: knownRevision,
        targetGeneration: snapshotValue.generation,
        targetRevision: snapshotValue.revision,
        recovery,
      });
      if (recovery === "delta") {
        const deltas = snapshotValue.deltas ?? [{ revision: snapshotValue.revision, text: snapshotValue.output }];
        for (const delta of deltas) {
          if (delta.revision <= channel.revision) continue;
          this.enqueueOutput(state, channel, {
            generation: snapshotValue.generation,
            revision: delta.revision,
            bytes: this.encoder.encode(delta.text),
          });
        }
      } else if (recovery === "current") {
        channel.revision = snapshotValue.revision;
      } else {
        // The client is fetching this exact authoritative boundary. Live output
        // begins after it; retaining the pre-request cursor here would report a
        // false gap whenever the snapshot already contained output.
        channel.revision = snapshotValue.revision;
      }
      channel.reconciling = false;
      const pendingDesync = channel.pendingDesync;
      channel.pendingDesync = null;
      if (pendingDesync) {
        this.desync(
          state,
          channel,
          pendingDesync.reason,
          pendingDesync.generation,
          pendingDesync.revision,
        );
        return;
      }
      const buffered = channel.bufferedLive.splice(0).sort((a, b) => a.revision - b.revision);
      channel.bufferedLiveBytes = 0;
      for (const output of buffered) {
        if (output.generation === channel.generation && output.revision <= snapshotValue.revision) continue;
        this.enqueueOutput(state, channel, output);
      }
      this.sendControl(state, {
        type: "lifecycle",
        channelId: channel.id,
        state: running ? "running" : "exited",
        generation: snapshotValue.generation,
        revision: snapshotValue.revision,
      });
    } catch (error) {
      this.retireChannel(state, channel);
      this.options.logger.warn("[TerminalWebSocket] Subscription failed", error);
      this.sendControl(state, { type: "error", code: "terminal-unavailable", message: "Terminal session is unavailable", requestId: frame.requestId });
    }
  }

  private enqueueOutput(state: SocketState, channel: Channel, output: TerminalEvent): void {
    if (channel.desynced || state.ws.readyState !== WebSocket.OPEN) return;
    if (output.generation !== channel.generation) {
      this.desync(state, channel, "generation-changed", output.generation, output.revision);
      return;
    }
    if (output.revision <= channel.revision) return;
    if (output.revision !== channel.revision + 1) {
      this.desync(state, channel, "revision-gap", output.generation, output.revision);
      return;
    }
    if (output.bytes.byteLength + 16 > TERMINAL_WEBSOCKET_MAX_BINARY_BYTES) {
      this.desync(state, channel, "slow-consumer", output.generation, output.revision);
      return;
    }
    const data = encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.output,
      channelId: channel.id,
      generation: output.generation,
      revision: output.revision,
      bytes: output.bytes,
    });
    const queued: QueuedFrame = { data, bytes: data.byteLength };
    const channelProjected = channel.queuedBytes + queued.bytes;
    const socketProjected = state.queuedBytes + state.ws.bufferedAmount + queued.bytes;
    if (channelProjected > TERMINAL_WEBSOCKET_CHANNEL_HARD_BUFFER_BYTES || socketProjected > TERMINAL_WEBSOCKET_SOCKET_HARD_BUFFER_BYTES) {
      this.closeSocket(state, TERMINAL_WEBSOCKET_CLOSE.slowConsumer, "Terminal socket exceeded its hard buffer limit");
      return;
    }
    if (channelProjected > TERMINAL_WEBSOCKET_CHANNEL_SOFT_BUFFER_BYTES || socketProjected > TERMINAL_WEBSOCKET_SOCKET_SOFT_BUFFER_BYTES) {
      this.desync(state, channel, "slow-consumer", output.generation, output.revision);
      return;
    }
    channel.queue.push(queued);
    channel.queuedBytes += queued.bytes;
    state.queuedBytes += queued.bytes;
    channel.revision = output.revision;
    this.scheduleFlush(state);
  }

  private desync(
    state: SocketState,
    channel: Channel,
    reason: "revision-gap" | "generation-changed" | "slow-consumer",
    generation: number,
    revision: number,
  ): void {
    if (channel.desynced) return;
    channel.desynced = true;
    for (const queued of channel.queue) state.queuedBytes -= queued.bytes;
    channel.queue = [];
    channel.queuedBytes = 0;
    channel.bufferedLive = [];
    channel.bufferedLiveBytes = 0;
    this.sendControl(state, { type: "desync", channelId: channel.id, generation, revision, reason });
  }

  private ready(state: SocketState): void {
    this.sendControl(state, {
      type: "ready",
      version: TERMINAL_WEBSOCKET_PROTOCOL_VERSION,
      socketId: randomBytes(12).toString("hex"),
    });
  }

  private sendControl(state: SocketState, frame: TerminalWebSocketServerControlFrame): void {
    if (state.ws.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(frame);
    const queued: QueuedFrame = { data, bytes: Buffer.byteLength(data) };
    const projected = state.queuedBytes + state.ws.bufferedAmount + queued.bytes;
    if (projected > TERMINAL_WEBSOCKET_SOCKET_HARD_BUFFER_BYTES) {
      this.closeSocket(state, TERMINAL_WEBSOCKET_CLOSE.slowConsumer, "Terminal socket exceeded its hard buffer limit");
      return;
    }
    state.controlQueue.push(queued);
    state.queuedBytes += queued.bytes;
    this.scheduleFlush(state);
  }

  private scheduleFlush(state: SocketState): void {
    if (state.flushScheduled || state.ws.readyState !== WebSocket.OPEN) return;
    state.flushScheduled = true;
    setImmediate(() => this.flush(state));
  }

  private flush(state: SocketState): void {
    state.flushScheduled = false;
    if (state.ws.readyState !== WebSocket.OPEN) return;
    let budget = 64 * 1024;
    while (state.controlQueue.length > 0 && budget > 0) {
      const frame = state.controlQueue.shift()!;
      state.queuedBytes -= frame.bytes;
      budget -= frame.bytes;
      state.ws.send(frame.data, (error) => error && state.ws.terminate());
    }
    const channels = [...state.channels.values()];
    if (channels.length > 0) {
      for (let offset = 0; offset < channels.length && budget > 0; offset += 1) {
        const index = (state.roundRobinCursor + offset) % channels.length;
        const channel = channels[index]!;
        let channelBudget = 16 * 1024;
        while (channel.queue.length > 0 && channelBudget > 0 && budget > 0) {
          const frame = channel.queue.shift()!;
          channel.queuedBytes -= frame.bytes;
          state.queuedBytes -= frame.bytes;
          channelBudget -= frame.bytes;
          budget -= frame.bytes;
          state.ws.send(frame.data, { binary: true }, (error) => error && state.ws.terminate());
        }
      }
      state.roundRobinCursor = (state.roundRobinCursor + 1) % channels.length;
    }
    if (state.controlQueue.length > 0 || [...state.channels.values()].some((channel) => channel.queue.length > 0)) {
      this.scheduleFlush(state);
    }
  }

  private channel(state: SocketState, channelId: number): Channel | null {
    const channel = state.channels.get(channelId);
    if (channel) {
      state.invalidChannelFrames = 0;
      return channel;
    }
    state.invalidChannelFrames += 1;
    this.sendControl(state, { type: "error", code: "unknown-channel", message: "Unknown terminal channel", channelId });
    if (state.invalidChannelFrames >= 3) this.closeSocket(state, TERMINAL_WEBSOCKET_CLOSE.policyViolation, "Repeated unknown terminal channel");
    return null;
  }

  private unsubscribe(state: SocketState, channelId: number): void {
    const channel = this.channel(state, channelId);
    if (!channel) return;
    this.retireChannel(state, channel);
    this.sendControl(state, { type: "unsubscribed", channelId });
  }

  private retireChannel(state: SocketState, channel: Channel): void {
    if (state.channels.get(channel.id) !== channel) return;
    state.channels.delete(channel.id);
    state.sessions.delete(channel.sessionId);
    for (const queued of channel.queue) state.queuedBytes -= queued.bytes;
    channel.queue = [];
    channel.queuedBytes = 0;
    channel.bufferedLive = [];
    channel.bufferedLiveBytes = 0;
    channel.pendingDesync = null;
  }

  private enqueueOperation(options: {
    state: SocketState;
    channelId: number;
    sessionId: string;
    operationId: number;
    operation: "input" | "resize";
    bytes: number;
    invoke: () => Promise<unknown> | unknown;
  }): void {
    // The ordering tail is gateway-owned rather than socket-owned. A reconnect
    // can therefore create a new channel while an accepted write from the old
    // socket is still completing without allowing the new write to overtake it.
    const existing = this.sessionOperations.get(options.sessionId);
    const sequence = existing ?? { tail: Promise.resolve(), count: 0, bytes: 0 };
    const saturated = (!existing
        && this.sessionOperations.size >= TERMINAL_WEBSOCKET_MAX_PENDING_OPERATION_SESSIONS)
      || sequence.count >= TERMINAL_WEBSOCKET_MAX_PENDING_OPERATIONS_PER_SESSION
      || sequence.bytes + options.bytes > TERMINAL_WEBSOCKET_MAX_PENDING_OPERATION_BYTES_PER_SESSION
      || this.pendingOperationCount >= TERMINAL_WEBSOCKET_MAX_PENDING_OPERATIONS
      || this.pendingOperationBytes + options.bytes > TERMINAL_WEBSOCKET_MAX_PENDING_OPERATION_BYTES;
    if (saturated) {
      this.operationResult(
        options.state,
        options.channelId,
        options.operationId,
        options.operation,
        false,
        "Terminal operation queue is full",
      );
      return;
    }
    sequence.count += 1;
    sequence.bytes += options.bytes;
    this.pendingOperationCount += 1;
    this.pendingOperationBytes += options.bytes;
    const previous = sequence.tail;
    const next = previous
      .then(() => options.invoke())
      .then(
        (result) => {
          const refusal = operationRefusal(result);
          this.operationResult(
            options.state,
            options.channelId,
            options.operationId,
            options.operation,
            !refusal,
            refusal ?? undefined,
          );
        },
        () => {
          this.options.logger.warn("[TerminalWebSocket] Terminal operation failed");
          this.operationResult(
            options.state,
            options.channelId,
            options.operationId,
            options.operation,
            false,
            "Terminal operation failed",
          );
        },
      )
      .then(() => undefined);
    sequence.tail = next;
    this.sessionOperations.set(options.sessionId, sequence);
    void next.finally(() => {
      sequence.count -= 1;
      sequence.bytes -= options.bytes;
      this.pendingOperationCount -= 1;
      this.pendingOperationBytes -= options.bytes;
      if (this.sessionOperations.get(options.sessionId) === sequence && sequence.count === 0) {
        this.sessionOperations.delete(options.sessionId);
      }
    });
  }

  private operationResult(
    state: SocketState,
    channelId: number,
    operationId: number,
    operation: "input" | "resize",
    ok: boolean,
    message?: string,
  ): void {
    this.sendControl(state, ok ? {
      type: "operation-result",
      channelId,
      operationId,
      operation,
      ok: true,
    } : {
      type: "operation-result",
      channelId,
      operationId,
      operation,
      ok: false,
      message: message ?? "Terminal operation failed",
    });
  }

  private allocateChannelId(state: SocketState): number | null {
    for (let attempts = 0; attempts < 0xffff; attempts += 1) {
      const candidate = state.nextChannelId;
      state.nextChannelId = candidate === 0xffff ? 1 : candidate + 1;
      if (!state.channels.has(candidate)) return candidate;
    }
    return null;
  }

  private fatal(
    state: SocketState,
    code: "authentication-required" | "unsupported-version" | "malformed-frame" | "frame-too-large",
    message: string,
    closeCode: number,
  ): void {
    if (state.ws.readyState !== WebSocket.OPEN) return;
    try {
      state.ws.send(JSON.stringify({ type: "error", code, message, fatal: true } satisfies TerminalWebSocketServerControlFrame));
      this.closeSocket(state, closeCode, message);
    } catch {
      state.ws.terminate();
    }
  }

  private closeSocket(state: SocketState, code: number, reason: string): void {
    if (state.ws.readyState === WebSocket.OPEN) {
      state.ws.close(code, reason.slice(0, 123));
      // A non-reading peer cannot complete the close handshake. Bound that
      // case too: the socket gets a brief chance to receive the close reason,
      // then the transport is forcibly released.
      if (!state.closeTimer) {
        state.closeTimer = setTimeout(() => {
          state.closeTimer = null;
          if (state.ws.readyState !== WebSocket.CLOSED) state.ws.terminate();
        }, 250);
        state.closeTimer.unref?.();
      }
    } else if (state.ws.readyState !== WebSocket.CLOSED) state.ws.terminate();
  }

  private dispose(state: SocketState): void {
    if (state.authTimer) clearTimeout(state.authTimer);
    if (state.closeTimer) clearTimeout(state.closeTimer);
    state.authTimer = null;
    state.closeTimer = null;
    state.channels.clear();
    state.sessions.clear();
    state.controlQueue = [];
    state.queuedBytes = 0;
    this.sockets.delete(state);
  }

  private rejectUpgrade(
    socket: Duplex,
    status: number,
    message: string,
    headers: Record<string, string> = {},
  ): void {
    const body = `${message}\n`;
    const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join("");
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${headerLines}\r\n${body}`,
    );
  }
}
