/**
 * The browser's per-node client registry (report §6.2 steps 4-5, plan item
 * 2004): for every leaf a window works with, one short-lived workspace grant
 * from the command node and one `NodeClient` over that leaf's own transport.
 *
 * - **One grant per (window, node)** (Decision 13.5 A). `acquire` is
 *   ref-counted: the first opens the grant, later ones share it, and the last
 *   release revokes it.
 * - **Direct first, relay fallback** (Decision 13.4 A): the grant is opened by
 *   `openLeafWorkspace`, which probes the leaf's direct origins with the grant
 *   and otherwise answers the command node's relay base.
 * - **In memory only.** The grant lives in this module's closures, never in
 *   `sessionStorage`.
 * - **Renewal, lapse and reopen without a reload.** `keepWorkspaceAlive`
 *   renews; a failed renewal, or the leaf refusing the credential, opens a new
 *   grant, clears that node's protected rich content and hands the transport
 *   the new bearer (`setCredential`, which reopens its streams). Only a route
 *   change (direct to relay, or another origin) replaces the transport, and
 *   even then the holders keep the same client object and listeners.
 * - **`pagehide` revokes** every grant with a keepalive `close_node_workspace`
 *   that outlives the page; a page restored from the back/forward cache opens
 *   new ones. Before this registry nothing closed a grant on `pagehide`.
 * - **Leaf terminals use the WebSocket transport** (§6.2 "Connection
 *   budget"); the origin-wide opt-in key still decides it for the command
 *   node only.
 * - **Relayed main streams share one request** once two or more relayed
 *   leaves are warm at once (plan item 5005, `multiplexed-relay-stream.ts`),
 *   and fall back to one stream each on a command node without the route.
 *
 * Effect: each grant's lifetime is a child of its node's `Lifetime` (an
 * Effect `Scope`), whose finalizers stop the renewal and revoke the grant, so
 * replacing, releasing, `pagehide` and disposing all end a grant the same way.
 * Opening a grant is an Effect with a per-attempt timeout and a bounded,
 * capped exponential retry (`Schedule`); interrupting it (a release while it
 * runs) revokes a grant that arrives late. Callers see promises only.
 *
 * In a browser or the iOS app, a workspace shown in the window's own tree
 * acquires its leaf here through `openLeafScope` (plan item 4001,
 * `lib/federation/in-tree-scopes.ts`); the desktop opens leaves through main's
 * node scopes instead.
 */

import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  NegotiatedDomains,
  NodeClient,
  NodeConnectionState,
  NodeInvokeOptions,
  ReadableSignal,
  Unlisten,
} from "@orkestrator/protocol/node-client";
import { clearProtectedRichContent } from "@/lib/chat/rich-content-reset";
import {
  resolveGatewayApiUrl,
  resolveNodeBrowserPreviewUrl,
  resolveNodeGatewayUrl,
  resolveNodeLoopbackBaseUrl,
} from "@/lib/gateway-url";
import {
  GATEWAY_PREFIX,
  TERMINAL_OUTPUT_EVENT_PREFIX,
  type NodeTransportLifecycle,
  type NodeTransportOptions,
} from "@/lib/native/node-transport";
import { browserWindowLifecycle } from "@/lib/native/window-shell";
import { commandScopeInvoke } from "@/lib/portal/command-scope";
import {
  closeLeafWorkspace,
  keepWorkspaceAlive,
  openLeafWorkspace,
  type CommandNodeInvoke,
  type KeepWorkspaceAliveOptions,
  type LeafWorkspace,
  type WorkspaceConnectionPath,
} from "@/lib/portal/workspaces";
import { createBrowserNodeClient } from "./browser-node-client";
import { Lifetime } from "./lifetime";
import { createListenerFanout } from "./listener-fanout";
import {
  createMultiplexedRelayStreams,
  type MultiplexedRelayStreams,
} from "./multiplexed-relay-stream";
import type { ExternalLoopbackAddressing } from "./external-loopback";
import type { NodeScope, NodeScopeTier } from "./node-scope";
import { createSignal } from "./signal";
import type { WindowScope } from "./window-scope";
import { typedInvoke } from "./typed-invoke";
import { typedListen } from "./typed-listen";

/** How a leaf is reached right now; shown in the info panel. */
export interface LeafRoute extends WorkspaceConnectionPath {
  /** Where commands and streams go: the leaf's origin, or the relay base. */
  readonly baseUrl: string;
  /** The command node's relay base for this leaf, whichever path is in use. */
  readonly relayBaseUrl: string;
}

/**
 * A leaf's client, as handed to one holder. Every `acquire` gets its own: its
 * listeners are its own, and `dispose()` releases exactly its reference.
 */
export interface LeafNodeClient extends NodeClient, ExternalLoopbackAddressing {
  readonly route: ReadableSignal<LeafRoute>;
  /** The current route's base URL (`route.get().baseUrl`). */
  readonly baseUrl: string;
  /** A gateway path on the current route, for a `fetch` that carries this client's bearer. */
  url(pathname: string): string;
  /**
   * A gateway path for an element or document load (`<img>`, a link, a
   * download). Such a load cannot carry the grant, so it always goes through
   * the command node's relay, on this page's own session.
   */
  resolveMediaUrl(pathname: string): string;
  /** A loopback URL on the leaf, through its loopback proxy (relayed, as media). */
  resolveLoopbackUrl(url: string): string;
  /**
   * A loopback page on the leaf for a preview iframe. Relayed even for a
   * direct leaf: no grant cookie exists, and a frame cannot send a bearer
   * (report §6.2 step 5).
   */
  resolvePreviewUrl(url: string): string;
}

/** What the registry needs of the client over one transport (the browser `NodeClient`). */
export interface LeafTransportClient extends NodeClient {
  readonly baseUrl: string | null;
  url(pathname: string): string;
  setCredential(token: string): void;
}

export interface LeafTransportClientOptions {
  readonly nodeId: BackendId;
  readonly transport: NodeTransportOptions;
}

/** Retry policy for opening a grant (first open and every reopen). */
export interface GrantOpenPolicy {
  /** One attempt (the open command and the direct probes) may take this long. */
  readonly attemptTimeoutMs: number;
  /** Retries after the first attempt. */
  readonly retries: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
}

export const DEFAULT_GRANT_OPEN_POLICY: GrantOpenPolicy = {
  attemptTimeoutMs: 20_000,
  retries: 3,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 10_000,
};

/**
 * A credential refusal right after a reopen waits this long before the next
 * reopen, so a leaf that refuses every new grant is not asked in a loop.
 */
export const CREDENTIAL_REOPEN_MIN_INTERVAL_MS = 30_000;

export interface NodeClientRegistryOptions {
  /** The command node's commands (grants). Defaults to the window's command scope. */
  readonly commandInvoke?: CommandNodeInvoke;
  /** Names the command node in a relayed route's `via`. */
  readonly commandNodeName?: () => string;
  /**
   * Sends `close_node_workspace` so that it outlives the page. Defaults to a
   * keepalive `fetch` to the page's command gateway on its own session.
   */
  readonly closeOnPageHide?: (workspaceId: string) => void;
  /** Page lifecycle; defaults to the window's. Also handed to every leaf transport. */
  readonly lifecycle?: NodeTransportLifecycle;
  /** Builds the client over one transport; defaults to `createBrowserNodeClient`. */
  readonly createClient?: (options: LeafTransportClientOptions) => LeafTransportClient;
  /** Transport settings for every leaf (reconnect, terminals); tests and embedding. */
  readonly transport?: Omit<
    NodeTransportOptions,
    "baseUrl" | "resolvePageUrl" | "credential" | "onCredentialRejected" | "lifecycle"
  >;
  /** Test seam for the direct-origin probe. */
  readonly probe?: (origin: string, token: string, nodeId: string) => Promise<boolean>;
  readonly renewal?: Omit<KeepWorkspaceAliveOptions, "invoke">;
  readonly openPolicy?: Partial<GrantOpenPolicy>;
  readonly credentialReopenMinIntervalMs?: number;
  /** Test seam; production clears through `clearProtectedRichContent`. */
  readonly clearRichContent?: (nodeId: BackendId) => void;
  /**
   * Carries relayed leaves' main streams on one shared request (plan item
   * 5005). Defaults to one per registry; `null` keeps one stream per leaf.
   */
  readonly relayStreams?: MultiplexedRelayStreams | null;
}

export interface NodeClientRegistry {
  /**
   * A client for `nodeId`, opening its grant if this window holds none.
   * Rejects when the grant cannot be opened (`NodeGrantOpenError`).
   */
  acquire(nodeId: BackendId): Promise<LeafNodeClient>;
  /** Releases one reference to `nodeId` (its latest client); the last revokes the grant. */
  release(nodeId: BackendId): void;
  /**
   * Opens `nodeId` as a leaf scope of `windowScope` on a newly acquired
   * client, or answers the scope already open. The scope owns the client:
   * disposing it releases the reference.
   */
  openLeafScope(
    windowScope: WindowScope,
    nodeId: BackendId,
    options?: { tier?: NodeScopeTier },
  ): Promise<NodeScope>;
  /** References held for `nodeId` (0 when none). */
  references(nodeId: BackendId): number;
  /** Revokes every grant and disposes every client. Idempotent. */
  dispose(): void;
}

export class NodeGrantOpenError extends Data.TaggedError("NodeGrantOpenError")<{
  readonly nodeId: BackendId;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Keepalive `close_node_workspace` to the page's command gateway, on the page's session. */
function keepaliveCloseOnCommandGateway(workspaceId: string): void {
  if (typeof fetch !== "function") return;
  void fetch(resolveGatewayApiUrl(`${GATEWAY_PREFIX}/invoke`), {
    method: "POST",
    keepalive: true,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "close_node_workspace", args: { workspaceId } }),
  }).catch(() => undefined);
}

function routeOf(workspace: LeafWorkspace): LeafRoute {
  return {
    nodeName: workspace.nodeName,
    path: workspace.path,
    ...(workspace.routeKind ? { routeKind: workspace.routeKind } : {}),
    ...(workspace.via ? { via: workspace.via } : {}),
    baseUrl: workspace.baseUrl,
    relayBaseUrl: workspace.relayBaseUrl ?? workspace.baseUrl,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One node's client across grants: it holds the current transport client and
 * re-attaches its listeners when a reopened grant moves to another route.
 */
interface SharedLeafClient {
  readonly route: ReadableSignal<LeafRoute>;
  readonly connection: ReadableSignal<NodeConnectionState>;
  readonly domains: ReadableSignal<NegotiatedDomains | null>;
  readonly capabilities: ReadableSignal<ReadonlySet<string> | null>;
  current(): LeafTransportClient;
  listen(event: string, handler: (payload: unknown) => void): Unlisten;
  /** Same route: swap the bearer. Another route: replace the transport client. */
  adopt(workspace: LeafWorkspace, create: () => LeafTransportClient): void;
  dispose(): void;
}

function createSharedLeafClient(
  first: LeafTransportClient,
  workspace: LeafWorkspace,
): SharedLeafClient {
  let inner = first;
  let disposed = false;
  const route = createSignal<LeafRoute>(routeOf(workspace));
  const connection = createSignal<NodeConnectionState>(inner.connection.get());
  const domains = createSignal<NegotiatedDomains | null>(inner.domains.get());
  const capabilities = createSignal<ReadonlySet<string> | null>(inner.capabilities.get());
  // A replaced transport client reads its own hello (a new route may reach a
  // new generation); its values are mirrored as they come, capabilities first.
  const mirror = (client: LeafTransportClient) => {
    const stopConnection = client.connection.subscribe((state) => connection.set(state));
    const stopCapabilities = client.capabilities.subscribe((value) => capabilities.set(value));
    const stopDomains = client.domains.subscribe((value) => domains.set(value));
    connection.set(client.connection.get());
    capabilities.set(client.capabilities.get());
    domains.set(client.domains.get());
    return () => {
      stopConnection();
      stopCapabilities();
      stopDomains();
    };
  };
  let stopMirror = mirror(inner);
  const listeners = createListenerFanout((event, deliver) => inner.listenRaw(event, deliver));

  return {
    route,
    connection,
    domains,
    capabilities,
    current: () => inner,
    listen: (event, handler) => listeners.add(event, handler),
    adopt(next, create) {
      if (disposed) return;
      const token = next.token ?? "";
      if (next.baseUrl === route.get().baseUrl) {
        // A relayed route carries no bearer (the page's own session), so
        // there is nothing to swap; the transport keeps retrying on its own.
        if (next.path === "direct") inner.setCredential(token);
        route.set(routeOf(next));
        return;
      }
      const previous = inner;
      listeners.suspend();
      stopMirror();
      inner = create();
      stopMirror = mirror(inner);
      route.set(routeOf(next));
      listeners.resume();
      previous.dispose();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.close();
      stopMirror();
      inner.dispose();
    },
  };
}

function createLease(
  nodeId: BackendId,
  shared: SharedLeafClient,
  onDispose: () => void,
): LeafNodeClient {
  let disposed = false;
  const listeners = createListenerFanout((event, deliver) => shared.listen(event, deliver));
  const disposedError = () => new Error("This node client is disposed.");
  const listenRaw = <T>(event: string, handler: (payload: T) => void): Unlisten =>
    disposed ? () => {} : listeners.add(event, handler as (payload: unknown) => void);
  const relayBase = () => shared.route.get().relayBaseUrl;
  function invokeRaw<T>(
    command: string,
    args?: Readonly<Record<string, unknown>>,
    options?: NodeInvokeOptions,
  ): Promise<T> {
    if (disposed) return Promise.reject(disposedError());
    return options
      ? shared.current().invokeRaw<T>(command, args, options)
      : shared.current().invokeRaw<T>(command, args);
  }
  return {
    nodeId,
    route: shared.route,
    get baseUrl() {
      return shared.route.get().baseUrl;
    },
    url: (pathname) => shared.current().url(pathname),
    resolveMediaUrl: (pathname) => resolveNodeGatewayUrl(relayBase(), pathname),
    resolveLoopbackUrl: (url) => resolveNodeLoopbackBaseUrl(relayBase(), url),
    resolveExternalLoopbackUrl: async (url) => {
      if (disposed) throw disposedError();
      return resolveNodeLoopbackBaseUrl(relayBase(), url);
    },
    resolvePreviewUrl: (url) => resolveNodeBrowserPreviewUrl(relayBase(), url),
    invoke: typedInvoke(invokeRaw),
    invokeRaw,
    listenRaw,
    listen: typedListen(listenRaw),
    eventStreamReady(event) {
      if (disposed) return Promise.reject(disposedError());
      return shared.current().eventStreamReady(event);
    },
    terminal: {
      listenOutput: (sessionId, handler) =>
        listenRaw(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`, handler),
      outputReady: (sessionId) =>
        disposed
          ? Promise.reject(disposedError())
          : shared.current().terminal.outputReady(sessionId),
    },
    connection: shared.connection,
    domains: shared.domains,
    capabilities: shared.capabilities,
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
      onDispose();
    },
  };
}

interface Grant {
  readonly workspace: LeafWorkspace;
  readonly lifetime: Lifetime;
}

interface Entry {
  readonly nodeId: BackendId;
  readonly lifetime: Lifetime;
  /** Aborted when the entry closes; interrupts an open in flight. */
  readonly abort: AbortController;
  refs: number;
  readonly leases: LeafNodeClient[];
  /** References taken by acquires still waiting for the client. */
  readonly waiting: Array<{ released: boolean }>;
  ready: Promise<SharedLeafClient>;
  shared: SharedLeafClient | null;
  grant: Grant | null;
  reopening: Promise<void> | null;
  lastCredentialReopenAt: number;
  credentialReopenTimer: ReturnType<typeof setTimeout> | null;
}

export function createNodeClientRegistry(
  options: NodeClientRegistryOptions = {},
): NodeClientRegistry {
  const invoke = options.commandInvoke ?? commandScopeInvoke;
  const lifecycle = options.lifecycle ?? browserWindowLifecycle();
  const closeOnPageHide = options.closeOnPageHide ?? keepaliveCloseOnCommandGateway;
  const createClient = options.createClient ?? createBrowserNodeClient;
  const clearRichContent =
    options.clearRichContent ??
    ((nodeId: BackendId) => clearProtectedRichContent("credentials", { nodeId }));
  const policy = { ...DEFAULT_GRANT_OPEN_POLICY, ...options.openPolicy };
  const credentialReopenMinIntervalMs =
    options.credentialReopenMinIntervalMs ?? CREDENTIAL_REOPEN_MIN_INTERVAL_MS;

  const ownsRelayStreams = options.relayStreams === undefined;
  const relayStreams =
    options.relayStreams === undefined ? createMultiplexedRelayStreams() : options.relayStreams;

  const root = Lifetime.root("node-clients");
  if (relayStreams && ownsRelayStreams) root.onClose("relay-streams", () => relayStreams.dispose());
  const entries = new Map<BackendId, Entry>();
  let pageHidden = false;

  const retrySchedule = Schedule.exponential(Duration.millis(policy.retryBaseDelayMs)).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.millis(policy.retryMaxDelayMs))),
    ),
    Schedule.upTo({ times: policy.retries }),
  );

  /** One grant, direct first then relay, retried on `policy`. */
  const openGrant = (entry: Entry): Promise<LeafWorkspace> => {
    const attempt = Effect.tryPromise({
      try: async (signal) => {
        const workspace = await openLeafWorkspace(entry.nodeId, {
          commandNodeName: options.commandNodeName?.() ?? "",
          invoke,
          ...(options.probe ? { probe: options.probe } : {}),
        });
        // Timed out or released meanwhile: nobody will use this grant.
        if (signal.aborted) {
          void closeLeafWorkspace(workspace.workspaceId, invoke);
          throw new Error("The grant arrived after its open was abandoned.");
        }
        return workspace;
      },
      catch: (cause) =>
        new NodeGrantOpenError({ nodeId: entry.nodeId, message: errorMessage(cause), cause }),
    }).pipe(
      Effect.timeout(Duration.millis(policy.attemptTimeoutMs)),
      Effect.mapError((error) =>
        error instanceof NodeGrantOpenError
          ? error
          : new NodeGrantOpenError({
              nodeId: entry.nodeId,
              message: "Opening the node's workspace timed out.",
              cause: error,
            }),
      ),
      Effect.retry(retrySchedule),
    );
    return Effect.runPromise(attempt, { signal: entry.abort.signal });
  };

  const revoke = (workspaceId: string) => {
    if (pageHidden) closeOnPageHide(workspaceId);
    else void closeLeafWorkspace(workspaceId, invoke);
  };

  const transportOptions = (entry: Entry, workspace: LeafWorkspace): NodeTransportOptions => ({
    ...options.transport,
    baseUrl: workspace.baseUrl,
    ...(workspace.token ? { credential: workspace.token } : {}),
    lifecycle,
    terminalTransport: options.transport?.terminalTransport ?? "websocket",
    onCredentialRejected: () => onCredentialRejected(entry),
    // A relayed leaf's main stream may share one request with the others'.
    // The workspace is read on every open, so a reopened grant is sent.
    ...(workspace.path === "relay" && relayStreams
      ? {
          openMainStream: relayStreams.opener(
            entry.nodeId,
            () => entry.grant?.workspace.workspaceId ?? null,
          ),
        }
      : {}),
  });

  const newTransportClient = (entry: Entry, workspace: LeafWorkspace) =>
    createClient({ nodeId: entry.nodeId, transport: transportOptions(entry, workspace) });

  /** The grant in use from now on; the one it replaces is revoked. */
  const holdGrant = (entry: Entry, workspace: LeafWorkspace) => {
    const previous = entry.grant;
    entry.grant = null;
    if (entry.lifetime.closed || pageHidden) {
      // Released, or the page went away while the grant was opening.
      revoke(workspace.workspaceId);
    } else {
      const lifetime = entry.lifetime.child("grant");
      lifetime.onClose("revoke", () => revoke(workspace.workspaceId));
      // Registered last, so it stops first: no renewal races the revoke.
      lifetime.onClose(
        "renewal",
        keepWorkspaceAlive(workspace.workspaceId, () => reopen(entry), {
          ...options.renewal,
          invoke,
        }),
      );
      entry.grant = { workspace, lifetime };
      if (previous && workspace.path === "relay") relayStreams?.refresh(entry.nodeId);
    }
    previous?.lifetime.close();
  };

  /** A new grant for a held node; the transport keeps running (no reload). */
  const reopen = (entry: Entry): Promise<void> => {
    if (entry.lifetime.closed) return Promise.resolve();
    entry.reopening ??= openGrant(entry)
      .then((workspace) => {
        const shared = entry.shared;
        if (entry.lifetime.closed || !shared) {
          revoke(workspace.workspaceId);
          return;
        }
        // Content derived under the old credential is dropped, for this node
        // only (a relayed route on the same base keeps the page's session, so
        // nothing changed). Then the new bearer reaches the transport before
        // the old grant is revoked, so its streams never see it refused.
        if (workspace.path === "direct" || workspace.baseUrl !== shared.route.get().baseUrl) {
          clearRichContent(entry.nodeId);
        }
        shared.adopt(workspace, () => newTransportClient(entry, workspace));
        holdGrant(entry, workspace);
      })
      .finally(() => {
        entry.reopening = null;
      });
    return entry.reopening;
  };

  const onCredentialRejected = (entry: Entry) => {
    if (entry.lifetime.closed || pageHidden || entry.reopening || entry.credentialReopenTimer) {
      return;
    }
    const run = () => {
      entry.credentialReopenTimer = null;
      if (entry.lifetime.closed || pageHidden) return;
      entry.lastCredentialReopenAt = Date.now();
      // A failed reopen leaves the client `lapsed`; the renewal tick, `online`
      // and `focus` try again.
      reopen(entry).catch(() => undefined);
    };
    const wait = entry.lastCredentialReopenAt + credentialReopenMinIntervalMs - Date.now();
    if (wait <= 0) run();
    else entry.credentialReopenTimer = setTimeout(run, wait);
  };

  const closeEntry = (entry: Entry) => {
    if (entries.get(entry.nodeId) === entry) entries.delete(entry.nodeId);
    entry.lifetime.close();
  };

  const releaseOne = (entry: Entry) => {
    if (entry.refs <= 0) return;
    entry.refs -= 1;
    if (entry.refs === 0) closeEntry(entry);
  };

  const createEntry = (nodeId: BackendId): Entry => {
    const entry: Entry = {
      nodeId,
      lifetime: root.child("node-client"),
      abort: new AbortController(),
      refs: 0,
      leases: [],
      waiting: [],
      ready: Promise.resolve(null as never),
      shared: null,
      grant: null,
      reopening: null,
      lastCredentialReopenAt: Number.NEGATIVE_INFINITY,
      credentialReopenTimer: null,
    };
    entry.lifetime.onClose("abort-open", () => {
      entry.abort.abort();
      if (entry.credentialReopenTimer) clearTimeout(entry.credentialReopenTimer);
      entry.credentialReopenTimer = null;
    });
    entry.lifetime.onClose("client", () => {
      entry.shared?.dispose();
      entry.shared = null;
    });
    entry.ready = openGrant(entry).then((workspace) => {
      if (entry.lifetime.closed) {
        revoke(workspace.workspaceId);
        throw new Error("The node was released before its grant opened.");
      }
      entry.shared = createSharedLeafClient(newTransportClient(entry, workspace), workspace);
      holdGrant(entry, workspace);
      return entry.shared;
    });
    // A failed open is forgotten at once, so the next acquire tries afresh.
    entry.ready.catch(() => closeEntry(entry));
    return entry;
  };

  const stopPageLifecycle = lifecycle.onPageHide((hiding) => {
    if (hiding) {
      pageHidden = true;
      for (const entry of entries.values()) {
        const grant = entry.grant;
        entry.grant = null;
        grant?.lifetime.close();
      }
      return;
    }
    if (!pageHidden) return;
    pageHidden = false;
    // Restored from the back/forward cache: its grants were revoked.
    for (const entry of entries.values()) {
      if (entry.shared && !entry.grant) reopen(entry).catch(() => undefined);
    }
  });
  root.onClose("page-lifecycle", stopPageLifecycle);

  const registry: NodeClientRegistry = {
    async acquire(nodeId) {
      if (root.closed) throw new Error("This node client registry is disposed.");
      let entry = entries.get(nodeId);
      if (!entry) {
        entry = createEntry(nodeId);
        entries.set(nodeId, entry);
      }
      const held = entry;
      held.refs += 1;
      // `release(nodeId)` can drop this reference before its client exists.
      const pending = { released: false };
      held.waiting.push(pending);
      const stopWaiting = () => {
        const index = held.waiting.indexOf(pending);
        if (index >= 0) held.waiting.splice(index, 1);
      };
      let shared: SharedLeafClient;
      try {
        shared = await held.ready;
      } catch (error) {
        stopWaiting();
        if (!pending.released) releaseOne(held);
        throw error;
      }
      stopWaiting();
      if (pending.released || held.lifetime.closed) {
        throw new Error("The node was released before its client opened.");
      }
      const lease = createLease(nodeId, shared, () => {
        const index = held.leases.indexOf(lease);
        if (index >= 0) held.leases.splice(index, 1);
        releaseOne(held);
      });
      held.leases.push(lease);
      return lease;
    },
    release(nodeId) {
      const entry = entries.get(nodeId);
      if (!entry) return;
      const lease = entry.leases.at(-1);
      if (lease) {
        lease.dispose();
        return;
      }
      // Only acquires still opening: release the latest of those.
      const latest = entry.waiting.pop();
      if (!latest) return;
      latest.released = true;
      releaseOne(entry);
    },
    async openLeafScope(windowScope, nodeId, scopeOptions = {}) {
      const open = windowScope.get(nodeId);
      if (open) return open;
      const client = await registry.acquire(nodeId);
      const raced = windowScope.get(nodeId);
      if (raced) {
        client.dispose();
        return raced;
      }
      try {
        return windowScope.open({
          role: "leaf",
          client,
          ...(scopeOptions.tier ? { tier: scopeOptions.tier } : {}),
        });
      } catch (error) {
        client.dispose();
        throw error;
      }
    },
    references: (nodeId) => entries.get(nodeId)?.refs ?? 0,
    dispose() {
      entries.clear();
      root.close();
    },
  };

  return registry;
}
