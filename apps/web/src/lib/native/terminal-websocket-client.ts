import {
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  parseTerminalWebSocketServerControlFrame,
  TERMINAL_BINARY_FRAME_TYPE,
  TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES,
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

type DesiredChannel = {
  sessionId: string;
  callbacks: Set<(payload: TerminalSocketPayload) => void>;
  ready: Promise<void>;
  resolveReady: () => void;
  readyResolved: boolean;
  channelId: number | null;
  generation: number | null;
  revision: number | null;
  inputSequence: number;
  awaitingSnapshot: boolean;
  requiresResubscribe: boolean;
  buffered: TerminalSocketPayload[];
};

export type TerminalWebSocketClientOptions = {
  url: string;
  token?: string;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  createSocket?: (url: string, protocols: string | string[]) => WebSocket;
  onFallbackRequired(): void;
  onSocketReady(): void;
};

export class TerminalWebSocketClient {
  private readonly desired = new Map<string, DesiredChannel>();
  private readonly channels = new Map<number, DesiredChannel>();
  private readonly pendingRequests = new Map<number, DesiredChannel>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private requestId = 0;
  private disposed = false;
  private token: string | undefined;

  constructor(private readonly options: TerminalWebSocketClientOptions) {
    this.token = options.token;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  subscribe(sessionId: string, callback: (payload: TerminalSocketPayload) => void): () => void {
    let channel = this.desired.get(sessionId);
    if (!channel) {
      let resolveReady = () => {};
      const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
      channel = {
        sessionId,
        callbacks: new Set(),
        ready,
        resolveReady,
        readyResolved: false,
        channelId: null,
        generation: null,
        revision: null,
        inputSequence: 0,
        awaitingSnapshot: false,
        requiresResubscribe: false,
        buffered: [],
      };
      this.desired.set(sessionId, channel);
      this.ensureSocket();
      if (this.socket?.readyState === WebSocket.OPEN) this.sendSubscribe(channel);
    }
    channel.callbacks.add(callback);
    return () => {
      channel!.callbacks.delete(callback);
      if (channel!.callbacks.size > 0 || this.desired.get(sessionId) !== channel) return;
      this.desired.delete(sessionId);
      if (channel!.channelId !== null) {
        this.send({ type: "unsubscribe", channelId: channel!.channelId });
        this.channels.delete(channel!.channelId);
      }
      if (this.desired.size === 0) this.closeIdleSocket();
    };
  }

  ready(sessionId: string): Promise<void> {
    return this.desired.get(sessionId)?.ready ?? Promise.resolve();
  }

  sendInput(sessionId: string, data: string): boolean {
    const channel = this.desired.get(sessionId);
    if (!channel || channel.channelId === null || channel.generation === null || this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    const bytes = new TextEncoder().encode(data);
    const maxPayload = TERMINAL_WEBSOCKET_MAX_BINARY_BYTES - TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES;
    let offset = 0;
    do {
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + maxPayload));
      channel.inputSequence += 1;
      this.socket.send(encodeTerminalBinaryFrame({
        type: TERMINAL_BINARY_FRAME_TYPE.input,
        channelId: channel.channelId,
        generation: channel.generation,
        revision: channel.inputSequence,
        bytes: chunk,
      }));
      offset += chunk.byteLength;
    } while (offset < bytes.byteLength);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const channel = this.desired.get(sessionId);
    if (!channel || channel.channelId === null || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.send({ type: "resize", channelId: channel.channelId, cols, rows });
    return true;
  }

  observeSnapshot(sessionId: string, snapshot: Snapshot): void {
    const channel = this.desired.get(sessionId);
    if (!channel) return;
    channel.generation = snapshot.generation;
    channel.revision = snapshot.revision;
    channel.awaitingSnapshot = false;
    if (channel.requiresResubscribe && channel.channelId !== null) {
      this.send({ type: "unsubscribe", channelId: channel.channelId });
      this.channels.delete(channel.channelId);
      channel.channelId = null;
      channel.requiresResubscribe = false;
      channel.buffered = [];
      this.sendSubscribe(channel);
      return;
    }
    // Run after the caller awaiting the HTTP snapshot has applied it to xterm.
    setTimeout(() => this.flushBuffered(channel!), 0);
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
    this.socket?.close(1000, "Gateway adapter disposed");
    this.socket = null;
    this.channels.clear();
    this.pendingRequests.clear();
    for (const channel of this.desired.values()) this.resolveReady(channel);
    this.desired.clear();
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible" || this.desired.size === 0) return;
    // Mobile WebViews can preserve an apparently-open but dead socket while
    // backgrounded. Rebuild from the authoritative desired registry.
    this.socket?.close(1000, "Foreground reconciliation");
    this.socket = null;
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
      this.channels.clear();
      this.pendingRequests.clear();
      for (const channel of this.desired.values()) {
        channel.channelId = null;
        channel.awaitingSnapshot = true;
        channel.requiresResubscribe = false;
        channel.buffered = [];
        this.emit(channel, {
          desynced: true,
          generation: channel.generation ?? 0,
          revision: channel.revision ?? 0,
        });
      }
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
          this.reconnectAttempts = 0;
          this.options.onSocketReady();
          for (const channel of this.desired.values()) this.sendSubscribe(channel);
          break;
        case "subscribed": {
          const channel = this.pendingRequests.get(frame.requestId);
          this.pendingRequests.delete(frame.requestId);
          if (!channel || this.desired.get(channel.sessionId) !== channel) return;
          channel.channelId = frame.channelId;
          channel.generation = frame.targetGeneration;
          channel.inputSequence = 0;
          this.channels.set(frame.channelId, channel);
          if (frame.recovery === "snapshot-required") {
            channel.revision = null;
            channel.awaitingSnapshot = true;
            channel.requiresResubscribe = false;
            channel.buffered = [];
            this.emit(channel, {
              desynced: true,
              generation: frame.targetGeneration,
              revision: frame.targetRevision,
            });
          } else {
            channel.generation = frame.baseGeneration;
            channel.revision = frame.baseRevision;
            channel.awaitingSnapshot = false;
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
          channel.buffered = [];
          this.emit(channel, { desynced: true, generation: frame.generation, revision: frame.revision });
          break;
        }
        case "unsubscribed":
          this.channels.delete(frame.channelId);
          break;
        case "error":
          if (frame.requestId !== undefined) {
            const channel = this.pendingRequests.get(frame.requestId);
            this.pendingRequests.delete(frame.requestId);
            if (channel) this.resolveReady(channel);
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
        channel.buffered.push(payload);
        return;
      }
      this.applyOutput(channel, payload);
    });
  }

  private applyOutput(channel: DesiredChannel, payload: TerminalSocketPayload): void {
    if (payload.bytes === undefined) return;
    if (channel.generation !== payload.generation) {
      channel.awaitingSnapshot = true;
      channel.requiresResubscribe = true;
      channel.revision = null;
      channel.buffered = [payload];
      this.emit(channel, { desynced: true, generation: payload.generation, revision: payload.revision });
      return;
    }
    const revision = channel.revision ?? 0;
    if (payload.revision <= revision) return;
    if (payload.revision !== revision + 1) {
      channel.awaitingSnapshot = true;
      channel.requiresResubscribe = true;
      channel.revision = null;
      channel.buffered = [payload];
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
    for (const payload of buffered) this.applyOutput(channel, payload);
  }

  private sendSubscribe(channel: DesiredChannel): void {
    if (channel.channelId !== null || this.socket?.readyState !== WebSocket.OPEN) return;
    this.requestId += 1;
    const requestId = this.requestId;
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
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private emit(channel: DesiredChannel, payload: TerminalSocketPayload): void {
    for (const callback of channel.callbacks) callback(payload);
  }

  private resolveReady(channel: DesiredChannel): void {
    if (channel.readyResolved) return;
    channel.readyResolved = true;
    channel.resolveReady();
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

  private closeIdleSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, "No terminal subscriptions");
    this.socket = null;
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
