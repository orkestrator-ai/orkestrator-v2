/**
 * The command scope's `NodeClient`, as a view over today's `window.orkestrator`
 * (the Electron preload, or the browser gateway API installed at boot). On
 * both hosts the command node keeps that path: Electron sends command-node
 * events on the top-level channel only (`node(commandNodeId)` receives none),
 * and the browser page's gateway is already the command node's transport.
 *
 * Every renderer call to the command node goes through this client (plan item
 * 2010): `@/lib/native/backend` `invoke` and `@/lib/native/events` `listen`
 * are wrappers over the command scope, and the components that used to read
 * `window.orkestrator.listen` call `commandClient().listenRaw`. The
 * prefetched-response cache is the scope's (`scope.prefetched`, consulted by
 * `invokeInScope`), not this client's. `window.orkestrator` is read on every
 * call because the gateway API may be installed after this module loads.
 *
 * `suspend` and `resume` do nothing: the command node's streams belong to the
 * window's transport, and the command scope is always live. `dispose` drops
 * only the listeners registered through this client; it never tears down
 * `window.orkestrator`.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  NodeClient,
  NodeConnectionState,
  ReadableSignal,
  Unlisten,
} from "@orkestrator/protocol/node-client";
import { constantSignal } from "./signal";
import { typedListen } from "./typed-listen";

type OrkestratorApi = NonNullable<Window["orkestrator"]>;
type GatewayStreamState = ReturnType<NonNullable<OrkestratorApi["eventStreamConnection"]>["state"]>;

/** Mirrors `TERMINAL_OUTPUT_EVENT_PREFIX` in `lib/native/node-transport.ts`. */
const TERMINAL_OUTPUT_EVENT_PREFIX = "terminal-output-";

function connectionStateOf(state: GatewayStreamState | undefined): NodeConnectionState {
  // Electron reports transport state through `connections`, not the stream.
  if (state === undefined || state === "connected") return "live";
  return "connecting";
}

const windowHost = (): OrkestratorApi | undefined =>
  typeof window === "undefined" ? undefined : window.orkestrator;

/**
 * Whether the window's command transport is installed yet. Code that
 * subscribes once and must retry until the transport exists (a module-level
 * sync started before the gateway API is installed) asks this first; a
 * `listenRaw` without a transport registers nothing.
 */
export function commandTransportAvailable(
  host: () => OrkestratorApi | undefined = windowHost,
): boolean {
  return typeof host()?.listen === "function";
}

/**
 * The browser gateway's raw main-stream state (`idle | connecting | connected
 * | disconnected`), for the transport-connectivity owner that pauses reads
 * only after a real failure. `NodeConnectionState` folds `idle`, `connecting`
 * and `disconnected` into `connecting`, which cannot tell a first connect from
 * an outage. Electron has none; its connection list reports outages.
 */
export function commandEventStreamConnection(
  host: () => OrkestratorApi | undefined = windowHost,
): OrkestratorApi["eventStreamConnection"] {
  return host()?.eventStreamConnection;
}

export function createWindowOrkestratorClient(
  nodeId: BackendId,
  host: () => OrkestratorApi | undefined = windowHost,
): NodeClient {
  const unlisteners = new Set<Unlisten>();
  let disposed = false;

  const listenRaw = <T>(event: string, handler: (payload: T) => void): Unlisten => {
    const api = host();
    // A host without `listen` (a partial page API, as some windows and
    // fixtures install) registers nothing, as the direct callers did.
    if (disposed || typeof api?.listen !== "function") return () => {};
    const stop = api.listen<T>(event, handler);
    let active = true;
    const unlisten = () => {
      if (!active) return;
      active = false;
      unlisteners.delete(unlisten);
      stop();
    };
    unlisteners.add(unlisten);
    return unlisten;
  };

  const eventStreamReady = (event?: string): Promise<void> => {
    const api = host();
    if (!event || !api?.eventStreamReady) return Promise.resolve();
    return api.eventStreamReady(event);
  };

  const connection: ReadableSignal<NodeConnectionState> = {
    get: () => connectionStateOf(host()?.eventStreamConnection?.state()),
    subscribe(listener) {
      const stream = host()?.eventStreamConnection;
      if (!stream) return () => {};
      return stream.subscribe((state) => listener(connectionStateOf(state)));
    },
  };

  return {
    nodeId,
    invokeRaw<T>(command: string, args?: Readonly<Record<string, unknown>>): Promise<T> {
      const api = host();
      if (disposed) return Promise.reject(new Error("This node client is disposed."));
      if (!api) return Promise.reject(new Error("Orkestrator native backend is not available"));
      return api.invoke<T>(command, args as Record<string, unknown> | undefined);
    },
    listenRaw,
    listen: typedListen(listenRaw),
    eventStreamReady,
    terminal: {
      listenOutput: (sessionId, handler) =>
        listenRaw(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`, handler),
      outputReady: (sessionId) => eventStreamReady(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`),
    },
    connection,
    // The renderer does not parse the command node's hello yet (plan item 2011).
    domains: constantSignal(null),
    suspend() {},
    resume() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unlisten of Array.from(unlisteners)) unlisten();
    },
  };
}
