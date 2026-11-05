import { LOCAL_CONNECTION_ID } from "@orkestrator/protocol/connections";
import {
  isPerNodeRelayedEvent,
  MAX_NODE_EVENT_WATCHES,
  relayedNodeEventNodeId,
} from "@orkestrator/protocol/node-events";
import type { ConnectionManager } from "./connection-manager.js";
import { PORTAL_EVENT_CHANNEL } from "./federation-ipc.js";
import { rebindWindowPreviews, type WindowPreviewRuntime } from "./preview-connection-backend.js";
import { editDesktopConnection, type WorkspaceContext } from "./window-workspace-target.js";
import { formatLogError, type Logger, type LogEventOf } from "@orkestrator/protocol/logger";

/** A renderer's web contents, as far as the window bookkeeping uses it. */
export type RendererContents = {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
};

/** The main process resources of one renderer: a window's own, or a realm's. */
export interface DesktopWindowContextRecord
  extends
    WorkspaceContext,
    WindowPreviewRuntime<{ destroyAll(): void }, { disposeAll(): Promise<void> }> {
  /** The renderer: the window's own, or a workspace realm inside it. */
  contents: RendererContents;
  slot: number;
  artifactHosts: { dispose(): void };
  /**
   * Read when the window was created: on Local it takes backend events and
   * commands over the gateway itself. Never set on a workspace realm.
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

/** Which of a renderer's event channels a per-node listen is on. */
export type RelayedListenChannel = "workspace" | "portal";

export function isRelayedListenChannel(value: unknown): value is RelayedListenChannel {
  return value === "workspace" || value === "portal";
}

type IpcSender = { sender?: { id: number } };

export interface DesktopWindowContextsOptions<T extends DesktopWindowContextRecord> {
  /** Workspace realms, by their own renderer's ID. */
  realms: { get(id: number): T | undefined; values(): Iterable<T> };
  /** The connection manager, once connections are initialized. */
  connections(): DesktopWindowConnections | null;
  /** A new preview runtime for `context` on `connectionId`. */
  createPreviews(
    context: T,
    connectionId: string,
    partitionKey: string,
  ): { manager: T["browserPreviewManager"]; previewTransport: T["previewTransport"] };
  /** Close the workspace realms inside a window. */
  closeRealms(webContentsId: number): void;
  cancelPrompts(webContentsId: number): void;
  /** Revoke a scope's node workspace grant, if it holds one. */
  releaseWorkspaceGrant(scope: string): void;
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
 * The desktop windows by their renderer's ID, and the realms inside them:
 * which renderer an IPC call came from, which renderers a connection's events
 * reach, and what each window owns until it closes.
 */
export class DesktopWindowContexts<T extends DesktopWindowContextRecord> {
  private readonly contexts = new Map<number, T>();
  readonly windows: ReadonlyMap<number, T> = this.contexts;
  /** The per-node relayed events each renderer listens to, by its ID. */
  private readonly relayedListens = new Map<number, Record<RelayedListenChannel, Set<string>>>();
  /** What each connection's filtered stream was last told to carry. */
  private readonly appliedRelayedEvents = new Map<string, string>();
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
      this.options.closeRealms(webContentsId);
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
      this.options.releaseWorkspaceGrant(scope);
      if (closing?.portalScope) this.options.connections()?.release(closing.portalScope);
      this.options.connections()?.release(scope);
      this.options.releaseSlot(slot);
      if (this.lastFocusedWindowId === webContentsId) {
        this.lastFocusedWindowId = this.contexts.keys().next().value ?? null;
      }
      this.options.menuChanged();
    };
  }

  /** Every renderer: main windows and the realms inside them. */
  renderers(): T[] {
    return [...this.contexts.values(), ...this.options.realms.values()];
  }

  forEvent(event?: IpcSender): T {
    const context = event?.sender
      ? (this.contexts.get(event.sender.id) ?? this.options.realms.get(event.sender.id))
      : null;
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
  addRelayedListen(event: IpcSender | undefined, channel: unknown, name: unknown): Promise<void> {
    const context = this.forEvent(event);
    if (
      !isRelayedListenChannel(channel) ||
      typeof name !== "string" ||
      !relayedNodeEventNodeId(name)
    )
      throw new Error("Expected a per-node relayed event");
    let listens = this.relayedListens.get(context.contents.id);
    if (!listens) {
      listens = { workspace: new Set(), portal: new Set() };
      this.relayedListens.set(context.contents.id, listens);
    }
    if (listens[channel].size >= MAX_NODE_EVENT_WATCHES && !listens[channel].has(name))
      throw new Error("Too many per-node relayed events");
    listens[channel].add(name);
    this.syncRelayedEvents();
    const connectionId = this.relayChannelConnection(context, channel);
    return connectionId === null
      ? Promise.resolve()
      : (this.options.connections()?.relayedEventReady(connectionId, name) ?? Promise.resolve());
  }

  removeRelayedListen(event: IpcSender | undefined, channel: unknown, name: unknown): void {
    if (!isRelayedListenChannel(channel) || typeof name !== "string") return;
    const context = this.forEvent(event);
    if (this.relayedListens.get(context.contents.id)?.[channel].delete(name)) {
      this.syncRelayedEvents();
    }
  }

  /** A renderer's document is new: nothing the previous one listened to still stands. */
  resetRelayedListens(event: IpcSender | undefined, channel: unknown): void {
    if (!isRelayedListenChannel(channel)) return;
    const listens = this.relayedListens.get(this.forEvent(event).contents.id)?.[channel];
    if (!listens?.size) return;
    listens.clear();
    this.syncRelayedEvents();
  }

  /** A window or realm closed. */
  dropRelayedListens(webContentsId: number): void {
    if (this.relayedListens.delete(webContentsId)) this.syncRelayedEvents();
  }

  /**
   * Tell each connection what its windows listen to now. Also what follows a
   * window or realm moving to another connection: the listens are the renderer's,
   * and the stream that carries them is whichever its scope is bound to.
   */
  syncRelayedEvents(): void {
    const connections = this.options.connections();
    if (!connections) return;
    const wanted = new Map<string, Set<string>>();
    for (const context of this.renderers()) {
      const listens = this.relayedListens.get(context.contents.id);
      if (!listens) continue;
      for (const channel of ["workspace", "portal"] as const) {
        if (listens[channel].size === 0) continue;
        const connectionId = this.relayChannelConnection(context, channel);
        if (connectionId === null) continue;
        const events = wanted.get(connectionId) ?? new Set<string>();
        wanted.set(connectionId, events);
        for (const name of listens[channel]) events.add(name);
      }
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
   * The connection whose relay feeds this channel. None for a window on the direct
   * gateway transport, which has these events from its own stream, or for a scope
   * that has just been released.
   */
  private relayChannelConnection(context: T, channel: RelayedListenChannel): string | null {
    const scope = channel === "portal" ? context.portalScope : context.scope;
    if (!scope) return null;
    let connectionId: string | undefined;
    try {
      connectionId = this.options.connections()?.getConnectionId(scope);
    } catch {
      return null;
    }
    if (!connectionId) return null;
    return channel === "workspace" &&
      connectionId === LOCAL_CONNECTION_ID &&
      context.localGatewayTransport
      ? null
      : connectionId;
  }

  private listensTo(context: T, channel: RelayedListenChannel, event: string): boolean {
    return (
      !isPerNodeRelayedEvent(event) ||
      this.relayedListens.get(context.contents.id)?.[channel].has(event) === true
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
        this.listensTo(context, "workspace", event)
      ) {
        emitToContents(context.contents, event, payload);
      }
      // The portal channel of a realm: its window's command node.
      if (
        context.portalScope &&
        connections.getConnectionId(context.portalScope) === connectionId &&
        !context.contents.isDestroyed() &&
        this.listensTo(context, "portal", event)
      ) {
        context.contents.send(PORTAL_EVENT_CHANNEL, event, payload);
      }
    }
  }

  /** End a window's previews when its connection changed; see `rebindWindowPreviews`. */
  followConnection(context: T): void {
    const connections = this.options.connections();
    if (!connections) return;
    this.syncRelayedEvents();
    rebindWindowPreviews(context, connections.getConnectionId(context.scope), (connectionId) =>
      this.options.createPreviews(
        context,
        connectionId,
        // A workspace connection is new on every switch; preview site data
        // stays with the node, as it would for a direct connection.
        context.target ? `node:${context.target.nodeId}` : connectionId,
      ),
    );
  }

  /** Retitle the requesting window; a realm has no title of its own. */
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
      async () => this.options.closeRealms(context.contents.id),
    );
    this.followConnection(context);
    this.updateWindowTitle(event);
    this.options.publishConnectionLists();
    return list;
  }
}
