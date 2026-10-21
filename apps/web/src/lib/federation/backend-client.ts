/**
 * A command and event surface bound to exactly one backend.
 *
 * Every federated read, write and subscription goes through one of these,
 * so its destination is fixed when the client is created and can never be
 * resolved from focus, a selection or a global. The envelope of every event
 * (which machine, which connection epoch) comes from the receiving
 * connection, never from the payload. No React, Electron or provider code
 * belongs here.
 */

import {
  GATEWAY_EVENT_CURSOR_PARAM,
  GatewayEventStreamState,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  readSseStream,
} from "@orkestrator/protocol/gateway-event-stream";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";
import type { ConnectionSummary } from "@orkestrator/protocol/connections";

export type BackendEventListener = (event: string, payload: unknown, epoch: number) => void;

export interface BackendClient {
  /** Catalogue entry this client is bound to (stable; never a route or port). */
  readonly connectionId: string;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  subscribe(listener: BackendEventListener): () => void;
  /** Ask the connection layer to keep this machine connected for this view. */
  observe(): Promise<ConnectionSummary | null>;
  release(): void;
}

/*
 * Desktop: the native broker owns routes, tunnels and secrets. One IPC
 * listener per renderer fans events out by the connection they arrived on.
 */

type DesktopBackendsApi = NonNullable<NonNullable<Window["orkestrator"]>["backends"]>;

const desktopListeners = new Map<string, Set<BackendEventListener>>();
let desktopDispatcher: (() => void) | null = null;

function ensureDesktopDispatcher(api: DesktopBackendsApi): void {
  if (desktopDispatcher) return;
  desktopDispatcher = api.onEvent((connectionId, epoch, event, payload) => {
    const listeners = desktopListeners.get(connectionId);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) listener(event, payload, epoch);
  });
}

export function desktopBackendsApi(): DesktopBackendsApi | null {
  if (typeof window === "undefined") return null;
  return window.orkestrator?.backends ?? null;
}

export function createDesktopBackendClient(
  connectionId: string,
  api: DesktopBackendsApi | null = desktopBackendsApi(),
): BackendClient {
  if (!api) throw new Error("This client cannot connect to several machines.");
  let observed = false;
  return {
    connectionId,
    invoke: <T>(command: string, args?: Record<string, unknown>) =>
      api.invoke<T>(connectionId, command, args ?? {}),
    subscribe(listener) {
      ensureDesktopDispatcher(api);
      const listeners = desktopListeners.get(connectionId) ?? new Set();
      desktopListeners.set(connectionId, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) desktopListeners.delete(connectionId);
      };
    },
    async observe() {
      const summary = await api.observe(connectionId);
      observed = true;
      return summary;
    },
    release() {
      if (!observed) return;
      observed = false;
      void api.unobserve(connectionId).catch(() => undefined);
    },
  };
}

/*
 * Hosted browser: a direct, independently authenticated HTTPS session per
 * backend. Never relayed through another backend; the other backend must
 * list this page's origin in its allowed origins.
 */

export type HttpBackendClientOptions = {
  connectionId: string;
  origin: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Connection-state hook for the runtime (open, closed, auth failure). */
  onTransport?: (state: "open" | "closed" | "unauthorized", detail?: string) => void;
};

const MAX_INVOKE_RESPONSE_BYTES = 32 * 1024 * 1024;

export function createHttpBackendClient(options: HttpBackendClientOptions): BackendClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const listeners = new Set<BackendEventListener>();
  let epoch = 1;
  let controller: AbortController | null = null;
  const headers = () => ({ authorization: `Bearer ${options.token}` });

  const startStream = () => {
    if (controller) return;
    const current = new AbortController();
    controller = current;
    void consume(current.signal);
  };

  const consume = async (signal: AbortSignal) => {
    const stream = new GatewayEventStreamState();
    const backoff = new ReconnectBackoff({
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      healthyAfterMs: 30_000,
    });
    while (!signal.aborted) {
      try {
        const url = new URL("/__orkestrator/events", options.origin);
        url.searchParams.set("excludeEvents", "terminal-output-");
        if (stream.cursor) url.searchParams.set(GATEWAY_EVENT_CURSOR_PARAM, stream.cursor);
        const response = await fetchImpl(url, {
          headers: headers(),
          credentials: "omit",
          mode: "cors",
          redirect: "error",
          signal,
        });
        if (response.status === 401) {
          options.onTransport?.("unauthorized", "The gateway token was rejected.");
          return;
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        backoff.connected();
        options.onTransport?.("open");
        await readSseStream(response.body, signal, (frame) => {
          if (!frame.data) return;
          const message = stream.accept(frame.data, frame.id);
          if (message.kind === "event") emit(message.event, message.payload);
          else if (message.kind === "resync") emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
        });
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      epoch += 1;
      options.onTransport?.("closed", "Connection lost; reconnecting.");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoff.nextDelayMs());
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  };

  const emit = (event: string, payload: unknown) => {
    for (const listener of Array.from(listeners)) listener(event, payload, epoch);
  };

  return {
    connectionId: options.connectionId,
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const response = await fetchImpl(new URL("/__orkestrator/invoke", options.origin), {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ command, args: args ?? {} }),
        credentials: "omit",
        mode: "cors",
        redirect: "error",
      });
      const text = await response.text();
      if (text.length > MAX_INVOKE_RESPONSE_BYTES) throw new Error("The response was too large.");
      let payload: { result?: T; error?: string } = {};
      try {
        payload = text ? (JSON.parse(text) as typeof payload) : {};
      } catch {
        if (response.ok) throw new Error("The backend returned malformed JSON.");
      }
      if (response.status === 401) {
        options.onTransport?.("unauthorized", "The gateway token was rejected.");
      }
      if (!response.ok) {
        throw new Error(payload.error ?? `Backend request failed with HTTP ${response.status}`);
      }
      return payload.result as T;
    },
    subscribe(listener) {
      listeners.add(listener);
      startStream();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          controller?.abort();
          controller = null;
        }
      };
    },
    async observe() {
      return null;
    },
    release() {
      controller?.abort();
      controller = null;
      listeners.clear();
    },
  };
}

/** Test seam: forget the desktop dispatcher between suites. */
export function resetDesktopBackendDispatcherForTests(): void {
  desktopDispatcher?.();
  desktopDispatcher = null;
  desktopListeners.clear();
}
