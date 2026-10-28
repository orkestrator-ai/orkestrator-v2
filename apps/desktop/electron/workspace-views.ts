import { randomUUID } from "node:crypto";

/**
 * Workspace realms inside a desktop window.
 *
 * The window always stays on its command node. Opening an environment of
 * another node shows that node's workspace in the window's central region as
 * a child view: its own renderer (the standard preload), bound to exactly
 * that node through its own connection scope, so its stores, caches, event
 * subscriptions and request credentials cannot reach another machine. The
 * window only places the view and passes small messages between the two
 * renderers. Closing a view only ends this window's view of the node; its
 * work keeps running.
 */

export type WorkspaceViewBounds = { x: number; y: number; width: number; height: number };

export type WorkspaceViewOpenInput = {
  nodeId: string;
  /** Query parameters the realm opens on (project, environment, dialogs). */
  search: Record<string, string>;
};

export type WorkspaceViewEvent =
  | { viewId: string; type: "message"; message: unknown }
  | { viewId: string; type: "closed" | "crashed" | "load-failed" };

type WebContentsLike = {
  id: number;
  isDestroyed(): boolean;
  close(): void;
  focus?(): void;
  loadURL(url: string): Promise<void>;
  send(channel: string, ...args: unknown[]): void;
  setZoomFactor?(factor: number): void;
  capturePage?(): Promise<{ isEmpty(): boolean; toJPEG(quality: number): Uint8Array }>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
};

type ViewLike = {
  webContents: WebContentsLike;
  setBounds(bounds: WorkspaceViewBounds): void;
  setVisible(visible: boolean): void;
  setBackgroundColor?(color: string): void;
};

export type ParentWindowLike = {
  id: number;
  isDestroyed(): boolean;
  contentView: { addChildView(view: never): void; removeChildView(view: never): void };
  webContents: {
    id: number;
    send(channel: string, ...args: unknown[]): void;
    isDestroyed(): boolean;
    getZoomFactor?(): number;
    focus?(): void;
  };
};

/**
 * Where a realm is in its window, for the native views the realm itself
 * opens (browser previews, live artifacts): they are children of the window
 * too, placed by the realm in its own coordinates.
 */
export class RealmLayout {
  private origin = { x: 0, y: 0 };
  private shown = false;
  private readonly listeners = new Set<() => void>();

  get visible(): boolean {
    return this.shown;
  }

  /** A rect in the realm's coordinates, in the window's. */
  place(bounds: WorkspaceViewBounds): WorkspaceViewBounds {
    return { ...bounds, x: bounds.x + this.origin.x, y: bounds.y + this.origin.y };
  }

  update(origin: { x: number; y: number }, shown: boolean): void {
    if (this.origin.x === origin.x && this.origin.y === origin.y && this.shown === shown) return;
    this.origin = { ...origin };
    this.shown = shown;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

type NativeViewLike = {
  setBounds(bounds: WorkspaceViewBounds): void;
  setVisible(visible: boolean): void;
  webContents: { isDestroyed(): boolean; on(event: string, listener: () => void): void };
};
// A mixin's base must accept any constructor arguments.
// oxlint-disable-next-line typescript/no-explicit-any
type NativeViewCtor = new (...args: any[]) => NativeViewLike;

/**
 * A view class for the native views a realm opens: they take bounds in the
 * realm's coordinates and are shown only while the realm is.
 */
export function realmChildViewClass<T extends NativeViewCtor>(Base: T, layout: RealmLayout): T {
  return class RealmChildView extends Base {
    private requestedBounds: WorkspaceViewBounds = { x: 0, y: 0, width: 0, height: 0 };
    private requestedVisible = false;

    // oxlint-disable-next-line typescript/no-explicit-any
    constructor(...args: any[]) {
      super(...args);
      const stop = layout.subscribe(() => this.apply());
      this.webContents.on("destroyed", stop);
    }

    override setBounds(bounds: WorkspaceViewBounds): void {
      this.requestedBounds = { ...bounds };
      super.setBounds(layout.place(bounds));
    }

    getBounds(): WorkspaceViewBounds {
      return { ...this.requestedBounds };
    }

    override setVisible(visible: boolean): void {
      this.requestedVisible = visible;
      super.setVisible(visible && layout.visible);
    }

    getVisible(): boolean {
      return this.requestedVisible && layout.visible;
    }

    private apply(): void {
      if (this.webContents.isDestroyed()) return;
      super.setBounds(layout.place(this.requestedBounds));
      super.setVisible(this.requestedVisible && layout.visible);
    }
  };
}

export type WorkspaceViewRecord = {
  viewId: string;
  scope: string;
  nodeId: string;
  parentWebContentsId: number;
  webContents: WebContentsLike;
  layout: RealmLayout;
};

export type WorkspaceViewsOptions = {
  WebContentsViewCtor: new (options: { webPreferences: Record<string, unknown> }) => ViewLike;
  preloadPath: string;
  /** Exact URL of the renderer, without query. */
  rendererUrl: string;
  /** The realm's renderer storage: per window and node. */
  partitionFor(nodeId: string, parentWebContentsId: number): string;
  /** Bind the realm's scope to the node, through the window's command node. */
  bindScope(scope: string, nodeId: string, parentWebContentsId: number): Promise<void>;
  releaseScope(scope: string): void;
  installRequestAuth(webContents: WebContentsLike, scope: string): void;
  installNavigationGuards(webContents: WebContentsLike): void;
  /** The realm's own IPC context: called before its document loads. */
  register(record: WorkspaceViewRecord, parent: ParentWindowLike): void;
  unregister(record: WorkspaceViewRecord): void;
  maxViewsPerWindow?: number;
};

export const WORKSPACE_VIEWS_EVENT_CHANNEL = "orkestrator:workspace-views:event";
/** Messages from the window to a realm. */
export const WORKSPACE_REALM_MESSAGE_CHANNEL = "orkestrator:workspace-realm:message";
/** A still only stands in for the live view for a moment; it need not be lossless. */
const STILL_JPEG_QUALITY = 85;
/** One more than a window's renderer keeps open, for a realm being replaced. */
const DEFAULT_MAX_VIEWS = 4;

type ViewEntry = WorkspaceViewRecord & {
  view: ViewLike;
  parent: ParentWindowLike;
  /** Bounds in the parent's CSS pixels, as last placed. */
  cssBounds: WorkspaceViewBounds | null;
  visible: boolean;
};

export class WorkspaceViews {
  private readonly views = new Map<string, ViewEntry>();
  private readonly maxViews: number;
  private readonly pending = new Map<string, { parentId: number; cancelled: boolean }>();

  constructor(private readonly options: WorkspaceViewsOptions) {
    this.maxViews = options.maxViewsPerWindow ?? DEFAULT_MAX_VIEWS;
  }

  async open(parent: ParentWindowLike, input: WorkspaceViewOpenInput): Promise<{ viewId: string }> {
    if (parent.isDestroyed()) throw new Error("The window is not available");
    const owned = Array.from(this.views.values()).filter(
      (entry) => entry.parentWebContentsId === parent.webContents.id,
    );
    const pendingCount = Array.from(this.pending.values()).filter(
      (open) => open.parentId === parent.webContents.id && !open.cancelled,
    ).length;
    if (owned.length + pendingCount >= this.maxViews) {
      throw new Error("Too many machines are open in this window. Close one and try again.");
    }
    const viewId = randomUUID();
    const scope = `realm:${viewId}`;
    const pending = { parentId: parent.webContents.id, cancelled: false };
    this.pending.set(scope, pending);
    try {
      await this.options.bindScope(scope, input.nodeId, parent.webContents.id);
      if (pending.cancelled || parent.isDestroyed() || parent.webContents.isDestroyed()) {
        throw new Error("The window is not available");
      }
    } catch (error) {
      this.options.releaseScope(scope);
      throw error;
    } finally {
      this.pending.delete(scope);
    }
    let view: ViewLike;
    try {
      view = new this.options.WebContentsViewCtor({
        webPreferences: {
          preload: this.options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          // Same reason as the main window: the preload is bundled as ESM.
          sandbox: false,
          partition: this.options.partitionFor(input.nodeId, parent.webContents.id),
        },
      });
    } catch (error) {
      this.options.releaseScope(scope);
      throw error;
    }
    const entry: ViewEntry = {
      viewId,
      scope,
      nodeId: input.nodeId,
      parentWebContentsId: parent.webContents.id,
      webContents: view.webContents,
      layout: new RealmLayout(),
      view,
      parent,
      cssBounds: null,
      visible: false,
    };
    this.views.set(viewId, entry);
    try {
      view.setBackgroundColor?.("#00000000");
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      view.setVisible(false);
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      this.options.installNavigationGuards(view.webContents);
      this.options.installRequestAuth(view.webContents, scope);
      this.options.register(entry, parent);
      view.webContents.on("render-process-gone", () => this.dispose(entry, "crashed"));
      view.webContents.on("destroyed", () => this.dispose(entry, "closed"));
      parent.contentView.addChildView(view as never);
      // The realm renders at the window's zoom so it reads as one window.
      this.applyZoom(entry);
      const url = new URL(this.options.rendererUrl);
      url.search = "";
      url.searchParams.set("realm", "workspace");
      for (const [name, value] of Object.entries(input.search)) url.searchParams.set(name, value);
      void view.webContents.loadURL(url.toString()).catch(() => {
        this.dispose(entry, "load-failed");
      });
    } catch (error) {
      this.dispose(entry, "closed", false);
      throw error;
    }
    return { viewId };
  }

  /** Bounds arrive in the parent's CSS pixels; the view is placed in window pixels. */
  setBounds(parentWebContentsId: number, viewId: string, bounds: WorkspaceViewBounds): void {
    const entry = this.owned(parentWebContentsId, viewId);
    entry.cssBounds = { ...bounds };
    this.layout(entry);
  }

  setVisible(parentWebContentsId: number, viewId: string, visible: boolean): void {
    const entry = this.owned(parentWebContentsId, viewId);
    entry.visible = visible;
    this.layout(entry);
  }

  /**
   * A still of a realm, as a data URL, for its window to show in its place
   * while one of the window's own overlays covers the region. `null` when the
   * realm has nothing to show yet.
   */
  async capture(parentWebContentsId: number, viewId: string): Promise<string | null> {
    const entry = this.owned(parentWebContentsId, viewId);
    if (entry.webContents.isDestroyed() || !entry.webContents.capturePage) return null;
    const image = await entry.webContents.capturePage();
    if (image.isEmpty()) return null;
    return `data:image/jpeg;base64,${Buffer.from(image.toJPEG(STILL_JPEG_QUALITY)).toString("base64")}`;
  }

  /** A message from the window to one of its realms. */
  send(parentWebContentsId: number, viewId: string, message: unknown): void {
    const entry = this.owned(parentWebContentsId, viewId);
    if (!entry.webContents.isDestroyed()) {
      entry.webContents.send(WORKSPACE_REALM_MESSAGE_CHANNEL, message);
      // DOM focus cannot cross the native child webContents boundary by itself.
      // Only the shell requests this handoff, after validating the dismissal.
      if (entry.visible && message && typeof message === "object") {
        const panel = message as { type?: unknown; open?: unknown; restoreFocus?: unknown };
        if (panel.type === "panel") {
          if (panel.open === true) entry.webContents.focus?.();
          else if (
            panel.open === false &&
            panel.restoreFocus === true &&
            !entry.parent.webContents.isDestroyed()
          ) {
            entry.parent.webContents.focus?.();
          }
        }
      }
    }
  }

  /** A message from a realm to its window. */
  post(realmWebContentsId: number, message: unknown): void {
    const entry = this.entryForWebContents(realmWebContentsId);
    if (!entry) throw new Error("Only a workspace realm can message its window.");
    // A window-owned shortcut (⌘K) opens UI in the window, whose keys must
    // stop going to the realm; only a realm the user can see asks this.
    if (
      entry.visible &&
      (message as { type?: unknown } | null)?.type === "shortcut" &&
      !entry.parent.webContents.isDestroyed()
    ) {
      entry.parent.webContents.focus?.();
    }
    this.notify(entry, { viewId: entry.viewId, type: "message", message });
  }

  close(parentWebContentsId: number, viewId: string): void {
    this.dispose(this.owned(parentWebContentsId, viewId), "closed");
  }

  /** The parent window closed or navigated: every realm it owned goes with it. */
  closeAllFor(parentWebContentsId: number): void {
    for (const pending of this.pending.values()) {
      if (pending.parentId === parentWebContentsId) pending.cancelled = true;
    }
    for (const entry of Array.from(this.views.values())) {
      if (entry.parentWebContentsId === parentWebContentsId) this.dispose(entry, "closed", false);
    }
  }

  /** The parent's zoom changed. */
  zoomChanged(parentWebContentsId: number): void {
    for (const entry of this.views.values()) {
      if (entry.parentWebContentsId === parentWebContentsId) this.layout(entry);
    }
  }

  viewForWebContents(webContentsId: number): WorkspaceViewRecord | null {
    return this.entryForWebContents(webContentsId);
  }

  private entryForWebContents(webContentsId: number): ViewEntry | null {
    for (const entry of this.views.values()) {
      if (entry.webContents.id === webContentsId) return entry;
    }
    return null;
  }

  private zoom(entry: ViewEntry): number {
    const zoom = entry.parent.webContents.getZoomFactor?.() ?? 1;
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  }

  private applyZoom(entry: ViewEntry): void {
    if (!entry.webContents.isDestroyed()) entry.webContents.setZoomFactor?.(this.zoom(entry));
  }

  private layout(entry: ViewEntry): void {
    if (entry.parent.isDestroyed()) return;
    const factor = this.zoom(entry);
    const css = entry.cssBounds;
    const bounds = css
      ? {
          x: Math.round(css.x * factor),
          y: Math.round(css.y * factor),
          width: Math.round(css.width * factor),
          height: Math.round(css.height * factor),
        }
      : { x: 0, y: 0, width: 0, height: 0 };
    const visible = entry.visible && bounds.width > 0 && bounds.height > 0;
    entry.view.setBounds(bounds);
    entry.view.setVisible(visible);
    this.applyZoom(entry);
    entry.layout.update({ x: bounds.x, y: bounds.y }, visible);
  }

  private owned(parentWebContentsId: number, viewId: string): ViewEntry {
    const entry = this.views.get(viewId);
    if (!entry || entry.parentWebContentsId !== parentWebContentsId) {
      throw new Error("That workspace is no longer open.");
    }
    return entry;
  }

  private dispose(
    entry: ViewEntry,
    reason: "closed" | "crashed" | "load-failed",
    notify = true,
  ): void {
    if (this.views.get(entry.viewId) !== entry) return;
    this.views.delete(entry.viewId);
    entry.layout.update({ x: 0, y: 0 }, false);
    this.options.unregister(entry);
    this.options.releaseScope(entry.scope);
    if (!entry.parent.isDestroyed()) {
      try {
        entry.parent.contentView.removeChildView(entry.view as never);
      } catch {
        // The view may already be detached by a closing window.
      }
    }
    if (!entry.webContents.isDestroyed()) entry.webContents.close();
    if (notify) this.notify(entry, { viewId: entry.viewId, type: reason });
  }

  private notify(entry: ViewEntry, event: WorkspaceViewEvent): void {
    if (entry.parent.isDestroyed() || entry.parent.webContents.isDestroyed()) return;
    entry.parent.webContents.send(WORKSPACE_VIEWS_EVENT_CHANNEL, event);
  }
}
