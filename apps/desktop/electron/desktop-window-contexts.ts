import type { ConnectionManager } from "./connection-manager.js";
import { PORTAL_EVENT_CHANNEL } from "./federation-ipc.js";
import { rebindWindowPreviews, type WindowPreviewRuntime } from "./preview-connection-backend.js";
import { editDesktopConnection, type WorkspaceContext } from "./window-workspace-target.js";

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
}

/** The part of `ConnectionManager` the window bookkeeping uses. */
export type DesktopWindowConnections = Pick<
  ConnectionManager,
  "connect" | "use" | "forget" | "getConnectionId" | "getList" | "release"
>;

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
  logger: Pick<Console, "warn">;
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
        this.options.logger.warn("[Previews] Failed to close preview transport:", error);
      });
      this.options.cancelPrompts(webContentsId);
      this.contexts.delete(webContentsId);
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

  emitToConnection(connectionId: string, event: string, payload: unknown): void {
    const connections = this.options.connections();
    if (!connections) return;
    for (const context of this.renderers()) {
      if (connections.getConnectionId(context.scope) === connectionId) {
        emitToContents(context.contents, event, payload);
      }
      // The portal channel of a realm: its window's command node.
      if (
        context.portalScope &&
        connections.getConnectionId(context.portalScope) === connectionId &&
        !context.contents.isDestroyed()
      ) {
        context.contents.send(PORTAL_EVENT_CHANNEL, event, payload);
      }
    }
  }

  /** End a window's previews when its connection changed; see `rebindWindowPreviews`. */
  followConnection(context: T): void {
    const connections = this.options.connections();
    if (!connections) return;
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
