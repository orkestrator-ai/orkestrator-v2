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
 *
 * The node's hello comes from main, which reads it for the node scope's
 * connection (once per connection epoch) and puts it in the
 * `orkestrator:nodes:gateway` snapshot (plan item 2011). The client asks for
 * it when the node's stream first connects and again after every drop, so
 * `domains` and `capabilities` follow the node's connection generation.
 */

import { readableCodedError } from "@orkestrator/protocol/contract/ipc-error";
import { nodeRefusalCode } from "@orkestrator/protocol/contract/node-refusal";
import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  NodeClient,
  NodeConnectionState,
  NodeInvokeOptions,
  ReadableSignal,
  Unlisten,
} from "@orkestrator/protocol/node-client";
import { createWindowOrkestratorClient } from "./command-client";
import { createListenerFanout } from "./listener-fanout";
import { createHelloNegotiation } from "./negotiation";
import { createSignal } from "./signal";
import { typedInvoke } from "./typed-invoke";
import { typedListen } from "./typed-listen";

type OrkestratorApi = NonNullable<Window["orkestrator"]>;
type PreloadNodeApi = ReturnType<NonNullable<OrkestratorApi["node"]>>;
type PreloadStreamState = ReturnType<PreloadNodeApi["eventStreamConnection"]["state"]>;

/** Mirrors `TERMINAL_OUTPUT_EVENT_PREFIX` in `lib/native/node-transport.ts`. */
const TERMINAL_OUTPUT_EVENT_PREFIX = "terminal-output-";

/**
 * The code of a refusal that crossed the context bridge (`[code] text`, or
 * `error.code` the preload set). The codes main's node IPC answers with are
 * `DesktopNodeRefusalCode` (2007, `node-ipc.ts`).
 */
export { nodeRefusalCode };

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

/**
 * The hello in a `nodes.gateway` snapshot: the hello, `null` when main read
 * none (a node that predates it), or `undefined` when the snapshot has no
 * answer (the scope is not open, or main could not tell).
 */
export function snapshotHello(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object" || !Object.hasOwn(snapshot, "hello")) {
    return undefined;
  }
  return (snapshot as { hello?: unknown }).hello ?? null;
}

/** The preview store's view of a client that addresses its node's previews (plan item 3012). */
interface PreviewAddressing {
  resolvePreviewUrl(url: string): string;
}

/**
 * Another node's address-bar preview, as this window sends it to main: the
 * canonical address, unchanged. The tab's attach names the node
 * (`previewNodeFor`), and main's preview runtime for that node loads it
 * through the node's own gateway on its current route (`nodePreviewUrl` in
 * `apps/desktop/electron/node-previews.ts`). Resolving here against the
 * window's gateway, the default for a client without this, would load the
 * command node's page in the leaf's view (4006 Finding 1).
 */
export function desktopNodePreviewUrl(url: string): string {
  return url;
}

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
  const negotiation = createHelloNegotiation(async () => {
    const nodes = host()?.nodes;
    return nodes ? snapshotHello(await nodes.gateway(nodeId)) : undefined;
  });
  /** The stream dropped since the hello was last read: the next open may be a new generation. */
  let droppedSinceHello = false;
  const noteStream = (stream: PreloadStreamState) => {
    if (stream === "disconnected") droppedSinceHello = true;
    if (stream !== "connected") return;
    if (droppedSinceHello) {
      droppedSinceHello = false;
      void negotiation.refresh();
    } else {
      void negotiation.ensure();
    }
  };
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
      noteStream(stream);
      publish();
    });
    const current = api.eventStreamConnection.state();
    if (current === "connected") everConnected = true;
    noteStream(current);
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

  function invokeRaw<T>(
    command: string,
    args?: Readonly<Record<string, unknown>>,
    options?: NodeInvokeOptions,
  ): Promise<T> {
    if (disposed) return Promise.reject(new Error("This node client is disposed."));
    const api = nodeApi();
    if (!api) return Promise.reject(new Error(NO_NODE_SCOPES));
    watch(api);
    const wireArgs = args as Record<string, unknown> | undefined;
    // The envelope crosses IPC without the arguments (plan item 1003); an
    // untyped call stays two arguments, as before.
    const sent = options?.envelope
      ? api.invoke<T>(command, wireArgs, {
          envelope: options.envelope as unknown as Record<string, unknown>,
        })
      : api.invoke<T>(command, wireArgs);
    // A registered code arrives as a `[code …] ` message prefix; every screen
    // shows `error.message`, so the prefix becomes the error's own `code`.
    return sent.catch((error: unknown) => {
      const readable = readableCodedError(error);
      noteRefusal(readable);
      throw readable;
    });
  }

  const client: NodeClient & PreviewAddressing = {
    nodeId,
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
    resolvePreviewUrl: desktopNodePreviewUrl,
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
      negotiation.dispose();
      listeners.close();
      stopWatching();
      // Releasing the node's scope revokes its grant in main.
      void host()
        ?.nodes?.release(nodeId)
        .catch(() => undefined);
    },
  };
  return client;
}
