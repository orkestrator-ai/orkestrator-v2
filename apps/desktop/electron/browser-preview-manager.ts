import type {
  BrowserWindow,
  ContextMenuParams,
  InputEvent,
  MenuItemConstructorOptions,
  Rectangle,
  Session,
  WebContents,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from "electron";
import type {
  BrowserPreviewAttachInput,
  BrowserPreviewBounds,
  BrowserPreviewOpenLinkEvent,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";
import { createContextMenuTemplate, type MenuLike } from "./context-menu.js";

type WebContentsViewConstructor = new (options?: WebContentsViewConstructorOptions) => WebContentsView;

interface ManagedPreview {
  view: WebContentsView;
  requestedUrl: string;
  navigationScope: string;
  loadGeneration: number;
  loading: boolean;
  error: string | null;
}

export interface BrowserPreviewManagerOptions {
  WebContentsViewCtor: WebContentsViewConstructor;
  browserSession: Session;
  menu: MenuLike;
  getWindow: () => BrowserWindow | null;
  emitState: (state: BrowserPreviewState) => void;
  emitOpenLink: (event: BrowserPreviewOpenLinkEvent) => void;
  openExternal: (url: string) => void;
  writeClipboardText: (text: string) => void;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const GATEWAY_PREVIEW_PATH = /^\/__orkestrator\/browser\/loopback\/([1-9]\d{0,4})(\/.*)?$/;
const CLIPBOARD_USER_ACTIVATION_WINDOW_MS = 5_000;
const CLIPBOARD_USER_ACTIVATION_INPUTS = new Set<InputEvent["type"]>([
  "mouseDown",
  "pointerDown",
  "touchStart",
  "rawKeyDown",
  "keyDown",
]);

function gatewayPreviewMatch(url: URL): RegExpExecArray | null {
  const match = GATEWAY_PREVIEW_PATH.exec(url.pathname);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? match : null;
}

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
  const gatewayMatch = gatewayPreviewMatch(url);
  return gatewayMatch ? `gateway:${url.origin}:${gatewayMatch[1]}` : null;
}

function browserTabUrlFromPreviewLink(value: string, sourcePreviewUrl: string): string | null {
  let url: URL;
  let sourceUrl: URL;
  try {
    url = new URL(value);
    sourceUrl = new URL(sourcePreviewUrl);
  } catch {
    return null;
  }

  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return url.toString();
  }

  const gatewayMatch = gatewayPreviewMatch(url);
  const sourceGatewayMatch = gatewayPreviewMatch(sourceUrl);
  if (
    url.protocol !== "https:" ||
    !gatewayMatch ||
    sourceUrl.protocol !== "https:" ||
    !sourceGatewayMatch ||
    url.origin !== sourceUrl.origin
  ) {
    return null;
  }

  try {
    return new URL(
      `${gatewayMatch[2] ?? "/"}${url.search}${url.hash}`,
      `http://localhost:${gatewayMatch[1]}`,
    ).toString();
  } catch {
    return null;
  }
}

function isExternalBrowserUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
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
  private readonly clipboardUserActivations = new WeakMap<WebContents, number>();

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
      this.clipboardUserActivations.delete(preview.view.webContents);
      preview.requestedUrl = input.url;
      preview.navigationScope = navigationScope;
      preview.error = null;
      await this.load(input.tabId, preview, input.url);
    }

    preview.view.setBounds(bounds);
    const visible = input.visible && bounds.width > 0 && bounds.height > 0;
    preview.view.setVisible(visible);
    if (!visible) this.clipboardUserActivations.delete(preview.view.webContents);
    return this.snapshot(input.tabId, preview);
  }

  setBounds(tabId: string, bounds: BrowserPreviewBounds): BrowserPreviewState {
    const preview = this.get(tabId);
    const normalized = validateBounds(bounds);
    preview.view.setBounds(normalized);
    if (normalized.width <= 0 || normalized.height <= 0) {
      this.clipboardUserActivations.delete(preview.view.webContents);
    }
    return this.snapshot(tabId, preview);
  }

  setVisible(tabId: string, visible: boolean): BrowserPreviewState | null {
    assertTabId(tabId);
    const preview = this.previews.get(tabId);
    if (!preview) return null;
    const bounds = preview.view.getBounds();
    const nextVisible = visible && bounds.width > 0 && bounds.height > 0;
    preview.view.setVisible(nextVisible);
    if (!nextVisible) this.clipboardUserActivations.delete(preview.view.webContents);
    return this.snapshot(tabId, preview);
  }

  consumeClipboardWriteUserActivation(
    webContents: WebContents,
    requestingUrl: string,
  ): boolean {
    if (webContents.isDestroyed()) return false;
    const preview = [...this.previews.values()].find(
      (candidate) => candidate.view.webContents === webContents,
    );
    if (!preview || !preview.view.getVisible()) return false;
    const bounds = preview.view.getBounds();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    if (
      !isNavigationWithinScope(webContents.getURL(), preview.navigationScope) ||
      !isNavigationWithinScope(requestingUrl, preview.navigationScope)
    ) {
      return false;
    }

    const activatedAt = this.clipboardUserActivations.get(webContents);
    if (activatedAt === undefined) return false;
    this.clipboardUserActivations.delete(webContents);
    const activationAge = Date.now() - activatedAt;
    return activationAge >= 0
      && activationAge <= CLIPBOARD_USER_ACTIVATION_WINDOW_MS;
  }

  async navigate(tabId: string, url: string): Promise<BrowserPreviewState> {
    const preview = this.get(tabId);
    const navigationScope = previewNavigationScope(url);
    if (!navigationScope) throw new Error("Browser previews require a loopback or authenticated gateway-preview URL");
    this.clipboardUserActivations.delete(preview.view.webContents);
    preview.requestedUrl = url;
    preview.navigationScope = navigationScope;
    preview.error = null;
    await this.load(tabId, preview, url);
    return this.snapshot(tabId, preview);
  }

  goBack(tabId: string): BrowserPreviewState {
    return this.navigateHistory(tabId, -1);
  }

  goForward(tabId: string): BrowserPreviewState {
    return this.navigateHistory(tabId, 1);
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
    this.clipboardUserActivations.delete(preview.view.webContents);
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
      loadGeneration: 0,
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
    contents.on("input-event", (_event, input: InputEvent) => {
      if (CLIPBOARD_USER_ACTIVATION_INPUTS.has(input.type)) {
        this.clipboardUserActivations.set(contents, Date.now());
      }
    });
    contents.on("context-menu", (_event, params: ContextMenuParams) => {
      const window = this.options.getWindow();
      if (!window || window.isDestroyed()) return;

      const template: MenuItemConstructorOptions[] = [];
      if (params.linkURL) {
        const browserTabUrl = browserTabUrlFromPreviewLink(params.linkURL, preview.requestedUrl);
        const externalBrowserUrl = isExternalBrowserUrl(params.linkURL);
        template.push(
          {
            label: "Open Link in New Tab",
            enabled: browserTabUrl !== null,
            click: () => {
              if (browserTabUrl) this.options.emitOpenLink({ tabId, url: browserTabUrl });
            },
          },
          {
            label: "Open in External Browser",
            enabled: externalBrowserUrl,
            click: () => {
              if (externalBrowserUrl) this.options.openExternal(params.linkURL);
            },
          },
          {
            label: "Copy Link Address",
            click: () => this.options.writeClipboardText(params.linkURL),
          },
        );
      }

      const defaultTemplate = createContextMenuTemplate(params);
      if (defaultTemplate.length > 0) {
        if (template.length > 0) template.push({ type: "separator" });
        template.push(...defaultTemplate);
      }
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
      this.clipboardUserActivations.delete(contents);
      if (!isNavigationWithinScope(event.url, preview.navigationScope)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame) this.clipboardUserActivations.delete(contents);
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
      this.clipboardUserActivations.delete(contents);
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
    const generation = ++preview.loadGeneration;
    preview.loading = true;
    this.emit(tabId, preview);
    try {
      await preview.view.webContents.loadURL(url);
    } catch (error) {
      if (
        preview.loadGeneration !== generation ||
        this.previews.get(tabId) !== preview ||
        preview.view.webContents.isDestroyed()
      ) {
        return;
      }
      preview.loading = false;
      preview.error = error instanceof Error ? error.message : String(error);
      this.emit(tabId, preview);
    }
  }

  private navigateHistory(tabId: string, offset: -1 | 1): BrowserPreviewState {
    const preview = this.get(tabId);
    const history = preview.view.webContents.navigationHistory;
    const canNavigate = offset === -1 ? history.canGoBack() : history.canGoForward();
    if (!canNavigate) return this.snapshot(tabId, preview);

    const destination = history.getEntryAtIndex(history.getActiveIndex() + offset);
    const navigationScope = destination && previewNavigationScope(destination.url);
    if (!navigationScope) {
      preview.error = "Blocked browser history navigation outside preview scope";
      return this.snapshot(tabId, preview);
    }

    // Programmatic history navigation does not emit `will-navigate`. Authorize the
    // validated destination before Chromium starts it so redirects and the eventual
    // commit are checked against the destination scope rather than the page we left.
    preview.requestedUrl = destination.url;
    preview.navigationScope = navigationScope;
    preview.error = null;
    preview.loadGeneration += 1;
    this.clipboardUserActivations.delete(preview.view.webContents);
    if (offset === -1) history.goBack();
    else history.goForward();
    return this.snapshot(tabId, preview);
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
