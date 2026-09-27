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
  BrowserPreviewAnchorResult,
  BrowserPreviewAttachInput,
  BrowserPreviewBounds,
  BrowserPreviewCaptureAck,
  BrowserPreviewCaptureCapabilities,
  BrowserPreviewCaptureEvent,
  BrowserPreviewExpiredCaptureNotice,
  BrowserPreviewOpenLinkEvent,
  BrowserPreviewPendingCapture,
  BrowserPreviewPendingCaptureDescriptor,
  BrowserPreviewPinSnapshot,
  BrowserPreviewPinsInput,
  BrowserPreviewReplaceImageInput,
  BrowserPreviewResponsiveSetInput,
  BrowserPreviewResponsiveSetResult,
  BrowserPreviewSelectionStatus,
  BrowserPreviewServiceTarget,
  BrowserPreviewShowOnPageInput,
  BrowserPreviewShowOnPageResult,
  BrowserPreviewStartCaptureInput,
  BrowserPreviewState,
  BrowserPreviewTransportState,
} from "@orkestrator/protocol/browser-preview";
import { previewFailure } from "@orkestrator/protocol/preview-services";
import { createContextMenuTemplate, type MenuLike } from "./context-menu.js";
import {
  BrowserPreviewCaptureSessions,
  type CaptureNativeImageApi,
  type CapturePreviewHandle,
  type CaptureStoreLike,
  type CaptureWebContents,
} from "./browser-preview-capture.js";
import {
  BrowserPreviewPinSessions,
  type BrowserPreviewPinSessionsOptions,
} from "./browser-preview-capture-pins.js";
import { captureResponsiveSet } from "./browser-preview-capture-responsive.js";
import { captureTabId } from "./browser-preview-capture-validation.js";

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
  /**
   * Advances on every main-frame navigation start/commit (including in-page
   * route changes) and reload. A capture is bound to the generation it started in.
   */
  documentGeneration: number;
  /**
   * Service previews: transport key, the partition the view was created with,
   * and the transport holder the view keeps (unique per attach, so a stale
   * attach can release its own hold without dropping a newer one).
   */
  service?: { key: string; partition: string; holderId: string };
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
  /** Open a service in the default browser through the private preview origin. */
  openServiceExternally?: (target: BrowserPreviewServiceTarget) => Promise<void>;
  /** Process-wide pending capture spool; capture is unavailable without it. */
  captureStore?: CaptureStoreLike;
  /** Content-free capture status hints for the owning renderer. */
  emitCaptureEvent?: (event: BrowserPreviewCaptureEvent) => void;
  /** Used to paint opaque masks over sensitive fields in captured pixels. */
  nativeImage?: CaptureNativeImageApi;
  capturePollIntervalMs?: number;
  /** Live pin polling and page-side limits (tests shorten or disable them). */
  pins?: Pick<BrowserPreviewPinSessionsOptions, "livePollIntervalMs" | "pageLimits" | "sleep">;
  /** Result-capture and responsive stability windows (tests shorten them). */
  stability?: { deadlineMs: number; quietMs: number };
  now?: () => number;
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
    const destination = new URL(`http://localhost:${gatewayMatch[1]}`);
    destination.pathname = gatewayMatch[2] ?? "/";
    destination.search = url.search;
    destination.hash = url.hash;
    return destination.toString();
  } catch {
    return null;
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
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
  /**
   * The latest attach per tab. An attach whose token is no longer current was
   * superseded by a newer attach or cancelled by `destroy`, and must not
   * create, replace, or show a view once its awaits resume.
   */
  private readonly attachTokens = new Map<string, number>();
  private readonly pendingAttaches = new Map<string, Promise<BrowserPreviewState>>();
  private attachSequence = 0;
  private disposed = false;
  private readonly captures: BrowserPreviewCaptureSessions;
  private readonly pins: BrowserPreviewPinSessions;

  constructor(private readonly options: BrowserPreviewManagerOptions) {
    this.captures = new BrowserPreviewCaptureSessions({
      preview: (tabId) => this.captureHandle(tabId),
      ...(options.captureStore ? { store: options.captureStore } : {}),
      ...(options.emitCaptureEvent ? { emit: options.emitCaptureEvent } : {}),
      ...(options.nativeImage ? { nativeImage: options.nativeImage } : {}),
      ...(options.capturePollIntervalMs !== undefined
        ? { pollIntervalMs: options.capturePollIntervalMs }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.stability ? { stability: options.stability } : {}),
      focusHost: () => this.focusHost(),
    });
    this.pins = new BrowserPreviewPinSessions({
      preview: (tabId) => this.captureHandle(tabId),
      ...(options.emitCaptureEvent ? { emit: options.emitCaptureEvent } : {}),
      // Deadlines use the real clock; `options.now` only stamps records.
      ...options.pins,
    });
  }

  /** Give keyboard focus back to the app window's renderer (the trusted editor). */
  private focusHost(): void {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return;
    const host = window as unknown as { focus?: () => void; webContents?: { focus?: () => void } };
    host.focus?.();
    host.webContents?.focus?.();
  }

  private captureHandle(tabId: string): CapturePreviewHandle | null {
    const preview = this.previews.get(tabId);
    if (!preview) return null;
    const transport = this.options.transport;
    return {
      contents: preview.view.webContents as unknown as CaptureWebContents,
      generation: preview.documentGeneration,
      visible: preview.view.getVisible(),
      loading: preview.loading,
      navigate: async (url: string) => {
        await this.navigate(tabId, url);
      },
      viewSize: () => {
        const bounds = preview.view.getBounds();
        return { width: bounds.width, height: bounds.height };
      },
      ...(preview.service && transport
        ? { describeService: (url: string) => transport.describe(url) }
        : {}),
    };
  }

  private advanceDocument(tabId: string, preview: ManagedPreview): void {
    preview.documentGeneration += 1;
    if (this.previews.get(tabId) === preview) {
      this.captures.onDocumentChanged(tabId);
      this.pins.onDocumentChanged(tabId, { loading: preview.loading });
    }
  }

  /** Apply visibility; a shown-to-hidden transition ends any selection in progress. */
  private applyVisibility(tabId: string, preview: ManagedPreview, visible: boolean): void {
    const wasVisible = preview.view.getVisible();
    preview.view.setVisible(visible);
    if (!visible) this.clipboardUserActivations.delete(preview.view.webContents);
    if (wasVisible && !visible) this.captures.onHidden(tabId);
  }

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

  attach(input: BrowserPreviewAttachInput): Promise<BrowserPreviewState> {
    try {
      assertTabId(input.tabId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.disposed) return Promise.reject(this.attachCancelled());
    const tabId = input.tabId;
    const token = ++this.attachSequence;
    this.attachTokens.set(tabId, token);
    const attempt = input.service
      ? this.attachService(input, input.service, token)
      : this.attachUrl(input, token);
    this.pendingAttaches.set(tabId, attempt);
    const settle = () => {
      if (this.pendingAttaches.get(tabId) === attempt) this.pendingAttaches.delete(tabId);
    };
    attempt.then(settle, settle);
    return attempt;
  }

  private isCurrentAttach(tabId: string, token: number): boolean {
    return !this.disposed && this.attachTokens.get(tabId) === token;
  }

  private attachCancelled(): Error {
    return previewFailure("backend-unavailable", {
      message: "The browser preview closed before it attached.",
    });
  }

  /**
   * Result for an attach that lost its turn. The renderer re-attaches on every
   * resize, so a superseded attach resolves with the newest attach's outcome
   * instead of failing (a failure would hide the view the newer attach shows).
   */
  private supersededAttach(tabId: string): Promise<BrowserPreviewState> | BrowserPreviewState {
    if (this.disposed) throw this.attachCancelled();
    const latest = this.pendingAttaches.get(tabId);
    if (latest) return latest;
    const preview = this.previews.get(tabId);
    if (preview) return this.snapshot(tabId, preview);
    throw this.attachCancelled();
  }

  private async attachUrl(
    input: BrowserPreviewAttachInput,
    token: number,
  ): Promise<BrowserPreviewState> {
    const url = input.url;
    const navigationScope = typeof url === "string" ? previewNavigationScope(url) : null;
    if (!url || !navigationScope)
      throw new Error("Browser previews require a loopback or authenticated gateway-preview URL");
    const bounds = validateBounds(input.bounds, this.hostZoomFactor());
    let preview = this.previews.get(input.tabId);
    if (preview?.service) {
      // A tab switching from a service to a manual URL needs the shared legacy session.
      this.removePreview(input.tabId);
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
      if (!this.isCurrentAttach(input.tabId, token)) return this.supersededAttach(input.tabId);
    }

    preview.view.setBounds(bounds);
    this.applyVisibility(
      input.tabId,
      preview,
      input.visible && bounds.width > 0 && bounds.height > 0,
    );
    return this.snapshot(input.tabId, preview);
  }

  private async attachService(
    input: BrowserPreviewAttachInput,
    target: BrowserPreviewServiceTarget,
    token: number,
  ): Promise<BrowserPreviewState> {
    const transport = this.options.transport;
    if (!transport) {
      throw previewFailure("unsupported", { message: "Service previews are not available." });
    }
    const bounds = validateBounds(input.bounds, this.hostZoomFactor());
    const holderId = `${input.tabId}#${token}`;
    const descriptor = await transport.acquire(target, holderId);
    if (!this.isCurrentAttach(input.tabId, token)) {
      transport.release(descriptor.serviceKey, holderId);
      return this.supersededAttach(input.tabId);
    }
    let preview = this.previews.get(input.tabId);
    // A session cannot change after a view exists: another service (or a
    // legacy tab) needs a fresh view on this service's partition.
    // Partitions derive from the service key, so an equal partition is the same service.
    if (preview && preview.service?.partition !== descriptor.partition) {
      this.removePreview(input.tabId);
      preview = undefined;
    }
    const scope = `service:${descriptor.serviceKey}`;
    if (!preview) {
      preview = this.createPreview(input.tabId, descriptor.url, scope, {
        session: transport.sessionFor(descriptor.partition),
        service: { key: descriptor.serviceKey, partition: descriptor.partition, holderId },
      });
    } else {
      // The view already holds this service; this attach's hold is a duplicate.
      transport.release(descriptor.serviceKey, holderId);
      const current = transport.describe(preview.requestedUrl);
      if (current?.serviceKey !== descriptor.serviceKey || current.path !== target.path) {
        this.clipboardUserActivations.delete(preview.view.webContents);
        preview.requestedUrl = descriptor.url;
        preview.navigationScope = scope;
        preview.error = null;
        await this.load(input.tabId, preview, descriptor.url);
        if (!this.isCurrentAttach(input.tabId, token)) return this.supersededAttach(input.tabId);
      }
    }
    preview.view.setBounds(bounds);
    this.applyVisibility(
      input.tabId,
      preview,
      input.visible && bounds.width > 0 && bounds.height > 0,
    );
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

  openServiceExternally(target: BrowserPreviewServiceTarget): Promise<void> {
    if (!this.options.openServiceExternally) {
      return Promise.reject(
        previewFailure("unsupported", { message: "Private preview publication is unavailable." }),
      );
    }
    return this.options.openServiceExternally(target);
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
    this.applyVisibility(tabId, preview, visible && bounds.width > 0 && bounds.height > 0);
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
    preview.loading = true;
    this.advanceDocument(tabId, preview);
    preview.view.webContents.reload();
    return this.snapshot(tabId, preview);
  }

  openDevTools(tabId: string): BrowserPreviewState {
    const preview = this.get(tabId);
    preview.view.webContents.openDevTools({ mode: "detach" });
    return this.snapshot(tabId, preview);
  }

  startCapture(input: BrowserPreviewStartCaptureInput): Promise<BrowserPreviewSelectionStatus> {
    return this.captures.start(input);
  }

  getCaptureStatus(tabId: string): Promise<BrowserPreviewSelectionStatus> {
    return this.captures.status(tabId);
  }

  cancelCapture(tabId: string): Promise<void> {
    return this.captures.cancel(tabId);
  }

  listPendingCaptures(): Promise<BrowserPreviewPendingCaptureDescriptor[]> {
    return this.captures.listPending();
  }

  readPendingCapture(captureId: string): Promise<BrowserPreviewPendingCapture | null> {
    return this.captures.readPending(captureId);
  }

  replacePendingCaptureImage(
    captureId: string,
    input: BrowserPreviewReplaceImageInput,
  ): Promise<BrowserPreviewPendingCaptureDescriptor> {
    return this.captures.replacePendingImage(captureId, input);
  }

  acknowledgePendingCapture(ack: BrowserPreviewCaptureAck): Promise<void> {
    return this.captures.acknowledgePending(ack);
  }

  recordPendingCaptureReceipt(
    ack: BrowserPreviewCaptureAck,
  ): Promise<BrowserPreviewPendingCaptureDescriptor | null> {
    return this.captures.recordPendingReceipt(ack);
  }

  discardPendingCapture(captureId: string): Promise<void> {
    return this.captures.discardPending(captureId);
  }

  listExpiredCaptureNotices(): Promise<BrowserPreviewExpiredCaptureNotice[]> {
    return this.captures.listExpiredNotices();
  }

  dismissExpiredCaptureNotices(captureIds?: string[]): Promise<void> {
    return this.captures.dismissExpiredNotices(captureIds);
  }

  getCaptureCapabilities(): BrowserPreviewCaptureCapabilities {
    return this.captures.capabilities();
  }

  showPins(input: BrowserPreviewPinsInput): Promise<BrowserPreviewAnchorResult[]> {
    return this.pins.showPins(input);
  }

  clearPins(tabId: string): Promise<void> {
    return this.pins.clearPins(tabId);
  }

  getPinResults(tabId: string): Promise<BrowserPreviewPinSnapshot | null> {
    return this.pins.getPinResults(tabId);
  }

  showOnPage(input: BrowserPreviewShowOnPageInput): Promise<BrowserPreviewShowOnPageResult> {
    return this.pins.showOnPage(input);
  }

  captureResponsiveSet(
    input: BrowserPreviewResponsiveSetInput,
  ): Promise<BrowserPreviewResponsiveSetResult> {
    const store = this.options.captureStore;
    if (!store) return Promise.reject(new Error("Trusted capture is unavailable in this build"));
    const tabId = captureTabId((input as { tabId?: unknown } | null)?.tabId);
    return captureResponsiveSet(
      {
        preview: () => this.captureHandle(tabId),
        store,
        ...(this.options.nativeImage ? { nativeImage: this.options.nativeImage } : {}),
        now: this.options.now ?? Date.now,
        busy: this.captures.isBusy(tabId),
        ...(this.options.stability ? { settle: this.options.stability } : {}),
      },
      input,
    );
  }

  destroy(tabId: string): void {
    assertTabId(tabId);
    // Cancel any attach still awaiting transport or a load for this tab.
    this.attachTokens.delete(tabId);
    this.pendingAttaches.delete(tabId);
    this.removePreview(tabId);
  }

  /** Close the manager for good: in-flight attaches settle without creating views. */
  destroyAll(): void {
    this.disposed = true;
    const tabIds = new Set([...this.previews.keys(), ...this.attachTokens.keys()]);
    for (const tabId of tabIds) this.destroy(tabId);
    this.pins.dispose();
  }

  private removePreview(tabId: string): void {
    const preview = this.previews.get(tabId);
    if (!preview) return;
    this.captures.onRemoved(tabId);
    this.pins.onRemoved(tabId);
    this.previews.delete(tabId);
    this.clipboardUserActivations.delete(preview.view.webContents);
    if (preview.service)
      this.options.transport?.release(preview.service.key, preview.service.holderId);
    const window = this.options.getWindow();
    if (window && !window.isDestroyed()) {
      window.contentView.removeChildView(preview.view);
    }
    if (!preview.view.webContents.isDestroyed()) {
      preview.view.webContents.close({ waitForBeforeUnload: false });
    }
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
      documentGeneration: 0,
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
            // A service link's runtime ingress URL means nothing outside this
            // app; it opens through the private preview origin instead.
            enabled: preview.service
              ? serviceTarget
                ? Boolean(this.options.openServiceExternally)
                : externalBrowserUrl && !serviceLink && !isLoopbackUrl(params.linkURL)
              : externalBrowserUrl,
            click: () => {
              if (serviceTarget && serviceLink) {
                void this.options
                  .openServiceExternally?.({ ...serviceTarget, path: serviceLink.path })
                  .catch((error: unknown) => {
                    preview.error = error instanceof Error ? error.message : String(error);
                    this.emit(tabId, preview);
                  });
              } else if (externalBrowserUrl) {
                this.options.openExternal(params.linkURL);
              }
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
    // Electron passes either a details event or positional (url, isInPlace, isMainFrame).
    contents.on("did-start-navigation", (...args: unknown[]) => {
      const details = args[0] as { isMainFrame?: unknown } | undefined;
      const isMainFrame =
        typeof args[1] === "string" ? args[3] === true : details?.isMainFrame === true;
      if (isMainFrame) this.advanceDocument(tabId, preview);
    });
    contents.on("did-start-loading", () => {
      preview.loading = true;
      preview.error = null;
      this.emit(tabId, preview);
    });
    contents.on("did-stop-loading", () => {
      preview.loading = false;
      if (this.previews.get(tabId) === preview) this.pins.onDocumentReady(tabId);
      this.emit(tabId, preview);
    });
    contents.on("did-navigate", (_event, url) => {
      this.clipboardUserActivations.delete(contents);
      this.advanceDocument(tabId, preview);
      if (this.withinScope(url, preview.navigationScope)) preview.requestedUrl = url;
      this.emit(tabId, preview);
    });
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) {
        this.advanceDocument(tabId, preview);
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
    // Loading first: pins cleared by this document change are re-requested
    // once the new document is ready, not against the one being replaced.
    preview.loading = true;
    this.advanceDocument(tabId, preview);
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
    preview.loading = true;
    this.advanceDocument(tabId, preview);
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
