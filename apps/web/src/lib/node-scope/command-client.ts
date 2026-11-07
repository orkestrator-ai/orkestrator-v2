/**
 * The command scope's `NodeClient`, as a view over today's `window.orkestrator`
 * (the Electron preload, or the browser gateway API installed at boot).
 *
 * Behaviour-neutral by design: nothing calls it yet. Plan item 2010 routes
 * `lib/native/backend.ts` `invoke` and `lib/native/events.ts` `listen` through
 * it and moves the prefetched-response cache onto the scope; until then those
 * wrappers keep calling `window.orkestrator` themselves, so this client does
 * not consult the prefetched cache. `window.orkestrator` is read on every
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

type OrkestratorApi = NonNullable<Window["orkestrator"]>;
type GatewayStreamState = ReturnType<NonNullable<OrkestratorApi["eventStreamConnection"]>["state"]>;

/** Mirrors `TERMINAL_OUTPUT_EVENT_PREFIX` in `lib/native/web-gateway.ts`. */
const TERMINAL_OUTPUT_EVENT_PREFIX = "terminal-output-";

function connectionStateOf(state: GatewayStreamState | undefined): NodeConnectionState {
  // Electron reports transport state through `connections`, not the stream.
  if (state === undefined || state === "connected") return "live";
  return "connecting";
}

export function createWindowOrkestratorClient(
  nodeId: BackendId,
  host: () => OrkestratorApi | undefined = () => window.orkestrator,
): NodeClient {
  const unlisteners = new Set<Unlisten>();
  let disposed = false;

  const listenRaw = <T>(event: string, handler: (payload: T) => void): Unlisten => {
    const api = host();
    if (disposed || !api) return () => {};
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
