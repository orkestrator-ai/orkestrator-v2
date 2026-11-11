import { withRelayController } from "./core/public-api/index.js";
import { isGlobalConfigEcho, isGlobalConfigWriteCommand } from "./core/nodes/index.js";
import type { GatewayAuth } from "./gateway-auth.js";
import type { GatewayContext } from "./gateway-context.js";
import type { GatewayEvents } from "./gateway-events.js";
import type { GatewayProxy } from "./gateway-proxy.js";
import type { LegacyLoopbackPortAccess } from "./core/preview-runtime.js";
import {
  BROWSER_PREVIEW_ENVIRONMENT_HEADER,
  browserPreviewEnvironmentId,
} from "@orkestrator/protocol/browser-preview";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { parseGatewayCursor } from "./gateway-event-replay.js";
import {
  GATEWAY_KEEPALIVE_EVENT,
  GATEWAY_KEEPALIVE_EVENTS_PARAM,
  GATEWAY_RELAYED_EVENTS_PARAM,
} from "@orkestrator/protocol/gateway-event-stream";
import { isPerNodeRelayedEvent } from "@orkestrator/protocol/node-events";
import { gatewayRequestCredential } from "./gateway-sessions.js";
import {
  API_PREFIX,
  MAX_INVOKE_BODY_BYTES,
  INVOKE_COMMAND_BODY_LIMITS,
  DROPPABLE_EVENT_PREFIX,
  SSE_CLIENT_HARD_BUFFER_BYTES,
  MAX_CLIENT_METRICS_BODY_BYTES,
  METRIC_UNKNOWN_COMMAND_KEY,
  METRIC_KEEPALIVE_KEY,
  normalizeMetricLabel,
  InvalidRequestBodyError,
  RequestBodyTooLargeError,
  sanitizeClientBootReport,
  negotiateEncoding,
  appendHeadersVary,
  responseCompressionContexts,
  jsonResponse,
  serializedJsonResponse,
  readJsonBody,
  IdentityEventClientWriter,
  GzipEventClientWriter,
  parseEventSubscriptionFilter,
  parseRelayedEventsMode,
} from "./gateway-internals.js";
import type {
  GatewayRequestMetrics,
  DrainAwareEventClientWriter,
  GatewayEventClient,
} from "./gateway-internals.js";
import { compatibilityPathUsage } from "./core/compatibility-path-usage.js";
import {
  isSpliceableResult,
  spliceEncodedJsonBytes,
} from "./core/native-agent-projection-encoding.js";
import { backendMetricsSnapshot } from "./core/backend-metrics.js";
import type { CommandInvocation } from "./core/commands-context.js";
import { decodeInvokeEnvelope } from "@orkestrator/protocol/contract/envelope";
import { codedErrorWire } from "@orkestrator/protocol/contract/errors";
import { mcpFailure } from "@orkestrator/protocol/mcp-management";
import * as Result from "effect/Result";

const KEEPALIVE_EVENT_FRAME = `event: ${GATEWAY_KEEPALIVE_EVENT}\ndata: 1\n\n`;

/** The invoke, event-stream, metrics and loopback-proxy routes. */
export class GatewayHandlers {
  constructor(
    private readonly ctx: GatewayContext,
    private readonly events: GatewayEvents,
    private readonly auth: GatewayAuth,
    private readonly proxy: GatewayProxy,
  ) {}

  commandIsRegistered(command: string, errorMessage: string): boolean {
    const hasCommand = this.ctx.backend.hasCommand;
    if (hasCommand) return hasCommand.call(this.ctx.backend, command);
    return !errorMessage.startsWith("Unknown backend command:");
  }

  async handleInvoke(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
    options: { refuseCommand?: (command: string) => boolean; controllerId?: string } = {},
  ): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    let body: Record<string, unknown>;
    let requestBytes = 0;
    try {
      const parsed = await readJsonBody(request, MAX_INVOKE_BODY_BYTES);
      body = parsed.body;
      requestBytes = parsed.bytes;
      requestMetrics.setRequestBytes(parsed.bytes);
    } catch (error) {
      // Without these branches an oversized or malformed body escapes to the
      // generic server catch and surfaces as a 500, which reads as a backend
      // fault rather than as a request the caller can correct.
      if (error instanceof RequestBodyTooLargeError) {
        jsonResponse(response, 413, { error: error.message });
        return;
      }
      if (error instanceof InvalidRequestBodyError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
    const command = body.command;
    const args = body.args;
    if (typeof command !== "string") {
      jsonResponse(response, 400, { error: "Expected command to be a string" });
      return;
    }
    // The envelope's contract fields travel next to `command` and `args`
    // (plan item 1003). A body without them is today's call, unchanged.
    const envelope = invocationFromBody(body);
    if (envelope.refused !== undefined) {
      jsonResponse(response, 400, { error: envelope.refused });
      return;
    }
    const invocation = envelope.invocation;
    if (options.refuseCommand?.(command)) {
      // A refused settings write that would change nothing is answered with
      // the current settings: an older realm sends one when it saves a model
      // favourite (`isGlobalConfigEcho`). Anything else stays refused.
      if (isGlobalConfigWriteCommand(command)) {
        const current: unknown = await Promise.resolve()
          .then(() => this.ctx.backend.invoke("get_config", {}))
          .catch(() => null);
        if (current && isGlobalConfigEcho(command, args, current)) {
          compatibilityPathUsage.record("workspace-grant.config-echo");
          serializedJsonResponse(response, 200, JSON.stringify({ result: current }));
          return;
        }
      }
      jsonResponse(response, 403, { error: "This credential cannot run that command." });
      return;
    }
    const commandLimit = Object.hasOwn(INVOKE_COMMAND_BODY_LIMITS, command)
      ? INVOKE_COMMAND_BODY_LIMITS[command]
      : undefined;
    if (commandLimit !== undefined && requestBytes > commandLimit) {
      // Structured so the MCP settings UI decodes a code rather than a transport failure.
      // Registered code `mcp-management` with its reason; the message keeps
      // the `McpManagementError:invalid-request:` marker for older renderers.
      jsonResponse(
        response,
        413,
        codedErrorWire(
          mcpFailure("invalid-request", {
            message: `The change is larger than ${Math.floor(commandLimit / 1024)} KiB.`,
          }),
        ),
      );
      return;
    }
    const safeArgs =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const startedAt = Date.now();
    // Attribute work to its arrival window, even if it outlives the burst.
    // Without registry evidence, retain only the reserved unknown label.
    this.ctx.traffic.noteInvoke(
      normalizeMetricLabel(
        this.ctx.backend.hasCommand?.(command) ? command : METRIC_UNKNOWN_COMMAND_KEY,
      ),
    );

    // The call's own cancellation: a client that goes away before the answer
    // (a node link whose caller stopped waiting aborts its request) aborts it.
    // Handlers may honour it; the answer is still written to a closed socket
    // harmlessly when they do not.
    const cancel = new AbortController();
    const onClose = () => {
      if (!response.writableFinished) cancel.abort(new Error("The client went away."));
    };
    response.once("close", onClose);
    try {
      const invokeArgs =
        command === "public_action" && options.controllerId
          ? withRelayController(safeArgs, options.controllerId)
          : safeArgs;
      const result = await this.ctx.backend.invoke(command, invokeArgs, {
        ...invocation,
        signal: cancel.signal,
      });
      // A transcript answer's rows were each encoded already to size and hash
      // them; splice those encodings in rather than serializing them again.
      // Either way the body is encoded to bytes once, here, and its length
      // read from the buffer rather than by scanning the string again.
      const responseBody =
        (isSpliceableResult(result) ? spliceEncodedJsonBytes({ result }) : undefined) ??
        Buffer.from(JSON.stringify({ result }));
      this.ctx.metrics.recordInvoke(
        command,
        requestBytes,
        responseBody.byteLength,
        Math.max(0, Date.now() - startedAt),
        true,
      );
      serializedJsonResponse(response, 200, responseBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: unknown } | null)?.code;
      // A registered code also names its bounded details (an
      // incompatibility's domain and range, or its critical field), never an
      // argument value (`contract/ipc-error.ts`, `REGISTERED_ERROR_CODES`).
      const responseBody = JSON.stringify(
        codedErrorWire(error) ?? {
          error: message,
          ...(typeof code === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(code) ? { code } : {}),
        },
      );
      // Never retain the rejected, network-supplied value: a syntactically
      // valid token-like string is just as sensitive as an obviously malformed
      // label. Gate on registry membership rather than on the error text, so a
      // name rejected before the registry is even consulted — during shutdown,
      // say — still cannot become a label.
      const metricCommand = this.commandIsRegistered(command, message)
        ? command
        : METRIC_UNKNOWN_COMMAND_KEY;
      this.ctx.metrics.recordInvoke(
        metricCommand,
        requestBytes,
        Buffer.byteLength(responseBody),
        Math.max(0, Date.now() - startedAt),
        false,
      );
      serializedJsonResponse(response, 500, responseBody);
    } finally {
      response.off("close", onClose);
    }
  }

  handleEvents(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }

    this.ctx.metrics.recordStreamConnecting();
    const compressionContext = responseCompressionContexts.get(response);
    const wantsGzip =
      compressionContext?.mode === "on" &&
      negotiateEncoding(compressionContext.acceptEncoding, ["gzip", "identity"]) === "gzip";
    const releaseStreamingCompression = wantsGzip
      ? this.ctx.metrics.tryStartStreamingCompression()
      : null;
    const useGzip = releaseStreamingCompression !== null;
    const headers: OutgoingHttpHeaders = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    if (compressionContext?.mode === "on") {
      appendHeadersVary(headers, "Accept-Encoding");
    }
    if (useGzip) headers["content-encoding"] = "gzip";

    let client: DrainAwareEventClientWriter;
    try {
      response.writeHead(200, headers);
      const writerMetrics = {
        sourceBytes: (bytes: number) => {
          this.ctx.metrics.recordStreamSourceBytes(bytes);
          if (useGzip) this.ctx.metrics.recordStreamingCompressionSourceBytes(bytes);
        },
        encodedBytes: (bytes: number) => {
          this.ctx.metrics.recordStreamEncodedBodyBytes(bytes);
          if (useGzip) this.ctx.metrics.recordStreamingCompressionEncodedBytes(bytes);
        },
        compressionFailure: () => this.ctx.metrics.recordStreamingCompressionFailure(),
        closed: () => releaseStreamingCompression?.(),
      };
      client = useGzip
        ? new GzipEventClientWriter(response, writerMetrics)
        : new IdentityEventClientWriter(response, writerMetrics);
      if (useGzip) {
        // Prime the compressor independently so a quiet stream's connected
        // frame is emitted in a sync-flushed gzip block immediately instead of
        // waiting for the first application event.
        client.write(": compression-priming\n\n");
      }
    } catch (error) {
      releaseStreamingCompression?.();
      // A handshake that never reaches `open` still has to release the gauge,
      // otherwise `connecting` climbs for the lifetime of the process.
      this.ctx.metrics.recordStreamConnectFailed();
      throw error;
    }
    const state: GatewayEventClient = {
      keepaliveEvents: url.searchParams.has(GATEWAY_KEEPALIVE_EVENTS_PARAM),
      prefixes: parseEventSubscriptionFilter(url.searchParams.get("events")),
      includedPrefixes: parseEventSubscriptionFilter(url.searchParams.get("includeEvents")),
      excludedPrefixes: parseEventSubscriptionFilter(url.searchParams.get("excludeEvents")),
      relayedEvents: parseRelayedEventsMode(url.searchParams.get(GATEWAY_RELAYED_EVENTS_PARAM)),
      desyncedSessions: new Set(),
      handshake: { events: [], bytes: 0 },
      tracksReplayCursor: false,
      sentRevision: 0,
      omittedRevision: null,
    };
    const explicitSince = url.searchParams.get("since")?.trim() ?? "";
    const lastEventIdHeader = Array.isArray(request.headers["last-event-id"])
      ? request.headers["last-event-id"][0]
      : request.headers["last-event-id"];
    const lastEventId = typeof lastEventIdHeader === "string" ? lastEventIdHeader.trim() : "";
    // A native EventSource reuses its original URL while advancing
    // Last-Event-ID on automatic retries. Prefer that newer browser-owned
    // cursor; direct-fetch clients still fall back to the explicit query.
    // Blank in either position means "no cursor", not a malformed one — a
    // client that always appends `since=` must not be forced to reconcile.
    const rawCursor = lastEventId || explicitSince || null;
    const isTerminalOnly =
      state.prefixes === null &&
      state.includedPrefixes?.every((prefix) => prefix.startsWith(DROPPABLE_EVENT_PREFIX)) &&
      state.excludedPrefixes?.some((prefix) => DROPPABLE_EVENT_PREFIX.startsWith(prefix));
    // A stream asking only for per-node relayed events resumes against their
    // ring, with its own cursor. A main stream's window never holds them.
    state.relayedStream =
      state.prefixes === null &&
      state.includedPrefixes !== null &&
      state.includedPrefixes.every(isPerNodeRelayedEvent);
    // Subscribe before inspecting the ring. `emit()` buffers into this state
    // until replay drains, closing the replay/live race. Everything from here
    // until the handshake settles is guarded: a throw after the client is in the
    // map but before its `close` handler exists would leak both the client and
    // the `connecting` gauge for the lifetime of the process.
    this.ctx.clients.set(client, state);
    try {
      client.write(": connected\n\n");
      // At once, so the client knows to expect them for as long as the stream lives.
      if (state.keepaliveEvents) client.write(KEEPALIVE_EVENT_FRAME);
      if (isTerminalOnly) {
        // Terminal streams use their own revisioned snapshot protocol. They are
        // deliberately absent from the authoritative gateway replay sequence.
        state.handshake = null;
      } else {
        state.tracksReplayCursor = true;
        this.events.initializeEventReplay(client, state, parseGatewayCursor(rawCursor));
      }
    } catch (error) {
      this.ctx.clients.delete(client);
      this.ctx.metrics.recordStreamConnectFailed();
      client.destroy();
      throw error;
    }
    this.ctx.metrics.recordStreamOpened();
    // A client only ever falls behind after a write was refused, so "drained"
    // is the earliest safe moment to tell it what it missed — waiting for the
    // next event would leave a quiet session desynced indefinitely.
    client.onDrain(() => {
      if (this.ctx.clients.get(client) !== state || state.desyncedSessions.size === 0) return;
      this.events.flushDesyncNotices(client, state);
    });

    // A keepalive is a write like any other, so it has to respect the same hard
    // limit. Otherwise a stream with no event traffic keeps a client that is
    // already hopelessly behind — and its buffer — alive indefinitely.
    this.ctx.keepalive ??= setInterval(() => {
      for (const [client, clientState] of Array.from(this.ctx.clients)) {
        if (client.writableLength > SSE_CLIENT_HARD_BUFFER_BYTES) {
          this.events.dropBufferedClient(client, METRIC_KEEPALIVE_KEY, client.writableLength);
          continue;
        }
        // Before the comment, so a scoped stream that received nothing this
        // interval still leaves with a current cursor.
        this.events.flushOmittedCursor(client, clientState);
        if (!this.ctx.clients.has(client)) continue;
        this.ctx.metrics.recordKeepalive();
        client.write(clientState.keepaliveEvents ? KEEPALIVE_EVENT_FRAME : ": keepalive\n\n");
      }
    }, this.ctx.keepaliveMs);
    this.ctx.keepalive.unref?.();

    let closed = false;
    let credentialExpiryTimer: ReturnType<typeof setTimeout> | null = null;
    const credential = gatewayRequestCredential(request.headers);
    let unsubscribeRevocation = () => {};
    const close = () => {
      unsubscribeRevocation();
      if (closed) return;
      closed = true;
      if (credentialExpiryTimer) clearTimeout(credentialExpiryTimer);
      credentialExpiryTimer = null;
      this.ctx.clients.delete(client);
      client.destroy();
      this.ctx.metrics.recordStreamClosed();
    };
    const scheduleCredentialExpiry = () => {
      if (!this.auth.gatewayCredentialMatches(credential, request)) {
        close();
        return;
      }
      const expiresAt = this.auth.gatewayCredentialExpiresAt(credential);
      if (expiresAt === null) return;
      credentialExpiryTimer = setTimeout(
        scheduleCredentialExpiry,
        Math.max(1, expiresAt - Date.now()),
      );
      credentialExpiryTimer.unref?.();
    };
    if (credential) unsubscribeRevocation = this.ctx.onCredentialRevoked(credential, close);
    request.once("close", close);
    response.once("close", close);
    scheduleCredentialExpiry();
  }

  handleMetrics(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }
    jsonResponse(response, 200, this.metricsSnapshot());
  }

  /** What `/metrics` answers, also read in-process by the diagnostics bundle. */
  metricsSnapshot() {
    const snapshot = this.ctx.metrics.snapshot();
    return {
      ...snapshot,
      // Ring occupancy and eviction are otherwise invisible: a ring dropping
      // every gap looks exactly like one that never needed to retain anything.
      replay: {
        ...snapshot.replay,
        ring: this.ctx.eventReplay.getStats(),
        relayedRing: this.ctx.relayedEventReplay.getStats(),
      },
      ...backendMetricsSnapshot(this.ctx.backend.databaseStats?.() ?? null),
    };
  }

  async handleClientMetrics(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(request, MAX_CLIENT_METRICS_BODY_BYTES);
      body = parsed.body;
      requestMetrics.setRequestBytes(parsed.bytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        jsonResponse(response, 413, { error: error.message });
        return;
      }
      if (error instanceof InvalidRequestBodyError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      throw error;
    }

    this.ctx.metrics.recordClientBootReport(
      sanitizeClientBootReport(body, request.httpVersion || "1.1"),
    );
    jsonResponse(response, 202, { ok: true });
  }

  async handleLoopbackProxy(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const prefix = `${API_PREFIX}/proxy/loopback/`;
    const remaining = url.pathname.slice(prefix.length);
    const slashIndex = remaining.indexOf("/");
    const rawPort = slashIndex >= 0 ? remaining.slice(0, slashIndex) : remaining;
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      jsonResponse(response, 400, { error: "Invalid loopback proxy port" });
      return;
    }

    const restPath = slashIndex >= 0 ? remaining.slice(slashIndex) : "/";
    const targetPath = `${restPath}${url.search}`;
    await this.proxy.proxyToTarget(
      request,
      response,
      new URL(`http://127.0.0.1:${port}${targetPath}`),
      `${API_PREFIX}/proxy/loopback/${port}`,
      false,
      true,
    );
  }

  async handleBrowserLoopbackProxy(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const prefix = `${API_PREFIX}/browser/loopback/`;
    const remaining = url.pathname.slice(prefix.length);
    const slashIndex = remaining.indexOf("/");
    const rawPort = slashIndex >= 0 ? remaining.slice(0, slashIndex) : remaining;
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      jsonResponse(response, 400, { error: "Invalid browser preview port" });
      return;
    }
    // Only a verified preview target of the requesting environment may be
    // opened, never a bridge, the gateway, another host-only service or
    // another environment's application (security report M2). Electron main
    // names the environment on the requests it authenticates.
    const environmentId = browserPreviewEnvironmentId(
      request.headers[BROWSER_PREVIEW_ENVIRONMENT_HEADER],
    );
    let access: LegacyLoopbackPortAccess;
    try {
      access = await this.ctx.legacyPreviewPortAccess(port, environmentId);
    } catch {
      jsonResponse(response, 503, { error: "Could not verify the browser preview port" });
      return;
    }
    if (access !== "allowed") {
      jsonResponse(response, 403, { error: legacyPreviewRefusal(access, port) });
      return;
    }

    const restPath = slashIndex >= 0 ? remaining.slice(slashIndex) : "/";
    const targetPath = `${restPath}${url.search}`;
    await this.proxy.proxyToTarget(
      request,
      response,
      new URL(`http://127.0.0.1:${port}${targetPath}`),
      `${API_PREFIX}/browser/loopback/${port}`,
      true,
    );
  }
}

function legacyPreviewRefusal(access: Exclude<LegacyLoopbackPortAccess, "allowed">, port: number) {
  switch (access) {
    case "reserved":
      return `Port ${port} belongs to Orkestrator or Docker and cannot be previewed.`;
    case "unscoped":
      return "This preview request names no environment. Update the Orkestrator desktop app to preview this address.";
    case "unknown":
      return `Port ${port} is not an available preview service of this environment. Add it as a service to preview it.`;
  }
}

const ENVELOPE_FIELDS = ["domain", "version", "critical"] as const;

/**
 * The invoke envelope's contract fields from a body, decoded with the
 * protocol's bounded guard. A body that carries none of them yields no
 * invocation; a malformed one is refused with a value-free message.
 */
export function invocationFromBody(body: Record<string, unknown>): {
  readonly invocation?: CommandInvocation;
  readonly refused?: string;
} {
  if (!ENVELOPE_FIELDS.some((key) => Object.hasOwn(body, key))) return {};
  const decoded = decodeInvokeEnvelope(body);
  if (Result.isFailure(decoded)) return { refused: decoded.failure.message };
  const { domain, version, critical } = decoded.success;
  return {
    invocation: {
      ...(domain === undefined ? {} : { domain }),
      ...(version === undefined ? {} : { version }),
      ...(critical === undefined ? {} : { critical }),
    },
  };
}
