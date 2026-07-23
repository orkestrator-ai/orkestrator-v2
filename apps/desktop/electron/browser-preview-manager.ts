import type {
  BrowserWindow,
  ContextMenuParams,
  Rectangle,
  Session,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from "electron";
import type {
  BrowserPreviewAttachInput,
  BrowserPreviewBounds,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";
import { createContextMenuTemplate, type MenuLike } from "./context-menu.js";

type WebContentsViewConstructor = new (options?: WebContentsViewConstructorOptions) => WebContentsView;

interface ManagedPreview {
  view: WebContentsView;
  requestedUrl: string;
  navigationScope: string;
  loading: boolean;
  error: string | null;
}

export interface BrowserPreviewManagerOptions {
  WebContentsViewCtor: WebContentsViewConstructor;
  browserSession: Session;
  menu: MenuLike;
  getWindow: () => BrowserWindow | null;
  emitState: (state: BrowserPreviewState) => void;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const GATEWAY_PREVIEW_PATH = /^\/__orkestrator\/browser\/loopback\/([1-9]\d{0,4})(?:\/|$)/;

function previewNavigationScope(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return `loopback:${url.origin}`;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const gatewayMatch = GATEWAY_PREVIEW_PATH.exec(url.pathname);
  return gatewayMatch ? `gateway:${url.origin}:${gatewayMatch[1]}` : null;
}

function isNavigationWithinScope(value: string, expectedScope: string): boolean {
  return previewNavigationScope(value) === expectedScope;
}

function assertTabId(tabId: unknown): asserts tabId is string {
  if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > 256) {
    throw new Error("Expected a browser preview tab ID");
  }
}

function validateBounds(bounds: BrowserPreviewBounds): Rectangle {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!values.every(Number.isFinite)) throw new Error("Expected finite browser preview bounds");
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

export class BrowserPreviewManager {
  private readonly previews = new Map<string, ManagedPreview>();

  constructor(private readonly options: BrowserPreviewManagerOptions) {}

  async attach(input: BrowserPreviewAttachInput): Promise<BrowserPreviewState> {
    assertTabId(input.tabId);
    const navigationScope = previewNavigationScope(input.url);
    if (!navigationScope) throw new Error("Browser previews require a loopback or authenticated gateway-preview URL");
    const bounds = validateBounds(input.bounds);
    let preview = this.previews.get(input.tabId);

    if (!preview) {
      preview = this.createPreview(input.tabId, input.url, navigationScope);
    } else if (preview.requestedUrl !== input.url) {
      preview.requestedUrl = input.url;
      preview.navigationScope = navigationScope;
      preview.error = null;
      await this.load(input.tabId, preview, input.url);
    }

    preview.view.setBounds(bounds);
    preview.view.setVisible(input.visible && bounds.width > 0 && bounds.height > 0);
    return this.snapshot(input.tabId, preview);
  }

  setBounds(tabId: string, bounds: BrowserPreviewBounds): BrowserPreviewState {
    const preview = this.get(tabId);
    const normalized = validateBounds(bounds);
    preview.view.setBounds(normalized);
    return this.snapshot(tabId, preview);
  }

  setVisible(tabId: string, visible: boolean): BrowserPreviewState | null {
    assertTabId(tabId);
    const preview = this.previews.get(tabId);
    if (!preview) return null;
    const bounds = preview.view.getBounds();
    preview.view.setVisible(visible && bounds.width > 0 && bounds.height > 0);
    return this.snapshot(tabId, preview);
  }

  async navigate(tabId: string, url: string): Promise<BrowserPreviewState> {
    const preview = this.get(tabId);
    const navigationScope = previewNavigationScope(url);
    if (!navigationScope) throw new Error("Browser previews require a loopback or authenticated gateway-preview URL");
    preview.requestedUrl = url;
    preview.navigationScope = navigationScope;
    preview.error = null;
    await this.load(tabId, preview, url);
    return this.snapshot(tabId, preview);
  }

  goBack(tabId: string): BrowserPreviewState {
    const preview = this.get(tabId);
    if (preview.view.webContents.navigationHistory.canGoBack()) {
      preview.view.webContents.navigationHistory.goBack();
    }
    return this.snapshot(tabId, preview);
  }

  goForward(tabId: string): BrowserPreviewState {
    const preview = this.get(tabId);
    if (preview.view.webContents.navigationHistory.canGoForward()) {
      preview.view.webContents.navigationHistory.goForward();
    }
    return this.snapshot(tabId, preview);
  }

  reload(tabId: string): BrowserPreviewState {
    const preview = this.get(tabId);
    preview.error = null;
    preview.view.webContents.reload();
    return this.snapshot(tabId, preview);
  }

  openDevTools(tabId: string): BrowserPreviewState {
    const preview = this.get(tabId);
    preview.view.webContents.openDevTools({ mode: "detach" });
    return this.snapshot(tabId, preview);
  }

  destroy(tabId: string): void {
    assertTabId(tabId);
    const preview = this.previews.get(tabId);
    if (!preview) return;
    this.previews.delete(tabId);
    const window = this.options.getWindow();
    if (window && !window.isDestroyed()) {
      window.contentView.removeChildView(preview.view);
    }
    if (!preview.view.webContents.isDestroyed()) {
      preview.view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  destroyAll(): void {
    for (const tabId of [...this.previews.keys()]) this.destroy(tabId);
  }

  private createPreview(tabId: string, url: string, navigationScope: string): ManagedPreview {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) throw new Error("The main window is not available");
    const view = new this.options.WebContentsViewCtor({
      webPreferences: {
        session: this.options.browserSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: true,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    view.setBackgroundColor("#00000000");
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    view.setVisible(false);
    window.contentView.addChildView(view);

    const preview: ManagedPreview = {
      view,
      requestedUrl: url,
      navigationScope,
      loading: true,
      error: null,
    };
    this.previews.set(tabId, preview);
    this.installListeners(tabId, preview);
    void this.load(tabId, preview, url);
    return preview;
  }

  private installListeners(tabId: string, preview: ManagedPreview): void {
    const contents = preview.view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("context-menu", (_event, params: ContextMenuParams) => {
      const window = this.options.getWindow();
      if (!window || window.isDestroyed()) return;

      const template = createContextMenuTemplate(params);
      if (template.length > 0) template.push({ type: "separator" });
      template.push({
        label: "Interrogate",
        click: () => {
          if (!contents.isDestroyed()) contents.inspectElement(params.x, params.y);
        },
      });
      this.options.menu.buildFromTemplate(template).popup({ window });
    });
    contents.on("will-navigate", (event) => {
      if (!isNavigationWithinScope(event.url, preview.navigationScope)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame && !isNavigationWithinScope(event.url, preview.navigationScope)) {
        event.preventDefault();
      }
    });
    contents.on("did-start-loading", () => {
      preview.loading = true;
      preview.error = null;
      this.emit(tabId, preview);
    });
    contents.on("did-stop-loading", () => {
      preview.loading = false;
      this.emit(tabId, preview);
    });
    contents.on("did-navigate", (_event, url) => {
      if (isNavigationWithinScope(url, preview.navigationScope)) preview.requestedUrl = url;
      this.emit(tabId, preview);
    });
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) {
        const url = contents.getURL();
        if (isNavigationWithinScope(url, preview.navigationScope)) preview.requestedUrl = url;
        this.emit(tabId, preview);
      }
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      preview.loading = false;
      preview.error = errorDescription;
      this.emit(tabId, preview);
    });
    contents.on("render-process-gone", (_event, details) => {
      preview.loading = false;
      preview.error = `Preview renderer stopped (${details.reason})`;
      this.emit(tabId, preview);
    });
  }

  private async load(tabId: string, preview: ManagedPreview, url: string): Promise<void> {
    preview.loading = true;
    this.emit(tabId, preview);
    try {
      await preview.view.webContents.loadURL(url);
    } catch (error) {
      if (preview.view.webContents.isDestroyed()) return;
      preview.loading = false;
      preview.error = error instanceof Error ? error.message : String(error);
      this.emit(tabId, preview);
    }
  }

  private get(tabId: string): ManagedPreview {
    assertTabId(tabId);
    const preview = this.previews.get(tabId);
    if (!preview) throw new Error(`Browser preview ${tabId} is not attached`);
    return preview;
  }

  private snapshot(tabId: string, preview: ManagedPreview): BrowserPreviewState {
    const contents = preview.view.webContents;
    return {
      tabId,
      url: contents.isDestroyed() ? "" : contents.getURL(),
      loading: preview.loading,
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      error: preview.error,
    };
  }

  private emit(tabId: string, preview: ManagedPreview): void {
    this.options.emitState(this.snapshot(tabId, preview));
  }

}
