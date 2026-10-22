import type { GatewayTokenSettings, WebClientStatus } from "@/types";
import {
  clearLegacyWorkspaceTarget,
  readStoredWorkspace,
} from "@/lib/portal/workspace-target-storage";
import { getGatewayBaseUrl, resolveGatewayApiUrl } from "@/lib/gateway-url";
import {
  configureDirectGatewayTransport,
  updateDirectGatewayToken,
} from "@/lib/native/gateway-auth-transport";
import { readClipboardImageDimensions } from "@/lib/clipboard-image";
import { GatewayHttpError } from "@/lib/native/gateway-http-error";
import { clearProtectedRichContent } from "@/lib/chat/rich-content-reset";
import {
  GATEWAY_EVENT_CURSOR_PARAM,
  GatewayEventStreamState,
  isGatewayTransportEvent,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  parseGatewayEventData,
  readSseStream,
} from "@orkestrator/protocol/gateway-event-stream";
import { TerminalInputSequencer } from "@orkestrator/protocol/terminal-input-sequencer";
import {
  TerminalWebSocketClient,
  terminalWebSocketUrl,
  type TerminalSocketPayload,
} from "@/lib/native/terminal-websocket-client";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";

const GATEWAY_PREFIX = "/__orkestrator";
const EVENT_RECONNECT_DELAY_MS = 2_000;
/**
 * Consecutive failures of the main stream or a terminal fallback stream back
 * off to at most this multiple of the first retry (16 s by default), and a
 * stream must stay up this long (longer than the gateway's 25 s keepalive)
 * before its loss counts as a first failure again. Open time, not a first
 * frame, is the test: an idle terminal sends nothing.
 */
const EVENT_RECONNECT_MAX_DELAY_FACTOR = 8;
const EVENT_STREAM_HEALTHY_AFTER_MS = 30_000;
const TERMINAL_OUTPUT_EVENT_PREFIX = "terminal-output-";
/**
 * `EventSource.CLOSED`, spelled as the spec's fixed numeric value rather than
 * read off the constructor: a same-origin browser may have replaced the global,
 * and the constant is what distinguishes a dead socket from one the browser is
 * still retrying for us.
 */
const EVENT_SOURCE_CLOSED = 2;
export const AGENT_TEST_SESSION_ACTIVITY_REFRESH_INTERVAL_MS = 60_000;
export const TERMINAL_TRANSPORT_STORAGE_KEY = "orkestrator-terminal-transport";
/** How long a shared-stream filter narrowing waits for its siblings. */
const TERMINAL_FILTER_NARROW_DELAY_MS = 50;

type EventCallback<T> = (payload: T) => unknown;
type GatewayWindow = Pick<
  Window,
  | "location"
  | "orkestrator"
  | "orkestratorGateway"
  | "orkestratorPortal"
  | "orkestratorWorkspaceTarget"
>;

const browserGatewayDisposers = new WeakMap<object, (reason?: unknown) => void>();

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
  reportBootMetrics?: boolean;
  /** Same-origin app install probes for the agent-test-only activity endpoint. */
  agentTestSessionActivity?: boolean;
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
}

function normalizedBaseUrl(value: string | undefined): string | undefined {
  return value?.trim().replace(/\/+$/, "") || undefined;
}

function terminalTransportEnabled(options: BrowserGatewayOptions): boolean {
  if (options.terminalTransport) return options.terminalTransport === "websocket";
  try {
    return localStorage.getItem(TERMINAL_TRANSPORT_STORAGE_KEY) === "websocket";
  } catch {
    return false;
  }
}

export function createBrowserGatewayApi(options: BrowserGatewayOptions = {}) {
  const listeners = new Map<string, Set<EventCallback<unknown>>>();
  let eventSource: EventSource | null = null;
  let streamAbortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // A backend restart drops every open tab's stream at once. Consecutive
  // failures back off with jitter so those tabs do not retry in lock-step for
  // the whole outage; the first retry is never slower than the configured
  // delay, and only a stream that stayed up resets the ladder. Replay is
  // unchanged: each attempt still resumes from `mainStream.cursor`. Terminal
  // fallback streams use the same policy, one ladder per reconnect owner.
  const eventReconnectDelayMs = options.eventReconnectDelayMs ?? EVENT_RECONNECT_DELAY_MS;
  const createStreamBackoff = () =>
    new ReconnectBackoff(
      {
        initialDelayMs: eventReconnectDelayMs,
        maxDelayMs:
          options.eventReconnectMaxDelayMs ??
          eventReconnectDelayMs * EVENT_RECONNECT_MAX_DELAY_FACTOR,
        healthyAfterMs: EVENT_STREAM_HEALTHY_AFTER_MS,
      },
      { random: options.eventReconnectRandom, now: options.eventReconnectNow },
    );
  const mainStreamBackoff = createStreamBackoff();
  let bootMetricsTimeout: ReturnType<typeof setTimeout> | null = null;
  let bootMetricsDeferredTimer: ReturnType<typeof setTimeout> | null = null;
  let bootMetricsLoadObserved =
    typeof document === "undefined" || document.readyState === "complete";
  let bootMetricsReported = false;
  let bootMetricsEventStreamConnectedMs: number | null = null;
  /** Cursor and recovery state for the authoritative stream, across reconnects. */
  const mainStream = new GatewayEventStreamState();
  type TerminalEventStream = {
    event: string;
    /**
     * Direct/bearer clients use one fetch stream per terminal. Same-origin
     * browser clients leave this null and share `browserTerminalEventSource`.
     */
    source: EventSource | null;
    controller: AbortController | null;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    /**
     * The direct fetch stream's own reconnect ladder. Each terminal has its
     * own socket, so a shared ladder would climb one rung per terminal when a
     * backend restart drops them all at once. A new stream for the same event
     * (the user's Reconnect re-listens) starts a fresh ladder.
     */
    backoff: ReconnectBackoff;
    socketUnlisten: (() => void) | null;
    ready: Promise<void>;
    resolveReady: () => void;
    readyResolved: boolean;
    /**
     * Whether this stream has ever been open. A reconnect is not the same as a
     * first connect: terminal output is deliberately outside the gateway's
     * replay ring, so everything the PTY emitted during the gap is gone from
     * this socket and the consumer has to re-read the authoritative snapshot.
     */
    connectedBefore: boolean;
    /**
     * Whether this terminal is currently consuming the compatibility SSE
     * transport. WebSocket readiness is channel-scoped: an authenticated
     * socket does not make a subscription (or its snapshot) usable.
     */
    fallbackActive: boolean;
    closed: boolean;
  };
  const terminalEventStreams = new Map<string, TerminalEventStream>();
  let browserTerminalEventSource: EventSource | null = null;
  let browserTerminalRefreshQueued = false;
  let browserTerminalNarrowTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The sorted event list backing `browserTerminalEventSource`. Rebuilding the
   * socket costs every already-connected terminal a full snapshot reconcile, so
   * a refresh that resolves to the same filter must not touch the socket.
   */
  let browserTerminalSubscribedEvents: string[] | null = null;
  /**
   * The terminal streams the shared socket was opened for, kept after a fatal
   * error. A refresh while that socket is dead rebuilds early only for a
   * stream it did not carry: a newly mounted terminal, or one the user
   * reconnected (re-listening creates a new stream object).
   */
  let browserTerminalSocketStreams: ReadonlySet<TerminalEventStream> = new Set();
  let browserTerminalReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** One ladder for the one shared socket, however many terminals it carries. */
  const browserTerminalBackoff = createStreamBackoff();
  /**
   * Whether `browserTerminalEventSource` has actually opened. A stream that
   * attaches to an already-open shared socket gets no `onopen` of its own, so
   * this is what tells it to latch readiness instead of waiting forever.
   */
  let browserTerminalEventSourceOpen = false;
  let bearerToken = options.token?.trim() || undefined;
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const apiUrl = (pathname: string): string => {
    if (options.unavailableReason) throw new Error(options.unavailableReason);
    return baseUrl ? `${baseUrl}${pathname}` : resolveGatewayApiUrl(pathname);
  };

  const requestHeaders = (headers?: Record<string, string>): Record<string, string> | undefined => {
    const result = { ...headers };
    if (bearerToken) result.authorization = `Bearer ${bearerToken}`;
    return Object.keys(result).length > 0 ? result : undefined;
  };

  const crossOrigin =
    baseUrl && new URL(baseUrl, window.location.href).origin !== window.location.origin;
  const credentials = bearerToken || crossOrigin ? ("omit" as const) : ("same-origin" as const);
  const websocketTerminalsEnabled = terminalTransportEnabled(options);
  let terminalSocket: TerminalWebSocketClient | null = null;
  let disposeAgentTestActivity: () => void = () => undefined;
  /** Set once the gateway confirms this tab holds an agent-test cookie session. */
  let agentTestSessionActive = false;
  let credentialLapseHandled = false;

  const applyGatewayToken = (token: string): void => {
    const normalizedToken = token.trim();
    // New credentials: rich content derived under the old ones is dropped.
    if ((normalizedToken || undefined) !== bearerToken) clearProtectedRichContent("credentials");
    bearerToken = normalizedToken || undefined;
    terminalSocket?.updateToken(normalizedToken);
    updateDirectGatewayToken(normalizedToken);
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

  /**
   * An agent-test session has a sliding idle deadline and a hard absolute one,
   * and the gateway tears down this tab's event stream and terminal sockets the
   * moment either passes. Nothing the tab does afterwards can succeed, so a 401
   * has to become a visible, actionable state: send the browser to the login
   * page, which names the `dev:login` command that mints a fresh link. Without
   * this the tab keeps rendering stale state behind an EventSource that retries
   * forever, which reads as a regression in whatever was being tested.
   *
   * Scoped to confirmed agent-test sessions on purpose. A durable-token client
   * has no deadline to trip, and a remote/bearer client must never be navigated.
   */
  const handleCredentialLapse = () => {
    if (!agentTestSessionActive || credentialLapseHandled) return;
    credentialLapseHandled = true;
    disposeAgentTestActivity();
    // The session ended: protected rich content must not outlive it.
    clearProtectedRichContent("logout");
    if (options.onCredentialLapsed) {
      options.onCredentialLapsed();
      return;
    }
    if (typeof window !== "undefined") {
      window.location.assign(apiUrl(`${GATEWAY_PREFIX}/login`));
    }
  };

  const detectAgentTestSession = async () => {
    if (credentials !== "same-origin" || !options.agentTestSessionActivity) return;
    const controller = new AbortController();
    let disposed = false;
    let lastRefreshAt = 0;
    const removeListeners = () => {
      if (disposed) return;
      disposed = true;
      agentTestSessionActive = false;
      controller.abort();
      window.removeEventListener("keydown", refreshAfterActivity);
      window.removeEventListener("pointerdown", refreshAfterActivity);
    };
    const refreshAfterActivity = () => {
      const now = Date.now();
      if (disposed || now - lastRefreshAt < AGENT_TEST_SESSION_ACTIVITY_REFRESH_INTERVAL_MS) return;
      lastRefreshAt = now;
      void fetch(apiUrl(`${GATEWAY_PREFIX}/agent-test/session`), {
        method: "POST",
        credentials,
        signal: controller.signal,
      })
        .then((response) => {
          // 401 is a lapsed session and needs the login page. 404 only means this
          // gateway has no such route, so the tab is fine and simply has nothing
          // to renew — tearing it down further would be wrong.
          if (response.status === 401) handleCredentialLapse();
          else if (response.status === 404) removeListeners();
        })
        .catch(() => undefined);
    };
    disposeAgentTestActivity = removeListeners;
    try {
      const response = await fetch(apiUrl(`${GATEWAY_PREFIX}/agent-test/session`), {
        credentials,
        signal: controller.signal,
      });
      if (!response.ok || disposed) {
        removeListeners();
        return;
      }
      agentTestSessionActive = true;
      window.addEventListener("keydown", refreshAfterActivity);
      window.addEventListener("pointerdown", refreshAfterActivity);
    } catch {
      removeListeners();
    }
  };
  void detectAgentTestSession();

  /**
   * Receive every authoritative state event, but only terminal byte streams
   * this browser currently consumes. Terminal events are namespaced by session,
   * so a remote tab looking at one environment no longer downloads output from
   * every terminal in every other environment.
   */
  const eventStreamPath = (terminalEvents?: string | readonly string[], since?: string | null) => {
    const params = new URLSearchParams({
      excludeEvents: TERMINAL_OUTPUT_EVENT_PREFIX,
    });
    if (terminalEvents) {
      const included =
        typeof terminalEvents === "string" ? terminalEvents : terminalEvents.join(",");
      if (included) params.set("includeEvents", included);
    }
    if (!terminalEvents && since) params.set(GATEWAY_EVENT_CURSOR_PARAM, since);
    return `${GATEWAY_PREFIX}/events?${params.toString()}`;
  };

  const isTerminalOutputEvent = (event: string): boolean =>
    event.startsWith(TERMINAL_OUTPUT_EVENT_PREFIX);

  const hasMainEventListeners = (): boolean =>
    [...listeners.keys()].some((event) => !isTerminalOutputEvent(event));

  const deliver = (event: string, payload: unknown) => {
    const callbacks = listeners.get(event);
    if (!callbacks) return;
    for (const callback of callbacks) {
      try {
        callback(payload);
      } catch (error) {
        console.error(`[RemoteGateway] Event listener for ${event} failed`, error);
      }
    }
  };

  /** One frame of the authoritative stream; only it may act on replay frames. */
  const dispatchMainFrame = (data: string, lastEventId: string | null) => {
    const message = mainStream.accept(data, lastEventId);
    if (message.kind === "resync") announceEventStreamConnected();
    else if (message.kind === "event") deliver(message.event, message.payload);
  };

  /**
   * A frame from a terminal stream, or one synthesized locally. Replay control
   * frames are swallowed so a terminal socket can neither reach ordinary
   * listeners nor latch authoritative connection state, and transport events
   * are swallowed so a server frame can never impersonate one.
   */
  const dispatchMessage = (data: string, options: { terminalFallback?: boolean } = {}) => {
    const parsed = parseGatewayEventData(data);
    if (!parsed || isGatewayTransportEvent(parsed.event)) return;
    if (options.terminalFallback && !terminalEventStreams.get(parsed.event)?.fallbackActive) return;
    deliver(parsed.event, parsed.payload);
  };

  const announceEventStreamConnected = () => {
    const callbacks = listeners.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT);
    if (!callbacks) return;
    for (const callback of callbacks) {
      try {
        callback(undefined);
      } catch (error) {
        console.error("[RemoteGateway] Event-stream listener failed", error);
      }
    }
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
      | PerformanceNavigationTiming
      | undefined;
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

    void fetch(apiUrl(`${GATEWAY_PREFIX}/client-metrics`), {
      method: "POST",
      credentials,
      headers: requestHeaders({ "content-type": "application/json" }),
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

  const consumeFetchEventStream = (
    response: Response,
    controller: AbortController,
    mainStreamFrames = false,
    terminalFallback = false,
  ): Promise<void> =>
    readSseStream(response.body!, controller.signal, (frame) => {
      if (!frame.data) return;
      if (mainStreamFrames) dispatchMainFrame(frame.data, frame.id);
      else dispatchMessage(frame.data, { terminalFallback });
    });

  const scheduleReconnect = () => {
    if (!hasMainEventListeners() || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureEventStream();
    }, mainStreamBackoff.nextDelayMs());
  };

  const connectFetchEventStream = () => {
    if (streamAbortController || !hasMainEventListeners()) return;
    startBootMetricsReporter();
    const controller = new AbortController();
    streamAbortController = controller;

    void (async () => {
      try {
        const response = await fetch(apiUrl(eventStreamPath(undefined, mainStream.cursor)), {
          credentials,
          headers: requestHeaders(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Gateway event stream failed with HTTP ${response.status}`);
        }
        mainStreamBackoff.connected();
        retryWaitingTerminalFallbacks();
        if (bootMetricsEventStreamConnectedMs === null && typeof performance !== "undefined") {
          bootMetricsEventStreamConnectedMs = performance.now();
          maybeSendBootMetrics();
        }
        await consumeFetchEventStream(response, controller, true);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("[RemoteGateway] Event stream disconnected", error);
        }
      } finally {
        const shouldReconnect = !controller.signal.aborted;
        controller.abort();
        if (streamAbortController === controller) streamAbortController = null;
        if (shouldReconnect) scheduleReconnect();
      }
    })();
  };

  const ensureEventStream = () => {
    if (eventSource || streamAbortController || !hasMainEventListeners()) return;
    startBootMetricsReporter();
    if (bearerToken || baseUrl) {
      connectFetchEventStream();
      return;
    }

    const source = new EventSource(apiUrl(eventStreamPath(undefined, mainStream.cursor)), {
      withCredentials: true,
    });
    eventSource = source;
    source.onopen = () => {
      if (eventSource === source) {
        mainStreamBackoff.connected();
        retryWaitingTerminalFallbacks();
      }
      if (bootMetricsEventStreamConnectedMs === null && typeof performance !== "undefined") {
        bootMetricsEventStreamConnectedMs = performance.now();
        maybeSendBootMetrics();
      }
    };
    source.onmessage = (message) => {
      if (eventSource !== source) return;
      dispatchMainFrame(message.data, message.lastEventId);
    };
    source.onerror = () => {
      if (eventSource !== source) return;
      console.warn("[RemoteGateway] Event stream disconnected");
      // A recoverable error leaves the socket CONNECTING and the browser retries
      // it for us, carrying Last-Event-ID; reconnecting here would race that. A
      // CLOSED socket is dead, and because `ensureEventStream` early-returns
      // while `eventSource` is set, nothing else would ever rebuild it — the tab
      // would silently stop receiving every authoritative event until reload.
      if (source.readyState !== EVENT_SOURCE_CLOSED) return;
      eventSource = null;
      scheduleReconnect();
    };
  };

  const closeEventStreamIfIdle = () => {
    if (hasMainEventListeners()) return;
    eventSource?.close();
    eventSource = null;
    streamAbortController?.abort();
    streamAbortController = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    // A later listener starts a fresh connection, not the tail of an old outage.
    mainStreamBackoff.reset();
    // Nothing is listening any more, so there is no boot left to measure. A
    // surviving timer would hold this whole closure and still report for a
    // session that has already torn down.
    clearBootMetricsTimers();
  };

  const resolveTerminalStreamReady = (stream: TerminalEventStream) => {
    if (stream.readyResolved) return;
    stream.readyResolved = true;
    stream.resolveReady();
  };

  /**
   * Announce that a per-terminal stream is open.
   *
   * `resolveTerminalStreamReady` is a one-shot latch, so on its own a stream
   * that drops and reconnects tells the consumer nothing — none of `useTerminal`'s
   * reconcile triggers fire and the terminal stays permanently truncated. Every
   * open after the first therefore synthesizes a desync frame for exactly this
   * event's listeners, which `decodeTerminalOutputPayload` maps to `null` and
   * `useTerminal` turns into a snapshot reconcile. Scoping it to the one event
   * avoids the app-wide resync `announceEventStreamConnected` would trigger.
   */
  const announceTerminalStreamOpen = (stream: TerminalEventStream) => {
    const isReconnect = stream.connectedBefore;
    stream.connectedBefore = true;
    resolveTerminalStreamReady(stream);
    if (!isReconnect) return;
    dispatchMessage(JSON.stringify({ event: stream.event, payload: { desynced: true } }));
  };

  const clearBrowserTerminalReconnectTimer = () => {
    if (!browserTerminalReconnectTimer) return;
    clearTimeout(browserTerminalReconnectTimer);
    browserTerminalReconnectTimer = null;
  };

  /**
   * Every reopen of a terminal stream announces a desync and costs each
   * terminal on it a snapshot read, so a backend that keeps failing must not
   * be retried at a fixed interval by every open tab at once.
   */
  const scheduleBrowserTerminalReconnect = () => {
    if (browserTerminalReconnectTimer) return;
    browserTerminalReconnectTimer = setTimeout(() => {
      browserTerminalReconnectTimer = null;
      refreshBrowserTerminalEventSource();
    }, browserTerminalBackoff.nextDelayMs());
  };

  /**
   * WKWebView enforces a small per-origin allowance for long-lived HTTP
   * requests. One EventSource per mounted terminal can therefore leave later
   * terminals with only their initial snapshot and no live output. Mobile keeps
   * every pane mounted intentionally, so this is easy to hit.
   *
   * Share one filtered EventSource for every terminal the same-origin browser
   * currently consumes. Changing the filter reconnects this one stream; opening
   * the replacement emits a scoped desync notice for terminals that were
   * already connected, causing their authoritative snapshot reconciliation to
   * cover the brief subscription gap.
   *
   * That desync is the reason an unchanged filter must be a no-op. A terminal
   * that reconnects to the same PTY unsubscribes and resubscribes the same
   * `terminal-output-<sessionId>` event, and rebuilding the socket for it would
   * make every *other* mounted terminal refetch its snapshot for nothing.
   */
  /**
   * Narrowing the filter (a channel moved to the WebSocket, or a terminal
   * closed) is not urgent, and doing it per channel would rebuild the shared
   * socket once per terminal — each rebuild costing every *other* mounted
   * terminal a snapshot reconcile. Widening it is urgent: that terminal has no
   * output until the socket carries it. So defer removals and coalesce them.
   */
  const refreshBrowserTerminalEventSource = (refresh: { defer?: boolean } = {}) => {
    if (refresh.defer) {
      if (browserTerminalRefreshQueued || browserTerminalNarrowTimer) return;
      browserTerminalNarrowTimer = setTimeout(() => {
        browserTerminalNarrowTimer = null;
        refreshBrowserTerminalEventSource();
      }, TERMINAL_FILTER_NARROW_DELAY_MS);
      browserTerminalNarrowTimer.unref?.();
      return;
    }
    if (browserTerminalRefreshQueued) return;
    browserTerminalRefreshQueued = true;
    if (browserTerminalNarrowTimer) {
      clearTimeout(browserTerminalNarrowTimer);
      browserTerminalNarrowTimer = null;
    }
    queueMicrotask(() => {
      browserTerminalRefreshQueued = false;

      const streams = [...terminalEventStreams.values()].filter(
        (stream) => !stream.closed && stream.fallbackActive,
      );
      const events = streams.map((stream) => stream.event).sort();

      // A live socket already carrying exactly this filter needs no work. The
      // null check matters: a fatal error clears the source but leaves the
      // event list, and that retry has to be able to rebuild.
      if (
        browserTerminalEventSource &&
        browserTerminalSubscribedEvents?.length === events.length &&
        browserTerminalSubscribedEvents.every((event, index) => event === events[index])
      ) {
        // The filter is unchanged but a stream object behind it may not be: a
        // terminal that unsubscribed and resubscribed the same event has a
        // fresh, unlatched stream riding an already-open socket, and no further
        // `onopen` is coming for it. Latch it as a first connect — it has not
        // missed anything it will not pick up in its own initial snapshot.
        browserTerminalSocketStreams = new Set(streams);
        if (browserTerminalEventSourceOpen) {
          for (const event of events) {
            const stream = terminalEventStreams.get(event);
            if (stream && !stream.closed && !stream.readyResolved) {
              announceTerminalStreamOpen(stream);
            }
          }
        }
        return;
      }

      // The socket is dead and a backed-off rebuild is pending. A refresh that
      // only narrows the filter, or repeats it (the terminal WebSocket asks
      // for fallback on every failed attempt), waits for that rebuild rather
      // than retrying early. A new terminal stream rebuilds now: it has no
      // output until the socket carries it.
      if (
        !browserTerminalEventSource &&
        browserTerminalReconnectTimer &&
        streams.length > 0 &&
        streams.every((stream) => browserTerminalSocketStreams.has(stream))
      ) {
        return;
      }

      clearBrowserTerminalReconnectTimer();
      if (browserTerminalEventSource) {
        // Replacing the socket is not a failure, but its uptime ends here: the
        // replacement's health counts only from its own open, so time spent
        // connecting it cannot pass as a healthy interval.
        browserTerminalEventSource.close();
        browserTerminalBackoff.disconnected();
      }
      browserTerminalEventSource = null;
      browserTerminalSubscribedEvents = null;
      browserTerminalSocketStreams = new Set();
      browserTerminalEventSourceOpen = false;
      if (events.length === 0) {
        // A later terminal starts a fresh connection, not the tail of an old
        // outage.
        browserTerminalBackoff.reset();
        return;
      }

      const source = new EventSource(apiUrl(eventStreamPath(events)), {
        withCredentials: true,
      });
      browserTerminalEventSource = source;
      browserTerminalSubscribedEvents = events;
      browserTerminalSocketStreams = new Set(streams);
      const subscribedEvents = new Set(events);
      source.onopen = () => {
        if (browserTerminalEventSource !== source) return;
        browserTerminalEventSourceOpen = true;
        browserTerminalBackoff.connected();
        for (const event of subscribedEvents) {
          const stream = terminalEventStreams.get(event);
          if (stream && !stream.closed && stream.fallbackActive) announceTerminalStreamOpen(stream);
        }
      };
      source.onmessage = (message) => {
        if (browserTerminalEventSource === source) {
          dispatchMessage(message.data, { terminalFallback: true });
        }
      };
      source.onerror = () => {
        if (browserTerminalEventSource !== source) return;
        console.warn("[RemoteGateway] Terminal event stream disconnected");
        // A recoverable error leaves the socket CONNECTING and the browser
        // retries it for us; reconnecting here would race that. A CLOSED socket
        // is dead and nothing else will rebuild it — and because every browser
        // terminal now shares this one socket, leaving it dead silently strands
        // every mounted terminal rather than one.
        if (source.readyState !== EVENT_SOURCE_CLOSED) return;
        browserTerminalEventSource = null;
        browserTerminalSubscribedEvents = null;
        browserTerminalEventSourceOpen = false;
        scheduleBrowserTerminalReconnect();
      };
    });
  };

  const startTerminalEventFallback = (stream: TerminalEventStream) => {
    if (stream.closed) return;
    stream.fallbackActive = true;
    // A pending backed-off retry owns the next attempt. Without this, every
    // failed terminal WebSocket attempt would restart the fetch at once and
    // the fallback would retry at the socket's pace instead of its own.
    if (stream.source || stream.controller || stream.reconnectTimer) return;
    if (bearerToken || baseUrl) {
      const controller = new AbortController();
      stream.controller = controller;
      void (async () => {
        try {
          const response = await fetch(apiUrl(eventStreamPath(stream.event)), {
            credentials,
            headers: requestHeaders(),
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`Gateway terminal event stream failed with HTTP ${response.status}`);
          }
          if (
            controller.signal.aborted ||
            stream.closed ||
            !stream.fallbackActive ||
            terminalEventStreams.get(stream.event) !== stream
          )
            return;
          stream.backoff.connected();
          announceTerminalStreamOpen(stream);
          await consumeFetchEventStream(response, controller, false, true);
        } catch (error) {
          if (!controller.signal.aborted) {
            console.warn("[RemoteGateway] Terminal event stream disconnected", error);
          }
        } finally {
          controller.abort();
          if (stream.controller === controller) stream.controller = null;
          if (
            !stream.closed &&
            // Stopping the fallback works by aborting this controller, which is
            // what runs this block. Without this check the stop schedules its
            // own replacement and the terminal ends up on both transports.
            stream.fallbackActive &&
            terminalEventStreams.get(stream.event) === stream &&
            listeners.has(stream.event) &&
            !stream.reconnectTimer
          ) {
            stream.reconnectTimer = setTimeout(() => {
              stream.reconnectTimer = null;
              startTerminalEventFallback(stream);
            }, stream.backoff.nextDelayMs());
          }
        }
      })();
      return;
    }
    refreshBrowserTerminalEventSource();
  };

  const stopTerminalEventFallback = (stream: TerminalEventStream) => {
    if (!stream.fallbackActive) return;
    stream.fallbackActive = false;
    stream.source?.close();
    stream.source = null;
    stream.controller?.abort();
    stream.controller = null;
    if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
    stream.reconnectTimer = null;
    if (!bearerToken && !baseUrl) refreshBrowserTerminalEventSource({ defer: true });
  };

  const stopTerminalEventFallbacks = () => {
    for (const stream of terminalEventStreams.values()) {
      // Disposal replaces the whole adapter, so these streams must never come
      // back. `closed` is the flag every reconnect path already honours.
      stream.closed = true;
      stopTerminalEventFallback(stream);
    }
    clearBrowserTerminalReconnectTimer();
    if (browserTerminalNarrowTimer) {
      clearTimeout(browserTerminalNarrowTimer);
      browserTerminalNarrowTimer = null;
    }
    browserTerminalEventSource?.close();
    browserTerminalEventSource = null;
    browserTerminalSubscribedEvents = null;
    browserTerminalSocketStreams = new Set();
    browserTerminalEventSourceOpen = false;
  };

  /**
   * The main stream just opened, so the gateway is reachable again. Retry
   * every terminal fallback that is waiting out its backoff now, instead of
   * leaving those terminals frozen for up to the cap after the rest of the UI
   * has recovered. Each tab's terminals follow that tab's own main stream, so
   * this adds no cross-tab lock-step. The ladders are kept: a retry that fails
   * again waits for the next rung.
   */
  const retryWaitingTerminalFallbacks = () => {
    if (browserTerminalReconnectTimer) {
      clearBrowserTerminalReconnectTimer();
      refreshBrowserTerminalEventSource();
    }
    for (const stream of terminalEventStreams.values()) {
      if (!stream.reconnectTimer) continue;
      clearTimeout(stream.reconnectTimer);
      stream.reconnectTimer = null;
      startTerminalEventFallback(stream);
    }
  };

  /**
   * The user came back to the tab, or the browser has a network path again.
   * Either way the backend may have been reachable for a while (a hidden tab's
   * timers are throttled), so retry the main stream and every terminal
   * fallback that is waiting out its backoff now. Nothing happens when nothing
   * is waiting, and the ladders are kept. Going offline changes nothing: a
   * local backend stays reachable without internet.
   */
  const retryWaitingStreams = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      ensureEventStream();
    }
    retryWaitingTerminalFallbacks();
  };
  const retryWaitingStreamsWhenVisible = () => {
    if (document.visibilityState === "visible") retryWaitingStreams();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", retryWaitingStreamsWhenVisible);
  }
  if (typeof window !== "undefined") window.addEventListener("online", retryWaitingStreams);
  const removeRetryWakeListeners = () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", retryWaitingStreamsWhenVisible);
    }
    if (typeof window !== "undefined") window.removeEventListener("online", retryWaitingStreams);
  };

  const ensureTerminalSocket = (): TerminalWebSocketClient => {
    if (terminalSocket) return terminalSocket;
    terminalSocket = new TerminalWebSocketClient({
      url: terminalWebSocketUrl(baseUrl),
      token: bearerToken,
      reconnectDelayMs: options.terminalWebSocketReconnectDelayMs,
      createSocket: options.terminalWebSocketFactory,
      onFallbackRequired: () => {
        for (const stream of terminalEventStreams.values()) {
          if (!stream.closed) startTerminalEventFallback(stream);
        }
      },
      onSocketReady: () => undefined,
      onChannelReady: (sessionId: string) => {
        const stream = terminalEventStreams.get(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`);
        if (!stream || stream.closed) return;
        stopTerminalEventFallback(stream);
        // Unlike an SSE reconnect, the WebSocket channel becomes usable only
        // after exact replay or an authoritative snapshot has completed.
        // Resolving readiness here must not ask the consumer for another
        // redundant snapshot.
        stream.connectedBefore = true;
        resolveTerminalStreamReady(stream);
      },
      onChannelUnavailable: (sessionId: string) => {
        const stream = terminalEventStreams.get(`${TERMINAL_OUTPUT_EVENT_PREFIX}${sessionId}`);
        if (stream && !stream.closed) startTerminalEventFallback(stream);
      },
    });
    return terminalSocket;
  };

  const startTerminalEventStream = (stream: TerminalEventStream) => {
    if (!websocketTerminalsEnabled) {
      startTerminalEventFallback(stream);
      return;
    }
    if (stream.closed || stream.socketUnlisten) return;
    // Keep compatibility output alive until this individual channel has
    // subscribed and completed any required snapshot. Socket-level `ready`
    // only authenticates the multiplexed connection.
    startTerminalEventFallback(stream);
    const sessionId = stream.event.slice(TERMINAL_OUTPUT_EVENT_PREFIX.length);
    const socket = ensureTerminalSocket();
    stream.socketUnlisten = socket.subscribe(sessionId, async (payload: TerminalSocketPayload) => {
      const callbacks = listeners.get(stream.event);
      if (!callbacks) return;
      await Promise.all(Array.from(callbacks, (callback) => callback(payload)));
    });
    void socket.ready(sessionId).catch(() => startTerminalEventFallback(stream));
  };

  const ensureTerminalEventStream = (event: string): TerminalEventStream => {
    const existing = terminalEventStreams.get(event);
    if (existing) return existing;
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const stream: TerminalEventStream = {
      event,
      source: null,
      controller: null,
      reconnectTimer: null,
      backoff: createStreamBackoff(),
      socketUnlisten: null,
      ready,
      resolveReady,
      readyResolved: false,
      connectedBefore: false,
      fallbackActive: false,
      closed: false,
    };
    terminalEventStreams.set(event, stream);
    startTerminalEventStream(stream);
    return stream;
  };

  const closeTerminalEventStream = (event: string) => {
    const stream = terminalEventStreams.get(event);
    if (!stream) return;
    stream.closed = true;
    stream.source?.close();
    stream.source = null;
    stream.controller?.abort();
    stream.controller = null;
    stream.socketUnlisten?.();
    stream.socketUnlisten = null;
    if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
    stream.reconnectTimer = null;
    resolveTerminalStreamReady(stream);
    terminalEventStreams.delete(event);
    // Unlike a channel moving to the WebSocket, closing a terminal is a
    // discrete user action rather than one of a burst, so it is not deferred:
    // the socket should stop carrying a terminal nobody is watching at once.
    if (stream.fallbackActive && !bearerToken && !baseUrl) refreshBrowserTerminalEventSource();
  };

  const readGatewayResponse = async <T>(response: Response, fallback: string): Promise<T> => {
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) {
      // The gateway only answers 401 from its authentication gate, so on an
      // agent-test session this is the deadline having passed rather than a
      // command-specific failure. Surface it before the throw: the idle path can
      // lapse with no pointer or key activity to notice it.
      if (response.status === 401) handleCredentialLapse();
      // The status travels as a property, not just inside the message. A
      // gateway 502/503 during environment bring-up has to reach the startup
      // retry classifier, and it looks for `error.status`.
      throw new GatewayHttpError(
        response.status,
        payload.error ?? `${fallback} with HTTP ${response.status}`,
      );
    }
    return payload;
  };

  const invokeImmediately = async <T = unknown>(
    command: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const response = await fetch(apiUrl(`${GATEWAY_PREFIX}/invoke`), {
      method: "POST",
      credentials,
      headers: requestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ command, args: args ?? {} }),
      signal,
    });
    const payload = await readGatewayResponse<{ result?: T }>(response, "Gateway command failed");
    return payload.result as T;
  };

  /**
   * The shared terminal input ordering contract. It also answers the
   * client-side resume commands, so they never reach the gateway.
   */
  const terminalInput = new TerminalInputSequencer({
    batchDelayMs: options.terminalInputBatchDelayMs,
    maxBatchBytes: options.terminalInputMaxBatchBytes,
    maxQueuedBytes: options.terminalInputMaxQueuedBytes,
    sendTimeoutMs: options.terminalInputSendTimeoutMs,
    sendInput: (request, signal) =>
      invokeImmediately<unknown>(
        request.command,
        { sessionId: request.sessionId, data: request.data },
        signal,
      ),
    runLifecycle: async (operation, signal) => {
      // A rejected socket resize must still reach the backend over HTTP; left
      // to propagate it would leave the PTY at stale dimensions.
      if (
        operation.kind === "resize" &&
        websocketTerminalsEnabled &&
        terminalSocket &&
        typeof operation.args.cols === "number" &&
        typeof operation.args.rows === "number" &&
        (await terminalSocket
          .resize(operation.sessionId, operation.args.cols, operation.args.rows)
          .catch(() => false))
      ) {
        return undefined;
      }
      return invokeImmediately<unknown>(operation.command, operation.args, signal);
    },
    pipelined: {
      active: () => websocketTerminalsEnabled && terminalSocket !== null,
      send: (request) => terminalSocket?.enqueueInput(request.sessionId, request.data) ?? null,
    },
  });

  const api = {
    async invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
      if (
        command === "terminal_snapshot_applied" &&
        typeof args?.sessionId === "string" &&
        Number.isSafeInteger(args.generation) &&
        Number.isSafeInteger(args.revision)
      ) {
        terminalSocket?.observeSnapshot(args.sessionId, {
          generation: args.generation as number,
          revision: args.revision as number,
        });
        return { acknowledged: true } as T;
      }
      if (command === "terminal_snapshot_failed" && typeof args?.sessionId === "string") {
        terminalSocket?.observeSnapshotFailure(args.sessionId);
        return { acknowledged: true } as T;
      }
      const ordered = terminalInput.invoke(command, args);
      if (ordered) return ordered as Promise<T>;
      return invokeImmediately<T>(command, args);
    },

    listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
      if (options.unavailableReason) return () => undefined;
      const callbackSet = listeners.get(event) ?? new Set<EventCallback<unknown>>();
      listeners.set(event, callbackSet);
      callbackSet.add(callback as EventCallback<unknown>);
      if (isTerminalOutputEvent(event)) {
        ensureTerminalEventStream(event);
      } else {
        ensureEventStream();
      }
      return () => {
        callbackSet.delete(callback as EventCallback<unknown>);
        if (callbackSet.size === 0) {
          listeners.delete(event);
          if (isTerminalOutputEvent(event)) closeTerminalEventStream(event);
        }
        closeEventStreamIfIdle();
      };
    },

    eventStreamReady(event: string): Promise<void> {
      if (!isTerminalOutputEvent(event)) return Promise.resolve();
      return ensureTerminalEventStream(event).ready;
    },

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
          url: `${baseUrl ?? getGatewayBaseUrl()}/`,
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
          headers: requestHeaders(),
        });
        return readGatewayResponse<GatewayTokenSettings>(
          response,
          "Gateway settings request failed",
        );
      },
      async setToken(token: string): Promise<GatewayTokenSettings> {
        const response = await fetch(apiUrl(`${GATEWAY_PREFIX}/gateway-settings`), {
          method: "PUT",
          credentials,
          headers: requestHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ token }),
        });
        const settings = await readGatewayResponse<GatewayTokenSettings>(
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
  browserGatewayDisposers.set(api, (reason = new Error("Browser gateway disposed")) => {
    disposeAgentTestActivity();
    removeRetryWakeListeners();
    terminalInput.dispose(reason);
    terminalSocket?.dispose();
    terminalSocket = null;
    stopTerminalEventFallbacks();
  });
  return api;
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
      browserGatewayDisposers.get(targetWindow.orkestrator)?.(
        new Error("Browser gateway replaced"),
      );
      // A replaced gateway may be another backend or other credentials.
      clearProtectedRichContent("gateway-replaced");
    }
    if (baseUrl && options.token) {
      configureDirectGatewayTransport(baseUrl, options.token.trim());
    }
    targetWindow.orkestratorGateway = { enabled: true, ...(baseUrl ? { baseUrl } : {}) };
    targetWindow.orkestrator = createBrowserGatewayApi({
      ...options,
      baseUrl,
      reportBootMetrics: !options.unavailableReason,
      // Only an isolated development profile can hold an agent-test session, and
      // its Vite instance is the only one given a profile id. Probing anywhere
      // else would spend a request per boot on a route that is always 404 —
      // including on every production gateway client.
      agentTestSessionActivity:
        options.agentTestSessionActivity ??
        (!options.unavailableReason && Boolean(import.meta.env.VITE_ORKESTRATOR_PROFILE?.trim())),
    });
  }
}

/**
 * Browser and iOS: a workspace realm (a frame showing another node's
 * workspace in the window's central region) is that node's client —
 * directly with the workspace's client grant, or through the command node's
 * relay with this page's own session — while its portal stays the command
 * node that served the page. The window itself is always the command node's.
 */
export function workspaceTargetGatewayOptions(
  targetWindow: GatewayWindow = window,
): BrowserGatewayOptions {
  if (targetWindow.orkestrator) return {};
  const workspace = readStoredWorkspace();
  if (!workspace) {
    if (targetWindow === window && window.top === window) clearLegacyWorkspaceTarget();
    return {};
  }
  targetWindow.orkestratorWorkspaceTarget = {
    nodeId: workspace.nodeId,
    nodeName: workspace.nodeName,
    path: workspace.path,
    ...(workspace.routeKind ? { routeKind: workspace.routeKind } : {}),
    ...(workspace.via ? { via: workspace.via } : {}),
  };
  targetWindow.orkestratorPortal = createBrowserGatewayApi({
    baseUrl: targetWindow.location.origin,
  });
  return workspace.token
    ? { baseUrl: workspace.baseUrl, token: workspace.token }
    : { baseUrl: workspace.baseUrl };
}

if (typeof window !== "undefined") {
  installBrowserGatewayApi(window, workspaceTargetGatewayOptions());
}
