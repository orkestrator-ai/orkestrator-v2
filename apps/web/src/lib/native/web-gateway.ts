/**
 * The page's `window.orkestrator` in a browser, iOS or a local desktop window
 * on the direct transport: a thin composition of the window's command
 * transport (`createNodeTransport`, `node-transport.ts`) and the window shell
 * (`window-shell.ts`). Module load installs it, as before.
 */
import { resolveGatewayApiUrl } from "@/lib/gateway-url";
import { clearProtectedRichContent } from "@/lib/chat/rich-content-reset";
import { isPerNodeRelayedEvent } from "@orkestrator/protocol/node-events";
import {
  createNodeTransport,
  TERMINAL_OUTPUT_EVENT_PREFIX,
  type EventCallback,
  type NodeTransportOptions,
} from "@/lib/native/node-transport";
import { createWindowShell } from "@/lib/native/window-shell";

export {
  credentialProbeVerdict,
  type GatewayEventStreamConnectionState,
} from "@/lib/native/node-transport";
export {
  BROWSER_SESSION_ACTIVITY_REFRESH_INTERVAL_MS,
  detectsBrowserSession,
} from "@/lib/native/window-shell";

export const TERMINAL_TRANSPORT_STORAGE_KEY = "orkestrator-terminal-transport";

type GatewayWindow = Pick<
  Window,
  "location" | "orkestrator" | "orkestratorDesktopHost" | "orkestratorGateway"
>;

const browserGatewayDisposers = new WeakMap<object, (reason?: unknown) => void>();

export interface BrowserGatewayOptions {
  unavailableReason?: string;
  baseUrl?: string;
  token?: string;
  replaceExisting?: boolean;
  onTokenChanged?: (token: string) => void;
  /**
   * First reconnect delay of the main stream and the terminal fallback
   * streams; repeated failures back off from it.
   */
  eventReconnectDelayMs?: number;
  /** Upper bound of the event stream reconnect backoff. */
  eventReconnectMaxDelayMs?: number;
  /** Jitter source for the event stream reconnect backoff; uniform in [0, 1). */
  eventReconnectRandom?: () => number;
  /** Clock that decides whether a dropped stream had stayed up long enough. */
  eventReconnectNow?: () => number;
  /** A main stream the gateway stays silent on this long counts as lost. */
  eventStreamSilenceLimitMs?: number;
  /** A main stream attempt with no answer after this long counts as failed. */
  eventStreamConnectTimeoutMs?: number;
  /**
   * Ask `/status` about the credential when the main fetch stream fails
   * without a 401 (see `NodeTransportOptions`). Off by default here;
   * `installBrowserGatewayApi` turns it on for a page on another base (a
   * hosted direct client).
   */
  probeCredentialOnStreamFailure?: boolean;
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
  connections?: NonNullable<Window["orkestrator"]>["connections"];
  /** Test/embedding overrides; production uses the bounded defaults. */
  terminalInputBatchDelayMs?: number;
  terminalInputMaxBatchBytes?: number;
  terminalInputMaxQueuedBytes?: number;
  terminalInputSendTimeoutMs?: number;
  /** Opt-in during the compatibility release; failures fall back to HTTP/SSE. */
  terminalTransport?: "http-sse" | "websocket";
  terminalWebSocketFactory?: (url: string, protocols: string | string[]) => WebSocket;
  terminalWebSocketReconnectDelayMs?: number;
  /**
   * Carry the shared terminal stream on an `EventSource` even with a
   * `baseUrl`, as the local desktop window does: main adds its credential at
   * the network layer, so the page has no bearer token to send. A client with
   * a bearer token always reads that stream with `fetch`, because an
   * `EventSource` cannot send one.
   */
  terminalEventSource?: boolean;
  /**
   * Let a command sent while the page goes away finish after it, as one
   * through Electron main always did (a final pane layout write, for example).
   */
  keepaliveOnPageHide?: boolean;
}

function normalizedBaseUrl(value: string | undefined): string | undefined {
  return value?.trim().replace(/\/+$/, "") || undefined;
}

/** The page-wide terminal transport opt-in: explicit, else this origin's stored choice. */
function terminalTransportEnabled(options: BrowserGatewayOptions): boolean {
  if (options.terminalTransport) return options.terminalTransport === "websocket";
  try {
    return localStorage.getItem(TERMINAL_TRANSPORT_STORAGE_KEY) === "websocket";
  } catch {
    return false;
  }
}

export function createBrowserGatewayApi(options: BrowserGatewayOptions = {}) {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  // Without a base this is the gateway that served the page, resolved the way
  // the rest of the page resolves it. Only this window-level composition reads
  // that global; the transport is told.
  const endpoint: Pick<NodeTransportOptions, "baseUrl" | "resolvePageUrl"> = baseUrl
    ? { baseUrl }
    : { baseUrl: null, resolvePageUrl: resolveGatewayApiUrl };
  const shell = createWindowShell(
    {
      reportBootMetrics: options.reportBootMetrics,
      browserSessionActivity: options.browserSessionActivity,
      onCredentialLapsed: options.onCredentialLapsed,
      onTokenChanged: options.onTokenChanged,
      connections: options.connections,
    },
    (hooks) =>
      createNodeTransport({
        ...(endpoint as NodeTransportOptions),
        credential: options.token,
        unavailableReason: options.unavailableReason,
        onCredentialRejected: hooks.onCredentialRejected,
        metrics: hooks.metrics,
        lifecycle: hooks.lifecycle,
        probeCredentialOnStreamFailure: options.probeCredentialOnStreamFailure ?? false,
        eventReconnectDelayMs: options.eventReconnectDelayMs,
        eventReconnectMaxDelayMs: options.eventReconnectMaxDelayMs,
        eventReconnectRandom: options.eventReconnectRandom,
        eventReconnectNow: options.eventReconnectNow,
        eventStreamSilenceLimitMs: options.eventStreamSilenceLimitMs,
        eventStreamConnectTimeoutMs: options.eventStreamConnectTimeoutMs,
        terminalInputBatchDelayMs: options.terminalInputBatchDelayMs,
        terminalInputMaxBatchBytes: options.terminalInputMaxBatchBytes,
        terminalInputMaxQueuedBytes: options.terminalInputMaxQueuedBytes,
        terminalInputSendTimeoutMs: options.terminalInputSendTimeoutMs,
        terminalTransport: terminalTransportEnabled(options) ? "websocket" : "http-sse",
        terminalWebSocketFactory: options.terminalWebSocketFactory,
        terminalWebSocketReconnectDelayMs: options.terminalWebSocketReconnectDelayMs,
        terminalEventSource: options.terminalEventSource,
        keepaliveOnPageHide: options.keepaliveOnPageHide,
      }),
  );
  const { transport } = shell;

  const api = {
    invoke: transport.invoke,
    hello: transport.hello,
    listen: transport.listen,
    eventStreamReady: transport.eventStreamReady,
    eventStreamConnection: transport.eventStreamConnection,
    ...shell.api,
  };
  browserGatewayDisposers.set(api, (reason = new Error("Browser gateway disposed")) => {
    transport.dispose(reason);
    shell.dispose();
  });
  return api;
}

/**
 * Stops everything a gateway from `createBrowserGatewayApi` runs on its own:
 * the cookie-session probe, its retry timer and window listeners, watchdogs,
 * and terminal and relayed streams. A no-op for anything else, and after the
 * first call. Callers that drop a gateway without replacing it through
 * `installBrowserGatewayApi` must call this, or its timers keep calling
 * `fetch` for the life of the page.
 */
export function disposeBrowserGatewayApi(api: object, reason?: unknown): void {
  const dispose = browserGatewayDisposers.get(api);
  if (!dispose) return;
  browserGatewayDisposers.delete(api);
  dispose(reason);
}

export function installBrowserGatewayApi(
  targetWindow: GatewayWindow = window,
  options: BrowserGatewayOptions = {},
): void {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  if (
    (!targetWindow.orkestrator || options.replaceExisting) &&
    targetWindow.location.protocol.startsWith("http")
  ) {
    if (options.replaceExisting && targetWindow.orkestrator) {
      disposeBrowserGatewayApi(targetWindow.orkestrator, new Error("Browser gateway replaced"));
      // A replaced gateway may be another backend or other credentials.
      clearProtectedRichContent("gateway-replaced");
    }
    // The transport sends its own bearer and reads bearer streams with
    // `fetch`, so nothing patches the page's `fetch` or `EventSource` for it.
    targetWindow.orkestratorGateway = { enabled: true, ...(baseUrl ? { baseUrl } : {}) };
    targetWindow.orkestrator = createBrowserGatewayApi({
      ...options,
      baseUrl,
      reportBootMetrics: !options.unavailableReason,
      // Every same-origin cookie client holds an expiring gateway session (login
      // form or agent-test link). A bearer client skips the probe on its own.
      browserSessionActivity: options.browserSessionActivity ?? !options.unavailableReason,
      // A page on another base (a hosted direct client) is that node's
      // transport: a stream failure that does not say 401 asks `/status`, so
      // a revoked credential shows as refused, not as an outage.
      probeCredentialOnStreamFailure: options.probeCredentialOnStreamFailure ?? Boolean(baseUrl),
    });
  }
}

/**
 * A local Electron window on the direct gateway transport (the
 * `localWindowGatewayTransport` setting). Commands and backend events go
 * straight to the local backend, with terminal output on its own filtered
 * stream; main adds the credential at the network layer, so the page never
 * holds it. Everything else stays the preload's: native APIs, and the events
 * main raises itself (menus, connection lists, a stopped backend).
 *
 * This window is still a local client, so it sets no `orkestratorGateway`.
 */
export function installLocalDesktopGateway(
  targetWindow: GatewayWindow = window,
  overrides: BrowserGatewayOptions = {},
): void {
  const host = targetWindow.orkestratorDesktopHost;
  if (!host || targetWindow.orkestrator) return;
  const gateway = createBrowserGatewayApi({
    baseUrl: host.baseUrl,
    // Not tied to the terminal WebSocket: to-do 1202 task 12 starts with SSE.
    terminalTransport: "http-sse",
    terminalEventSource: true,
    keepaliveOnPageHide: true,
    ...overrides,
  });
  targetWindow.orkestrator = {
    ...host.api,
    invoke: gateway.invoke,
    hello: gateway.hello,
    listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
      const unlistenGateway = gateway.listen(event, callback);
      // Main raises neither itself, so its relay has nothing to add here.
      if (event.startsWith(TERMINAL_OUTPUT_EVENT_PREFIX) || isPerNodeRelayedEvent(event)) {
        return unlistenGateway;
      }
      const unlistenHost = host.api.listen(event, callback);
      return () => {
        unlistenHost();
        unlistenGateway();
      };
    },
    eventStreamReady: gateway.eventStreamReady,
    eventStreamConnection: gateway.eventStreamConnection,
  };
}

// Browser and iOS: the window is always its command node's client; another
// node's workspace runs in the window's tree on that node's own client
// (`lib/node-scope/node-clients.ts`).
if (typeof window !== "undefined") {
  installLocalDesktopGateway(window);
  installBrowserGatewayApi(window);
}
