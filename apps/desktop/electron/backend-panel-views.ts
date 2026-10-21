import { randomUUID } from "node:crypto";
import type { PanelBounds, PanelOpenInput } from "./federation-ipc.js";

/**
 * Backend-scoped workspace panels inside a desktop window.
 *
 * Each panel is its own renderer (a child view with the standard preload),
 * bound to exactly one machine through its own connection scope. Its stores,
 * caches, event subscriptions and request credentials therefore cannot
 * reach another machine: isolation comes from the realm, not from careful
 * keying. The parent window only positions panels. Closing a panel releases
 * presentation demand and its connection lease; it never stops remote work.
 */

type WebContentsLike = {
  id: number;
  isDestroyed(): boolean;
  close(): void;
  loadURL(url: string): Promise<void>;
  setZoomFactor?(factor: number): void;
  session: { webRequest: unknown };
  on(event: string, listener: (...args: unknown[]) => void): void;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
};

type ViewLike = {
  webContents: WebContentsLike;
  setBounds(bounds: PanelBounds): void;
  setVisible(visible: boolean): void;
  setBackgroundColor?(color: string): void;
};

type ParentWindowLike = {
  id: number;
  isDestroyed(): boolean;
  contentView: { addChildView(view: ViewLike): void; removeChildView(view: ViewLike): void };
  webContents: {
    id: number;
    send(channel: string, ...args: unknown[]): void;
    isDestroyed(): boolean;
    getZoomFactor?(): number;
  };
};

export type BackendPanelViewsOptions = {
  WebContentsViewCtor: new (options: { webPreferences: Record<string, unknown> }) => ViewLike;
  preloadPath: string;
  /** Exact URL of the renderer, without query. */
  rendererUrl: string;
  partitionFor(connectionId: string): string;
  bindScope(scope: string, connectionId: string): Promise<void>;
  releaseScope(scope: string): void;
  installRequestAuth(webContents: WebContentsLike, scope: string): void;
  installNavigationGuards(webContents: WebContentsLike): void;
  register(panel: PanelRecord): void;
  unregister(webContentsId: number): void;
  maxPanelsPerWindow?: number;
};

export type PanelRecord = {
  panelId: string;
  scope: string;
  connectionId: string;
  parentWebContentsId: number;
  parentWindowId: number;
  webContents: WebContentsLike;
};

export const PANEL_EVENT_CHANNEL = "orkestrator:panels:event";
const DEFAULT_MAX_PANELS = 4;

type PanelEntry = PanelRecord & { view: ViewLike; parent: ParentWindowLike };

export class BackendPanelViews {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly maxPanels: number;

  constructor(private readonly options: BackendPanelViewsOptions) {
    this.maxPanels = options.maxPanelsPerWindow ?? DEFAULT_MAX_PANELS;
  }

  async open(parent: ParentWindowLike, input: PanelOpenInput): Promise<{ panelId: string }> {
    if (parent.isDestroyed()) throw new Error("The window is not available");
    const owned = Array.from(this.panels.values()).filter(
      (panel) => panel.parentWebContentsId === parent.webContents.id,
    );
    if (owned.length >= this.maxPanels) {
      throw new Error(`Close a panel first: a window shows at most ${this.maxPanels} side panels.`);
    }
    const panelId = randomUUID();
    const scope = `panel:${panelId}`;
    await this.options.bindScope(scope, input.connectionId);
    if (parent.isDestroyed()) {
      this.options.releaseScope(scope);
      throw new Error("The window is not available");
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
          partition: this.options.partitionFor(input.connectionId),
        },
      });
    } catch (error) {
      this.options.releaseScope(scope);
      throw error;
    }
    const entry: PanelEntry = {
      panelId,
      scope,
      connectionId: input.connectionId,
      parentWebContentsId: parent.webContents.id,
      parentWindowId: parent.id,
      webContents: view.webContents,
      view,
      parent,
    };
    view.setBackgroundColor?.("#00000000");
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.options.installNavigationGuards(view.webContents);
    this.options.installRequestAuth(view.webContents, scope);
    this.panels.set(panelId, entry);
    this.options.register(entry);
    view.webContents.on("render-process-gone", () => {
      this.notify(entry, "crashed");
    });
    view.webContents.on("destroyed", () => {
      if (this.panels.get(panelId) === entry) this.dispose(entry, "closed");
    });
    parent.contentView.addChildView(view);
    const url = new URL(this.options.rendererUrl);
    url.searchParams.set("panel", "workspace");
    if (input.projectId) url.searchParams.set("project", input.projectId);
    if (input.environmentId) url.searchParams.set("environment", input.environmentId);
    view.webContents.loadURL(url.toString()).catch(() => {
      this.notify(entry, "load-failed");
    });
    return { panelId };
  }

  /** Bounds arrive in the parent's CSS pixels; the view is placed in window pixels. */
  setBounds(parentWebContentsId: number, panelId: string, bounds: PanelBounds): void {
    const entry = this.owned(parentWebContentsId, panelId);
    const zoom = entry.parent.webContents.getZoomFactor?.() ?? 1;
    const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    entry.view.setBounds({
      x: Math.round(bounds.x * factor),
      y: Math.round(bounds.y * factor),
      width: Math.round(bounds.width * factor),
      height: Math.round(bounds.height * factor),
    });
    // The panel renders at the parent's zoom so it reads as one window.
    if (!entry.webContents.isDestroyed()) entry.webContents.setZoomFactor?.(factor);
  }

  setVisible(parentWebContentsId: number, panelId: string, visible: boolean): void {
    this.owned(parentWebContentsId, panelId).view.setVisible(visible);
  }

  close(parentWebContentsId: number, panelId: string): void {
    this.dispose(this.owned(parentWebContentsId, panelId), "closed");
  }

  /** The parent window closed or navigated: every panel it owned goes with it. */
  closeAllFor(parentWebContentsId: number): void {
    for (const entry of Array.from(this.panels.values())) {
      if (entry.parentWebContentsId === parentWebContentsId) this.dispose(entry, "closed", false);
    }
  }

  setZoomFactor(parentWebContentsId: number, factor: number): void {
    for (const entry of this.panels.values()) {
      if (entry.parentWebContentsId === parentWebContentsId && !entry.webContents.isDestroyed()) {
        entry.webContents.setZoomFactor?.(factor);
      }
    }
  }

  panelForWebContents(webContentsId: number): PanelRecord | null {
    for (const entry of this.panels.values()) {
      if (entry.webContents.id === webContentsId) return entry;
    }
    return null;
  }

  private owned(parentWebContentsId: number, panelId: string): PanelEntry {
    const entry = this.panels.get(panelId);
    if (!entry || entry.parentWebContentsId !== parentWebContentsId) {
      throw new Error("That panel is no longer open.");
    }
    return entry;
  }

  private dispose(entry: PanelEntry, reason: "closed", notify = true): void {
    if (this.panels.get(entry.panelId) !== entry) return;
    this.panels.delete(entry.panelId);
    this.options.unregister(entry.webContents.id);
    this.options.releaseScope(entry.scope);
    if (!entry.parent.isDestroyed()) {
      try {
        entry.parent.contentView.removeChildView(entry.view);
      } catch {
        // The view may already be detached by a closing window.
      }
    }
    if (!entry.webContents.isDestroyed()) entry.webContents.close();
    if (notify) this.notify(entry, reason);
  }

  private notify(entry: PanelEntry, type: "closed" | "crashed" | "load-failed"): void {
    if (entry.parent.isDestroyed() || entry.parent.webContents.isDestroyed()) return;
    entry.parent.webContents.send(PANEL_EVENT_CHANNEL, { panelId: entry.panelId, type });
  }
}
