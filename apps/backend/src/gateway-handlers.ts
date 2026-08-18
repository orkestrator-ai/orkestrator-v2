import { GatewayAuth } from "./gateway-auth.js";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { parseGatewayCursor } from "./gateway-event-replay.js";
import {
  AUTH_COOKIE,
  API_PREFIX,
  MAX_INVOKE_BODY_BYTES,
  DROPPABLE_EVENT_PREFIX,
  SSE_CLIENT_HARD_BUFFER_BYTES,
  MAX_CLIENT_METRICS_BODY_BYTES,
  METRIC_UNKNOWN_COMMAND_KEY,
  METRIC_KEEPALIVE_KEY,
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
  getBearerToken,
  getCookie,
} from "./gateway-internals.js";
import type {
  GatewayRequestMetrics,
  DrainAwareEventClientWriter,
  GatewayEventClient,
} from "./gateway-internals.js";

export abstract class GatewayHandlers extends GatewayAuth {
  protected commandIsRegistered(command: string, errorMessage: string): boolean {
    const hasCommand = this.backend.hasCommand;
    if (hasCommand) return hasCommand.call(this.backend, command);
    return !errorMessage.startsWith("Unknown backend command:");
  }

  protected async handleInvoke(
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
    const safeArgs =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const startedAt = Date.now();

    try {
      const result = await this.backend.invoke(command, safeArgs);
      const responseBody = JSON.stringify({ result });
      this.metrics.recordInvoke(
        command,
        requestBytes,
        Buffer.byteLength(responseBody),
        Math.max(0, Date.now() - startedAt),
        true,
      );
      serializedJsonResponse(response, 200, responseBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const responseBody = JSON.stringify({ error: message });
      // Never retain the rejected, network-supplied value: a syntactically
      // valid token-like string is just as sensitive as an obviously malformed
      // label. Gate on registry membership rather than on the error text, so a
      // name rejected before the registry is even consulted — during shutdown,
      // say — still cannot become a label.
      const metricCommand = this.commandIsRegistered(command, message)
        ? command
        : METRIC_UNKNOWN_COMMAND_KEY;
      this.metrics.recordInvoke(
        metricCommand,
        requestBytes,
        Buffer.byteLength(responseBody),
        Math.max(0, Date.now() - startedAt),
        false,
      );
      serializedJsonResponse(response, 500, responseBody);
    }
  }

  protected handleEvents(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }

    this.metrics.recordStreamConnecting();
    const compressionContext = responseCompressionContexts.get(response);
    const useGzip =
      compressionContext?.mode === "on" &&
      negotiateEncoding(compressionContext.acceptEncoding, ["gzip", "identity"]) === "gzip";
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
      client = useGzip
        ? new GzipEventClientWriter(response)
        : new IdentityEventClientWriter(response);
      if (useGzip) {
        // Prime the compressor independently so a quiet stream's connected
        // frame is emitted in a sync-flushed gzip block immediately instead of
        // waiting for the first application event.
        client.write(": compression-priming\n\n");
      }
    } catch (error) {
      // A handshake that never reaches `open` still has to release the gauge,
      // otherwise `connecting` climbs for the lifetime of the process.
      this.metrics.recordStreamConnectFailed();
      throw error;
    }
    const state: GatewayEventClient = {
      prefixes: parseEventSubscriptionFilter(url.searchParams.get("events")),
      includedPrefixes: parseEventSubscriptionFilter(url.searchParams.get("includeEvents")),
      excludedPrefixes: parseEventSubscriptionFilter(url.searchParams.get("excludeEvents")),
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
    // Subscribe before inspecting the ring. `emit()` buffers into this state
    // until replay drains, closing the replay/live race. Everything from here
    // until the handshake settles is guarded: a throw after the client is in the
    // map but before its `close` handler exists would leak both the client and
    // the `connecting` gauge for the lifetime of the process.
    this.clients.set(client, state);
    try {
      client.write(": connected\n\n");
      if (isTerminalOnly) {
        // Terminal streams use their own revisioned snapshot protocol. They are
        // deliberately absent from the authoritative gateway replay sequence.
        state.handshake = null;
      } else {
        state.tracksReplayCursor = true;
        this.initializeEventReplay(client, state, parseGatewayCursor(rawCursor));
      }
    } catch (error) {
      this.clients.delete(client);
      this.metrics.recordStreamConnectFailed();
      client.destroy();
      throw error;
    }
    this.metrics.recordStreamOpened();
    // A client only ever falls behind after a write was refused, so "drained"
    // is the earliest safe moment to tell it what it missed — waiting for the
    // next event would leave a quiet session desynced indefinitely.
    client.onDrain(() => {
      if (this.clients.get(client) !== state || state.desyncedSessions.size === 0) return;
      this.flushDesyncNotices(client, state);
    });

    // A keepalive is a write like any other, so it has to respect the same hard
    // limit. Otherwise a stream with no event traffic keeps a client that is
    // already hopelessly behind — and its buffer — alive indefinitely.
    this.keepalive ??= setInterval(() => {
      for (const [client, clientState] of [...this.clients]) {
        if (client.writableLength > SSE_CLIENT_HARD_BUFFER_BYTES) {
          this.dropBufferedClient(client, METRIC_KEEPALIVE_KEY, client.writableLength);
          continue;
        }
        // Before the comment, so a scoped stream that received nothing this
        // interval still leaves with a current cursor.
        this.flushOmittedCursor(client, clientState);
        if (!this.clients.has(client)) continue;
        this.metrics.recordKeepalive();
        client.write(": keepalive\n\n");
      }
    }, this.keepaliveMs);
    this.keepalive.unref?.();

    let closed = false;
    let credentialExpiryTimer: ReturnType<typeof setTimeout> | null = null;
    const credential = getBearerToken(request.headers) ?? getCookie(request.headers, AUTH_COOKIE);
    const close = () => {
      if (closed) return;
      closed = true;
      if (credentialExpiryTimer) clearTimeout(credentialExpiryTimer);
      credentialExpiryTimer = null;
      this.clients.delete(client);
      client.destroy();
      this.metrics.recordStreamClosed();
    };
    const scheduleCredentialExpiry = () => {
      if (!this.gatewayCredentialMatches(credential)) {
        close();
        return;
      }
      const expiresAt = this.gatewayCredentialExpiresAt(credential);
      if (expiresAt === null) return;
      credentialExpiryTimer = setTimeout(
        scheduleCredentialExpiry,
        Math.max(1, expiresAt - Date.now()),
      );
      credentialExpiryTimer.unref?.();
    };
    request.once("close", close);
    response.once("close", close);
    scheduleCredentialExpiry();
  }

  protected handleMetrics(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }
    const snapshot = this.metrics.snapshot();
    jsonResponse(response, 200, {
      ...snapshot,
      // Ring occupancy and eviction are otherwise invisible: a ring dropping
      // every gap looks exactly like one that never needed to retain anything.
      replay: { ...snapshot.replay, ring: this.eventReplay.getStats() },
    });
  }

  protected async handleClientMetrics(
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

    this.metrics.recordClientBootReport(
      sanitizeClientBootReport(body, request.httpVersion || "1.1"),
    );
    jsonResponse(response, 202, { ok: true });
  }

  protected async handleLoopbackProxy(
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
    await this.proxyToTarget(
      request,
      response,
      new URL(`http://127.0.0.1:${port}${targetPath}`),
      `${API_PREFIX}/proxy/loopback/${port}`,
      false,
      true,
    );
  }

  protected async handleBrowserLoopbackProxy(
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

    const restPath = slashIndex >= 0 ? remaining.slice(slashIndex) : "/";
    const targetPath = `${restPath}${url.search}`;
    await this.proxyToTarget(
      request,
      response,
      new URL(`http://127.0.0.1:${port}${targetPath}`),
      `${API_PREFIX}/browser/loopback/${port}`,
      true,
    );
  }
}
