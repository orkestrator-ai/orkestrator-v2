/**
 * The browser and iOS `NodeClient` (report §6.1, §6.2): one node's commands,
 * events and terminals over its own `createNodeTransport` (plan item 2002),
 * with no global state. The page's command node keeps the window's gateway
 * (`createWindowOrkestratorClient`); this client is for every other node a
 * page talks to, opened by the node-client registry (plan item 2004), which
 * also owns the grant: the client holds only the credential it was given.
 *
 * Connection state is a small pure function of three inputs, recomputed on
 * every change (`browserConnectionState`): whether the transport was created
 * unavailable, whether the node refused the credential since it was last set,
 * and the main stream's state.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  NodeClient,
  NodeConnectionState,
  ReadableSignal,
  Unlisten,
} from "@orkestrator/protocol/node-client";
import {
  createNodeTransport,
  TERMINAL_OUTPUT_EVENT_PREFIX,
  type GatewayEventStreamConnectionState,
  type NodeTransport,
  type NodeTransportOptions,
} from "@/lib/native/node-transport";
import { createListenerFanout } from "./listener-fanout";
import { constantSignal, createSignal } from "./signal";

export interface BrowserNodeClientOptions {
  readonly nodeId: BackendId;
  /**
   * The node's transport settings. The client creates the transport and owns
   * it; `onCredentialRejected` is still called, after the client has marked
   * itself `lapsed`.
   */
  readonly transport: NodeTransportOptions;
  /** Test seam; production uses `createNodeTransport`. */
  readonly createTransport?: (options: NodeTransportOptions) => NodeTransport;
}

export interface BrowserNodeClient extends NodeClient {
  /** The node's normalized base URL (`null` only for the page's own gateway). */
  readonly baseUrl: string | null;
  /** The URL of a gateway path on this node, for media and downloads. */
  url(pathname: string): string;
  /**
   * Swaps the bearer (a renewed or reopened grant) without a reload, and
   * clears `lapsed`: the next refusal sets it again.
   */
  setCredential(token: string): void;
}

export interface BrowserConnectionInputs {
  readonly unavailable: boolean;
  readonly credentialRejected: boolean;
  readonly stream: GatewayEventStreamConnectionState;
}

/**
 * - an unavailable transport (`unavailableReason`) never connects: `failed`;
 * - a refused credential is `lapsed` until a new one is set or the stream
 *   opens again (a cookie session that came back);
 * - otherwise `live` exactly while the main stream is connected, and
 *   `connecting` before its first open, while idle, and while it retries.
 *
 * `resyncing` is not reported yet: the gateway signals a gap with the
 * `native-event-stream-connected` event, and the stores' resync is not
 * tracked by the transport (plan item 4002 owns tiers and resync).
 */
export function browserConnectionState(inputs: BrowserConnectionInputs): NodeConnectionState {
  if (inputs.unavailable) return "failed";
  if (inputs.credentialRejected) return "lapsed";
  return inputs.stream === "connected" ? "live" : "connecting";
}

export function createBrowserNodeClient(options: BrowserNodeClientOptions): BrowserNodeClient {
  const unavailable = Boolean(options.transport.unavailableReason);
  let credentialRejected = false;
  let disposed = false;

  const state = createSignal<NodeConnectionState>("connecting");
  let transport: NodeTransport | null = null;
  const publish = () => {
    if (!transport) return;
    state.set(
      browserConnectionState({
        unavailable,
        credentialRejected,
        stream: transport.eventStreamConnection.state(),
      }),
    );
  };

  const make = options.createTransport ?? createNodeTransport;
  const transportOptions = {
    ...options.transport,
    onCredentialRejected: () => {
      if (disposed) return;
      credentialRejected = true;
      publish();
      options.transport.onCredentialRejected?.();
    },
  } as NodeTransportOptions;
  const created = make(transportOptions);
  transport = created;
  const stopWatchingStream = created.eventStreamConnection.subscribe((stream) => {
    if (stream === "connected") credentialRejected = false;
    publish();
  });
  publish();

  const listeners = createListenerFanout((event, deliver) => created.listen(event, deliver));
  const pendingReady = new Set<() => void>();

  const listenRaw = <T>(event: string, handler: (payload: T) => void): Unlisten =>
    disposed ? () => {} : listeners.add(event, handler as (payload: unknown) => void);

  const mainStreamReady = (): Promise<void> => {
    if (created.eventStreamConnection.state() === "connected") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        stop();
        pendingReady.delete(onDispose);
      };
      const onDispose = () => {
        settle();
        reject(new Error("This node client is disposed."));
      };
      const stop = created.eventStreamConnection.subscribe((stream) => {
        if (stream !== "connected") return;
        settle();
        resolve();
      });
      pendingReady.add(onDispose);
    });
  };

  const eventStreamReady = (event?: string): Promise<void> => {
    if (disposed) return Promise.reject(new Error("This node client is disposed."));
    return event ? created.eventStreamReady(event) : mainStreamReady();
  };

  const connection: ReadableSignal<NodeConnectionState> = state;

  return {
    nodeId: options.nodeId,
    baseUrl: created.baseUrl,
    url: (pathname) => created.url(pathname),
    setCredential(token) {
      if (disposed) return;
      created.setCredential(token);
      credentialRejected = false;
      publish();
    },
    invokeRaw<T>(command: string, args?: Readonly<Record<string, unknown>>): Promise<T> {
      if (disposed) return Promise.reject(new Error("This node client is disposed."));
      return created.invoke<T>(command, args as Record<string, unknown> | undefined);
    },
    listenRaw,
    eventStreamReady,
    terminal: {
      listenOutput: (sessionId, handler) =>
        listenRaw(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`, handler),
      outputReady: (sessionId) => eventStreamReady(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`),
    },
    connection,
    // The node's hello is not parsed here yet (plan item 2011).
    domains: constantSignal(null),
    suspend() {
      if (!disposed) listeners.suspend();
    },
    resume() {
      if (!disposed) listeners.resume();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.close();
      for (const cancel of Array.from(pendingReady)) cancel();
      stopWatchingStream();
      created.dispose();
    },
  };
}
