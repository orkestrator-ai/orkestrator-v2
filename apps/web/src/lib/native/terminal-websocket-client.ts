import {
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  parseTerminalWebSocketServerControlFrame,
  TERMINAL_BINARY_FRAME_TYPE,
  TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES,
  TERMINAL_WEBSOCKET_CHANNEL_SOFT_BUFFER_BYTES,
  TERMINAL_WEBSOCKET_MAX_BINARY_BYTES,
  TERMINAL_WEBSOCKET_PATH,
  TERMINAL_WEBSOCKET_PROTOCOL_VERSION,
  TERMINAL_WEBSOCKET_SUBPROTOCOL,
  type TerminalWebSocketClientControlFrame,
} from "@orkestrator/protocol/terminal-websocket";

export type TerminalSocketPayload = {
  bytes?: Uint8Array;
  desynced?: boolean;
  generation: number;
  revision: number;
};

type Snapshot = { generation: number; revision: number };
type TerminalCallback = (payload: TerminalSocketPayload) => void;

type DesiredChannel = {
  sessionId: string;
  callbacks: Map<TerminalCallback, number>;
  ready: Promise<void>;
  resolveReady: () => void;
  readyResolved: boolean;
  channelId: number | null;
  pendingRequestId: number | null;
  generation: number | null;
  revision: number | null;
  awaitingSnapshot: boolean;
  requiresResubscribe: boolean;
  buffered: TerminalSocketPayload[];
  bufferedBytes: number;
  usable: boolean;
  unavailableNotified: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Consecutive failed subscription attempts, used to back off the retry. */
  subscribeAttempts: number;
};

type PendingOperation = {
  channel: DesiredChannel;
  operation: "input" | "resize";
  bytes: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
};

export type TerminalWebSocketClientOptions = {
  url: string;
  token?: string;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  subscriptionRetryDelayMs?: number;
  maxSubscriptionRetryDelayMs?: number;
  maxAwaitingSnapshotFrames?: number;
  maxAwaitingSnapshotBytes?: number;
  maxPendingOperations?: number;
  maxPendingOperationBytes?: number;
  operationTimeoutMs?: number;
  createSocket?: (url: string, protocols: string | string[]) => WebSocket;
  onFallbackRequired(): void;
  onSocketReady(): void;
  onChannelReady?(sessionId: string): void;
  onChannelUnavailable?(sessionId: string): void;
};

const DEFAULT_MAX_AWAITING_SNAPSHOT_FRAMES = 1_024;
const DEFAULT_MAX_PENDING_OPERATIONS = 1_024;
const DEFAULT_MAX_PENDING_OPERATION_BYTES = 2 * 1024 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

export class TerminalWebSocketClient {
  private readonly desired = new Map<string, DesiredChannel>();
  private readonly channels = new Map<number, DesiredChannel>();
  private readonly pendingRequests = new Map<number, DesiredChannel>();
  private readonly pendingOperations = new Map<number, PendingOperation>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private requestId = 0;
  private operationId = 0;
  private pendingOperationBytes = 0;
  private serverReady = false;
  private disposed = false;
  private token: string | undefined;

  constructor(private readonly options: TerminalWebSocketClientOptions) {
    this.token = options.token;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  subscribe(sessionId: string, callback: TerminalCallback): () => void {
    let channel = this.desired.get(sessionId);
    if (!channel) {
      let resolveReady = () => {};
      const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
      channel = {
        sessionId,
        callbacks: new Map(),
        ready,
        resolveReady,
        readyResolved: false,
        channelId: null,
        pendingRequestId: null,
        generation: null,
        revision: null,
        awaitingSnapshot: false,
        requiresResubscribe: false,
        buffered: [],
        bufferedBytes: 0,
        usable: false,
        unavailableNotified: false,
        retryTimer: null,
        subscribeAttempts: 0,
      };
      this.desired.set(sessionId, channel);
      this.ensureSocket();
      if (this.socket?.readyState === WebSocket.OPEN) this.sendSubscribe(channel);
    }
    channel.callbacks.set(callback, (channel.callbacks.get(callback) ?? 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const count = channel!.callbacks.get(callback) ?? 0;
      if (count <= 1) channel!.callbacks.delete(callback);
      else channel!.callbacks.set(callback, count - 1);
      if (channel!.callbacks.size > 0 || this.desired.get(sessionId) !== channel) return;
      this.removeChannel(channel!);
      if (this.desired.size === 0) this.closeIdleSocket();
    };
  }

  ready(sessionId: string): Promise<void> {
    return this.desired.get(sessionId)?.ready ?? Promise.resolve();
  }

  /**
   * Sends one input payload and returns a promise for its backend
   * acknowledgement, or `null` when this channel cannot carry it and the caller
   * should fall back to HTTP.
   *
   * The send itself is synchronous. Callers therefore preserve frame order
   * without waiting for the previous acknowledgement — making each keystroke
   * wait a full round trip is not a usable terminal on a high-latency link.
   */
  enqueueInput(sessionId: string, data: string): Promise<void> | null {
    const channel = this.usableChannel(sessionId);
    if (!channel || channel.generation === null) return null;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return null;

    const bytes = new TextEncoder().encode(data);
    const maxPayload = TERMINAL_WEBSOCKET_MAX_BINARY_BYTES - TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES;
    const chunks = this.splitUtf8(bytes, maxPayload);
    // A refused write says nothing about channel health, so it neither tears
    // the channel down nor throws: HTTP carries this payload instead.
    if (!this.hasOperationCapacity(chunks.length, bytes.byteLength)) return null;
    const completions: Promise<void>[] = [];
    try {
      for (const chunk of chunks) {
        const operationId = this.nextOperationId();
        const completion = this.registerOperation(operationId, channel, "input", chunk.byteLength);
        completions.push(completion);
        socket.send(encodeTerminalBinaryFrame({
          type: TERMINAL_BINARY_FRAME_TYPE.input,
          channelId: channel.channelId!,
          generation: channel.generation,
          revision: operationId,
          bytes: chunk,
        }));
      }
    } catch (error) {
      const sendError = this.asError(error, "Terminal input could not be sent");
      this.rejectChannelOperations(channel, sendError);
      this.markUnavailable(channel);
      socket.close(1011, "Terminal input send failed");
      return Promise.allSettled(completions).then(() => { throw sendError; });
    }
    return Promise.all(completions).then(() => undefined);
  }

  async sendInput(sessionId: string, data: string): Promise<boolean> {
    const completion = this.enqueueInput(sessionId, data);
    if (!completion) return false;
    await completion;
    return true;
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<boolean> {
    const channel = this.usableChannel(sessionId);
    if (!channel) return false;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (!this.hasOperationCapacity(1, 0)) return false;
    const operationId = this.nextOperationId();
    const completion = this.registerOperation(operationId, channel, "resize", 0);
    try {
      this.send({ type: "resize", channelId: channel.channelId!, operationId, cols, rows });
    } catch (error) {
      const sendError = this.asError(error, "Terminal resize could not be sent");
      this.rejectOperation(operationId, sendError);
      this.markUnavailable(channel);
      socket.close(1011, "Terminal resize send failed");
      await completion.catch(() => undefined);
      throw sendError;
    }
    await completion;
    return true;
  }

  observeSnapshot(sessionId: string, snapshot: Snapshot): void {
    const channel = this.desired.get(sessionId);
    if (!channel) return;
    // A snapshot computed before output this channel has already applied must
    // not rewind the cursor. Adopting it would make the next live frame look
    // non-contiguous and desynchronize a perfectly healthy channel.
    const stale = channel.generation === snapshot.generation
      && channel.revision !== null
      && snapshot.revision < channel.revision;
    // The server pins a channel's generation at subscribe time and never
    // advances it. A snapshot carrying a new one is therefore the first this
    // client has heard of the restart: adopting it without resubscribing would
    // make the next input frame disagree with the server about the generation.
    const generationChanged = channel.generation !== null
      && channel.generation !== snapshot.generation;
    if (!stale) {
      channel.generation = snapshot.generation;
      channel.revision = snapshot.revision;
    }
    channel.awaitingSnapshot = false;
    if (generationChanged) channel.requiresResubscribe = true;
    if (channel.requiresResubscribe) {
      if (channel.channelId !== null) this.unsubscribeForRecovery(channel);
      else channel.requiresResubscribe = false;
      this.scheduleSubscribe(channel, 0);
      return;
    }
    // Run after the caller awaiting the HTTP snapshot has applied it to xterm.
    setTimeout(() => {
      if (this.desired.get(sessionId) !== channel || channel.awaitingSnapshot) return;
      this.flushBuffered(channel);
      if (!channel.awaitingSnapshot) this.markReady(channel);
    }, 0);
  }

  observeSnapshotFailure(sessionId: string): void {
    const channel = this.desired.get(sessionId);
    if (!channel) return;
    channel.awaitingSnapshot = true;
    channel.requiresResubscribe = false;
    this.clearBuffered(channel);
    this.markUnavailable(channel);
    this.unsubscribeForRecovery(channel);
    this.scheduleSubscribe(channel);
  }

  updateToken(token: string): void {
    this.token = token;
    if (!this.socket || this.desired.size === 0) return;
    this.socket.close(1000, "Gateway credential changed");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const channel of this.desired.values()) {
      if (channel.retryTimer) clearTimeout(channel.retryTimer);
      this.resolveReady(channel);
    }
    this.rejectAllOperations(new Error("Terminal WebSocket client was disposed"));
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Gateway adapter disposed");
    this.channels.clear();
    this.pendingRequests.clear();
    this.desired.clear();
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible" || this.desired.size === 0) return;
    // Mobile WebViews can preserve an apparently-open but dead socket while
    // backgrounded. Rebuild from the authoritative desired registry.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const oldSocket = this.socket;
    this.socket = null;
    oldSocket?.close(1000, "Foreground reconciliation");
    this.resetChannelsForReconnect(new Error("Terminal WebSocket is reconnecting"));
    this.ensureSocket();
  };

  private ensureSocket(): void {
    if (this.disposed || this.desired.size === 0 || this.socket || this.reconnectTimer) return;
    const createSocket = this.options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols));
    let socket: WebSocket;
    try {
      socket = createSocket(this.options.url, TERMINAL_WEBSOCKET_SUBPROTOCOL);
    } catch {
      this.fallbackAndReconnect();
      return;
    }
    this.socket = socket;
    this.serverReady = false;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.socket !== socket) return;
      if (this.token) {
        this.send({ type: "authenticate", version: TERMINAL_WEBSOCKET_PROTOCOL_VERSION, token: this.token });
      }
    };
    socket.onmessage = (message) => this.onMessage(socket, message);
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.serverReady = false;
      this.resetChannelsForReconnect(new Error("Terminal WebSocket closed before the operation completed"));
      this.fallbackAndReconnect();
    };
  }

  private onMessage(socket: WebSocket, message: MessageEvent): void {
    if (socket !== this.socket) return;
    if (typeof message.data === "string") {
      let frame;
      try {
        frame = parseTerminalWebSocketServerControlFrame(message.data);
      } catch {
        socket.close(4004, "Malformed server control frame");
        return;
      }
      switch (frame.type) {
        case "ready":
          this.serverReady = true;
          this.reconnectAttempts = 0;
          this.options.onSocketReady();
          for (const channel of this.desired.values()) this.sendSubscribe(channel);
          break;
        case "subscribed": {
          const channel = this.pendingRequests.get(frame.requestId);
          this.pendingRequests.delete(frame.requestId);
          if (!channel || this.desired.get(channel.sessionId) !== channel) {
            this.send({ type: "unsubscribe", channelId: frame.channelId });
            return;
          }
          if (channel.pendingRequestId !== frame.requestId || frame.sessionId !== channel.sessionId) {
            socket.close(4004, "Mismatched subscription response");
            return;
          }
          channel.pendingRequestId = null;
          channel.channelId = frame.channelId;
          channel.generation = frame.targetGeneration;
          channel.subscribeAttempts = 0;
          this.channels.set(frame.channelId, channel);
          if (frame.recovery === "snapshot-required") {
            channel.revision = null;
            channel.awaitingSnapshot = true;
            channel.requiresResubscribe = false;
            this.clearBuffered(channel);
            this.markUnavailable(channel);
            this.emit(channel, {
              desynced: true,
              generation: frame.targetGeneration,
              revision: frame.targetRevision,
            });
          } else {
            channel.generation = frame.baseGeneration;
            channel.revision = frame.baseRevision;
            channel.awaitingSnapshot = false;
            channel.requiresResubscribe = false;
            this.markReady(channel);
          }
          this.resolveReady(channel);
          break;
        }
        case "desync": {
          const channel = this.channels.get(frame.channelId);
          if (!channel) return;
          channel.awaitingSnapshot = true;
          channel.requiresResubscribe = true;
          channel.revision = null;
          this.clearBuffered(channel);
          this.markUnavailable(channel);
          this.emit(channel, { desynced: true, generation: frame.generation, revision: frame.revision });
          break;
        }
        case "unsubscribed":
          this.channels.delete(frame.channelId);
          break;
        case "operation-result": {
          const pending = this.pendingOperations.get(frame.operationId);
          if (!pending) return;
          if (pending.channel.channelId !== frame.channelId || pending.operation !== frame.operation) {
            socket.close(4004, "Mismatched operation response");
            return;
          }
          if (frame.ok) this.resolveOperation(frame.operationId);
          else this.rejectOperation(frame.operationId, new Error(frame.message || `Terminal ${frame.operation} failed`));
          break;
        }
        case "error":
          if (frame.requestId !== undefined) {
            const channel = this.pendingRequests.get(frame.requestId);
            this.pendingRequests.delete(frame.requestId);
            if (channel && channel.pendingRequestId === frame.requestId) {
              channel.pendingRequestId = null;
              this.resolveReady(channel);
              this.markUnavailable(channel);
              this.scheduleSubscribe(channel);
            }
          }
          if (frame.channelId !== undefined) {
            const channel = this.channels.get(frame.channelId);
            if (channel) {
              this.rejectChannelOperations(channel, new Error(frame.message));
              this.markUnavailable(channel);
              this.unsubscribeForRecovery(channel);
              this.scheduleSubscribe(channel);
            }
          }
          if (frame.fatal) socket.close(4004, frame.code);
          break;
        case "lifecycle":
          break;
      }
      return;
    }
    void this.readBinaryData(message.data).then((data) => {
      if (socket !== this.socket) return;
      let frame;
      try {
        frame = decodeTerminalBinaryFrame(data);
      } catch {
        socket.close(4004, "Malformed server binary frame");
        return;
      }
      if (frame.type !== TERMINAL_BINARY_FRAME_TYPE.output) {
        socket.close(4004, "Server sent an input frame");
        return;
      }
      const channel = this.channels.get(frame.channelId);
      if (!channel) return;
      const payload: TerminalSocketPayload = {
        bytes: frame.bytes,
        generation: frame.generation,
        revision: frame.revision,
      };
      if (channel.awaitingSnapshot) {
        this.bufferAwaitingSnapshot(channel, payload);
        return;
      }
      this.applyOutput(channel, payload);
    }).catch(() => {
      if (socket === this.socket) socket.close(4004, "Unsupported server binary payload");
    });
  }

  private applyOutput(channel: DesiredChannel, payload: TerminalSocketPayload): void {
    if (payload.bytes === undefined) return;
    if (channel.generation !== payload.generation) {
      channel.awaitingSnapshot = true;
      channel.requiresResubscribe = true;
      channel.revision = null;
      this.clearBuffered(channel);
      this.bufferAwaitingSnapshot(channel, payload);
      this.markUnavailable(channel);
      this.emit(channel, { desynced: true, generation: payload.generation, revision: payload.revision });
      return;
    }
    const revision = channel.revision ?? 0;
    if (payload.revision <= revision) return;
    if (payload.revision !== revision + 1) {
      channel.awaitingSnapshot = true;
      channel.requiresResubscribe = true;
      channel.revision = null;
      this.clearBuffered(channel);
      this.bufferAwaitingSnapshot(channel, payload);
      this.markUnavailable(channel);
      this.emit(channel, { desynced: true, generation: payload.generation, revision: payload.revision });
      return;
    }
    channel.revision = payload.revision;
    this.emit(channel, payload);
    if (channel.channelId !== null) this.send({
      type: "ack",
      channelId: channel.channelId,
      generation: payload.generation,
      revision: payload.revision,
    });
  }

  private flushBuffered(channel: DesiredChannel): void {
    const buffered = channel.buffered.splice(0).sort((a, b) => a.revision - b.revision);
    channel.bufferedBytes = 0;
    for (const payload of buffered) {
      this.applyOutput(channel, payload);
      if (channel.awaitingSnapshot) return;
    }
  }

  private bufferAwaitingSnapshot(channel: DesiredChannel, payload: TerminalSocketPayload): void {
    const payloadBytes = payload.bytes?.byteLength ?? 0;
    const maxFrames = this.options.maxAwaitingSnapshotFrames ?? DEFAULT_MAX_AWAITING_SNAPSHOT_FRAMES;
    const maxBytes = this.options.maxAwaitingSnapshotBytes ?? TERMINAL_WEBSOCKET_CHANNEL_SOFT_BUFFER_BYTES;
    if (channel.buffered.length >= maxFrames || channel.bufferedBytes + payloadBytes > maxBytes) {
      this.clearBuffered(channel);
      channel.requiresResubscribe = true;
      this.markUnavailable(channel);
      return;
    }
    channel.buffered.push(payload);
    channel.bufferedBytes += payloadBytes;
  }

  private sendSubscribe(channel: DesiredChannel): void {
    if (
      channel.channelId !== null
      || channel.pendingRequestId !== null
      || this.socket?.readyState !== WebSocket.OPEN
      || !this.serverReady
      || this.desired.get(channel.sessionId) !== channel
    ) return;
    if (channel.retryTimer) {
      clearTimeout(channel.retryTimer);
      channel.retryTimer = null;
    }
    this.requestId += 1;
    const requestId = this.requestId;
    channel.pendingRequestId = requestId;
    this.pendingRequests.set(requestId, channel);
    this.send(channel.generation === null || channel.revision === null ? {
      type: "subscribe",
      requestId,
      sessionId: channel.sessionId,
    } : {
      type: "subscribe",
      requestId,
      sessionId: channel.sessionId,
      knownGeneration: channel.generation,
      knownRevision: channel.revision,
    });
  }

  private send(frame: TerminalWebSocketClientControlFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Terminal WebSocket is not open");
    }
    socket.send(JSON.stringify(frame));
  }

  private emit(channel: DesiredChannel, payload: TerminalSocketPayload): void {
    for (const callback of channel.callbacks.keys()) callback(payload);
  }

  private resolveReady(channel: DesiredChannel): void {
    if (channel.readyResolved) return;
    channel.readyResolved = true;
    channel.resolveReady();
  }

  /**
   * Readiness retires this terminal's compatibility transport, so it must mean
   * "this channel can carry the terminal", not merely "a snapshot arrived". A
   * channel with no live subscription — after a reconnect, or between an
   * unsubscribe and its replacement — has no transport of its own, and
   * announcing it would strand the terminal with none at all.
   */
  private markReady(channel: DesiredChannel): void {
    if (
      channel.usable
      || channel.channelId === null
      || this.desired.get(channel.sessionId) !== channel
    ) return;
    channel.usable = true;
    channel.unavailableNotified = false;
    this.options.onChannelReady?.(channel.sessionId);
  }

  private markUnavailable(channel: DesiredChannel): void {
    channel.usable = false;
    if (channel.unavailableNotified) return;
    channel.unavailableNotified = true;
    this.options.onChannelUnavailable?.(channel.sessionId);
  }

  private fallbackAndReconnect(): void {
    this.options.onFallbackRequired();
    if (this.disposed || this.desired.size === 0 || this.reconnectTimer) return;
    const base = this.options.reconnectDelayMs ?? 500;
    const cap = this.options.maxReconnectDelayMs ?? 10_000;
    const delay = Math.min(cap, base * (2 ** Math.min(this.reconnectAttempts, 5)));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delay);
  }

  /**
   * A denied subscription costs the backend two command invocations per
   * attempt, so a session the server will never accept must not be retried at a
   * fixed interval forever. `delay` is only supplied for a recovery resubscribe
   * the client itself initiated, which is not a failed attempt.
   */
  private scheduleSubscribe(channel: DesiredChannel, delay?: number): void {
    if (this.disposed || this.desired.get(channel.sessionId) !== channel || channel.retryTimer) return;
    let wait = delay;
    if (wait === undefined) {
      const base = this.options.subscriptionRetryDelayMs ?? 500;
      const cap = this.options.maxSubscriptionRetryDelayMs ?? 10_000;
      wait = Math.min(cap, base * (2 ** Math.min(channel.subscribeAttempts, 5)));
      channel.subscribeAttempts += 1;
    }
    channel.retryTimer = setTimeout(() => {
      channel.retryTimer = null;
      this.sendSubscribe(channel);
    }, wait);
  }

  private unsubscribeForRecovery(channel: DesiredChannel): void {
    if (channel.channelId !== null) {
      try {
        this.send({ type: "unsubscribe", channelId: channel.channelId });
      } catch {
        // Socket close reconciliation will finish cleanup.
      }
      this.channels.delete(channel.channelId);
      channel.channelId = null;
    }
    channel.requiresResubscribe = false;
    this.clearBuffered(channel);
    this.rejectChannelOperations(channel, new Error("Terminal channel is recovering"));
  }

  private removeChannel(channel: DesiredChannel): void {
    this.desired.delete(channel.sessionId);
    if (channel.retryTimer) clearTimeout(channel.retryTimer);
    channel.retryTimer = null;
    if (channel.pendingRequestId !== null) {
      this.pendingRequests.delete(channel.pendingRequestId);
      channel.pendingRequestId = null;
    }
    if (channel.channelId !== null) {
      try {
        this.send({ type: "unsubscribe", channelId: channel.channelId });
      } catch {
        // The channel is already locally removed; close recovery has nothing left to do.
      }
      this.channels.delete(channel.channelId);
      channel.channelId = null;
    }
    this.rejectChannelOperations(channel, new Error("Terminal channel was unsubscribed"));
    this.resolveReady(channel);
  }

  private resetChannelsForReconnect(error: Error): void {
    this.channels.clear();
    this.pendingRequests.clear();
    this.rejectAllOperations(error);
    for (const channel of this.desired.values()) {
      if (channel.retryTimer) clearTimeout(channel.retryTimer);
      channel.retryTimer = null;
      channel.channelId = null;
      channel.pendingRequestId = null;
      channel.awaitingSnapshot = true;
      channel.requiresResubscribe = false;
      this.clearBuffered(channel);
      this.markUnavailable(channel);
      this.emit(channel, {
        desynced: true,
        generation: channel.generation ?? 0,
        revision: channel.revision ?? 0,
      });
    }
  }

  private usableChannel(sessionId: string): DesiredChannel | null {
    const channel = this.desired.get(sessionId);
    if (!channel || !channel.usable || channel.channelId === null) return null;
    return channel;
  }

  private clearBuffered(channel: DesiredChannel): void {
    channel.buffered = [];
    channel.bufferedBytes = 0;
  }

  private splitUtf8(bytes: Uint8Array, maxPayload: number): Uint8Array[] {
    if (bytes.byteLength === 0) return [bytes];
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
      let end = Math.min(bytes.byteLength, offset + maxPayload);
      if (end < bytes.byteLength) {
        while (end > offset && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      }
      if (end === offset) end = Math.min(bytes.byteLength, offset + maxPayload);
      chunks.push(bytes.subarray(offset, end));
      offset = end;
    }
    return chunks;
  }

  private hasOperationCapacity(count: number, bytes: number): boolean {
    const maxCount = this.options.maxPendingOperations ?? DEFAULT_MAX_PENDING_OPERATIONS;
    const maxBytes = this.options.maxPendingOperationBytes ?? DEFAULT_MAX_PENDING_OPERATION_BYTES;
    return this.pendingOperations.size + count <= maxCount
      && this.pendingOperationBytes + bytes <= maxBytes;
  }

  private nextOperationId(): number {
    this.operationId = this.operationId >= Number.MAX_SAFE_INTEGER ? 1 : this.operationId + 1;
    while (this.pendingOperations.has(this.operationId)) {
      this.operationId = this.operationId >= Number.MAX_SAFE_INTEGER ? 1 : this.operationId + 1;
    }
    return this.operationId;
  }

  private registerOperation(
    operationId: number,
    channel: DesiredChannel,
    operation: PendingOperation["operation"],
    bytes: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.takeOperation(operationId);
        if (!pending) return;
        pending.reject(new Error(`Terminal ${operation} acknowledgement timed out`));
        this.markUnavailable(channel);
        this.socket?.close(4008, "Terminal operation acknowledgement timed out");
      }, this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
      this.pendingOperations.set(operationId, { channel, operation, bytes, timeout, resolve, reject });
      this.pendingOperationBytes += bytes;
    });
  }

  private resolveOperation(operationId: number): void {
    const pending = this.takeOperation(operationId);
    pending?.resolve();
  }

  private rejectOperation(operationId: number, error: Error): void {
    const pending = this.takeOperation(operationId);
    pending?.reject(error);
  }

  private takeOperation(operationId: number): PendingOperation | undefined {
    const pending = this.pendingOperations.get(operationId);
    if (!pending) return undefined;
    this.pendingOperations.delete(operationId);
    this.pendingOperationBytes -= pending.bytes;
    clearTimeout(pending.timeout);
    return pending;
  }

  private rejectChannelOperations(channel: DesiredChannel, error: Error): void {
    for (const [operationId, pending] of this.pendingOperations) {
      if (pending.channel === channel) this.rejectOperation(operationId, error);
    }
  }

  private rejectAllOperations(error: Error): void {
    for (const operationId of [...this.pendingOperations.keys()]) this.rejectOperation(operationId, error);
  }

  private asError(error: unknown, fallback: string): Error {
    return error instanceof Error ? error : new Error(fallback);
  }

  private closeIdleSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.rejectAllOperations(new Error("Terminal WebSocket closed because it is idle"));
    const socket = this.socket;
    this.socket = null;
    this.serverReady = false;
    socket?.close(1000, "No terminal subscriptions");
    this.channels.clear();
    this.pendingRequests.clear();
  }

  private async readBinaryData(data: unknown): Promise<ArrayBuffer | Uint8Array> {
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) return data;
    if (data instanceof Blob) return data.arrayBuffer();
    throw new TypeError("Unsupported WebSocket binary payload");
  }
}

export function terminalWebSocketUrl(baseUrl?: string): string {
  const httpUrl = baseUrl
    ? new URL(TERMINAL_WEBSOCKET_PATH, `${baseUrl}/`)
    : new URL(TERMINAL_WEBSOCKET_PATH, window.location.href);
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return httpUrl.toString();
}
