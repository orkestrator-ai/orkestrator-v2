import { LOCAL_CONNECTION_ID } from "@orkestrator/protocol/connections";
import {
  isPerNodeRelayedEvent,
  MAX_NODE_EVENT_WATCHES,
  relayedNodeEventNodeId,
} from "@orkestrator/protocol/node-events";
import type { ConnectionManager } from "./connection-manager.js";
import { NODE_EVENT_CHANNEL } from "./node-ipc.js";
import { rebindWindowPreviews, type WindowPreviewRuntime } from "./preview-connection-backend.js";
import { editDesktopConnection, type ConnectionEditContext } from "./desktop-connection-edits.js";
import { formatLogError, type Logger, type LogEventOf } from "@orkestrator/protocol/logger";

/** A renderer's web contents, as far as the window bookkeeping uses it. */
export type RendererContents = {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
};

/** The main process resources of one window's renderer. */
export interface DesktopWindowContextRecord
  extends
    ConnectionEditContext,
    WindowPreviewRuntime<{ destroyAll(): void }, { disposeAll(): Promise<void> }> {
  /** The window's renderer. */
  contents: RendererContents;
  slot: number;
  artifactHosts: { dispose(): void };
  /**
   * Read when the window was created: on Local it takes backend events and
   * commands over the gateway itself.
   */
  localGatewayTransport?: boolean;
}

/** The part of `ConnectionManager` the window bookkeeping uses. */
export type DesktopWindowConnections = Pick<
  ConnectionManager,
  | "connect"
  | "use"
  | "forget"
  | "getConnectionId"
  | "getList"
  | "release"
  | "setRelayedEvents"
  | "relayedEventReady"
>;

type IpcSender = { sender?: { id: number } };

export interface DesktopWindowContextsOptions<T extends DesktopWindowContextRecord> {
  /** The connection manager, once connections are initialized. */
  connections(): DesktopWindowConnections | null;
  /** A new preview runtime for `context` on `connectionId`. */
  createPreviews(
    context: T,
    connectionId: string,
    partitionKey: string,
  ): { manager: T["browserPreviewManager"]; previewTransport: T["previewTransport"] };
  cancelPrompts(webContentsId: number): void;
  /** Revoke a scope's node workspace grant, if it holds one. */
  releaseWorkspaceGrant(scope: string): void;
  /**
   * Release a window's node scopes (`node-scopes.ts`): on close, and when its
   * command node changes.
   */
  releaseNodeScopes?(context: T): void;
  releaseSlot(slot: number): void;
  setConnectionTitle(context: T): void;
  publishConnectionLists(): void;
  /** The window list or focus changed; rebuild the application menu. */
  menuChanged(): void;
  logger: Pick<Logger<LogEventOf<"preview">>, "warn">;
}

export function emitToContents(contents: RendererContents, event: string, payload: unknown): void {
  if (!contents.isDestroyed()) contents.send("orkestrator:event", event, payload);
}

/**
 * The desktop windows by their renderer's ID: which window an IPC call came
 * from, which windows a connection's events reach, and what each window owns
 * until it closes. Other nodes reach a window through its node scopes.
 */
export class DesktopWindowContexts<T extends DesktopWindowContextRecord> {
  private readonly contexts = new Map<number, T>();
  readonly windows: ReadonlyMap<number, T> = this.contexts;
  /** The per-node relayed events each window listens to, by its renderer's ID. */
  private readonly relayedListens = new Map<number, Set<string>>();
  /** What each connection's filtered stream was last told to carry. */
  private readonly appliedRelayedEvents = new Map<string, string>();
  /** Node scope connections: whose `orkestrator:node-event` each one feeds. */
  private readonly nodeConnections = new Map<
    string,
    Set<{ contents: RendererContents; nodeId: string }>
  >();
  lastFocusedWindowId: number | null = null;

  constructor(private readonly options: DesktopWindowContextsOptions<T>) {}

  /**
   * Register a new window, which takes focus. The returned callback ends what
   * the window owns once it has closed.
   */
  register(context: T): () => void {
    const webContentsId = context.contents.id;
    const { scope, slot } = context;
    this.contexts.set(webContentsId, context);
    this.lastFocusedWindowId = webContentsId;
    return () => {
      const closing = this.contexts.get(webContentsId);
      closing?.browserPreviewManager.destroyAll();
      closing?.artifactHosts.dispose();
      // Owned local listeners and tunnel connections end with the window;
      // the backend's services and applications keep running.
      void closing?.previewTransport.disposeAll().catch((error: unknown) => {
        this.options.logger.warn("transport.close-failed", { error: formatLogError(error) });
      });
      this.options.cancelPrompts(webContentsId);
      this.contexts.delete(webContentsId);
      this.dropRelayedListens(webContentsId);
      // Closing never stops the node's work; it only revokes the grant.
      if (closing) this.options.releaseNodeScopes?.(closing);
      this.options.releaseWorkspaceGrant(scope);
      this.options.connections()?.release(scope);
      this.options.releaseSlot(slot);
      if (this.lastFocusedWindowId === webContentsId) {
        this.lastFocusedWindowId = this.contexts.keys().next().value ?? null;
      }
      this.options.menuChanged();
    };
  }

  /** Every window renderer. */
  renderers(): T[] {
    return [...this.contexts.values()];
  }

  forEvent(event?: IpcSender): T {
    const context = event?.sender ? this.contexts.get(event.sender.id) : null;
    if (!context) throw new Error("The requesting window is no longer available");
    return context;
  }

  /** An event main itself raises for a connection; it reaches every renderer on it. */
  emitToConnection(connectionId: string, event: string, payload: unknown): void {
    this.sendToConnection(connectionId, event, payload, false);
  }

  /**
   * An event from a connection's backend. A window on the direct gateway
   * transport already has it from its own stream, so relaying it again would
   * deliver it twice.
   */
  relayBackendEvent(connectionId: string, event: string, payload: unknown): void {
    this.sendToConnection(connectionId, event, payload, connectionId === LOCAL_CONNECTION_ID);
  }

  /**
   * Deliver a node scope's connection events to its window, tagged with the
   * node, until the returned callback runs (the scope's release).
   */
  mapNodeConnection(
    context: { contents: RendererContents },
    nodeId: string,
    connectionId: string,
  ): () => void {
    const entry = { contents: context.contents, nodeId };
    const entries = this.nodeConnections.get(connectionId) ?? new Set();
    this.nodeConnections.set(connectionId, entries);
    entries.add(entry);
    return () => {
      const current = this.nodeConnections.get(connectionId);
      if (!current?.delete(entry)) return;
      if (current.size === 0) this.nodeConnections.delete(connectionId);
    };
  }

  /** Whether any open window would take terminal output from main's local stream. */
  needsLocalTerminalRelay(): boolean {
    for (const context of this.contexts.values()) {
      if (!context.localGatewayTransport) return true;
    }
    return false;
  }

  /**
   * A renderer started listening to a per-node relayed event. Settles once the
   * stream carrying it is open, so a read that follows cannot precede it.
   */
  addRelayedListen(event: IpcSender | undefined, name: unknown): Promise<void> {
    const context = this.forEvent(event);
    if (typeof name !== "string" || !relayedNodeEventNodeId(name))
      throw new Error("Expected a per-node relayed event");
    let listens = this.relayedListens.get(context.contents.id);
    if (!listens) {
      listens = new Set();
      this.relayedListens.set(context.contents.id, listens);
    }
    if (listens.size >= MAX_NODE_EVENT_WATCHES && !listens.has(name))
      throw new Error("Too many per-node relayed events");
    listens.add(name);
    this.syncRelayedEvents();
    const connectionId = this.relayConnection(context);
    return connectionId === null
      ? Promise.resolve()
      : (this.options.connections()?.relayedEventReady(connectionId, name) ?? Promise.resolve());
  }

  removeRelayedListen(event: IpcSender | undefined, name: unknown): void {
    if (typeof name !== "string") return;
    const context = this.forEvent(event);
    if (this.relayedListens.get(context.contents.id)?.delete(name)) {
      this.syncRelayedEvents();
    }
  }

  /** A window's document is new: nothing the previous one listened to still stands. */
  resetRelayedListens(event: IpcSender | undefined): void {
    const listens = this.relayedListens.get(this.forEvent(event).contents.id);
    if (!listens?.size) return;
    listens.clear();
    this.syncRelayedEvents();
  }

  /** A window closed. */
  dropRelayedListens(webContentsId: number): void {
    if (this.relayedListens.delete(webContentsId)) this.syncRelayedEvents();
  }

  /**
   * Tell each connection what its windows listen to now. Also what follows a
   * window moving to another connection: the listens are the renderer's, and
   * the stream that carries them is whichever its scope is bound to.
   */
  syncRelayedEvents(): void {
    const connections = this.options.connections();
    if (!connections) return;
    const wanted = new Map<string, Set<string>>();
    for (const context of this.renderers()) {
      const listens = this.relayedListens.get(context.contents.id);
      if (!listens?.size) continue;
      const connectionId = this.relayConnection(context);
      if (connectionId === null) continue;
      const events = wanted.get(connectionId) ?? new Set<string>();
      wanted.set(connectionId, events);
      for (const name of listens) events.add(name);
    }
    for (const connectionId of Array.from(this.appliedRelayedEvents.keys())) {
      if (wanted.has(connectionId)) continue;
      this.appliedRelayedEvents.delete(connectionId);
      connections.setRelayedEvents(connectionId, []);
    }
    for (const [connectionId, events] of wanted) {
      const sorted = [...events].sort();
      const key = sorted.join(",");
      if (this.appliedRelayedEvents.get(connectionId) === key) continue;
      this.appliedRelayedEvents.set(connectionId, key);
      connections.setRelayedEvents(connectionId, sorted);
    }
  }

  /**
   * The connection whose relay feeds a window's listens. None for a window on
   * the direct gateway transport, which has these events from its own stream,
   * or for a scope that has just been released.
   */
  private relayConnection(context: T): string | null {
    let connectionId: string | undefined;
    try {
      connectionId = this.options.connections()?.getConnectionId(context.scope);
    } catch {
      return null;
    }
    if (!connectionId) return null;
    return connectionId === LOCAL_CONNECTION_ID && context.localGatewayTransport
      ? null
      : connectionId;
  }

  private listensTo(context: T, event: string): boolean {
    return (
      !isPerNodeRelayedEvent(event) ||
      this.relayedListens.get(context.contents.id)?.has(event) === true
    );
  }

  private sendToConnection(
    connectionId: string,
    event: string,
    payload: unknown,
    skipDirectTransport: boolean,
  ): void {
    const connections = this.options.connections();
    if (!connections) return;
    for (const context of this.renderers()) {
      if (
        connections.getConnectionId(context.scope) === connectionId &&
        !(skipDirectTransport && context.localGatewayTransport) &&
        this.listensTo(context, event)
      ) {
        emitToContents(context.contents, event, payload);
      }
    }
    // A node scope's own stream, terminal output included. Per-node relayed
    // events are a command-node channel; a node scope never asks for them.
    const nodes = this.nodeConnections.get(connectionId);
    if (!nodes || isPerNodeRelayedEvent(event)) return;
    for (const { contents, nodeId } of nodes) {
      if (!contents.isDestroyed()) contents.send(NODE_EVENT_CHANNEL, nodeId, event, payload);
    }
  }

  /** End a window's previews when its connection changed; see `rebindWindowPreviews`. */
  followConnection(context: T): void {
    const connections = this.options.connections();
    if (!connections) return;
    this.syncRelayedEvents();
    rebindWindowPreviews(context, connections.getConnectionId(context.scope), (connectionId) =>
      this.options.createPreviews(context, connectionId, connectionId),
    );
  }

  /** Retitle the requesting window. */
  updateWindowTitle(event: IpcSender | undefined): void {
    const senderId = event?.sender?.id;
    const context = senderId === undefined ? undefined : this.contexts.get(senderId);
    if (context) this.options.setConnectionTitle(context);
  }

  /** Move the requesting window to another connection, and its previews with it. */
  async useConnection(
    connectionId: string,
    event: IpcSender | undefined,
  ): Promise<ReturnType<ConnectionManager["getList"]>> {
    const context = this.forEvent(event);
    const connections = this.options.connections();
    if (!connections) throw new Error("Connections are not initialized");
    const list = await editDesktopConnection(
      context,
      { kind: "use", connectionId },
      connections,
      async () => {
        this.options.releaseNodeScopes?.(context);
      },
    );
    this.followConnection(context);
    this.updateWindowTitle(event);
    this.options.publishConnectionLists();
    return list;
  }
}

/** Lifecycle callbacks of main's connection owners. */
export function createDesktopRelayedLifecycle(
  windows: Pick<DesktopWindowContexts<DesktopWindowContextRecord>, "syncRelayedEvents">,
  publish: () => void,
) {
  return {
    onStateChange(): void {
      windows.syncRelayedEvents();
      publish();
    },
  };
}
