import type { GatewayTokenSettings, WebClientStatus } from "@/types";
import { getGatewayBaseUrl, resolveGatewayApiUrl } from "@/lib/gateway-url";
import {
  configureDirectGatewayTransport,
  updateDirectGatewayToken,
} from "@/lib/native/gateway-auth-transport";
import { readClipboardImageDimensions } from "@/lib/clipboard-image";
import { GatewayHttpError } from "@/lib/native/gateway-http-error";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import {
  parseTerminalInputRequest,
  TerminalHttpInputBatcher,
} from "@/lib/native/terminal-input-batcher";

const GATEWAY_PREFIX = "/__orkestrator";
const EVENT_RECONNECT_DELAY_MS = 2_000;
const TERMINAL_OUTPUT_EVENT_PREFIX = "terminal-output-";
const GATEWAY_CONNECTED_EVENT = "gateway.connected";
const GATEWAY_RECONCILE_REQUIRED_EVENT = "gateway.reconcile-required";
const GATEWAY_CURSOR_EVENT = "gateway.cursor";
/**
 * `EventSource.CLOSED`, spelled as the spec's fixed numeric value rather than
 * read off the constructor: a same-origin browser may have replaced the global,
 * and the constant is what distinguishes a dead socket from one the browser is
 * still retrying for us.
 */
const EVENT_SOURCE_CLOSED = 2;

type EventCallback<T> = (payload: T) => void;
type GatewayWindow = Pick<Window, "location" | "orkestrator" | "orkestratorGateway">;

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
    return { ...await readClipboardImageDimensions(blob), blob };
  }

  return null;
}

export interface BrowserGatewayOptions {
  baseUrl?: string;
  token?: string;
  replaceExisting?: boolean;
  onTokenChanged?: (token: string) => void;
  eventReconnectDelayMs?: number;
  reportBootMetrics?: boolean;
  connections?: NonNullable<Window["orkestrator"]>["connections"];
}

function normalizedBaseUrl(value: string | undefined): string | undefined {
  return value?.trim().replace(/\/+$/, "") || undefined;
}

function parseEventBlock(block: string): { data: string | null; id: string | null } {
  const idLine = block
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("id:"));
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return {
    data: data || null,
    id: idLine ? idLine.slice(3).trimStart() : null,
  };
}

export function createBrowserGatewayApi(options: BrowserGatewayOptions = {}) {
  const listeners = new Map<string, Set<EventCallback<unknown>>>();
  let eventSource: EventSource | null = null;
  let streamAbortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let bootMetricsTimeout: ReturnType<typeof setTimeout> | null = null;
  let bootMetricsDeferredTimer: ReturnType<typeof setTimeout> | null = null;
  let bootMetricsLoadObserved = typeof document === "undefined" || document.readyState === "complete";
  let bootMetricsReported = false;
  let bootMetricsEventStreamConnectedMs: number | null = null;
  let mainEventCursor: string | null = null;
  let mainConnectionAnnounced = false;
  type TerminalEventStream = {
    event: string;
    /**
     * Direct/bearer clients use one fetch stream per terminal. Same-origin
     * browser clients leave this null and share `browserTerminalEventSource`.
     */
    source: EventSource | null;
    controller: AbortController | null;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    ready: Promise<void>;
    resolveReady: () => void;
    readyResolved: boolean;
    /**
     * Whether this stream has ever been open. A reconnect is not the same as a
     * first connect: the gateway has no replay buffer, so everything the PTY
     * emitted during the gap is gone from this socket and the consumer has to
     * be told to re-read the authoritative snapshot.
     */
    connectedBefore: boolean;
    closed: boolean;
  };
  const terminalEventStreams = new Map<string, TerminalEventStream>();
  let browserTerminalEventSource: EventSource | null = null;
  let browserTerminalRefreshQueued = false;
  /**
   * The sorted event list backing `browserTerminalEventSource`. Rebuilding the
   * socket costs every already-connected terminal a full snapshot reconcile, so
   * a refresh that resolves to the same filter must not touch the socket.
   */
  let browserTerminalSubscribedEvents: string[] | null = null;
  let browserTerminalReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether `browserTerminalEventSource` has actually opened. A stream that
   * attaches to an already-open shared socket gets no `onopen` of its own, so
   * this is what tells it to latch readiness instead of waiting forever.
   */
  let browserTerminalEventSourceOpen = false;
  let bearerToken = options.token?.trim() || undefined;
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const apiUrl = (pathname: string): string =>
    baseUrl ? `${baseUrl}${pathname}` : resolveGatewayApiUrl(pathname);

  const requestHeaders = (headers?: Record<string, string>): Record<string, string> | undefined => {
    const result = { ...headers };
    if (bearerToken) result.authorization = `Bearer ${bearerToken}`;
    return Object.keys(result).length > 0 ? result : undefined;
  };

  const credentials = bearerToken || baseUrl ? "omit" as const : "same-origin" as const;

  /**
   * Receive every authoritative state event, but only terminal byte streams
   * this browser currently consumes. Terminal events are namespaced by session,
   * so a remote tab looking at one environment no longer downloads output from
   * every terminal in every other environment.
   */
  const eventStreamPath = (
    terminalEvents?: string | readonly string[],
    since?: string | null,
  ) => {
    const params = new URLSearchParams({
      excludeEvents: TERMINAL_OUTPUT_EVENT_PREFIX,
    });
    if (terminalEvents) {
      const included = typeof terminalEvents === "string"
        ? terminalEvents
        : terminalEvents.join(",");
      if (included) params.set("includeEvents", included);
    }
    if (!terminalEvents && since) params.set("since", since);
    return `${GATEWAY_PREFIX}/events?${params.toString()}`;
  };

  const isTerminalOutputEvent = (event: string): boolean =>
    event.startsWith(TERMINAL_OUTPUT_EVENT_PREFIX);

  const hasMainEventListeners = (): boolean =>
    [...listeners.keys()].some((event) => !isTerminalOutputEvent(event));

  const dispatchMessage = (
    data: string,
    options: { mainStream?: boolean; lastEventId?: string | null } = {},
  ) => {
    let parsed: { event?: unknown; payload?: unknown };
    try {
      parsed = JSON.parse(data) as { event?: unknown; payload?: unknown };
    } catch {
      return;
    }
    if (typeof parsed.event !== "string") return;
    if (options.mainStream && options.lastEventId) {
      mainEventCursor = options.lastEventId;
    }
    // Replay control frames are meaningful only on the authoritative stream, and
    // only the transport may act on them. Swallow them everywhere so a frame
    // arriving on a terminal socket can neither reach ordinary listeners nor
    // latch main-stream connection state it has no authority over.
    if (
      parsed.event === GATEWAY_CONNECTED_EVENT
      || parsed.event === GATEWAY_RECONCILE_REQUIRED_EVENT
      || parsed.event === GATEWAY_CURSOR_EVENT
    ) {
      if (!options.mainStream) return;
      if (parsed.event === GATEWAY_CURSOR_EVENT) return;
      if (parsed.event === GATEWAY_RECONCILE_REQUIRED_EVENT) {
        mainConnectionAnnounced = true;
        announceEventStreamConnected();
        return;
      }
      const status = parsed.payload
        && typeof parsed.payload === "object"
        && "status" in parsed.payload
        ? (parsed.payload as { status?: unknown }).status
        : null;
      if (status === "fresh" && !mainConnectionAnnounced) {
        mainConnectionAnnounced = true;
        announceEventStreamConnected();
      }
      return;
    }
    // Transport-level events are synthesized locally and share this listener
    // map, so a server frame must never be able to impersonate one.
    if (parsed.event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) return;
    const callbacks = listeners.get(parsed.event);
    if (!callbacks) return;
    for (const callback of callbacks) callback(parsed.payload);
  };

  const announceEventStreamConnected = () => {
    const callbacks = listeners.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT);
    if (!callbacks) return;
    for (const callback of callbacks) callback(undefined);
  };

  const clearBootMetricsTimers = () => {
    if (bootMetricsTimeout) clearTimeout(bootMetricsTimeout);
    bootMetricsTimeout = null;
    if (bootMetricsDeferredTimer) clearTimeout(bootMetricsDeferredTimer);
    bootMetricsDeferredTimer = null;
  };

  const sendBootMetrics = async () => {
    if (bootMetricsReported || !options.reportBootMetrics || typeof performance === "undefined") return;
    bootMetricsReported = true;
    clearBootMetricsTimers();

    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const paintEntries = performance.getEntriesByType("paint");
    const firstPaint = paintEntries.find((entry) => entry.name === "first-paint");
    const firstContentfulPaint = paintEntries.find((entry) => entry.name === "first-contentful-paint");
    const payload = {
      platform: window.__orkestratorClientPlatform
        ?? ((window as Window & { webkit?: unknown }).webkit ? "ios-wkwebview" : "desktop-browser"),
      navigationType: navigation?.type ?? "unknown",
      nextHopProtocol: navigation?.nextHopProtocol ?? null,
      transferSize: navigation?.transferSize ?? null,
      encodedBodySize: navigation?.encodedBodySize ?? null,
      decodedBodySize: navigation?.decodedBodySize ?? null,
      resourceCount: resources.length,
      resourceTransferSize: resources.reduce((total, entry) => total + (entry.transferSize ?? 0), 0),
      resourceEncodedBodySize: resources.reduce((total, entry) => total + (entry.encodedBodySize ?? 0), 0),
      resourceDecodedBodySize: resources.reduce((total, entry) => total + (entry.decodedBodySize ?? 0), 0),
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
      window.addEventListener("load", () => {
        bootMetricsLoadObserved = true;
        maybeSendBootMetrics();
      }, { once: true });
    }
    bootMetricsTimeout = setTimeout(() => {
      bootMetricsTimeout = null;
      if (bootMetricsReported) return;
      void sendBootMetrics();
    }, 15_000);
  };

  const consumeFetchEventStream = async (
    response: Response,
    controller: AbortController,
    mainStream = false,
  ): Promise<void> => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const frame = parseEventBlock(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (frame.data) {
          dispatchMessage(frame.data, {
            mainStream,
            lastEventId: frame.id,
          });
        }
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) break;
    }
  };

  const scheduleReconnect = () => {
    if (!hasMainEventListeners() || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureEventStream();
    }, options.eventReconnectDelayMs ?? EVENT_RECONNECT_DELAY_MS);
  };

  const connectFetchEventStream = () => {
    if (streamAbortController || !hasMainEventListeners()) return;
    startBootMetricsReporter();
    const controller = new AbortController();
    streamAbortController = controller;

    void (async () => {
      try {
        const response = await fetch(apiUrl(eventStreamPath(undefined, mainEventCursor)), {
          credentials,
          headers: requestHeaders(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Gateway event stream failed with HTTP ${response.status}`);
        }
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
        if (streamAbortController === controller) streamAbortController = null;
        if (!controller.signal.aborted) scheduleReconnect();
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

    const source = new EventSource(apiUrl(eventStreamPath(undefined, mainEventCursor)), {
      withCredentials: true,
    });
    eventSource = source;
    source.onopen = () => {
      if (bootMetricsEventStreamConnectedMs === null && typeof performance !== "undefined") {
        bootMetricsEventStreamConnectedMs = performance.now();
        maybeSendBootMetrics();
      }
    };
    source.onmessage = (message) => {
      if (eventSource !== source) return;
      dispatchMessage(message.data, {
        mainStream: true,
        lastEventId: message.lastEventId,
      });
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
    dispatchMessage(
      JSON.stringify({ event: stream.event, payload: { desynced: true } }),
    );
  };

  const clearBrowserTerminalReconnectTimer = () => {
    if (!browserTerminalReconnectTimer) return;
    clearTimeout(browserTerminalReconnectTimer);
    browserTerminalReconnectTimer = null;
  };

  const scheduleBrowserTerminalReconnect = () => {
    if (browserTerminalReconnectTimer) return;
    browserTerminalReconnectTimer = setTimeout(() => {
      browserTerminalReconnectTimer = null;
      refreshBrowserTerminalEventSource();
    }, options.eventReconnectDelayMs ?? EVENT_RECONNECT_DELAY_MS);
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
  const refreshBrowserTerminalEventSource = () => {
    if (browserTerminalRefreshQueued) return;
    browserTerminalRefreshQueued = true;
    queueMicrotask(() => {
      browserTerminalRefreshQueued = false;

      const events = [...terminalEventStreams.values()]
        .filter((stream) => !stream.closed)
        .map((stream) => stream.event)
        .sort();

      // A live socket already carrying exactly this filter needs no work. The
      // null check matters: a fatal error clears the source but leaves the
      // event list, and that retry has to be able to rebuild.
      if (
        browserTerminalEventSource
        && browserTerminalSubscribedEvents?.length === events.length
        && browserTerminalSubscribedEvents.every((event, index) => event === events[index])
      ) {
        // The filter is unchanged but a stream object behind it may not be: a
        // terminal that unsubscribed and resubscribed the same event has a
        // fresh, unlatched stream riding an already-open socket, and no further
        // `onopen` is coming for it. Latch it as a first connect — it has not
        // missed anything it will not pick up in its own initial snapshot.
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

      clearBrowserTerminalReconnectTimer();
      browserTerminalEventSource?.close();
      browserTerminalEventSource = null;
      browserTerminalSubscribedEvents = null;
      browserTerminalEventSourceOpen = false;
      if (events.length === 0) return;

      const source = new EventSource(apiUrl(eventStreamPath(events)), {
        withCredentials: true,
      });
      browserTerminalEventSource = source;
      browserTerminalSubscribedEvents = events;
      const subscribedEvents = new Set(events);
      source.onopen = () => {
        if (browserTerminalEventSource !== source) return;
        browserTerminalEventSourceOpen = true;
        for (const event of subscribedEvents) {
          const stream = terminalEventStreams.get(event);
          if (stream && !stream.closed) announceTerminalStreamOpen(stream);
        }
      };
      source.onmessage = (message) => {
        if (browserTerminalEventSource === source) dispatchMessage(message.data);
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

  const startTerminalEventStream = (stream: TerminalEventStream) => {
    if (stream.closed || stream.source || stream.controller) return;
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
          announceTerminalStreamOpen(stream);
          await consumeFetchEventStream(response, controller);
        } catch (error) {
          if (!controller.signal.aborted) {
            console.warn("[RemoteGateway] Terminal event stream disconnected", error);
          }
        } finally {
          if (stream.controller === controller) stream.controller = null;
          if (
            !stream.closed
            && terminalEventStreams.get(stream.event) === stream
            && listeners.has(stream.event)
            && !stream.reconnectTimer
          ) {
            stream.reconnectTimer = setTimeout(() => {
              stream.reconnectTimer = null;
              startTerminalEventStream(stream);
            }, options.eventReconnectDelayMs ?? EVENT_RECONNECT_DELAY_MS);
          }
        }
      })();
      return;
    }
    refreshBrowserTerminalEventSource();
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
      ready,
      resolveReady,
      readyResolved: false,
      connectedBefore: false,
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
    if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
    stream.reconnectTimer = null;
    resolveTerminalStreamReady(stream);
    terminalEventStreams.delete(event);
    if (!bearerToken && !baseUrl) refreshBrowserTerminalEventSource();
  };

  const readGatewayResponse = async <T>(response: Response, fallback: string): Promise<T> => {
    const payload = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) {
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
  ): Promise<T> => {
    const response = await fetch(apiUrl(`${GATEWAY_PREFIX}/invoke`), {
      method: "POST",
      credentials,
      headers: requestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ command, args: args ?? {} }),
    });
    const payload = await readGatewayResponse<{ result?: T }>(response, "Gateway command failed");
    return payload.result as T;
  };

  const terminalInputBatcher = new TerminalHttpInputBatcher(async (request) => {
    await invokeImmediately(request.command, {
      sessionId: request.sessionId,
      data: request.data,
    });
  });

  return {
    async invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
      const terminalInput = parseTerminalInputRequest(command, args);
      if (terminalInput) {
        await terminalInputBatcher.enqueue(terminalInput);
        return undefined as T;
      }
      return invokeImmediately<T>(command, args);
    },

    listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
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
        return navigator.clipboard?.writeText(text) ?? Promise.resolve();
      },
      readImage(): Promise<{ width: number; height: number; blob: Blob } | null> {
        return readBrowserClipboardImage();
      },
      writeImage(_dataUrl: string): Promise<void> {
        return Promise.resolve();
      },
    },

    dialog: {
      open(): Promise<string | string[] | null> {
        return Promise.resolve(null);
      },
    },

    ...(options.connections ? { connections: options.connections } : {}),

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
        return Promise.reject(new Error("Web client controls are only available in the desktop app"));
      },
      resetServe(): Promise<WebClientStatus> {
        return Promise.reject(new Error("Tailscale Serve reset is only available for the local desktop app"));
      },
      async getTokenSettings(): Promise<GatewayTokenSettings> {
        const response = await fetch(apiUrl(`${GATEWAY_PREFIX}/gateway-settings`), {
          credentials,
          headers: requestHeaders(),
        });
        return readGatewayResponse<GatewayTokenSettings>(response, "Gateway settings request failed");
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
        bearerToken = settings.token;
        updateDirectGatewayToken(settings.token);
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
}

export function installBrowserGatewayApi(
  targetWindow: GatewayWindow = window,
  options: BrowserGatewayOptions = {},
): void {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  if (
    (!targetWindow.orkestrator || options.replaceExisting)
    && targetWindow.location.protocol.startsWith("http")
  ) {
    if (baseUrl && options.token) {
      configureDirectGatewayTransport(baseUrl, options.token.trim());
    }
    targetWindow.orkestratorGateway = { enabled: true, ...(baseUrl ? { baseUrl } : {}) };
    targetWindow.orkestrator = createBrowserGatewayApi({ ...options, baseUrl, reportBootMetrics: true });
  }
}

if (typeof window !== "undefined") {
  installBrowserGatewayApi();
}
