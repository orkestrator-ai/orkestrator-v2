import { randomUUID } from "node:crypto";
import type {
  BrowserWindow,
  OnBeforeRedirectListenerDetails,
  OnBeforeRequestListenerDetails,
  Rectangle,
  Session,
  WebContents,
  WebContentsView,
  WebContentsViewConstructorOptions,
  WebFrameMain,
  WebPreferences,
} from "electron";
import {
  ArtifactFrameRateLimiter,
  normalizeArtifactLink,
  parseArtifactFrameMessage,
  type ArtifactFrameIdentity,
  type ArtifactThemeMessage,
} from "@orkestrator/protocol/artifact-frame-channel";
import type {
  ArtifactHostBounds,
  ArtifactHostEvent,
  ArtifactHostOpenInput,
} from "@orkestrator/protocol/artifact-host-ipc";
import {
  ARTIFACT_SHELL_DRAIN_EXPRESSION,
  ARTIFACT_SHELL_QUEUE_LIMIT,
  ARTIFACT_SHELL_SCHEME,
  ARTIFACT_SHELL_URL,
  artifactShellDocument,
  artifactShellHeaders,
  artifactShellThemeExpression,
} from "./artifact-host-shell.js";

/** Nonpersistent: no `persist:` prefix, so nothing reaches disk and nothing is shared. */
export const ARTIFACT_HOST_PARTITION_PREFIX = "artifact-host-";

/**
 * Exact preferences for the live host view. No preload of any kind: the
 * artifact and the shell get no bridge, no `ipcRenderer`, no channel names.
 */
export function artifactHostWebPreferences(session: Session, zoomFactor: number): WebPreferences {
  return {
    session,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: false,
    safeDialogs: true,
    disableDialogs: true,
    navigateOnDragDrop: false,
    spellcheck: false,
    webviewTag: false,
    plugins: false,
    enableWebSQL: false,
    experimentalFeatures: false,
    autoplayPolicy: "document-user-activation-required",
    zoomFactor,
  };
}

/**
 * Session proxy for a live host. Only the exact content host bypasses it;
 * `<-loopback>` removes Chromium's implicit loopback bypass. Everything else
 * that is proxied (notably WebRTC TCP/TURN, which webRequest never sees,
 * under `disable_non_proxied_udp`) is sent to the loopback discard port and
 * fails. Exported for tests.
 */
export const ARTIFACT_HOST_BLACKHOLE_PROXY = "http://127.0.0.1:9";

export function artifactHostProxyConfig(contentHref: string): {
  mode: "fixed_servers";
  proxyRules: string;
  proxyBypassRules: string;
} {
  const host = new URL(contentHref).host;
  return {
    mode: "fixed_servers",
    proxyRules: ARTIFACT_HOST_BLACKHOLE_PROXY,
    proxyBypassRules: `<-loopback>;${host}`,
  };
}

type WebContentsViewConstructor = new (
  options?: WebContentsViewConstructorOptions,
) => WebContentsView;

/** Content-free reason codes; never URLs, capability tokens, or page data. */
export type ArtifactHostBlockReason =
  | "shell-reload"
  | "shell-wrong-request"
  | "content-reload"
  | "content-wrong-request"
  | "websocket"
  | "navigation"
  | "subresource"
  | "foreign-request"
  | "invalid-url"
  | "redirect"
  | "main-frame-navigation"
  | "frame-navigation"
  | "nested-frame-navigation"
  | "content-unavailable"
  | "load-failed"
  | "shell-load-failed"
  | "shell-unreachable"
  | "client-certificate"
  | "network-policy-failed";

export type ArtifactHostRejectReason =
  | "not-object"
  | "wrong-channel"
  | "wrong-version"
  | "unknown-type"
  | "bad-shape"
  | "identity-mismatch"
  | "too-large"
  | "rate-limited"
  | "nonce-mismatch"
  | "duplicate-ready"
  | "bad-batch"
  | "shell-dropped"
  | "theme-identity-mismatch";

export interface ArtifactHostDiagnostics {
  blocked: Partial<Record<ArtifactHostBlockReason, number>>;
  rejected: Partial<Record<ArtifactHostRejectReason, number>>;
}

export type ArtifactHostCloseReason = Extract<ArtifactHostEvent, { type: "closed" }>["reason"];

export interface ArtifactHostSessionOptions {
  input: ArtifactHostOpenInput;
  window: BrowserWindow;
  WebContentsViewCtor: WebContentsViewConstructor;
  /** `session.fromPartition`; called with a fresh nonpersistent partition name. */
  fromPartition: (partition: string) => Session;
  /** Window DIPs per renderer CSS pixel (the main window's page zoom). */
  hostZoomFactor: () => number;
  emit: (event: ArtifactHostEvent) => void;
  /** Called exactly once when the host has been torn down for any reason. */
  onTerminated: (host: ArtifactHostSession, diagnostics: ArtifactHostDiagnostics) => void;
  now?: () => number;
  randomId?: () => string;
  /** Liveness probe cadence for the out-of-process artifact frame. */
  heartbeatIntervalMs?: number;
  /** A probe unanswered this long reports `unresponsive`. */
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
}

export const ARTIFACT_HOST_READY_TIMEOUT_MS = 15_000;
export const ARTIFACT_HOST_HEARTBEAT_INTERVAL_MS = 1_000;
export const ARTIFACT_HOST_HEARTBEAT_TIMEOUT_MS = 3_000;

function increment<K extends string>(counts: Partial<Record<K, number>>, key: K): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function normalizedHref(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function safeFrame(read: () => WebFrameMain | null | undefined): WebFrameMain | null {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

/** True when `frame` is a direct child of `main` (or unknown, which Electron allows for navigations). */
function isDirectChildFrame(frame: WebFrameMain | null, main: WebFrameMain | null): boolean {
  if (!frame) return true;
  const parent = safeFrame(() => frame.parent);
  if (!parent || !main) return false;
  return parent.frameTreeNodeId === main.frameTreeNodeId;
}

/** Strip control and bidirectional-format characters from a label shown in trusted chrome. */
function sanitizeLabel(label: string): string {
  return label
    .replace(
      new RegExp(
        "[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
        "g",
      ),
      "",
    )
    .trim();
}

/**
 * One live interactive-artifact host: a sandboxed `WebContentsView` on a
 * fresh nonpersistent session that this object exclusively owns.
 *
 * Fail-closed: any load, navigation, redirect, or request other than the one
 * shell document and the one exact content document disposes the channel,
 * emits `navigation-blocked`, and destroys the view. The UI then shows the
 * saved preview; the host never reloads itself.
 */
export class ArtifactHostSession {
  readonly hostId: string;
  readonly identity: ArtifactFrameIdentity;
  readonly contentHref: string;
  private readonly readinessNonce: string;
  private readonly limiter: ArtifactFrameRateLimiter;
  private readonly diagnostics: ArtifactHostDiagnostics = { blocked: {}, rejected: {} };
  private state: "idle" | "open" | "closed" = "idle";
  private electronSession: Session | null = null;
  private view: WebContentsView | null = null;
  private cssBounds: ArtifactHostBounds;
  private requestedVisible: boolean;
  private appliedZoomFactor = 1;
  private ready = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTheme: ArtifactThemeMessage | null = null;
  private unresponsive = false;
  private pumping = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatSentAt: number | null = null;
  private frameHangReported = false;
  // One-shot authorizations: each document is admitted exactly once.
  private shellRequestAdmitted = false;
  private contentRequestAdmitted = false;
  private mainNavigationStarted = false;
  private contentNavigationStarted = false;
  private contentWillNavigateSeen = false;

  constructor(private readonly options: ArtifactHostSessionOptions) {
    const { input } = options;
    const contentHref = normalizedHref(input.contentUrl);
    if (!contentHref) throw new Error("Expected an artifact content URL");
    this.hostId = input.hostId;
    this.contentHref = contentHref;
    this.identity = {
      artifactId: input.artifactId,
      revision: input.revision,
      generation: input.generation,
    };
    this.readinessNonce = input.readinessNonce;
    this.cssBounds = { ...input.bounds };
    this.requestedVisible = input.visible;
    this.limiter = new ArtifactFrameRateLimiter(options.now);
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Same document and identity: reopening it must not reload the live view. */
  matches(input: ArtifactHostOpenInput): boolean {
    return (
      input.hostId === this.hostId &&
      normalizedHref(input.contentUrl) === this.contentHref &&
      input.artifactId === this.identity.artifactId &&
      input.revision === this.identity.revision &&
      input.generation === this.identity.generation &&
      input.readinessNonce === this.readinessNonce
    );
  }

  snapshotDiagnostics(): ArtifactHostDiagnostics {
    return {
      blocked: { ...this.diagnostics.blocked },
      rejected: { ...this.diagnostics.rejected },
    };
  }

  webContents(): WebContents | null {
    return this.view?.webContents ?? null;
  }

  focusIfVisible(): boolean {
    const contents = this.webContents();
    if (!this.isOpen || !contents || contents.isDestroyed() || !this.view?.getVisible())
      return false;
    contents.focus();
    return true;
  }

  /**
   * Create the session, install every policy hook, then the view, then load
   * the shell. Throws when this Electron cannot provide the required APIs;
   * nothing is left behind in that case.
   */
  start(): void {
    if (this.state !== "idle") throw new Error("Artifact host already started");
    const { window, WebContentsViewCtor } = this.options;
    if (window.isDestroyed()) throw new Error("The window is not available");
    if (typeof WebContentsViewCtor !== "function") {
      throw new Error("This desktop build cannot host interactive artifacts");
    }
    const randomId = this.options.randomId ?? randomUUID;
    const partition = `${ARTIFACT_HOST_PARTITION_PREFIX}${randomId()}`;
    const electronSession = this.options.fromPartition(partition);
    if (
      !electronSession ||
      typeof electronSession.webRequest?.onBeforeRequest !== "function" ||
      typeof electronSession.protocol?.handle !== "function" ||
      typeof electronSession.setPermissionRequestHandler !== "function" ||
      typeof electronSession.setPermissionCheckHandler !== "function" ||
      typeof electronSession.setProxy !== "function"
    ) {
      throw new Error("This desktop build cannot host interactive artifacts");
    }
    this.electronSession = electronSession;
    this.state = "open";
    try {
      this.readyTimer = setTimeout(() => {
        if (this.state !== "open" || this.ready) return;
        this.unresponsive = true;
        this.options.emit({ hostId: this.hostId, type: "unresponsive" });
        this.close("crashed", { silent: true });
      }, this.options.readyTimeoutMs ?? ARTIFACT_HOST_READY_TIMEOUT_MS);
      this.readyTimer.unref?.();
      this.hardenSession(electronSession);
      this.installRequestPolicy(electronSession);
      this.installShellProtocol(electronSession);
      this.appliedZoomFactor = this.options.hostZoomFactor();
      const view = new WebContentsViewCtor({
        webPreferences: artifactHostWebPreferences(electronSession, this.appliedZoomFactor),
      });
      this.view = view;
      view.setBackgroundColor("#00000000");
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      view.setVisible(false);
      this.installContentsGuards(view.webContents);
      // WebRTC opens sockets outside webRequest. No non-proxied UDP, and
      // every proxied connection goes to a black hole (below).
      if (typeof view.webContents.setWebRTCIPHandlingPolicy !== "function") {
        throw new Error("This desktop build cannot host interactive artifacts");
      }
      view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      window.contentView.addChildView(view);
      this.applyPresentation();
      void electronSession.setProxy(artifactHostProxyConfig(this.contentHref)).then(
        () => {
          if (this.state !== "open" || view.webContents.isDestroyed()) return;
          void view.webContents.loadURL(ARTIFACT_SHELL_URL).catch(() => {
            // A blocked or failed shell document never becomes a live host.
            this.block("shell-load-failed");
          });
        },
        () => this.block("network-policy-failed"),
      );
    } catch (error) {
      this.teardown();
      this.state = "closed";
      throw error;
    }
  }

  setBounds(bounds: ArtifactHostBounds): void {
    if (this.state !== "open") return;
    this.cssBounds = { ...bounds };
    this.applyPresentation();
  }

  setVisible(visible: boolean): void {
    if (this.state !== "open") return;
    this.requestedVisible = visible;
    this.applyPresentation();
  }

  /** Theme reaches the frame only after the readiness handshake. */
  postTheme(theme: ArtifactThemeMessage): void {
    if (this.state !== "open") return;
    if (
      theme.artifactId !== this.identity.artifactId ||
      theme.revision !== this.identity.revision ||
      theme.generation !== this.identity.generation
    ) {
      increment(this.diagnostics.rejected, "theme-identity-mismatch");
      return;
    }
    if (!this.ready) {
      this.pendingTheme = theme;
      return;
    }
    this.deliverTheme(theme);
  }

  close(reason: ArtifactHostCloseReason, { silent = false }: { silent?: boolean } = {}): void {
    if (this.state !== "open") return;
    this.state = "closed";
    this.teardown();
    if (!silent) this.options.emit({ hostId: this.hostId, type: "closed", reason });
    this.options.onTerminated(this, this.snapshotDiagnostics());
  }

  // --- presentation -------------------------------------------------------

  private applyPresentation(): void {
    const view = this.view;
    if (!view || this.state !== "open") return;
    const zoom = this.options.hostZoomFactor();
    const rect: Rectangle = {
      x: Math.max(0, Math.round(this.cssBounds.x * zoom)),
      y: Math.max(0, Math.round(this.cssBounds.y * zoom)),
      width: Math.max(0, Math.round(this.cssBounds.width * zoom)),
      height: Math.max(0, Math.round(this.cssBounds.height * zoom)),
    };
    const visible = this.requestedVisible && rect.width > 0 && rect.height > 0;
    view.setBounds(rect);
    view.setVisible(visible);
    if (zoom !== this.appliedZoomFactor) {
      this.appliedZoomFactor = zoom;
      const contents = view.webContents;
      if (!contents.isDestroyed()) contents.setZoomFactor(zoom);
    }
  }

  // --- session policy -----------------------------------------------------

  private hardenSession(electronSession: Session): void {
    electronSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    electronSession.setPermissionCheckHandler(() => false);
    // Platform-specific hooks: absent or unsupported ones are already denied
    // by the permission handlers above.
    const optional = (apply: () => void) => {
      try {
        apply();
      } catch {
        // Not supported on this platform or Electron version.
      }
    };
    optional(() => electronSession.setDevicePermissionHandler?.(() => false));
    optional(() =>
      electronSession.setBluetoothPairingHandler?.((_details, callback) =>
        callback({ confirmed: false }),
      ),
    );
    optional(() =>
      electronSession.setDisplayMediaRequestHandler?.((_request, callback) => callback(null)),
    );
    optional(() => electronSession.setSpellCheckerEnabled?.(false));
    electronSession.on("will-download", (event, item) => {
      event.preventDefault();
      try {
        item.cancel();
      } catch {
        // Already cancelled by preventDefault.
      }
    });
    electronSession.on("select-hid-device", (event, _details, callback) => {
      event.preventDefault();
      callback(null);
    });
    electronSession.on("select-serial-port", (event, _ports, _contents, callback) => {
      event.preventDefault();
      callback("");
    });
    electronSession.on("select-usb-device", (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
  }

  /**
   * The single policy owner for this private session's request hooks.
   * Electron keeps only the last listener per webRequest event, and nothing
   * else ever receives this randomly named session, so these are the only ones.
   */
  private installRequestPolicy(electronSession: Session): void {
    electronSession.webRequest.onBeforeRequest((details, callback) => {
      callback(this.decideRequest(details) ? {} : { cancel: true });
    });
    electronSession.webRequest.onBeforeRedirect((details) => this.observeRedirect(details));
  }

  /** Exposed for tests: true admits the request, false cancels it. */
  decideRequest(details: OnBeforeRequestListenerDetails): boolean {
    if (this.state !== "open") return false;
    const contents = this.view?.webContents ?? null;
    const attributed =
      details.webContentsId === undefined ||
      (contents !== null && details.webContentsId === contents.id);
    if (!attributed) {
      // Nothing else uses this session; never fatal for an unknown requester.
      increment(this.diagnostics.blocked, "foreign-request");
      return false;
    }
    const href = normalizedHref(details.url);
    if (!href) return this.denyRequest("invalid-url");
    if (href === ARTIFACT_SHELL_URL) {
      if (details.resourceType !== "mainFrame" || details.method !== "GET") {
        return this.denyRequest("shell-wrong-request");
      }
      if (this.shellRequestAdmitted) return this.denyRequest("shell-reload");
      this.shellRequestAdmitted = true;
      return true;
    }
    if (href === this.contentHref) {
      // Electron attributes a subframe navigation request to the navigating
      // frame or its parent (or to none); either must sit directly under the
      // shell. Anything deeper is an artifact-created nested frame.
      const frame = safeFrame(() => details.frame);
      const main = safeFrame(() => contents?.mainFrame);
      const frameAllowed =
        frame === null ||
        main === null ||
        frame.frameTreeNodeId === main.frameTreeNodeId ||
        isDirectChildFrame(frame, main);
      if (
        details.resourceType !== "subFrame" ||
        details.method !== "GET" ||
        !this.shellRequestAdmitted ||
        !frameAllowed
      ) {
        return this.denyRequest("content-wrong-request");
      }
      if (this.contentRequestAdmitted) return this.denyRequest("content-reload");
      this.contentRequestAdmitted = true;
      return true;
    }
    if (details.resourceType === "webSocket") return this.denyRequest("websocket");
    if (
      details.resourceType === "mainFrame" ||
      details.resourceType === "subFrame" ||
      details.resourceType === "object"
    ) {
      return this.denyRequest("navigation");
    }
    // The content policy should have stopped this before the network layer;
    // reaching here means it did not, so the host is no longer trustworthy.
    return this.denyRequest("subresource");
  }

  private denyRequest(reason: ArtifactHostBlockReason): false {
    this.block(reason);
    return false;
  }

  private observeRedirect(details: OnBeforeRedirectListenerDetails): void {
    if (this.state !== "open") return;
    const contents = this.view?.webContents ?? null;
    if (details.webContentsId !== undefined && contents && details.webContentsId !== contents.id) {
      return;
    }
    this.block("redirect");
  }

  private installShellProtocol(electronSession: Session): void {
    const contentUrl = this.contentHref;
    let served = false;
    electronSession.protocol.handle(ARTIFACT_SHELL_SCHEME, (request) => {
      if (
        this.state !== "open" ||
        served ||
        request.method !== "GET" ||
        normalizedHref(request.url) !== ARTIFACT_SHELL_URL
      ) {
        return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      served = true;
      return new Response(artifactShellDocument(contentUrl), {
        status: 200,
        headers: artifactShellHeaders(contentUrl),
      });
    });
  }

  // --- navigation guards --------------------------------------------------

  private installContentsGuards(contents: WebContents): void {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => {
      event.preventDefault();
      this.block("main-frame-navigation");
    });
    contents.on("will-frame-navigate", (event) => {
      const details = event as unknown as {
        url: string;
        isMainFrame: boolean;
        frame: WebFrameMain | null;
        preventDefault(): void;
      };
      if (details.isMainFrame) {
        details.preventDefault();
        this.block("main-frame-navigation");
        return;
      }
      const frame = safeFrame(() => details.frame);
      const main = safeFrame(() => contents.mainFrame);
      if (!isDirectChildFrame(frame, main)) {
        details.preventDefault();
        this.block("nested-frame-navigation");
        return;
      }
      if (normalizedHref(details.url) !== this.contentHref || this.contentWillNavigateSeen) {
        details.preventDefault();
        this.block("frame-navigation");
        return;
      }
      this.contentWillNavigateSeen = true;
    });
    contents.on("will-redirect", (event) => {
      event.preventDefault();
      this.block("redirect");
    });
    contents.on("did-redirect-navigation", () => this.block("redirect"));
    contents.on("did-start-navigation", (event) => {
      const details = event as unknown as {
        url: string;
        isMainFrame: boolean;
        isSameDocument: boolean;
        frame: WebFrameMain | null;
      };
      if (details.isSameDocument) return;
      if (details.isMainFrame) {
        if (this.mainNavigationStarted || normalizedHref(details.url) !== ARTIFACT_SHELL_URL) {
          this.block("main-frame-navigation");
          return;
        }
        this.mainNavigationStarted = true;
        return;
      }
      const frame = safeFrame(() => details.frame);
      if (
        !isDirectChildFrame(
          frame,
          safeFrame(() => contents.mainFrame),
        )
      ) {
        this.block("nested-frame-navigation");
        return;
      }
      if (this.contentNavigationStarted || normalizedHref(details.url) !== this.contentHref) {
        this.block("frame-navigation");
        return;
      }
      this.contentNavigationStarted = true;
    });
    contents.on("did-frame-navigate", (_event, url, httpResponseCode, _status, isMainFrame) => {
      if (isMainFrame) {
        if (normalizedHref(url) !== ARTIFACT_SHELL_URL) this.block("main-frame-navigation");
        return;
      }
      if (normalizedHref(url) !== this.contentHref) {
        this.block("frame-navigation");
        return;
      }
      if (httpResponseCode !== 200) this.block("content-unavailable");
    });
    contents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (errorCode === -3) return;
      this.block(isMainFrame ? "shell-load-failed" : "load-failed");
    });
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
      this.block("navigation");
    });
    contents.on("will-prevent-unload", (event) => event.preventDefault());
    // Never present a client certificate (Electron's default picks the first
    // one in the store). The dedicated content origin never asks for one.
    contents.on("select-client-certificate", (event) => {
      event.preventDefault();
      this.block("client-certificate");
    });
    contents.on("login", (event, _details, _authInfo, callback) => {
      event.preventDefault();
      callback();
    });
    contents.on("dom-ready", () => {
      if (this.state !== "open") return;
      if (contents.getZoomFactor?.() !== this.appliedZoomFactor) {
        contents.setZoomFactor(this.appliedZoomFactor);
      }
      void this.pump();
    });
    contents.on("render-process-gone", (_event, details) => {
      if (this.state !== "open") return;
      this.options.emit({ hostId: this.hostId, type: "crashed", reason: details.reason });
      this.close("crashed");
    });
    contents.on("unresponsive", () => {
      if (this.state !== "open") return;
      this.unresponsive = true;
      this.options.emit({ hostId: this.hostId, type: "unresponsive" });
    });
    contents.on("responsive", () => {
      this.unresponsive = false;
    });
  }

  // --- presentation channel ----------------------------------------------

  /** Long-poll the shell for validated frame messages until the host closes. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.state === "open") {
        const contents = this.view?.webContents;
        if (!contents || contents.isDestroyed()) return;
        const frame = safeFrame(() => contents.mainFrame);
        if (!frame || normalizedHref(frame.url) !== ARTIFACT_SHELL_URL) {
          this.block("shell-unreachable");
          return;
        }
        let batch: unknown;
        try {
          batch = await frame.executeJavaScript(ARTIFACT_SHELL_DRAIN_EXPRESSION, false);
        } catch {
          // Frame disposed or the shell is gone; a live host cannot continue.
          if (this.state === "open") this.block("shell-unreachable");
          return;
        }
        if (this.state !== "open") return;
        this.acceptBatch(batch);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Exposed for tests: process one drained batch from the shell. */
  acceptBatch(batch: unknown): void {
    if (this.state !== "open") return;
    if (typeof batch !== "object" || batch === null || Array.isArray(batch)) {
      increment(this.diagnostics.rejected, "bad-batch");
      return;
    }
    const { messages, dropped } = batch as { messages?: unknown; dropped?: unknown };
    if (typeof dropped === "number" && Number.isSafeInteger(dropped) && dropped > 0) {
      this.diagnostics.rejected["shell-dropped"] =
        (this.diagnostics.rejected["shell-dropped"] ?? 0) + dropped;
    }
    if (!Array.isArray(messages)) {
      increment(this.diagnostics.rejected, "bad-batch");
      return;
    }
    for (const message of messages.slice(0, ARTIFACT_SHELL_QUEUE_LIMIT)) {
      if (this.state !== "open") return;
      this.acceptFrameMessage(message);
    }
  }

  private acceptFrameMessage(data: unknown): void {
    const parsed = parseArtifactFrameMessage(data, this.ready ? this.identity : null);
    if (!parsed.ok) {
      increment(this.diagnostics.rejected, parsed.reason);
      return;
    }
    const message = parsed.message;
    if (!this.limiter.admit(message.type)) {
      increment(this.diagnostics.rejected, "rate-limited");
      return;
    }
    switch (message.type) {
      case "ready": {
        if (message.nonce !== this.readinessNonce) {
          increment(this.diagnostics.rejected, "nonce-mismatch");
          return;
        }
        if (this.ready) {
          increment(this.diagnostics.rejected, "duplicate-ready");
          return;
        }
        this.ready = true;
        if (this.readyTimer !== null) clearTimeout(this.readyTimer);
        this.readyTimer = null;
        this.startHeartbeat();
        this.options.emit({ hostId: this.hostId, type: "ready" });
        const pending = this.pendingTheme;
        this.pendingTheme = null;
        if (pending) this.deliverTheme(pending);
        return;
      }
      case "size":
        this.options.emit({
          hostId: this.hostId,
          type: "size",
          height: message.height,
          ...(message.width !== undefined ? { width: message.width } : {}),
        });
        return;
      case "link-request": {
        // Never opened here: the renderer shows a host-owned control the user must click.
        const link = normalizeArtifactLink(message.url);
        if (!link) {
          increment(this.diagnostics.rejected, "bad-shape");
          return;
        }
        this.options.emit({
          hostId: this.hostId,
          type: "link-request",
          href: link.href,
          hostname: link.hostname,
          label: sanitizeLabel(message.label),
        });
        return;
      }
    }
  }

  private deliverTheme(theme: ArtifactThemeMessage): void {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const frame = safeFrame(() => contents.mainFrame);
    if (!frame) return;
    void frame.executeJavaScript(artifactShellThemeExpression(theme), false).catch(() => {
      // The pump detects an unreachable shell; a lost theme is not fatal on its own.
    });
  }

  /**
   * Electron's `unresponsive` covers only the shell's renderer. The opaque
   * artifact frame usually runs in its own process, so a loop after
   * readiness is detected by a trivial probe evaluated in that frame. The
   * probe carries no data either way; its result is ignored.
   */
  private startHeartbeat(): void {
    if (this.heartbeat !== null) return;
    const interval = this.options.heartbeatIntervalMs ?? ARTIFACT_HOST_HEARTBEAT_INTERVAL_MS;
    const timeout = this.options.heartbeatTimeoutMs ?? ARTIFACT_HOST_HEARTBEAT_TIMEOUT_MS;
    const now = () => Date.now();
    this.heartbeat = setInterval(() => {
      if (this.state !== "open") return;
      if (this.heartbeatSentAt !== null) {
        if (!this.frameHangReported && now() - this.heartbeatSentAt >= timeout) {
          this.frameHangReported = true;
          this.unresponsive = true;
          this.options.emit({ hostId: this.hostId, type: "unresponsive" });
        }
        return;
      }
      const frame = this.contentFrame();
      if (!frame) return;
      const sentAt = now();
      this.heartbeatSentAt = sentAt;
      void frame.executeJavaScript("0", false).then(
        () => {
          if (this.heartbeatSentAt !== sentAt) return;
          this.heartbeatSentAt = null;
          if (this.frameHangReported) {
            this.frameHangReported = false;
            this.unresponsive = false;
          }
        },
        () => {
          // A detached frame is handled by the navigation and pump guards.
          if (this.heartbeatSentAt === sentAt) this.heartbeatSentAt = null;
        },
      );
    }, interval);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private contentFrame(): WebFrameMain | null {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return null;
    const main = safeFrame(() => contents.mainFrame);
    let children: WebFrameMain[] = [];
    try {
      children = main?.frames ?? [];
    } catch {
      return null;
    }
    return children.find((frame) => normalizedHref(frame.url) === this.contentHref) ?? null;
  }

  // --- teardown -----------------------------------------------------------

  /** Fail closed: dispose the channel and the view, then report the reason. */
  private block(reason: ArtifactHostBlockReason): void {
    increment(this.diagnostics.blocked, reason);
    if (this.state !== "open") return;
    this.state = "closed";
    this.teardown();
    this.options.emit({ hostId: this.hostId, type: "navigation-blocked", reason });
    this.options.onTerminated(this, this.snapshotDiagnostics());
  }

  private teardown(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.ready = false;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.pendingTheme = null;
    const view = this.view;
    const electronSession = this.electronSession;
    if (view) {
      const window = this.options.window;
      try {
        if (!window.isDestroyed()) window.contentView.removeChildView(view);
      } catch {
        // The window is closing; its views go with it.
      }
      const contents = view.webContents;
      if (!contents.isDestroyed()) {
        if (this.unresponsive) {
          try {
            contents.forcefullyCrashRenderer();
          } catch {
            // Already gone.
          }
        }
        try {
          contents.close({ waitForBeforeUnload: false });
        } catch {
          // Already closing.
        }
      }
    }
    if (electronSession) {
      // Keep the private session fail-closed after disposal, then forget it.
      try {
        electronSession.webRequest.onBeforeRequest((_details, callback) =>
          callback({ cancel: true }),
        );
        electronSession.webRequest.onBeforeRedirect(null);
      } catch {
        // Best effort.
      }
      try {
        electronSession.protocol.unhandle(ARTIFACT_SHELL_SCHEME);
      } catch {
        // Not handled or already removed.
      }
      void Promise.resolve()
        .then(() =>
          Promise.allSettled([
            electronSession.clearStorageData(),
            electronSession.clearCache(),
            electronSession.clearAuthCache(),
          ]),
        )
        .catch(() => undefined);
    }
  }
}
