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
 *
 * The command node's hello (plan item 2011) is read from the page's gateway
 * (`window.orkestrator.hello`, the browser gateway and a local desktop window
 * on the direct transport) or, in an Electron IPC window, from main's
 * `nodes.gateway(commandNodeId)` snapshot. It is read when the client is made
 * (or on the first call, if the gateway API was installed later), after the
 * gateway's main stream reconnects from a drop, and in Electron when main
 * reports a connection change (`desktop-connections-changed`, sent after the
 * local backend restarts). A client made with a provisional id adopts the
 * installation id the hello proves (`provenNodeId`); `app-window-scope.ts`
 * moves the command scope to it.
 */

import { readableCodedError } from "@orkestrator/protocol/contract/ipc-error";
import { isProvisionalBackendId, type BackendId } from "@orkestrator/protocol/federation";
import type {
  NodeClient,
  NodeConnectionState,
  NodeInvokeOptions,
  ReadableSignal,
  Unlisten,
} from "@orkestrator/protocol/node-client";
import { createHelloNegotiation } from "./negotiation";
import { typedInvoke } from "./typed-invoke";
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

/** Main's event after a connection change (a local backend restart re-reads its hello). */
const DESKTOP_CONNECTIONS_CHANGED_EVENT = "desktop-connections-changed";

/** The hello in a `nodes.gateway` snapshot; see `snapshotHello` in `desktop-node-client.ts`. */
function gatewaySnapshotHello(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object" || !Object.hasOwn(snapshot, "hello")) {
    return undefined;
  }
  return (snapshot as { hello?: unknown }).hello ?? null;
}

/** The command scope's client: a `NodeClient` that can learn its proven id. */
export interface WindowOrkestratorClient extends NodeClient {
  /**
   * The installation id the command node's hello proved, or `null` while
   * none has. A client made with a provisional id takes it as its `nodeId`.
   */
  readonly provenNodeId: ReadableSignal<BackendId | null>;
}

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
): WindowOrkestratorClient {
  const unlisteners = new Set<Unlisten>();
  let disposed = false;
  let currentNodeId = nodeId;

  const negotiation = createHelloNegotiation(async () => {
    const api = host();
    if (typeof api?.hello === "function") return api.hello();
    if (typeof api?.nodes?.gateway === "function" && !isProvisionalBackendId(currentNodeId)) {
      return gatewaySnapshotHello(await api.nodes.gateway(currentNodeId));
    }
    return undefined;
  });
  const stopAdopting = negotiation.installationId.subscribe((proven) => {
    if (proven && isProvisionalBackendId(currentNodeId)) currentNodeId = proven;
  });

  /** Attached once the host exists: reconnects and main's connection changes re-read the hello. */
  let watchedHost: OrkestratorApi | undefined;
  let stopWatchingHost: Unlisten = () => {};
  const watchHost = () => {
    const api = host();
    if (disposed || !api || api === watchedHost) return;
    stopWatchingHost();
    watchedHost = api;
    const stops: Unlisten[] = [];
    const stream = api.eventStreamConnection;
    if (stream) {
      let dropped = false;
      stops.push(
        stream.subscribe((state) => {
          if (state === "disconnected") dropped = true;
          if (state === "connected" && dropped) {
            dropped = false;
            void negotiation.refresh();
          }
        }),
      );
    } else if (api.nodes && typeof api.listen === "function") {
      // Electron: main's own event, so listening opens no backend stream.
      stops.push(api.listen(DESKTOP_CONNECTIONS_CHANGED_EVENT, () => void negotiation.refresh()));
    }
    stopWatchingHost = () => {
      for (const stop of stops) stop();
    };
    void negotiation.ensure();
  };

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

  function invokeRaw<T>(
    command: string,
    args?: Readonly<Record<string, unknown>>,
    options?: NodeInvokeOptions,
  ): Promise<T> {
    const api = host();
    if (disposed) return Promise.reject(new Error("This node client is disposed."));
    if (!api) return Promise.reject(new Error("Orkestrator native backend is not available"));
    watchHost();
    const wireArgs = args as Record<string, unknown> | undefined;
    // An untyped call stays two arguments, as before; the envelope never
    // carries the arguments (plan item 1003).
    const sent = options?.envelope
      ? api.invoke<T>(command, wireArgs, {
          envelope: options.envelope as unknown as Record<string, unknown>,
        })
      : api.invoke<T>(command, wireArgs);
    // A registered code arrives as a `[code …] ` message prefix; every screen
    // shows `error.message`, so the prefix becomes the error's own `code`.
    return sent.catch((error: unknown) => {
      throw readableCodedError(error);
    });
  }

  watchHost();

  return {
    get nodeId() {
      return currentNodeId;
    },
    provenNodeId: negotiation.installationId,
    invoke: typedInvoke(invokeRaw),
    invokeRaw,
    listenRaw,
    listen: typedListen(listenRaw),
    eventStreamReady,
    terminal: {
      listenOutput: (sessionId, handler) =>
        listenRaw(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`, handler),
      outputReady: (sessionId) => eventStreamReady(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`),
    },
    connection,
    domains: negotiation.domains,
    capabilities: negotiation.capabilities,
    suspend() {},
    resume() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      negotiation.dispose();
      stopAdopting();
      stopWatchingHost();
      for (const unlisten of Array.from(unlisteners)) unlisten();
    },
  };
}
