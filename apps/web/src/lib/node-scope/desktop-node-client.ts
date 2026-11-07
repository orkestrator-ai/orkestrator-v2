/**
 * The Electron `NodeClient` (report §6.1, §6.3): another node through this
 * window's node scope in main, over the preload's `node(nodeId)` API (plan
 * item 2007). Main owns the scope, its grant and its event stream; the
 * renderer never sees a credential.
 *
 * The command node is not reached through `node(nodeId)`: main sends its
 * events on the top-level channel only, so a client for the window's own
 * command node is the window client (`createWindowOrkestratorClient`).
 *
 * Connection state is a pure function (`desktopConnectionState`) of the
 * preload's stream state for the node, whether it was ever connected, and
 * the last coded refusal main answered (`[code] text`, see `nodeRefusalCode`).
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  NodeClient,
  NodeConnectionState,
  ReadableSignal,
  Unlisten,
} from "@orkestrator/protocol/node-client";
import { createWindowOrkestratorClient } from "./command-client";
import { createListenerFanout } from "./listener-fanout";
import { constantSignal, createSignal } from "./signal";
import { typedListen } from "./typed-listen";

type OrkestratorApi = NonNullable<Window["orkestrator"]>;
type PreloadNodeApi = ReturnType<NonNullable<OrkestratorApi["node"]>>;
type PreloadStreamState = ReturnType<PreloadNodeApi["eventStreamConnection"]["state"]>;

/** Mirrors `TERMINAL_OUTPUT_EVENT_PREFIX` in `lib/native/node-transport.ts`. */
const TERMINAL_OUTPUT_EVENT_PREFIX = "terminal-output-";

/** The refusal codes main's node IPC answers with (2007, `node-ipc.ts`). */
export type NodeRefusalCode =
  "unknown-node" | "node-admin-refused" | "node-scope-closed" | "node-unavailable";

const REFUSAL_PREFIX = /^\[([a-z][a-z0-9-]{0,63})\] /;

/**
 * The code of a refusal that crossed the context bridge. Electron passes
 * only an error's message over IPC, so main leads it with `[code] `; the
 * preload also copies it to `error.code`. Either form is read.
 */
export function nodeRefusalCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && REFUSAL_PREFIX.test(`[${code}] `)) return code;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  return REFUSAL_PREFIX.exec(message)?.[1] ?? null;
}

export interface DesktopConnectionInputs {
  readonly stream: PreloadStreamState;
  readonly everConnected: boolean;
  /** The last refusal for the node's scope since it was last connected. */
  readonly refusal: string | null;
}

/**
 * - `live` while main delivers the node's stream (`connected`);
 * - `connecting` before the first open and while one is in flight;
 * - after a refusal or a drop: `lapsed` when the scope was closed or released
 *   under a listener (`node-scope-closed`, or a drop after it had connected:
 *   main revoked the grant and the next listen reopens it), `failed` when the
 *   node is unknown or did not open (`unknown-node`, `node-unavailable`, or
 *   a first open that never connected).
 */
export function desktopConnectionState(inputs: DesktopConnectionInputs): NodeConnectionState {
  if (inputs.stream === "connected") return "live";
  if (inputs.refusal === "node-scope-closed") return "lapsed";
  if (inputs.refusal === "unknown-node" || inputs.refusal === "node-unavailable") return "failed";
  if (inputs.stream === "disconnected") return inputs.everConnected ? "lapsed" : "failed";
  return "connecting";
}

export interface DesktopNodeClientOptions {
  readonly nodeId: BackendId;
  /** Defaults to `window.orkestrator`, read on every call. */
  readonly host?: () => OrkestratorApi | undefined;
  /**
   * The window's command node, which keeps the top-level API. Defaults to the
   * identity main proved for this window (`orkestratorDesktopIdentity`).
   */
  readonly commandNodeId?: BackendId | null;
}

const windowHost = (): OrkestratorApi | undefined =>
  typeof window === "undefined" ? undefined : window.orkestrator;

function windowCommandNodeId(): BackendId | null {
  if (typeof window === "undefined") return null;
  return (window.orkestratorDesktopIdentity?.backendId as BackendId | null | undefined) ?? null;
}

const NO_NODE_SCOPES = "This window cannot open other machines' scopes.";

export function createDesktopNodeClient(options: DesktopNodeClientOptions): NodeClient {
  const host = options.host ?? windowHost;
  const commandNodeId =
    options.commandNodeId === undefined ? windowCommandNodeId() : options.commandNodeId;
  if (commandNodeId && options.nodeId === commandNodeId) {
    return createWindowOrkestratorClient(options.nodeId, host);
  }

  const nodeId = options.nodeId;
  const nodeApi = (): PreloadNodeApi | undefined => host()?.node?.(nodeId);
  let disposed = false;
  let everConnected = false;
  let refusal: string | null = null;
  let watched: PreloadNodeApi | undefined;
  let stopWatching: Unlisten = () => {};

  const state = createSignal<NodeConnectionState>("connecting");
  const publish = () => {
    const stream = watched?.eventStreamConnection.state() ?? "idle";
    state.set(desktopConnectionState({ stream, everConnected, refusal }));
  };
  /** Follows the preload's state for this node once the preload API is there. */
  const watch = (api: PreloadNodeApi | undefined) => {
    if (!api || watched === api || disposed) return;
    stopWatching();
    watched = api;
    stopWatching = api.eventStreamConnection.subscribe((stream) => {
      if (stream === "connected") {
        everConnected = true;
        refusal = null;
      }
      publish();
    });
    if (api.eventStreamConnection.state() === "connected") everConnected = true;
    publish();
  };
  const noteRefusal = (error: unknown) => {
    const code = nodeRefusalCode(error);
    if (!code || code === "node-admin-refused" || disposed) return;
    refusal = code;
    publish();
  };
  watch(nodeApi());

  const listeners = createListenerFanout((event, deliver) => {
    const api = nodeApi();
    watch(api);
    return api ? api.listen(event, deliver) : () => {};
  });

  const listenRaw = <T>(event: string, handler: (payload: T) => void): Unlisten =>
    disposed ? () => {} : listeners.add(event, handler as (payload: unknown) => void);

  const eventStreamReady = (event?: string): Promise<void> => {
    if (disposed) return Promise.reject(new Error("This node client is disposed."));
    const api = nodeApi();
    if (!api) return Promise.reject(new Error(NO_NODE_SCOPES));
    watch(api);
    return api.eventStreamReady(event ?? "").catch((error: unknown) => {
      noteRefusal(error);
      throw error;
    });
  };

  const connection: ReadableSignal<NodeConnectionState> = state;

  return {
    nodeId,
    invokeRaw<T>(command: string, args?: Readonly<Record<string, unknown>>): Promise<T> {
      if (disposed) return Promise.reject(new Error("This node client is disposed."));
      const api = nodeApi();
      if (!api) return Promise.reject(new Error(NO_NODE_SCOPES));
      watch(api);
      return api
        .invoke<T>(command, args as Record<string, unknown> | undefined)
        .catch((error: unknown) => {
          noteRefusal(error);
          throw error;
        });
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
    // Main does not pass the node's negotiated domains yet (plan item 2011).
    domains: constantSignal(null),
    // Main owns the node's stream and closes it when the scope goes idle; a
    // suspended client only stops delivering, and resumes without a reopen.
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
      stopWatching();
      // Releasing the node's scope revokes its grant in main.
      void host()
        ?.nodes?.release(nodeId)
        .catch(() => undefined);
    },
  };
}
