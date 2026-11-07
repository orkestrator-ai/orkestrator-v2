/**
 * One node's transport (docs/reports/unified-federation.md §6.2 step 1):
 * commands, the authoritative main event stream, filtered terminal and relayed
 * streams, the terminal WebSocket, the watchdog, reconnect backoff and the
 * terminal input sequencer, all in one closure per backend.
 *
 * Nothing here is global. The transport reads no gateway URL from the window,
 * no opt-in from `localStorage`, and attaches no `document` or `window`
 * listener itself: the page tells it when it becomes visible, comes back
 * online or goes away (`lifecycle`). Several transports therefore coexist in
 * one page, each with its own streams, cursors, terminals, backoff and
 * credential, and disposing one leaves the others running.
 *
 * The window-only parts (clipboard, `webClient`, boot metrics, the cookie
 * session) live in `window-shell.ts`, and `createBrowserGatewayApi` in
 * `web-gateway.ts` composes the two into today's `window.orkestrator`.
 */
import { GatewayHttpError } from "@/lib/native/gateway-http-error";
import {
  BACKEND_HELLO_PATH,
  parseBackendHello,
  type BackendHello,
} from "@orkestrator/protocol/backend-profile";
import {
  GATEWAY_EVENT_CURSOR_PARAM,
  GATEWAY_KEEPALIVE_EVENT,
  GATEWAY_KEEPALIVE_EVENTS_PARAM,
  GATEWAY_RELAYED_EVENTS_PARAM,
  GATEWAY_STREAM_CONNECT_TIMEOUT_MS,
  GATEWAY_STREAM_SILENCE_LIMIT_MS,
  GatewayEventStreamState,
  isGatewayTransportEvent,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  parseGatewayEventData,
  readSseStream,
  type GatewayRelayedEventsMode,
} from "@orkestrator/protocol/gateway-event-stream";
import { isPerNodeRelayedEvent } from "@orkestrator/protocol/node-events";
import { TerminalInputSequencer } from "@orkestrator/protocol/terminal-input-sequencer";
import {
  TerminalWebSocketClient,
  terminalWebSocketUrl,
  type TerminalSocketPayload,
} from "@/lib/native/terminal-websocket-client";
import {
  RelayedEventStream,
  type RelayedEventConnection,
  type RelayedEventConnectionHandlers,
} from "@orkestrator/protocol/relayed-event-stream";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.gateway");

export const GATEWAY_PREFIX = "/__orkestrator";
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
export const TERMINAL_OUTPUT_EVENT_PREFIX = "terminal-output-";
/**
 * `EventSource.CLOSED`, spelled as the spec's fixed numeric value rather than
 * read off the constructor: a same-origin browser may have replaced the global.
 * The gateway answered with an HTTP error, as opposed to a network failure,
 * which leaves the socket CONNECTING.
 */
const EVENT_SOURCE_CLOSED = 2;
/** How long a shared-stream filter narrowing waits for its siblings. */
const TERMINAL_FILTER_NARROW_DELAY_MS = 50;
/** Chromium refuses a `keepalive` request body beyond 64 KiB. */
const KEEPALIVE_MAX_BODY_BYTES = 64 * 1024;
/** A hello read gives up after this long; the next connection reads again. */
const HELLO_TIMEOUT_MS = 10_000;
/** A larger answer is not a hello (the same bound as the desktop's check). */
const MAX_HELLO_BYTES = 64 * 1024;
/** The invoke envelope's contract fields, the only envelope keys a body takes. */
const ENVELOPE_FIELDS = ["domain", "version", "critical"] as const;

/** The invoke envelope's contract fields (`ContractEnvelopeFields` in the protocol). */
export interface NodeTransportEnvelope {
  readonly domain?: unknown;
  readonly version?: unknown;
  readonly critical?: unknown;
}

/** Options of one command call. */
export interface NodeTransportInvokeOptions {
  /**
   * The invoke envelope's contract fields (plan items 1003 and 2011), sent
   * next to `command` and `args`. Only `domain`, `version` and `critical` are
   * read; the arguments always come from the call.
   */
  envelope?: NodeTransportEnvelope;
}

function envelopeBodyFields(envelope: NodeTransportEnvelope | undefined): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (!envelope) return fields;
  for (const key of ENVELOPE_FIELDS) {
    if (Object.hasOwn(envelope, key) && envelope[key] !== undefined) fields[key] = envelope[key];
  }
  return fields;
}

export type EventCallback<T> = (payload: T) => unknown;
/**
 * Whether the authoritative main event stream is up.
 *
 * - `idle`: nothing is listening, so no stream is open (or has failed).
 * - `connecting`: the first connection is being opened.
 * - `connected`: the stream opened (`onopen`, or the OK response).
 * - `disconnected`: the stream failed or dropped and is waiting out its
 *   backoff, or the browser is retrying it. It stays `disconnected` through
 *   reconnect attempts until one opens.
 */
export type GatewayEventStreamConnectionState =
  "idle" | "connecting" | "connected" | "disconnected";

/**
 * What a `/status` answer says about this client's credential. Only a 401 is
 * a refusal. Anything else is no verdict: a 404 comes from a command node
 * whose relay predates `/status` (or a missing route), never from a lapse.
 */
export function credentialProbeVerdict(status: number): "accepted" | "refused" | "unavailable" {
  if (status === 401) return "refused";
  return status >= 200 && status < 300 ? "accepted" : "unavailable";
}

/**
 * Hooks the window shell's boot metrics hang on the main stream. They only
 * observe; the stream behaves the same with or without them.
 */
export interface TransportMetricsHooks {
  /** A main stream connection is about to be opened (first or retry). */
  mainStreamStarting(): void;
  /** A main stream connection opened. Called on every open, not just the first. */
  mainStreamOpened(): void;
  /** Nothing listens on the main stream any more, or the transport was disposed. */
  mainStreamIdle(): void;
}

/**
 * Page lifecycle signals, injected by the window that owns the transport.
 * Each subscription returns its own stop, which the transport calls on dispose.
 */
export interface NodeTransportLifecycle {
  /** The page became visible (`true`) or hidden (`false`). */
  onVisibility(listener: (visible: boolean) => void): () => void;
  /** The browser has a network path again. */
  onOnline(listener: () => void): () => void;
  /** The page is going away (`true`, `pagehide`) or came back (`false`, `pageshow`). */
  onPageHide(listener: (hiding: boolean) => void): () => void;
}

/** What a main stream opener may ask of the transport whose stream it opens. */
export interface MainStreamControl {
  /**
   * Abandon the open main stream (or its pending retry) and open it again at
   * once from its cursor, so the opener can carry it another way. Counts no
   * failure; a transport with no main stream ignores it.
   */
  reconnect(): void;
}

/**
 * Opens the main stream's request in place of `fetch`, with the same URL and
 * init (plan item 5005: several relayed nodes' main streams on one shared
 * request). It answers a `Response` whose body is this node's SSE stream, or
 * throws as `fetch` would; the transport treats the answer exactly as its own.
 */
export type MainStreamOpener = (
  url: string,
  init: RequestInit,
  control: MainStreamControl,
) => Promise<Response>;

interface NodeTransportSettings {
  /** Bearer credential (a gateway token or a client grant). */
  credential?: string;
  /** Every command throws this, and `listen` opens nothing. */
  unavailableReason?: string;
  /**
   * The gateway refused this transport's credential: a 401 on a stream, a
   * command or the `/status` probe. No retry will help; the owner decides
   * what to do (a cookie-session window reloads to its login page).
   */
  onCredentialRejected?: () => void;
  metrics?: TransportMetricsHooks;
  /** Without one the transport retries only on its own backoff. */
  lifecycle?: NodeTransportLifecycle;
  /**
   * Opens the fetch-read main stream; defaults to `fetch`. The `EventSource`
   * main stream of the page's own gateway never uses it.
   */
  openMainStream?: MainStreamOpener;
  /**
   * Ask `/status` whether the credential still holds when the main fetch
   * stream fails without saying so itself (an HTTP error other than 401, or a
   * stream that ended), so a revoked grant is reported as refused rather than
   * as an outage retried forever. Defaults to on; the `EventSource` main
   * stream always probes, because it cannot read the status that closed it.
   */
  probeCredentialOnStreamFailure?: boolean;
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
  /** Test/embedding overrides; production uses the bounded defaults. */
  terminalInputBatchDelayMs?: number;
  terminalInputMaxBatchBytes?: number;
  terminalInputMaxQueuedBytes?: number;
  terminalInputSendTimeoutMs?: number;
  /** Defaults to `http-sse`; WebSocket failures fall back to HTTP/SSE. */
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
   * Needs `lifecycle` to learn about `pagehide`.
   */
  keepaliveOnPageHide?: boolean;
}

/**
 * Where the node answers. A node transport always names its base URL: a node
 * origin, or a relay base (`<command origin>/__orkestrator/nodes/<id>`). The
 * one exception is the gateway that served the page itself, reached with
 * same-origin requests (`baseUrl: null`); its owner then says how a path
 * resolves, so the transport still reads no global.
 */
type NodeTransportEndpoint =
  | { baseUrl: string; resolvePageUrl?: undefined }
  | { baseUrl: null; resolvePageUrl: (pathname: string) => string };

export type NodeTransportOptions = NodeTransportSettings & NodeTransportEndpoint;

export interface NodeTransport {
  /**
   * Runs a command. `options.envelope` adds the contract fields to the body;
   * terminal input and lifecycle commands, which the input sequencer orders,
   * are untyped and go without one.
   */
  invoke<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
    options?: NodeTransportInvokeOptions,
  ): Promise<T>;
  /**
   * The node's hello (`/__orkestrator/hello` on this transport's base, so a
   * relayed node answers its own): the parsed hello, or `null` when the node
   * answered without one (a backend that predates it: a 404, or a page that is
   * not a hello). Throws when it cannot tell (unreachable, timed out, a
   * refused credential, a server error), so a transient failure is never read
   * as a pre-contract node.
   */
  hello(): Promise<BackendHello | null>;
  listen<T = unknown>(event: string, callback: EventCallback<T>): () => void;
  eventStreamReady(event: string): Promise<void>;
  /**
   * Connection state of the authoritative main stream. Observing it never
   * opens or holds a stream: it reports what the event listeners caused.
   */
  readonly eventStreamConnection: {
    state(): GatewayEventStreamConnectionState;
    subscribe(listener: (state: GatewayEventStreamConnectionState) => void): () => void;
  };
  /** The normalized base URL, or `null` for the page's own gateway. */
  readonly baseUrl: string | null;
  /** `omit` for a bearer or cross-origin transport, else `same-origin`. */
  readonly requestCredentials: RequestCredentials;
  /** The URL of a gateway path on this node. Throws `unavailableReason`. */
  url(pathname: string): string;
  /** Request headers with this transport's bearer added, or `undefined` if empty. */
  requestHeaders(headers?: Record<string, string>): Record<string, string> | undefined;
  /** Reads a gateway JSON answer, throwing `GatewayHttpError` for a non-OK one. */
  readResponse<T>(response: Response, fallback: string): Promise<T>;
  /** The current bearer credential, if any. */
  credential(): string | undefined;
  /**
   * Swaps the bearer, without a document reload: later requests carry the new
   * one, and every open or waiting stream (main, shared terminal, relayed,
   * terminal WebSocket) is reopened with it now, resuming from its cursor. A
   * refused credential stops counting as refused. The same credential again
   * changes nothing. Used when a grant lapses and the node is reopened.
   */
  setCredential(token: string): void;
  /** Closes every stream, timer and lifecycle subscription. Idempotent. */
  dispose(reason?: unknown): void;
}

function normalizedBaseUrl(value: string | undefined): string | undefined {
  return value?.trim().replace(/\/+$/, "") || undefined;
}

export function createNodeTransport(options: NodeTransportOptions): NodeTransport {
  const listeners = new Map<string, Set<EventCallback<unknown>>>();
  let disposed = false;
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
  let mainStreamConnectionState: GatewayEventStreamConnectionState = "idle";
  const mainStreamConnectionListeners = new Set<
    (state: GatewayEventStreamConnectionState) => void
  >();
  const setMainStreamConnectionState = (next: GatewayEventStreamConnectionState) => {
    if (mainStreamConnectionState === next) return;
    mainStreamConnectionState = next;
    for (const listener of Array.from(mainStreamConnectionListeners)) {
      try {
        listener(next);
      } catch (error) {
        log.error("connection-listener.failed", { error: formatLogError(error) });
      }
    }
  };
  const streamSilenceLimitMs = options.eventStreamSilenceLimitMs ?? GATEWAY_STREAM_SILENCE_LIMIT_MS;
  const streamConnectTimeoutMs =
    options.eventStreamConnectTimeoutMs ?? GATEWAY_STREAM_CONNECT_TIMEOUT_MS;
  const livenessNow = options.eventReconnectNow ?? Date.now;
  const metrics = options.metrics;
  const probeCredentialOnStreamFailure = options.probeCredentialOnStreamFailure ?? true;
  /** When the main stream counts as lost unless it shows some sign of life first. */
  let mainStreamDeadline: number | null = null;
  let mainStreamWatchdog: ReturnType<typeof setInterval> | null = null;
  /** Until the stream opens again, a refusal means this and not a new outage. */
  let mainStreamCredentialRefused = false;
  /** A silent drop happened, so a terminal attempt still unanswered is on the dead link. */
  let silentDropSinceMainOpen = false;
  const watchMainStream = (withinMs: number) => {
    mainStreamDeadline = livenessNow() + withinMs;
    if (mainStreamWatchdog) return;
    mainStreamWatchdog = setInterval(
      () => {
        if (mainStreamDeadline !== null && livenessNow() >= mainStreamDeadline) {
          dropSilentStreams();
        }
      },
      Math.min(streamSilenceLimitMs, streamConnectTimeoutMs) / 4,
    );
    mainStreamWatchdog.unref?.();
  };
  const stopWatchingMainStream = () => {
    mainStreamDeadline = null;
    if (mainStreamWatchdog) clearInterval(mainStreamWatchdog);
    mainStreamWatchdog = null;
  };
  /** Cursor and recovery state for the authoritative stream, across reconnects. */
  const mainStream = new GatewayEventStreamState();
  type TerminalEventStream = {
    event: string;
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
  /**
   * The one connection carrying every terminal this client consumes over SSE:
   * an `EventSource`, or a `fetch` reader for a client that has to send a
   * bearer token. Either way `close()` is a deliberate stop and reports no
   * error.
   */
  type SharedTerminalConnection = { close(): void };
  const terminalEventStreams = new Map<string, TerminalEventStream>();
  let sharedTerminalConnection: SharedTerminalConnection | null = null;
  let sharedTerminalRefreshQueued = false;
  let sharedTerminalNarrowTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The sorted event list backing `sharedTerminalConnection`. Rebuilding the
   * socket costs every already-connected terminal a full snapshot reconcile, so
   * a refresh that resolves to the same filter must not touch the socket.
   */
  let sharedTerminalSubscribedEvents: string[] | null = null;
  /**
   * The terminal streams the shared socket was opened for, kept after a fatal
   * error. A refresh while that socket is dead rebuilds early only for a
   * stream it did not carry: a newly mounted terminal, or one the user
   * reconnected (re-listening creates a new stream object).
   */
  let sharedTerminalSocketStreams: ReadonlySet<TerminalEventStream> = new Set();
  let sharedTerminalReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** One ladder for the one shared socket, however many terminals it carries. */
  const sharedTerminalBackoff = createStreamBackoff();
  /**
   * Whether `sharedTerminalConnection` has actually opened. A stream that
   * attaches to an already-open shared socket gets no open of its own, so
   * this is what tells it to latch readiness instead of waiting forever.
   */
  let sharedTerminalConnectionOpen = false;
  let bearerToken = options.credential?.trim() || undefined;
  const baseUrl = options.baseUrl === null ? undefined : normalizedBaseUrl(options.baseUrl);
  if (options.baseUrl !== null && !baseUrl) {
    throw new TypeError("A node transport needs a base URL");
  }
  const resolvePageUrl = options.resolvePageUrl;
  /**
   * A same-origin page (or one whose credential is added below it) reads a
   * filtered stream with an `EventSource`; a bearer or cross-origin client reads
   * the same stream with `fetch`.
   */
  const filteredStreamsUseEventSource = () =>
    !bearerToken && (!baseUrl || options.terminalEventSource === true);
  const apiUrl = (pathname: string): string => {
    if (options.unavailableReason) throw new Error(options.unavailableReason);
    return baseUrl ? `${baseUrl}${pathname}` : resolvePageUrl!(pathname);
  };

  const requestHeaders = (headers?: Record<string, string>): Record<string, string> | undefined => {
    const result = { ...headers };
    if (bearerToken) result.authorization = `Bearer ${bearerToken}`;
    return Object.keys(result).length > 0 ? result : undefined;
  };

  // The page's own location, not a gateway setting: a base on another origin
  // must not be sent this page's cookies.
  const crossOrigin =
    baseUrl && new URL(baseUrl, window.location.href).origin !== window.location.origin;
  const credentials = bearerToken || crossOrigin ? ("omit" as const) : ("same-origin" as const);
  const websocketTerminalsEnabled = options.terminalTransport === "websocket";
  let terminalSocket: TerminalWebSocketClient | null = null;

  const credentialRejected = () => options.onCredentialRejected?.();

  /**
   * The gateway refused the stream's credential, so the link is up and no retry
   * will help. That is no outage: stop calling it one, so reads run again and
   * show the failure (see `transport-connectivity.ts`) instead of a banner
   * promising a reconnect, and a cookie-session tab goes to its login page.
   */
  const mainStreamCredentialRejected = () => {
    mainStreamCredentialRefused = true;
    credentialRejected();
    setMainStreamConnectionState("connecting");
  };

  let mainStreamCredentialProbe: AbortController | null = null;
  const invalidateMainStreamCredentialProbe = () => {
    mainStreamCredentialProbe?.abort();
    mainStreamCredentialProbe = null;
  };

  /**
   * An `EventSource` cannot read the status that closed it, and a fetch stream
   * that failed with anything but a 401 has not said either, so ask the same
   * gate. `/status` answers only that, and never carries the token back.
   */
  const checkMainStreamCredential = () => {
    invalidateMainStreamCredentialProbe();
    const controller = new AbortController();
    mainStreamCredentialProbe = controller;
    void fetch(apiUrl(`${GATEWAY_PREFIX}/status`), {
      credentials,
      headers: requestHeaders(),
      signal: controller.signal,
    })
      .then((response) => {
        if (mainStreamCredentialProbe !== controller || controller.signal.aborted) return;
        if (credentialProbeVerdict(response.status) === "refused") mainStreamCredentialRejected();
      })
      .catch(() => undefined)
      .finally(() => {
        if (mainStreamCredentialProbe === controller) mainStreamCredentialProbe = null;
      });
  };

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
    // Relayed node events have their own stream. A gateway that predates this
    // ignores the parameter and sends them here under the one old name, which is
    // why `lib/federation/node-events.ts` keeps listening for that name.
    if (!terminalEvents) {
      params.set(GATEWAY_RELAYED_EVENTS_PARAM, "per-node" satisfies GatewayRelayedEventsMode);
    }
    // Only an `EventSource` needs it, and only the main stream is watched.
    if (!terminalEvents && !bearerToken && !baseUrl) {
      params.set(GATEWAY_KEEPALIVE_EVENTS_PARAM, "1");
    }
    return `${GATEWAY_PREFIX}/events?${params.toString()}`;
  };

  const isTerminalOutputEvent = (event: string): boolean =>
    event.startsWith(TERMINAL_OUTPUT_EVENT_PREFIX);

  const hasMainEventListeners = (): boolean =>
    [...listeners.keys()].some(
      (event) => !isTerminalOutputEvent(event) && !isPerNodeRelayedEvent(event),
    );

  const deliver = (event: string, payload: unknown) => {
    const callbacks = listeners.get(event);
    if (!callbacks) return;
    for (const callback of callbacks) {
      try {
        callback(payload);
      } catch (error) {
        log.error("event-listener.failed", { eventName: event, error: formatLogError(error) });
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
        log.error("stream-listener.failed", { error: formatLogError(error) });
      }
    }
  };

  const consumeMainFetchEventStream = (
    response: Response,
    controller: AbortController,
  ): Promise<void> =>
    readSseStream(
      response.body!,
      controller.signal,
      (frame) => {
        if (frame.data) dispatchMainFrame(frame.data, frame.id);
      },
      undefined,
      () => watchMainStream(streamSilenceLimitMs),
    );

  /** The main stream the watchdog gave up on, while its abort unwinds. */
  let silentMainStream: AbortController | null = null;

  const scheduleReconnect = () => {
    if (!hasMainEventListeners() || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureEventStream();
    }, mainStreamBackoff.nextDelayMs());
  };

  const connectFetchEventStream = () => {
    if (streamAbortController || !hasMainEventListeners()) return;
    metrics?.mainStreamStarting();
    const controller = new AbortController();
    streamAbortController = controller;
    watchMainStream(streamConnectTimeoutMs);
    let credentialRefused = false;
    /** Whether the gateway answered at all, as opposed to a network failure. */
    let answered = false;

    void (async () => {
      try {
        const url = apiUrl(eventStreamPath(undefined, mainStream.cursor));
        const init: RequestInit = {
          credentials,
          headers: requestHeaders(),
          signal: controller.signal,
        };
        const response = await (options.openMainStream
          ? options.openMainStream(url, init, mainStreamControl)
          : fetch(url, init));
        // Replaced while connecting (a new credential): the replacement owns
        // the stream state now.
        if (controller.signal.aborted) return;
        answered = true;
        if (response.status === 401) credentialRefused = true;
        if (!response.ok || !response.body) {
          throw new Error(`Gateway event stream failed with HTTP ${response.status}`);
        }
        mainStreamBackoff.connected();
        watchMainStream(streamSilenceLimitMs);
        setMainStreamConnectionState("connected");
        afterMainStreamOpened();
        metrics?.mainStreamOpened();
        await consumeMainFetchEventStream(response, controller);
      } catch (error) {
        if (!controller.signal.aborted) {
          log.warn("events.disconnected", { transport: "fetch", error: formatLogError(error) });
        }
      } finally {
        // An abort means someone stopped this stream on purpose; the watchdog is
        // the one aborter that still wants a replacement.
        const silent = silentMainStream === controller;
        const shouldReconnect = silent || !controller.signal.aborted;
        controller.abort();
        if (silent) silentMainStream = null;
        if (streamAbortController === controller) {
          streamAbortController = null;
          stopWatchingMainStream();
        }
        if (shouldReconnect) {
          if (credentialRefused) mainStreamCredentialRejected();
          else if (!probeCredentialOnStreamFailure || silent) {
            setMainStreamConnectionState("disconnected");
          } else {
            // As for the `EventSource`: a failure nothing answered ends what an
            // earlier refusal told us, while an HTTP error after a refusal is
            // the same refusal and needs no second probe.
            if (!answered) mainStreamCredentialRefused = false;
            if (!mainStreamCredentialRefused) {
              setMainStreamConnectionState("disconnected");
              checkMainStreamCredential();
            }
          }
          scheduleReconnect();
        }
      }
    })();
  };

  const ensureEventStream = () => {
    if (disposed || eventSource || streamAbortController || !hasMainEventListeners()) return;
    metrics?.mainStreamStarting();
    // A retry after a failure stays `disconnected` until it actually opens.
    if (mainStreamConnectionState === "idle") setMainStreamConnectionState("connecting");
    if (bearerToken || baseUrl) {
      connectFetchEventStream();
      return;
    }

    const source = new EventSource(apiUrl(eventStreamPath(undefined, mainStream.cursor)), {
      withCredentials: true,
    });
    eventSource = source;
    watchMainStream(streamConnectTimeoutMs);
    // Set by the gateway's first keepalive; an older gateway never sends one.
    let keepalivesExpected = false;
    source.addEventListener(GATEWAY_KEEPALIVE_EVENT, () => {
      if (eventSource !== source) return;
      keepalivesExpected = true;
      watchMainStream(streamSilenceLimitMs);
    });
    source.onopen = () => {
      if (eventSource === source) {
        if (!keepalivesExpected) stopWatchingMainStream();
        mainStreamBackoff.connected();
        setMainStreamConnectionState("connected");
        afterMainStreamOpened();
      }
      metrics?.mainStreamOpened();
    };
    source.onmessage = (message) => {
      if (eventSource !== source) return;
      if (keepalivesExpected) watchMainStream(streamSilenceLimitMs);
      dispatchMainFrame(message.data, message.lastEventId);
    };
    source.onerror = () => {
      if (eventSource !== source) return;
      log.warn("events.disconnected", { transport: "event-source" });
      invalidateMainStreamCredentialProbe();
      const refused = source.readyState === EVENT_SOURCE_CLOSED;
      // A network failure ends what a refusal told us, so the next one asks again.
      if (!refused) mainStreamCredentialRefused = false;
      if (!mainStreamCredentialRefused) setMainStreamConnectionState("disconnected");
      // Left CONNECTING, the browser would retry by itself: every 3 s for the
      // whole outage, and in lock-step across tabs when a restart drops them
      // together. Take the retry over, so it follows the jittered ladder like
      // every other stream. The new socket resumes from `mainStream.cursor`.
      source.close();
      eventSource = null;
      stopWatchingMainStream();
      if (refused && !mainStreamCredentialRefused) checkMainStreamCredential();
      scheduleReconnect();
    };
  };

  /**
   * The main stream shows no sign of life, or an attempt got no answer: the link
   * dropped without telling anyone. It carries the terminal streams too, and
   * they have no watchdog of their own.
   */
  const dropSilentStreams = () => {
    invalidateMainStreamCredentialProbe();
    stopWatchingMainStream();
    log.warn("events.disconnected", { reason: "silent" });
    setMainStreamConnectionState("disconnected");
    silentDropSinceMainOpen = true;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
      scheduleReconnect();
    }
    if (streamAbortController) {
      silentMainStream = streamAbortController;
      streamAbortController.abort();
    }
    if (sharedTerminalConnection) {
      closeSharedTerminalConnection();
      scheduleSharedTerminalReconnect();
    }
    relayedEvents.dropConnection();
    terminalSocket?.dropConnection();
  };

  const afterMainStreamOpened = () => {
    invalidateMainStreamCredentialProbe();
    mainStreamCredentialRefused = false;
    retryWaitingTerminalFallbacks();
    if (!silentDropSinceMainOpen) return;
    silentDropSinceMainOpen = false;
    // An attempt made while the link was silent will never be answered, and
    // only its own TCP timeout would end it. The link is back, so try again.
    if (sharedTerminalConnection && !sharedTerminalConnectionOpen) {
      closeSharedTerminalConnection();
      refreshSharedTerminalConnection();
    }
    relayedEvents.retryUnanswered();
    terminalSocket?.reconnectIfNotReady();
  };

  /**
   * The opener wants the main stream carried another way: replace it now, from
   * its cursor, without counting a failure or changing the connection state.
   */
  const reconnectMainStream = () => {
    if (disposed || eventSource || (!streamAbortController && !reconnectTimer)) return;
    invalidateMainStreamCredentialProbe();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    streamAbortController?.abort();
    streamAbortController = null;
    stopWatchingMainStream();
    mainStreamBackoff.disconnected();
    ensureEventStream();
  };
  const mainStreamControl: MainStreamControl = { reconnect: () => reconnectMainStream() };

  /** Stops the main stream, its retry and its watchdog, and forgets the outage. */
  const closeMainStream = () => {
    invalidateMainStreamCredentialProbe();
    eventSource?.close();
    eventSource = null;
    streamAbortController?.abort();
    streamAbortController = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopWatchingMainStream();
    // A later listener starts a fresh connection, not the tail of an old outage.
    mainStreamBackoff.reset();
    setMainStreamConnectionState("idle");
    // Nothing is listening any more, so there is no boot left to measure. A
    // surviving timer would hold this whole closure and still report for a
    // session that has already torn down.
    metrics?.mainStreamIdle();
  };

  const closeEventStreamIfIdle = () => {
    if (hasMainEventListeners()) return;
    closeMainStream();
  };

  const resolveTerminalStreamReady = (stream: TerminalEventStream) => {
    if (stream.readyResolved) return;
    stream.readyResolved = true;
    stream.resolveReady();
  };

  /**
   * Announce that a terminal's stream is open.
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

  const closeSharedTerminalConnection = () => {
    sharedTerminalConnection?.close();
    sharedTerminalConnection = null;
    sharedTerminalSubscribedEvents = null;
    sharedTerminalConnectionOpen = false;
  };

  const clearSharedTerminalReconnectTimer = () => {
    if (!sharedTerminalReconnectTimer) return;
    clearTimeout(sharedTerminalReconnectTimer);
    sharedTerminalReconnectTimer = null;
  };

  /**
   * Every reopen of a terminal stream announces a desync and costs each
   * terminal on it a snapshot read, so a backend that keeps failing must not
   * be retried at a fixed interval by every open tab at once.
   */
  const scheduleSharedTerminalReconnect = () => {
    if (sharedTerminalReconnectTimer) return;
    sharedTerminalReconnectTimer = setTimeout(() => {
      sharedTerminalReconnectTimer = null;
      refreshSharedTerminalConnection();
    }, sharedTerminalBackoff.nextDelayMs());
  };

  /**
   * WKWebView enforces a small per-origin allowance for long-lived HTTP
   * requests. One EventSource per mounted terminal can therefore leave later
   * terminals with only their initial snapshot and no live output. Mobile keeps
   * every pane mounted intentionally, so this is easy to hit.
   *
   * A plain-HTTP/1.1 gateway gives a browser about six connections per host,
   * so a bearer or cross-origin client holding one fetch per terminal would leave
   * commands queued behind them, and with streaming compression on each one
   * also takes one of the gateway's few gzip slots.
   *
   * Share one filtered stream for every terminal this client currently
   * consumes, whichever transport carries it (`openSharedTerminalConnection`
   * picks). Changing the filter reconnects this one stream; opening
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
  const refreshSharedTerminalConnection = (refresh: { defer?: boolean } = {}) => {
    if (refresh.defer) {
      if (sharedTerminalRefreshQueued || sharedTerminalNarrowTimer) return;
      sharedTerminalNarrowTimer = setTimeout(() => {
        sharedTerminalNarrowTimer = null;
        refreshSharedTerminalConnection();
      }, TERMINAL_FILTER_NARROW_DELAY_MS);
      sharedTerminalNarrowTimer.unref?.();
      return;
    }
    if (sharedTerminalRefreshQueued) return;
    sharedTerminalRefreshQueued = true;
    if (sharedTerminalNarrowTimer) {
      clearTimeout(sharedTerminalNarrowTimer);
      sharedTerminalNarrowTimer = null;
    }
    queueMicrotask(() => {
      sharedTerminalRefreshQueued = false;

      const streams = [...terminalEventStreams.values()].filter(
        (stream) => !stream.closed && stream.fallbackActive,
      );
      const events = streams.map((stream) => stream.event).sort();

      // A live socket already carrying exactly this filter needs no work. The
      // null check matters: a fatal error clears the source but leaves the
      // event list, and that retry has to be able to rebuild.
      if (
        sharedTerminalConnection &&
        sharedTerminalSubscribedEvents?.length === events.length &&
        sharedTerminalSubscribedEvents.every((event, index) => event === events[index])
      ) {
        // The filter is unchanged but a stream object behind it may not be: a
        // terminal that unsubscribed and resubscribed the same event has a
        // fresh, unlatched stream riding an already-open socket, and no further
        // `onopen` is coming for it. Latch it as a first connect — it has not
        // missed anything it will not pick up in its own initial snapshot.
        sharedTerminalSocketStreams = new Set(streams);
        if (sharedTerminalConnectionOpen) {
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
        !sharedTerminalConnection &&
        sharedTerminalReconnectTimer &&
        streams.length > 0 &&
        streams.every((stream) => sharedTerminalSocketStreams.has(stream))
      ) {
        return;
      }

      clearSharedTerminalReconnectTimer();
      if (sharedTerminalConnection) {
        // Replacing the socket is not a failure, but its uptime ends here: the
        // replacement's health counts only from its own open, so time spent
        // connecting it cannot pass as a healthy interval.
        sharedTerminalConnection.close();
        sharedTerminalBackoff.disconnected();
      }
      sharedTerminalConnection = null;
      sharedTerminalSubscribedEvents = null;
      sharedTerminalSocketStreams = new Set();
      sharedTerminalConnectionOpen = false;
      if (events.length === 0) {
        // A later terminal starts a fresh connection, not the tail of an old
        // outage.
        sharedTerminalBackoff.reset();
        return;
      }

      const subscribedEvents = new Set(events);
      const connection: SharedTerminalConnection = openSharedTerminalConnection(events, {
        onOpen: () => {
          if (sharedTerminalConnection !== connection) return;
          sharedTerminalConnectionOpen = true;
          sharedTerminalBackoff.connected();
          for (const event of subscribedEvents) {
            const stream = terminalEventStreams.get(event);
            if (stream && !stream.closed && stream.fallbackActive) {
              announceTerminalStreamOpen(stream);
            }
          }
        },
        onMessage: (data) => {
          if (sharedTerminalConnection === connection) {
            dispatchMessage(data, { terminalFallback: true });
          }
        },
        onError: () => {
          if (sharedTerminalConnection !== connection) return;
          // As for the main stream: the jittered ladder owns the retry, rather
          // than the browser's fixed one, and one shared socket means one ladder
          // however many terminals it strands.
          closeSharedTerminalConnection();
          scheduleSharedTerminalReconnect();
        },
      });
      sharedTerminalConnection = connection;
      sharedTerminalSubscribedEvents = events;
      sharedTerminalSocketStreams = new Set(streams);
    });
  };

  /**
   * Open the shared terminal stream for `events`. The handlers run only after
   * this returns, never synchronously, and `onError` means the connection
   * failed or ended by itself: `close()` reports nothing.
   */
  const openSharedTerminalConnection = (
    events: readonly string[],
    handlers: RelayedEventConnectionHandlers,
  ): SharedTerminalConnection =>
    openFilteredConnection(apiUrl(eventStreamPath(events)), "terminal", handlers);

  /** One filtered stream, on whichever transport this client can authenticate. */
  const openFilteredConnection = (
    url: string,
    kind: "terminal" | "relayed",
    handlers: RelayedEventConnectionHandlers,
  ): RelayedEventConnection => {
    const logEvent =
      kind === "terminal" ? "terminal-stream.disconnected" : "relayed-stream.disconnected";
    if (filteredStreamsUseEventSource()) {
      const source = new EventSource(url, { withCredentials: credentials !== "omit" });
      source.onopen = handlers.onOpen;
      source.onmessage = (message) => handlers.onMessage(message.data, message.lastEventId);
      source.onerror = () => {
        log.warn(logEvent, { transport: "event-source" });
        handlers.onError();
      };
      return source;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, {
          credentials,
          headers: requestHeaders(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Gateway ${kind} event stream failed with HTTP ${response.status}`);
        }
        if (controller.signal.aborted) return;
        handlers.onOpen();
        await readSseStream(response.body, controller.signal, (frame) => {
          if (frame.data) handlers.onMessage(frame.data, frame.id);
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          log.warn(logEvent, {
            transport: "fetch",
            error: formatLogError(error),
          });
        }
      } finally {
        // An abort is `close()`; anything else, a clean end included, is a
        // failure the ladder retries.
        const stoppedOnPurpose = controller.signal.aborted;
        controller.abort();
        if (!stoppedOnPurpose) handlers.onError();
      }
    })();
    return { close: () => controller.abort() };
  };

  const relayedEvents = new RelayedEventStream({
    open: (events, since, handlers) => {
      const params = new URLSearchParams({ includeEvents: events.join(",") });
      if (since) params.set(GATEWAY_EVENT_CURSOR_PARAM, since);
      return openFilteredConnection(
        apiUrl(`${GATEWAY_PREFIX}/events?${params.toString()}`),
        "relayed",
        handlers,
      );
    },
    deliver,
    backoff: createStreamBackoff(),
  });

  const startTerminalEventFallback = (stream: TerminalEventStream) => {
    if (stream.closed) return;
    stream.fallbackActive = true;
    // The shared stream decides whether this needs any work: a filter it
    // already carries, or a dead socket waiting out its backoff, is left alone,
    // so a terminal WebSocket asking for fallback on every failed attempt does
    // not retry at the socket's pace.
    refreshSharedTerminalConnection();
  };

  const stopTerminalEventFallback = (stream: TerminalEventStream) => {
    if (!stream.fallbackActive) return;
    stream.fallbackActive = false;
    refreshSharedTerminalConnection({ defer: true });
  };

  const stopTerminalEventFallbacks = () => {
    for (const stream of terminalEventStreams.values()) {
      // Disposal replaces the whole adapter, so these streams must never come
      // back. `closed` is the flag every reconnect path already honours.
      stream.closed = true;
      stopTerminalEventFallback(stream);
    }
    clearSharedTerminalReconnectTimer();
    if (sharedTerminalNarrowTimer) {
      clearTimeout(sharedTerminalNarrowTimer);
      sharedTerminalNarrowTimer = null;
    }
    sharedTerminalConnection?.close();
    sharedTerminalConnection = null;
    sharedTerminalSubscribedEvents = null;
    sharedTerminalSocketStreams = new Set();
    sharedTerminalConnectionOpen = false;
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
    if (sharedTerminalReconnectTimer) {
      clearSharedTerminalReconnectTimer();
      refreshSharedTerminalConnection();
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
    relayedEvents.retryWaiting();
  };
  const lifecycleStops: Array<() => void> = [];
  if (options.lifecycle) {
    lifecycleStops.push(
      options.lifecycle.onVisibility((visible) => {
        if (visible) retryWaitingStreams();
      }),
      options.lifecycle.onOnline(retryWaitingStreams),
    );
  }

  const ensureTerminalSocket = (): TerminalWebSocketClient => {
    if (terminalSocket) return terminalSocket;
    terminalSocket = new TerminalWebSocketClient({
      url: terminalWebSocketUrl(baseUrl),
      token: bearerToken,
      reconnectDelayMs: options.terminalWebSocketReconnectDelayMs,
      // One jitter source and clock for every reconnect ladder this gateway owns.
      reconnectRandom: options.eventReconnectRandom,
      reconnectNow: options.eventReconnectNow,
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
    stream.socketUnlisten?.();
    stream.socketUnlisten = null;
    resolveTerminalStreamReady(stream);
    terminalEventStreams.delete(event);
    // Unlike a channel moving to the WebSocket, closing a terminal is a
    // discrete user action rather than one of a burst, so it is not deferred:
    // the socket should stop carrying a terminal nobody is watching at once.
    if (stream.fallbackActive) refreshSharedTerminalConnection();
  };

  /**
   * A new credential: nothing may keep running on the old one, and a stream
   * that was refused or is waiting out its backoff can open now. Each stream
   * is replaced, not failed, so its ladder counts no failure (a refused one
   * starts afresh) and each resumes from its own cursor; a terminal on the
   * replaced shared stream reconciles its snapshot as after any reopen.
   */
  const reopenStreamsWithNewCredential = () => {
    if (disposed) return;
    if (eventSource || streamAbortController || reconnectTimer) {
      const wasRefused = mainStreamCredentialRefused;
      invalidateMainStreamCredentialProbe();
      mainStreamCredentialRefused = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      eventSource?.close();
      eventSource = null;
      streamAbortController?.abort();
      streamAbortController = null;
      stopWatchingMainStream();
      if (wasRefused) mainStreamBackoff.reset();
      else mainStreamBackoff.disconnected();
      ensureEventStream();
    }
    if (sharedTerminalConnection || sharedTerminalReconnectTimer) {
      clearSharedTerminalReconnectTimer();
      if (sharedTerminalConnection) {
        closeSharedTerminalConnection();
        sharedTerminalBackoff.disconnected();
      }
      refreshSharedTerminalConnection();
    }
    relayedEvents.reopen();
  };

  const readGatewayResponse = async <T>(response: Response, fallback: string): Promise<T> => {
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) {
      // The gateway only answers 401 from its authentication gate, so on a
      // cookie session this is the deadline having passed rather than a
      // command-specific failure. Surface it before the throw: the idle path can
      // lapse with no pointer or key activity to notice it.
      if (response.status === 401) credentialRejected();
      // The status travels as a property, not just inside the message. A
      // gateway 502/503 during environment bring-up has to reach the startup
      // retry classifier, and it looks for `error.status`.
      // So do its `code` and an incompatibility's bounded `details` (1005).
      throw new GatewayHttpError(
        response.status,
        payload.error ?? `${fallback} with HTTP ${response.status}`,
        payload,
      );
    }
    return payload;
  };

  let pageHiding = false;
  if (options.keepaliveOnPageHide && options.lifecycle) {
    // Subscribed as the transport is built, so before any listener that flushes.
    lifecycleStops.push(
      options.lifecycle.onPageHide((hiding) => {
        pageHiding = hiding;
      }),
    );
  }

  const invokeImmediately = async <T = unknown>(
    command: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
    envelope?: NodeTransportEnvelope,
  ): Promise<T> => {
    const body = JSON.stringify({ command, args: args ?? {}, ...envelopeBodyFields(envelope) });
    const response = await fetch(apiUrl(`${GATEWAY_PREFIX}/invoke`), {
      method: "POST",
      credentials,
      headers: requestHeaders({ "content-type": "application/json" }),
      body,
      signal,
      // A UTF-16 unit is at most three UTF-8 bytes. A larger body goes as usual,
      // and ends with the page like any other request.
      ...(pageHiding && body.length * 3 <= KEEPALIVE_MAX_BODY_BYTES ? { keepalive: true } : {}),
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

  const hello = async (): Promise<BackendHello | null> => {
    if (disposed) throw new Error("This node transport is disposed.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HELLO_TIMEOUT_MS);
    try {
      const response = await fetch(apiUrl(BACKEND_HELLO_PATH), {
        credentials,
        headers: requestHeaders({ accept: "application/json" }),
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`The node hello failed with HTTP ${response.status}.`);
      }
      const text = await response.text();
      if (text.length > MAX_HELLO_BYTES) return null;
      try {
        return parseBackendHello(JSON.parse(text) as unknown);
      } catch {
        // A 200 that is not a hello is an older backend serving its page.
        return null;
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    hello,
    async invoke<T = unknown>(
      command: string,
      args?: Record<string, unknown>,
      options?: NodeTransportInvokeOptions,
    ): Promise<T> {
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
      return invokeImmediately<T>(command, args, undefined, options?.envelope);
    },

    listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
      if (options.unavailableReason || disposed) return () => undefined;
      const callbackSet = listeners.get(event) ?? new Set<EventCallback<unknown>>();
      listeners.set(event, callbackSet);
      callbackSet.add(callback as EventCallback<unknown>);
      if (isTerminalOutputEvent(event)) {
        ensureTerminalEventStream(event);
      } else if (isPerNodeRelayedEvent(event)) {
        relayedEvents.add(event);
      } else {
        ensureEventStream();
      }
      return () => {
        callbackSet.delete(callback as EventCallback<unknown>);
        if (callbackSet.size === 0) {
          listeners.delete(event);
          if (isTerminalOutputEvent(event)) closeTerminalEventStream(event);
          else if (isPerNodeRelayedEvent(event)) relayedEvents.remove(event);
        }
        closeEventStreamIfIdle();
      };
    },

    eventStreamReady(event: string): Promise<void> {
      if (isPerNodeRelayedEvent(event)) return relayedEvents.ready(event);
      if (!isTerminalOutputEvent(event)) return Promise.resolve();
      return ensureTerminalEventStream(event).ready;
    },

    eventStreamConnection: {
      state(): GatewayEventStreamConnectionState {
        return mainStreamConnectionState;
      },
      subscribe(listener: (state: GatewayEventStreamConnectionState) => void): () => void {
        mainStreamConnectionListeners.add(listener);
        return () => {
          mainStreamConnectionListeners.delete(listener);
        };
      },
    },

    baseUrl: baseUrl ?? null,
    requestCredentials: credentials,
    url: apiUrl,
    requestHeaders,
    readResponse: readGatewayResponse,
    credential: () => bearerToken,
    setCredential(token: string): void {
      const normalizedToken = token.trim();
      if ((normalizedToken || undefined) === bearerToken) return;
      bearerToken = normalizedToken || undefined;
      terminalSocket?.updateToken(normalizedToken);
      reopenStreamsWithNewCredential();
    },

    dispose(reason: unknown = new Error("Node transport disposed")): void {
      if (disposed) return;
      disposed = true;
      // A disposed transport's state says nothing about its successor, and
      // nothing of it may keep running (invariant 15).
      closeMainStream();
      mainStreamConnectionListeners.clear();
      for (const stop of lifecycleStops.splice(0)) stop();
      terminalInput.dispose(reason);
      terminalSocket?.dispose();
      terminalSocket = null;
      stopTerminalEventFallbacks();
      relayedEvents.dispose();
    },
  };
}
