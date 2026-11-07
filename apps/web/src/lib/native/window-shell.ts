/**
 * The window-only half of the browser gateway API (docs/reports/unified-federation.md
 * §6.2 step 1): clipboard, `webClient`, `process`, `window`, server
 * connections, boot metrics and the cookie-session detection.
 *
 * A page has one shell and one command transport. The shell owns the hooks
 * the transport reports through (a refused credential, main stream opens for
 * boot metrics) and the page lifecycle the transport is told about, and wires
 * both into that transport when it creates it. Node transports for other
 * nodes (`createNodeTransport`) need none of this.
 */
import type { GatewayTokenSettings, WebClientStatus } from "@/types";
import { getGatewayBaseUrl } from "@/lib/gateway-url";
import { readClipboardImageDimensions } from "@/lib/clipboard-image";
import { clearProtectedRichContent } from "@/lib/chat/rich-content-reset";
import {
  GATEWAY_PREFIX,
  type NodeTransport,
  type NodeTransportLifecycle,
  type TransportMetricsHooks,
} from "@/lib/native/node-transport";

export const BROWSER_SESSION_ACTIVITY_REFRESH_INTERVAL_MS = 60_000;

/**
 * Whether this transport probes the gateway's cookie session. A node transport
 * never does: one with a grant sends a bearer, and a relayed one
 * (`/__orkestrator/nodes/<id>`) reaches a leaf whose cookie session it never
 * holds, so the command node does not relay `/session`.
 */
export function detectsBrowserSession(
  credentials: RequestCredentials,
  enabled: boolean | undefined,
  baseUrl: string | undefined,
): boolean {
  if (credentials !== "same-origin" || !enabled) return false;
  if (!baseUrl) return true;
  return !new URL(baseUrl, "http://gateway.invalid").pathname.startsWith(
    `${GATEWAY_PREFIX}/nodes/`,
  );
}

async function readBrowserClipboardImage(): Promise<{
  width: number;
  height: number;
  blob: Blob;
} | null> {
  const read = navigator.clipboard?.read?.bind(navigator.clipboard);
  if (!read) return null;

  for (const item of await read()) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (!imageType) continue;

    const blob = await item.getType(imageType);
    return { ...(await readClipboardImageDimensions(blob)), blob };
  }

  return null;
}

/**
 * The page lifecycle as a transport sees it, on this page's `document` and
 * `window`. Each subscription attaches its DOM listener when made and removes
 * it when stopped, so a transport's order of subscription is the listener
 * order, and a disposed transport leaves nothing behind.
 */
export function browserWindowLifecycle(): NodeTransportLifecycle {
  return {
    onVisibility(listener) {
      if (typeof document === "undefined") return () => undefined;
      const changed = () => listener(document.visibilityState === "visible");
      document.addEventListener("visibilitychange", changed);
      return () => document.removeEventListener("visibilitychange", changed);
    },
    onOnline(listener) {
      if (typeof window === "undefined") return () => undefined;
      const online = () => listener();
      window.addEventListener("online", online);
      return () => window.removeEventListener("online", online);
    },
    onPageHide(listener) {
      if (typeof window === "undefined") return () => undefined;
      const hide = () => listener(true);
      const show = () => listener(false);
      window.addEventListener("pagehide", hide);
      window.addEventListener("pageshow", show);
      return () => {
        window.removeEventListener("pagehide", hide);
        window.removeEventListener("pageshow", show);
      };
    },
  };
}

export interface WindowShellOptions {
  reportBootMetrics?: boolean;
  /**
   * Same-origin app install probes the gateway's cookie-session endpoint, so a
   * tab signed in through the login form renews on activity and goes back to
   * the login page when its session ends.
   */
  browserSessionActivity?: boolean;
  /**
   * Test/embedding override for the lapsed-credential recovery. Production
   * navigates to the gateway login page, which cannot be asserted in happy-dom.
   */
  onCredentialLapsed?: () => void;
  onTokenChanged?: (token: string) => void;
  connections?: NonNullable<Window["orkestrator"]>["connections"];
}

/** What the shell hands the command transport it creates. */
export interface WindowShellTransportHooks {
  onCredentialRejected: () => void;
  metrics: TransportMetricsHooks;
  lifecycle: NodeTransportLifecycle;
}

export interface WindowShellApi {
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
    readImage(): Promise<{ width: number; height: number; blob: Blob } | null>;
    writeImage(_dataUrl: string): Promise<void>;
  };
  connections?: NonNullable<Window["orkestrator"]>["connections"];
  webClient: {
    getStatus(): Promise<WebClientStatus>;
    setEnabled(): Promise<WebClientStatus>;
    resetServe(): Promise<WebClientStatus>;
    getTokenSettings(): Promise<GatewayTokenSettings>;
    setToken(token: string): Promise<GatewayTokenSettings>;
  };
  process: { exit(): Promise<void> };
  window: {
    startDragging(): Promise<void>;
    setZoomFactor(_factor: number): Promise<boolean>;
  };
}

export interface WindowShell<T extends NodeTransport> {
  /** The window's command transport, created with the shell's hooks. */
  readonly transport: T;
  readonly api: WindowShellApi;
  /** Swaps the command transport's credential, as a token rotation does. */
  applyGatewayToken(token: string): void;
  /** Stops the cookie-session probe, its retry and listeners, and boot metrics timers. */
  dispose(): void;
}

/**
 * Builds the window shell and its command transport. `createTransport`
 * receives the shell's hooks and must pass them to `createNodeTransport`.
 */
export function createWindowShell<T extends NodeTransport>(
  options: WindowShellOptions,
  createTransport: (hooks: WindowShellTransportHooks) => T,
): WindowShell<T> {
  let bootMetricsTimeout: ReturnType<typeof setTimeout> | null = null;
  let bootMetricsDeferredTimer: ReturnType<typeof setTimeout> | null = null;
  let bootMetricsLoadObserved =
    typeof document === "undefined" || document.readyState === "complete";
  let bootMetricsReported = false;
  let bootMetricsEventStreamConnectedMs: number | null = null;
  let disposeBrowserSessionActivity: () => void = () => undefined;
  /** Set once the gateway confirms this tab holds a cookie session. */
  let browserSessionActive = false;
  let credentialLapseHandled = false;

  /**
   * A cookie session (login form or agent-test link) has a sliding idle
   * deadline and a hard absolute one, ends when the backend restarts, and is
   * revoked by token rotation; the gateway tears down this tab's event stream
   * and terminal sockets the moment it ends. Nothing the tab does afterwards
   * can succeed, so a 401 has to become a visible, actionable state: reload,
   * which lands on the gateway's login page (on a development profile it names
   * the `dev:login` command that mints a fresh link). Without this the tab
   * keeps rendering stale state behind an EventSource that retries forever.
   *
   * Scoped to confirmed cookie sessions on purpose. A bearer client (hosted,
   * Electron, another node's client) must never be navigated.
   */
  const handleCredentialLapse = () => {
    if (!browserSessionActive || credentialLapseHandled) return;
    credentialLapseHandled = true;
    disposeBrowserSessionActivity();
    // The session ended: protected rich content must not outlive it.
    clearProtectedRichContent("logout");
    if (options.onCredentialLapsed) {
      options.onCredentialLapsed();
      return;
    }
    // Reload rather than open `/login`: the gateway answers the reloaded page
    // with its login form and the reason the session ended, and the iOS shell
    // treats that main-frame 401 as its cue to offer a fresh native sign-in.
    if (typeof window !== "undefined") window.location.reload();
  };

  const clearBootMetricsTimers = () => {
    if (bootMetricsTimeout) clearTimeout(bootMetricsTimeout);
    bootMetricsTimeout = null;
    if (bootMetricsDeferredTimer) clearTimeout(bootMetricsDeferredTimer);
    bootMetricsDeferredTimer = null;
  };

  const sendBootMetrics = async () => {
    if (bootMetricsReported || !options.reportBootMetrics || typeof performance === "undefined")
      return;
    bootMetricsReported = true;
    clearBootMetricsTimers();

    const navigation = performance.getEntriesByType("navigation")[0] as
      PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const paintEntries = performance.getEntriesByType("paint");
    const firstPaint = paintEntries.find((entry) => entry.name === "first-paint");
    const firstContentfulPaint = paintEntries.find(
      (entry) => entry.name === "first-contentful-paint",
    );
    const payload = {
      platform:
        window.__orkestratorClientPlatform ??
        ((window as Window & { webkit?: unknown }).webkit ? "ios-wkwebview" : "desktop-browser"),
      navigationType: navigation?.type ?? "unknown",
      nextHopProtocol: navigation?.nextHopProtocol ?? null,
      transferSize: navigation?.transferSize ?? null,
      encodedBodySize: navigation?.encodedBodySize ?? null,
      decodedBodySize: navigation?.decodedBodySize ?? null,
      resourceCount: resources.length,
      resourceTransferSize: resources.reduce(
        (total, entry) => total + (entry.transferSize ?? 0),
        0,
      ),
      resourceEncodedBodySize: resources.reduce(
        (total, entry) => total + (entry.encodedBodySize ?? 0),
        0,
      ),
      resourceDecodedBodySize: resources.reduce(
        (total, entry) => total + (entry.decodedBodySize ?? 0),
        0,
      ),
      jsTransferSize: resources
        .filter((entry) => entry.initiatorType === "script")
        .reduce((total, entry) => total + (entry.transferSize ?? 0), 0),
      jsDecodedBodySize: resources
        .filter((entry) => entry.initiatorType === "script")
        .reduce((total, entry) => total + (entry.decodedBodySize ?? 0), 0),
      cssTransferSize: resources
        .filter((entry) => entry.initiatorType === "css" || entry.name.endsWith(".css"))
        .reduce((total, entry) => total + (entry.transferSize ?? 0), 0),
      cssDecodedBodySize: resources
        .filter((entry) => entry.initiatorType === "css" || entry.name.endsWith(".css"))
        .reduce((total, entry) => total + (entry.decodedBodySize ?? 0), 0),
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
      loadEventMs: navigation?.loadEventEnd ?? null,
      firstPaintMs: firstPaint?.startTime ?? null,
      firstContentfulPaintMs: firstContentfulPaint?.startTime ?? null,
      eventStreamConnectedMs: bootMetricsEventStreamConnectedMs,
    };

    void fetch(transport.url(`${GATEWAY_PREFIX}/client-metrics`), {
      method: "POST",
      credentials: transport.requestCredentials,
      headers: transport.requestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  };

  /**
   * Re-reads `document.readyState` rather than trusting the value captured when
   * this API was constructed. Construction happens at module evaluation, long
   * before anything subscribes, so the snapshot is almost always `"loading"`;
   * if the load event then fires before the first `listen()`, the listener
   * registered below is attached too late to ever run and the flag would stay
   * false forever, stranding the report on the 15s fallback.
   */
  const bootMetricsLoadHasHappened = () => {
    if (bootMetricsLoadObserved) return true;
    if (typeof document !== "undefined" && document.readyState === "complete") {
      bootMetricsLoadObserved = true;
    }
    return bootMetricsLoadObserved;
  };

  const maybeSendBootMetrics = () => {
    if (!options.reportBootMetrics || bootMetricsReported) return;
    if (!bootMetricsLoadHasHappened()) return;
    if (bootMetricsEventStreamConnectedMs === null) return;
    if (bootMetricsDeferredTimer) return;
    // `PerformanceNavigationTiming.loadEventEnd` remains zero while the
    // browser is dispatching the load event. Always cross a task boundary
    // before taking the snapshot so a stream that connects during a load
    // handler cannot permanently report a zero load duration.
    bootMetricsDeferredTimer = setTimeout(() => {
      bootMetricsDeferredTimer = null;
      void sendBootMetrics();
    }, 0);
  };

  const startBootMetricsReporter = () => {
    if (!options.reportBootMetrics || bootMetricsReported || bootMetricsTimeout) return;
    if (!bootMetricsLoadHasHappened()) {
      window.addEventListener(
        "load",
        () => {
          bootMetricsLoadObserved = true;
          maybeSendBootMetrics();
        },
        { once: true },
      );
    }
    bootMetricsTimeout = setTimeout(() => {
      bootMetricsTimeout = null;
      if (bootMetricsReported) return;
      void sendBootMetrics();
    }, 15_000);
  };

  const transport = createTransport({
    onCredentialRejected: handleCredentialLapse,
    metrics: {
      mainStreamStarting: startBootMetricsReporter,
      mainStreamOpened: () => {
        if (bootMetricsEventStreamConnectedMs === null && typeof performance !== "undefined") {
          bootMetricsEventStreamConnectedMs = performance.now();
          maybeSendBootMetrics();
        }
      },
      mainStreamIdle: clearBootMetricsTimers,
    },
    lifecycle: browserWindowLifecycle(),
  });
  const credentials = transport.requestCredentials;
  const apiUrl = transport.url;

  /**
   * The window's own connection got a new token. Its transport sends it and
   * reopens its streams with it (`setCredential`); nothing patches the page's
   * `fetch` on its behalf. Everything this window shows came through this
   * connection, relayed leaves included, so the clear is window-wide; a node
   * transport's owner clears only that node (`{ nodeId }`).
   */
  const applyGatewayToken = (token: string): void => {
    const normalizedToken = token.trim();
    // New credentials: rich content derived under the old ones is dropped.
    if ((normalizedToken || undefined) !== transport.credential()) {
      clearProtectedRichContent("credentials");
    }
    transport.setCredential(normalizedToken);
  };

  const sourceConnections = options.connections;
  const connections = sourceConnections
    ? {
        ...sourceConnections,
        async updateToken(connectionId: string, token: string) {
          const list = await sourceConnections.updateToken(connectionId, token);
          if (list.activeConnectionId === connectionId) applyGatewayToken(token);
          return list;
        },
      }
    : undefined;

  const detectBrowserSession = async () => {
    if (
      !detectsBrowserSession(
        credentials,
        options.browserSessionActivity,
        transport.baseUrl ?? undefined,
      )
    ) {
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    let lastRefreshAt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    let probing = false;
    const removeListeners = () => {
      if (disposed) return;
      disposed = true;
      browserSessionActive = false;
      controller.abort();
      clearTimeout(retryTimer);
      window.removeEventListener("online", probe);
      window.removeEventListener("keydown", refreshAfterActivity);
      window.removeEventListener("pointerdown", refreshAfterActivity);
    };
    const refreshAfterActivity = () => {
      const now = Date.now();
      if (disposed || now - lastRefreshAt < BROWSER_SESSION_ACTIVITY_REFRESH_INTERVAL_MS) return;
      lastRefreshAt = now;
      void fetch(apiUrl(`${GATEWAY_PREFIX}/session`), {
        method: "POST",
        credentials,
        signal: controller.signal,
      })
        .then((response) => {
          // 401 is a lapsed session and needs the login page. 404 means the
          // gateway holds no session for this tab, so it has nothing to renew —
          // tearing it down further would be wrong.
          if (response.status === 401) handleCredentialLapse();
          else if (response.status === 404) removeListeners();
        })
        .catch(() => undefined);
    };
    disposeBrowserSessionActivity = removeListeners;
    const scheduleRetry = () => {
      if (disposed) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(probe, retryDelay);
      retryDelay = Math.min(30_000, retryDelay * 2);
    };
    const probe = async () => {
      if (disposed || probing) return;
      probing = true;
      clearTimeout(retryTimer);
      try {
        const response = await fetch(apiUrl(`${GATEWAY_PREFIX}/session`), {
          credentials,
          signal: controller.signal,
        });
        if (disposed) return;
        if (response.status === 401) {
          browserSessionActive = true;
          handleCredentialLapse();
        } else if (response.status === 404) {
          removeListeners();
        } else if (!response.ok) {
          scheduleRetry();
        } else {
          browserSessionActive = true;
          window.removeEventListener("online", probe);
          window.addEventListener("keydown", refreshAfterActivity);
          window.addEventListener("pointerdown", refreshAfterActivity);
        }
      } catch {
        scheduleRetry();
      } finally {
        probing = false;
      }
    };
    window.addEventListener("online", probe);
    await probe();
  };
  void detectBrowserSession();

  const api: WindowShellApi = {
    clipboard: {
      readText(): Promise<string> {
        return navigator.clipboard?.readText() ?? Promise.resolve("");
      },
      writeText(text: string): Promise<void> {
        const clipboard = navigator.clipboard;
        if (!clipboard?.writeText) {
          return Promise.reject(
            new Error("Clipboard text writes are not supported by this browser"),
          );
        }
        return clipboard.writeText(text);
      },
      readImage(): Promise<{ width: number; height: number; blob: Blob } | null> {
        return readBrowserClipboardImage();
      },
      writeImage(_dataUrl: string): Promise<void> {
        return Promise.resolve();
      },
    },

    ...(connections ? { connections } : {}),

    webClient: {
      getStatus(): Promise<WebClientStatus> {
        return Promise.resolve({
          enabled: true,
          running: true,
          // The command transport's own base; only the page's own gateway,
          // which has none, asks the page.
          url: `${transport.baseUrl ?? getGatewayBaseUrl()}/`,
          error: null,
          resetAvailable: false,
        });
      },
      setEnabled(): Promise<WebClientStatus> {
        return Promise.reject(
          new Error("Web client controls are only available in the desktop app"),
        );
      },
      resetServe(): Promise<WebClientStatus> {
        return Promise.reject(
          new Error("Tailscale Serve reset is only available for the local desktop app"),
        );
      },
      async getTokenSettings(): Promise<GatewayTokenSettings> {
        const response = await fetch(apiUrl(`${GATEWAY_PREFIX}/gateway-settings`), {
          credentials,
          headers: transport.requestHeaders(),
        });
        return transport.readResponse<GatewayTokenSettings>(
          response,
          "Gateway settings request failed",
        );
      },
      async setToken(token: string): Promise<GatewayTokenSettings> {
        const response = await fetch(apiUrl(`${GATEWAY_PREFIX}/gateway-settings`), {
          method: "PUT",
          credentials,
          headers: transport.requestHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ token }),
        });
        const settings = await transport.readResponse<GatewayTokenSettings>(
          response,
          "Gateway settings request failed",
        );
        applyGatewayToken(settings.token);
        options.onTokenChanged?.(settings.token);
        return settings;
      },
    },

    process: {
      exit(): Promise<void> {
        window.close();
        return Promise.resolve();
      },
    },

    window: {
      startDragging(): Promise<void> {
        return Promise.resolve();
      },
      // No webContents to zoom in a browser tab. Reporting false is what routes
      // the renderer to its CSS `zoom` fallback.
      setZoomFactor(_factor: number): Promise<boolean> {
        return Promise.resolve(false);
      },
    },
  };

  return {
    transport,
    api,
    applyGatewayToken,
    dispose() {
      disposeBrowserSessionActivity();
      clearBootMetricsTimers();
    },
  };
}
