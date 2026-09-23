import type {
  BrowserWindow,
  ContextMenuParams,
  InputEvent,
  MenuItemConstructorOptions,
  NativeImage,
  Rectangle,
  Session,
  WebContents,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from "electron";
import { randomUUID } from "node:crypto";
import type {
  BrowserPreviewAnnotationStatus,
  BrowserPreviewAttachInput,
  BrowserPreviewBounds,
  BrowserPreviewElementDetails,
  BrowserPreviewOpenLinkEvent,
  BrowserPreviewServiceTarget,
  BrowserPreviewState,
  BrowserPreviewTransportState,
} from "@orkestrator/protocol/browser-preview";
import { previewFailure } from "@orkestrator/protocol/preview-services";
import { createContextMenuTemplate, type MenuLike } from "./context-menu.js";
import {
  BROWSER_PREVIEW_ANNOTATION_CANCEL_SCRIPT,
  BROWSER_PREVIEW_ANNOTATION_STATUS_SCRIPT,
  browserPreviewAnnotationStartScript,
} from "./browser-preview-annotation-script.js";

type WebContentsViewConstructor = new (
  options?: WebContentsViewConstructorOptions,
) => WebContentsView;

interface ManagedPreview {
  view: WebContentsView;
  requestedUrl: string;
  navigationScope: string;
  loadGeneration: number;
  loading: boolean;
  error: string | null;
  annotationSessionId?: string;
  /** Service previews: transport key and the partition the view was created with. */
  service?: { key: string; partition: string };
}

/**
 * Service transport owned by Electron main (see `PreviewTransportManager`).
 * The renderer supplies only a service reference; main resolves the URL.
 */
export interface BrowserPreviewServiceTransport {
  acquire(
    target: BrowserPreviewServiceTarget,
    holderId: string,
  ): Promise<{ serviceKey: string; partition: string; url: string }>;
  release(serviceKey: string, holderId: string): void;
  scopeFor(url: string): string | null;
  describe(
    url: string,
  ): { serviceKey: string; serviceId: string; path: string; displayUrl: string } | null;
  target(serviceKey: string): Omit<BrowserPreviewServiceTarget, "path"> | null;
  transportState(serviceKey: string): BrowserPreviewTransportState;
  sessionFor(partition: string): Session;
  resetSiteData(
    target: Pick<BrowserPreviewServiceTarget, "backendInstanceId" | "serviceId">,
  ): Promise<void>;
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
  focusAddressBar: (tabId: string) => void;
  /** Service previews are unavailable without a transport (old backend, feature off). */
  transport?: BrowserPreviewServiceTransport;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const GATEWAY_PREVIEW_PATH = /^\/__orkestrator\/browser\/loopback\/([1-9]\d{0,4})(\/.*)?$/;
const CLIPBOARD_USER_ACTIVATION_WINDOW_MS = 5_000;
const MAX_ANNOTATION_SCREENSHOT_DIMENSION = 2_000;
const MAX_ANNOTATION_SCREENSHOT_BYTES = 8 * 1024 * 1024;
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
    const destination = new URL(`http://localhost:${gatewayMatch[1]}`);
    destination.pathname = gatewayMatch[2] ?? "/";
    destination.search = url.search;
    destination.hash = url.hash;
    return destination.toString();
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

function assertTabId(tabId: unknown): asserts tabId is string {
  if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > 256) {
    throw new Error("Expected a browser preview tab ID");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, entry]) => key.length <= 200 && typeof entry === "string" && entry.length <= 12_000,
    )
  );
}

function isFiniteRect(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["x", "y", "width", "height", "top", "right", "bottom", "left"].every(
    (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
  );
}

function isElementDetails(value: unknown): value is BrowserPreviewElementDetails {
  if (!isRecord(value) || !isRecord(value.viewport) || !isFiniteRect(value.rect)) return false;
  const boundedStrings = [
    [value.pageUrl, 4_000],
    [value.pageTitle, 1_000],
    [value.tagName, 100],
    [value.selector, 2_000],
    [value.cssPath, 8_000],
    [value.xpath, 8_000],
    [value.text, 4_000],
    [value.outerHtml, 12_000],
  ] as const;
  if (
    boundedStrings.some(([entry, limit]) => typeof entry !== "string" || entry.length > limit) ||
    ![value.viewport.width, value.viewport.height, value.viewport.devicePixelRatio].every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    ) ||
    !isStringRecord(value.attributes) ||
    !isStringRecord(value.styles) ||
    !Array.isArray(value.classNames) ||
    value.classNames.length > 50 ||
    value.classNames.some((entry) => typeof entry !== "string" || entry.length > 500) ||
    !Array.isArray(value.hierarchy) ||
    value.hierarchy.length > 32
  ) {
    return false;
  }
  for (const nullable of [value.id, value.role, value.ariaLabel, value.testId]) {
    if (nullable !== null && (typeof nullable !== "string" || nullable.length > 2_000))
      return false;
  }
  return value.hierarchy.every((ancestor) => {
    if (!isRecord(ancestor)) return false;
    return (
      typeof ancestor.tagName === "string" &&
      ancestor.tagName.length <= 100 &&
      typeof ancestor.selector === "string" &&
      ancestor.selector.length <= 2_000 &&
      Array.isArray(ancestor.classNames) &&
      ancestor.classNames.length <= 50 &&
      ancestor.classNames.every((entry) => typeof entry === "string" && entry.length <= 500) &&
      [ancestor.id, ancestor.role, ancestor.ariaLabel, ancestor.testId].every(
        (entry) => entry === null || (typeof entry === "string" && entry.length <= 2_000),
      )
    );
  });
}

function parseAnnotationRuntimeStatus(
  value: unknown,
  expectedSessionId: string | undefined,
):
  | { status: "inactive" | "active" | "cancelled" }
  | { status: "error"; message: string }
  | { status: "submitted"; comment: string; element: BrowserPreviewElementDetails } {
  if (typeof value !== "string" || value.length > 65_536) return { status: "inactive" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { status: "inactive" };
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.status !== "string" ||
    typeof parsed.sessionId !== "string" ||
    parsed.sessionId !== expectedSessionId
  ) {
    return { status: "inactive" };
  }
  if (parsed.status === "active" || parsed.status === "cancelled" || parsed.status === "inactive") {
    return { status: parsed.status };
  }
  if (
    parsed.status === "error" &&
    typeof parsed.message === "string" &&
    parsed.message.trim().length > 0 &&
    parsed.message.length <= 500
  ) {
    return { status: "error", message: parsed.message };
  }
  if (
    parsed.status === "submitted" &&
    typeof parsed.comment === "string" &&
    parsed.comment.trim().length > 0 &&
    parsed.comment.length <= 2_000 &&
    isElementDetails(parsed.element)
  ) {
    return { status: "submitted", comment: parsed.comment, element: parsed.element };
  }
  return { status: "inactive" };
}

function pngDataUrlByteLength(dataUrl: string): number {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) throw new Error("The browser frame did not return a PNG image");
  const base64 = dataUrl.slice(prefix.length);
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("The browser frame returned an invalid PNG image");
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function annotationScreenshotDataUrl(image: NativeImage): string {
  const originalSize = image.getSize();
  const longestSide = Math.max(originalSize.width, originalSize.height);
  const initialScale = Math.min(1, MAX_ANNOTATION_SCREENSHOT_DIMENSION / longestSide);
  let width = Math.max(1, Math.round(originalSize.width * initialScale));
  let height = Math.max(1, Math.round(originalSize.height * initialScale));
  let candidate = initialScale < 1 ? image.resize({ width, height, quality: "best" }) : image;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const dataUrl = candidate.toDataURL();
    const byteLength = pngDataUrlByteLength(dataUrl);
    if (byteLength <= MAX_ANNOTATION_SCREENSHOT_BYTES) return dataUrl;
    if (width === 1 && height === 1) break;
    const byteScale = Math.sqrt(MAX_ANNOTATION_SCREENSHOT_BYTES / byteLength) * 0.92;
    const scale = Math.min(0.85, Math.max(0.1, byteScale));
    const nextWidth = Math.max(1, Math.floor(width * scale));
    const nextHeight = Math.max(1, Math.floor(height * scale));
    width = nextWidth === width && width > 1 ? width - 1 : nextWidth;
    height = nextHeight === height && height > 1 ? height - 1 : nextHeight;
    candidate = image.resize({ width, height, quality: "best" });
  }

  throw new Error("The browser screenshot is too large to save. Try a smaller preview window.");
}

function validateBounds(bounds: BrowserPreviewBounds, zoomFactor: number): Rectangle {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!values.every(Number.isFinite)) throw new Error("Expected finite browser preview bounds");
  return {
    x: Math.max(0, Math.round(bounds.x * zoomFactor)),
    y: Math.max(0, Math.round(bounds.y * zoomFactor)),
    width: Math.max(0, Math.round(bounds.width * zoomFactor)),
    height: Math.max(0, Math.round(bounds.height * zoomFactor)),
  };
}

export class BrowserPreviewManager {
  private readonly previews = new Map<string, ManagedPreview>();
  private readonly clipboardUserActivations = new WeakMap<WebContents, number>();

  constructor(private readonly options: BrowserPreviewManagerOptions) {}

  /**
   * The renderer measures the preview host with `getBoundingClientRect()`, which
   * reports CSS pixels. `WebContentsView.setBounds` takes window DIPs, and the
   * host's native page zoom is exactly the factor between them, so every rect
   * from the renderer has to be scaled by it. Falls back to 1 whenever the
   * window cannot be asked, which is also the CSS-zoom fallback's factor: there
   * the renderer is not natively zoomed, so its rects are already DIPs.
   */
  private hostZoomFactor(): number {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return 1;
    const factor = window.webContents?.getZoomFactor?.();
    return typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
  }

  /** Service transport scope first, then the legacy loopback/gateway rules. */
  private scopeFor(url: string): string | null {
    return this.options.transport?.scopeFor(url) ?? previewNavigationScope(url);
  }

  private withinScope(url: string, scope: string): boolean {
    return this.scopeFor(url) === scope;
  }

  async attach(input: BrowserPreviewAttachInput): Promise<BrowserPreviewState> {
    assertTabId(input.tabId);
    if (input.service) return this.attachService(input, input.service);
    const url = input.url;
    const navigationScope = typeof url === "string" ? previewNavigationScope(url) : null;
    if (!url || !navigationScope)
      throw new Error("Browser previews require a loopback or authenticated gateway-preview URL");
    const bounds = validateBounds(input.bounds, this.hostZoomFactor());
    let preview = this.previews.get(input.tabId);
    if (preview?.service) {
      // A tab switching from a service to a manual URL needs the shared legacy session.
      this.destroy(input.tabId);
      preview = undefined;
    }

    if (!preview) {
      preview = this.createPreview(input.tabId, url, navigationScope);
    } else if (preview.requestedUrl !== url) {
      this.clipboardUserActivations.delete(preview.view.webContents);
      preview.requestedUrl = url;
      preview.navigationScope = navigationScope;
      preview.error = null;
      await this.load(input.tabId, preview, url);
    }

    preview.view.setBounds(bounds);
    const visible = input.visible && bounds.width > 0 && bounds.height > 0;
    preview.view.setVisible(visible);
    if (!visible) this.clipboardUserActivations.delete(preview.view.webContents);
    return this.snapshot(input.tabId, preview);
  }

  private async attachService(
    input: BrowserPreviewAttachInput,
    target: BrowserPreviewServiceTarget,
  ): Promise<BrowserPreviewState> {
    const transport = this.options.transport;
    if (!transport) {
      throw previewFailure("unsupported", { message: "Service previews are not available." });
    }
    const bounds = validateBounds(input.bounds, this.hostZoomFactor());
    const descriptor = await transport.acquire(target, input.tabId);
    let preview = this.previews.get(input.tabId);
    // A session cannot change after a view exists: another service (or a
    // legacy tab) needs a fresh view on this service's partition.
    // Partitions derive from the service key, so an equal partition is the same service.
    if (preview && preview.service?.partition !== descriptor.partition) {
      this.destroy(input.tabId);
      preview = undefined;
    }
    const scope = `service:${descriptor.serviceKey}`;
    if (!preview) {
      preview = this.createPreview(input.tabId, descriptor.url, scope, {
        session: transport.sessionFor(descriptor.partition),
        service: { key: descriptor.serviceKey, partition: descriptor.partition },
      });
    } else {
      preview.service = { key: descriptor.serviceKey, partition: descriptor.partition };
      const current = transport.describe(preview.requestedUrl);
      if (current?.serviceKey !== descriptor.serviceKey || current.path !== target.path) {
        this.clipboardUserActivations.delete(preview.view.webContents);
        preview.requestedUrl = descriptor.url;
        preview.navigationScope = scope;
        preview.error = null;
        await this.load(input.tabId, preview, descriptor.url);
      }
    }
    preview.view.setBounds(bounds);
    const visible = input.visible && bounds.width > 0 && bounds.height > 0;
    preview.view.setVisible(visible);
    if (!visible) this.clipboardUserActivations.delete(preview.view.webContents);
    return this.snapshot(input.tabId, preview);
  }

  /**
   * Reset one service's site data. Open views of that service reload so the
   * page does not keep using state that no longer exists on disk.
   */
  async resetServiceSiteData(target: BrowserPreviewServiceTarget): Promise<void> {
    const transport = this.options.transport;
    if (!transport) throw previewFailure("unsupported");
    await transport.resetSiteData(target);
    for (const preview of this.previews.values()) {
      const owner = preview.service ? transport.target(preview.service.key) : null;
      if (
        owner?.serviceId === target.serviceId &&
        owner.backendInstanceId === target.backendInstanceId
      ) {
        preview.view.webContents.reload();
      }
    }
  }

  /** Re-emit state for every tab of a service whose transport state changed. */
  refreshService(serviceKey: string): void {
    for (const [tabId, preview] of this.previews) {
      if (preview.service?.key === serviceKey) this.emit(tabId, preview);
    }
  }

  setBounds(tabId: string, bounds: BrowserPreviewBounds): BrowserPreviewState {
    const preview = this.get(tabId);
    const normalized = validateBounds(bounds, this.hostZoomFactor());
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

  consumeClipboardWriteUserActivation(webContents: WebContents, requestingUrl: string): boolean {
    if (webContents.isDestroyed()) return false;
    const preview = [...this.previews.values()].find(
      (candidate) => candidate.view.webContents === webContents,
    );
    if (!preview || !preview.view.getVisible()) return false;
    const bounds = preview.view.getBounds();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    if (
      !this.withinScope(webContents.getURL(), preview.navigationScope) ||
      !this.withinScope(requestingUrl, preview.navigationScope)
    ) {
      return false;
    }

    const activatedAt = this.clipboardUserActivations.get(webContents);
    if (activatedAt === undefined) return false;
    this.clipboardUserActivations.delete(webContents);
    const activationAge = Date.now() - activatedAt;
    return activationAge >= 0 && activationAge <= CLIPBOARD_USER_ACTIVATION_WINDOW_MS;
  }

  async navigate(tabId: string, url: string): Promise<BrowserPreviewState> {
    const preview = this.get(tabId);
    const navigationScope = this.scopeFor(url);
    if (preview.service && navigationScope !== preview.navigationScope) {
      throw new Error("Service previews navigate by service path; attach the new path instead");
    }
    if (!navigationScope)
      throw new Error("Browser previews require a loopback or authenticated gateway-preview URL");
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

  async startAnnotation(tabId: string): Promise<BrowserPreviewAnnotationStatus> {
    const preview = this.get(tabId);
    const sessionId = randomUUID();
    preview.annotationSessionId = sessionId;
    try {
      await preview.view.webContents.executeJavaScript(
        browserPreviewAnnotationStartScript(sessionId),
        true,
      );
    } catch (error) {
      delete preview.annotationSessionId;
      throw error;
    }
    return { status: "active" };
  }

  async getAnnotationStatus(tabId: string): Promise<BrowserPreviewAnnotationStatus> {
    const preview = this.get(tabId);
    const encoded = await preview.view.webContents.executeJavaScript(
      BROWSER_PREVIEW_ANNOTATION_STATUS_SCRIPT,
      true,
    );
    const status = parseAnnotationRuntimeStatus(encoded, preview.annotationSessionId);
    if (status.status === "active") return status;
    if (status.status !== "submitted") {
      delete preview.annotationSessionId;
      await preview.view.webContents
        .executeJavaScript(BROWSER_PREVIEW_ANNOTATION_CANCEL_SCRIPT, true)
        .catch(() => undefined);
      return status;
    }

    const screenshot = await preview.view.webContents.capturePage();
    const screenshotDataUrl = annotationScreenshotDataUrl(screenshot);
    await preview.view.webContents
      .executeJavaScript(BROWSER_PREVIEW_ANNOTATION_CANCEL_SCRIPT, true)
      .catch(() => undefined);
    delete preview.annotationSessionId;
    return {
      ...status,
      screenshotDataUrl,
    };
  }

  async cancelAnnotation(tabId: string): Promise<void> {
    const preview = this.get(tabId);
    delete preview.annotationSessionId;
    await preview.view.webContents
      .executeJavaScript(BROWSER_PREVIEW_ANNOTATION_CANCEL_SCRIPT, true)
      .catch(() => undefined);
  }

  destroy(tabId: string): void {
    assertTabId(tabId);
    const preview = this.previews.get(tabId);
    if (!preview) return;
    this.previews.delete(tabId);
    this.clipboardUserActivations.delete(preview.view.webContents);
    if (preview.service) this.options.transport?.release(preview.service.key, tabId);
    const window = this.options.getWindow();
    if (window && !window.isDestroyed()) {
      window.contentView.removeChildView(preview.view);
    }
    if (!preview.view.webContents.isDestroyed()) {
      preview.view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  destroyAll(): void {
    for (const tabId of Array.from(this.previews.keys())) this.destroy(tabId);
  }

  private createPreview(
    tabId: string,
    url: string,
    navigationScope: string,
    service?: { session: Session; service: NonNullable<ManagedPreview["service"]> },
  ): ManagedPreview {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) throw new Error("The main window is not available");
    const view = new this.options.WebContentsViewCtor({
      webPreferences: {
        // Service previews get their own partition; legacy previews share the
        // window/connection partition as before.
        session: service?.session ?? this.options.browserSession,
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
      ...(service ? { service: service.service } : {}),
    };
    this.previews.set(tabId, preview);
    this.installListeners(tabId, preview);
    void this.load(tabId, preview, url);
    return preview;
  }

  private installListeners(tabId: string, preview: ManagedPreview): void {
    const contents = preview.view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("before-input-event", (event, input) => {
      const isAddressShortcut =
        input.type === "keyDown" &&
        input.key.toLowerCase() === "l" &&
        (input.meta || input.control) &&
        !input.alt &&
        !input.shift;
      if (!isAddressShortcut) return;

      event.preventDefault();
      this.options.focusAddressBar(tabId);
    });
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
        // Service previews open same-service links as service tabs; anything
        // else is external-only, so a remote page cannot open a client-local URL.
        const serviceLink = preview.service
          ? this.options.transport?.describe(params.linkURL)
          : null;
        const serviceTarget =
          serviceLink && serviceLink.serviceKey === preview.service?.key
            ? this.options.transport?.target(serviceLink.serviceKey)
            : null;
        const browserTabUrl = preview.service
          ? (serviceLink?.displayUrl ?? null)
          : browserTabUrlFromPreviewLink(params.linkURL, preview.requestedUrl);
        const externalBrowserUrl = isExternalBrowserUrl(params.linkURL);
        template.push(
          {
            label: "Open Link in New Tab",
            enabled: browserTabUrl !== null && (!preview.service || Boolean(serviceTarget)),
            click: () => {
              if (!browserTabUrl) return;
              if (serviceTarget && serviceLink) {
                this.options.emitOpenLink({
                  tabId,
                  url: browserTabUrl,
                  service: { ...serviceTarget, path: serviceLink.path },
                });
              } else if (!preview.service) {
                this.options.emitOpenLink({ tabId, url: browserTabUrl });
              }
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
            // Never copy a runtime ingress URL; copy the application address.
            click: () => this.options.writeClipboardText(serviceLink?.displayUrl ?? params.linkURL),
          },
        );
      }

      const defaultTemplate = createContextMenuTemplate(params, {
        replaceMisspelling: (suggestion) => {
          contents.replaceMisspelling(suggestion);
        },
        addToDictionary: (word) => {
          contents.session.addWordToSpellCheckerDictionary(word);
        },
        copyImageAt: (x, y) => {
          if (!contents.isDestroyed()) contents.copyImageAt(x, y);
        },
        writeClipboardText: this.options.writeClipboardText,
      });
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
      if (!this.withinScope(event.url, preview.navigationScope)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame) this.clipboardUserActivations.delete(contents);
      if (event.isMainFrame && !this.withinScope(event.url, preview.navigationScope)) {
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
      if (this.withinScope(url, preview.navigationScope)) preview.requestedUrl = url;
      this.emit(tabId, preview);
    });
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) {
        const url = contents.getURL();
        if (this.withinScope(url, preview.navigationScope)) preview.requestedUrl = url;
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
    const navigationScope = destination && this.scopeFor(destination.url);
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
    const url = contents.isDestroyed() ? "" : contents.getURL();
    const transport = this.options.transport;
    const described =
      preview.service && transport ? transport.describe(url || preview.requestedUrl) : null;
    return {
      tabId,
      url,
      loading: preview.loading,
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      error: preview.error,
      ...(preview.service && transport
        ? {
            ...(described
              ? {
                  service: {
                    serviceId: described.serviceId,
                    path: described.path,
                    displayUrl: described.displayUrl,
                  },
                }
              : {}),
            transport: transport.transportState(preview.service.key),
          }
        : {}),
    };
  }

  private emit(tabId: string, preview: ManagedPreview): void {
    this.options.emitState(this.snapshot(tabId, preview));
  }
}
