/**
 * Shared fixtures for the `web-gateway` browser API suites (`web-gateway.test.ts`,
 * `web-gateway-terminal.test.ts`, `window-shell.test.ts`): tracked gateway
 * constructors, mock `EventSource` and `WebSocket`, and the per-test reset of
 * every global those suites replace.
 */
import { afterEach, beforeEach, mock } from "bun:test";
import type { LogCapture } from "@orkestrator/protocol/testing/log-capture";
import {
  createBrowserGatewayApi as createUntrackedBrowserGatewayApi,
  disposeBrowserGatewayApi,
  installBrowserGatewayApi as installUntrackedBrowserGatewayApi,
  TERMINAL_TRANSPORT_STORAGE_KEY,
} from "./web-gateway";
import { decodeTerminalBinaryFrame } from "@orkestrator/protocol/terminal-websocket";

/** Every warning, as the old console spies counted them. */
export function gatewayWarnings(logs: LogCapture) {
  return logs.records().filter(({ level }) => level === "warn");
}

/**
 * Every gateway a test made, disposed after it. A gateway owns real timers and
 * window listeners (the cookie-session probe retries for ever with backoff), and
 * each of them calls whatever `globalThis.fetch` is installed when it fires. A
 * leftover one therefore lands requests in a later test's fetch mock, where
 * they count as that test's attempts.
 */
const createdGateways = new Set<object>();

export function createBrowserGatewayApi(
  ...args: Parameters<typeof createUntrackedBrowserGatewayApi>
): ReturnType<typeof createUntrackedBrowserGatewayApi> {
  const api = createUntrackedBrowserGatewayApi(...args);
  createdGateways.add(api);
  return api;
}

export function installBrowserGatewayApi(
  ...args: Parameters<typeof installUntrackedBrowserGatewayApi>
): void {
  installUntrackedBrowserGatewayApi(...args);
  const installed = (args[0] ?? window).orkestrator;
  if (installed) createdGateways.add(installed);
}

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalWebSocket = globalThis.WebSocket;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalGetEntriesByType = performance.getEntriesByType;
const originalDocumentReadyStateDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "readyState",
);
const originalWebkitDescriptor = Object.getOwnPropertyDescriptor(window, "webkit");
export const originalSetTimeout = globalThis.setTimeout;

export function pngBlob(width: number, height: number): Blob {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: "image/png" });
}
export type TestGatewayWindow = {
  location: Pick<Location, "protocol">;
  orkestrator?: Window["orkestrator"];
  orkestratorGateway?: Window["orkestratorGateway"];
};

export const EVENT_SOURCE_CONNECTING = 0;
const EVENT_SOURCE_OPEN = 1;
export const EVENT_SOURCE_CLOSED = 2;

export function gatewayControlFrame(
  event: "gateway.connected" | "gateway.reconcile-required",
  statusOrReason: string,
  id = "12345678:0",
): string {
  const payload =
    event === "gateway.connected"
      ? { status: statusOrReason, generation: "12345678", revision: 0 }
      : { reason: statusOrReason, generation: "12345678", latestRevision: 0 };
  return `id: ${id}\ndata: ${JSON.stringify({ event, payload })}\n\n`;
}

export class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((message: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(_type: string, _listener: () => void): void {}
  closed = false;
  /**
   * Mirrors the real `EventSource`: `CONNECTING` after a network failure, which
   * a browser would retry on its own, and `CLOSED` after an HTTP error.
   */
  readyState: number = EVENT_SOURCE_CONNECTING;

  constructor(
    public readonly url: string,
    public readonly options?: EventSourceInit,
  ) {
    MockEventSource.instances.push(this);
  }

  /** Drive a successful connection the way the browser would. */
  open(): void {
    this.readyState = EVENT_SOURCE_OPEN;
    this.onopen?.();
  }

  /** Fail the socket, either recoverably (browser retries) or fatally. */
  fail(readyState: number = EVENT_SOURCE_CLOSED): void {
    this.readyState = readyState;
    this.onerror?.();
  }

  close(): void {
    this.closed = true;
    this.readyState = EVENT_SOURCE_CLOSED;
  }
}

export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "orkestrator-terminal.v1";
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closeCode: number | undefined;
  closeReason: string | undefined;

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(data: string | ArrayBuffer | Uint8Array): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("Socket is not open");
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

export function sentControlFrames(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

export function decodeSentBinaryFrame(value: ArrayBufferLike | ArrayBufferView) {
  if (value instanceof ArrayBuffer) return decodeTerminalBinaryFrame(value);
  if (ArrayBuffer.isView(value)) {
    return decodeTerminalBinaryFrame(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  throw new TypeError("Unsupported mock WebSocket binary frame");
}

export function openTerminalSocket(socket: MockWebSocket): void {
  socket.open();
  socket.receive(JSON.stringify({ type: "ready", version: 1, socketId: "socket-test" }));
}

export function subscribeTerminalSocket(
  socket: MockWebSocket,
  sessionId: string,
  recovery: "current" | "snapshot-required" = "snapshot-required",
  channelId = 1,
  generation = 1,
  revision = 0,
): number {
  const request = sentControlFrames(socket).findLast(
    (frame) => frame.type === "subscribe" && frame.sessionId === sessionId,
  );
  if (!request || typeof request.requestId !== "number") {
    throw new Error(`No subscription request for ${sessionId}`);
  }
  socket.receive(
    JSON.stringify({
      type: "subscribed",
      requestId: request.requestId,
      sessionId,
      channelId,
      recovery,
      baseGeneration: recovery === "snapshot-required" ? null : generation,
      baseRevision: recovery === "snapshot-required" ? null : revision,
      targetGeneration: generation,
      targetRevision: revision,
    }),
  );
  return channelId;
}

export async function waitForCondition(
  condition: () => boolean,
  message = "Condition was not met",
  timeoutMs = 500,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (condition()) return resolve();
      if (Date.now() > deadline) return reject(new Error(message));
      originalSetTimeout(poll, 1);
    };
    poll();
  });
}

/** Registers the reset and restore every suite using these fixtures needs. */
export function useGatewayTestGlobals(): void {
  beforeEach(() => {
    delete window.orkestrator;
    delete window.orkestratorGateway;
    MockEventSource.instances = [];
    MockWebSocket.instances = [];
    localStorage.removeItem(TERMINAL_TRANSPORT_STORAGE_KEY);
  });

  afterEach(() => {
    for (const api of createdGateways) disposeBrowserGatewayApi(api);
    createdGateways.clear();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.WebSocket = originalWebSocket;
    localStorage.removeItem(TERMINAL_TRANSPORT_STORAGE_KEY);
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: originalGetEntriesByType,
    });
    if (originalDocumentReadyStateDescriptor) {
      Object.defineProperty(document, "readyState", originalDocumentReadyStateDescriptor);
    } else {
      Reflect.deleteProperty(document, "readyState");
    }
    if (originalWebkitDescriptor) {
      Object.defineProperty(window, "webkit", originalWebkitDescriptor);
    } else {
      delete (window as Window & { webkit?: unknown }).webkit;
    }
    globalThis.setTimeout = originalSetTimeout;
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
    delete window.__orkestratorClientPlatform;
    delete window.orkestrator;
    delete window.orkestratorGateway;
    mock.restore();
  });
}
