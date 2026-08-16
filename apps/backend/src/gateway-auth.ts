import { GatewayEvents } from "./gateway-events.js";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { GatewayTokenValidationError, gatewayTokenCookieHeader } from "@orkestrator/protocol/gateway-token";
import { AUTH_COOKIE, API_PREFIX, AGENT_TEST_BOOTSTRAP_TTL_MS, AGENT_TEST_SESSION_TTL_MS, MAX_AGENT_TEST_BOOTSTRAPS, MAX_AGENT_TEST_SESSIONS, CORS_ALLOWED_METHODS, CORS_ALLOWED_HEADERS, InvalidRequestBodyError, RequestBodyTooLargeError, compressionModeForListener, headerValueToString, parseContentLengthHeader, classifyGatewayRoute, instrumentGatewayResponse, isLoopbackAddress, originMatchesRule, appendVary, appendResponseVary, appendHeadersVary, responseCompressionContexts, jsonResponse, textResponse, getCookie, getBearerToken, tokenMatches, readJsonBody, readLoginToken, loginPage, wantsHtml, browserPreviewRefererPrefix } from "./gateway-internals.js";
import type { ListenerKind, GatewayRequestMetrics } from "./gateway-internals.js";

export abstract class GatewayAuth extends GatewayEvents {
  protected authenticated(request: IncomingMessage): boolean {
    const credential = getBearerToken(request.headers) ?? getCookie(request.headers, AUTH_COOKIE);
    return this.gatewayCredentialMatches(credential);
  }

  protected gatewayCredentialMatches(candidate: string | null): boolean {
    if (tokenMatches(this.token, candidate)) return true;
    if (!this.agentTestMode || !candidate) return false;
    const expiresAt = this.agentTestSessions.get(candidate);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.agentTestSessions.delete(candidate);
      return false;
    }
    return true;
  }

  protected pruneAgentTestCredentials(now = Date.now()): void {
    for (const [code, expiresAt] of this.agentTestBootstraps) {
      if (expiresAt <= now) this.agentTestBootstraps.delete(code);
    }
    for (const [session, expiresAt] of this.agentTestSessions) {
      if (expiresAt <= now) this.agentTestSessions.delete(session);
    }
  }

  protected issueAgentTestSession(now = Date.now()): string {
    this.pruneAgentTestCredentials(now);
    while (this.agentTestSessions.size >= MAX_AGENT_TEST_SESSIONS) {
      const oldest = this.agentTestSessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.agentTestSessions.delete(oldest);
    }
    const session = randomBytes(32).toString("base64url");
    this.agentTestSessions.set(session, now + AGENT_TEST_SESSION_TTL_MS);
    return session;
  }

  protected agentTestSessionCookie(session: string): string {
    return `${AUTH_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(AGENT_TEST_SESSION_TTL_MS / 1000)}`;
  }

  protected isOriginAllowed(request: IncomingMessage, originValue: string): boolean {
    let origin: URL;
    try {
      origin = new URL(originValue);
    } catch {
      return false;
    }

    // Keep the existing renderer served by the backend working without extra
    // configuration, including when TLS is terminated by Tailscale Serve.
    if (request.headers.host && origin.host === request.headers.host) return true;
    return this.allowedOrigins.some((rule) => originMatchesRule(origin, rule));
  }

  protected applyCorsHeaders(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    if (!this.isOriginAllowed(request, origin)) return false;

    response.setHeader("access-control-allow-origin", origin);
    appendResponseVary(response, "Origin");
    return true;
  }

  protected handleCorsPreflight(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (!origin || !this.isOriginAllowed(request, origin)) {
      jsonResponse(response, 403, { error: "Origin not allowed" });
      return;
    }

    response.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": CORS_ALLOWED_METHODS,
      "access-control-allow-headers": CORS_ALLOWED_HEADERS,
      "access-control-max-age": "600",
      ...(request.headers["access-control-request-private-network"] === "true"
        ? { "access-control-allow-private-network": "true" }
        : {}),
      vary: appendVary(
        null,
        "Origin, Access-Control-Request-Private-Network",
      ),
    });
    response.end();
  }

  protected handleBrowserPreviewCorsPreflight(request: IncomingMessage, response: ServerResponse): void {
    const requestedHeaders = request.headers["access-control-request-headers"];
    const allowedHeaders = Array.isArray(requestedHeaders)
      ? requestedHeaders.join(", ")
      : requestedHeaders?.trim() || CORS_ALLOWED_HEADERS;
    response.writeHead(204, {
      "access-control-allow-origin": "null",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": CORS_ALLOWED_METHODS,
      "access-control-allow-headers": allowedHeaders,
      "access-control-max-age": "600",
      ...(request.headers["access-control-request-private-network"] === "true"
        ? { "access-control-allow-private-network": "true" }
        : {}),
      vary: appendVary(
        null,
        "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
      ),
    });
    response.end();
  }

  protected async handle(
    request: IncomingMessage,
    response: ServerResponse,
    listenerKind: ListenerKind,
  ): Promise<void> {
    responseCompressionContexts.set(response, {
      mode: compressionModeForListener(this.compression, listenerKind),
      acceptEncoding: headerValueToString(request.headers["accept-encoding"]),
    });
    const url = new URL(request.url ?? "/", "http://orkestrator.local");
    const route = classifyGatewayRoute(url.pathname);
    const requestMetrics = this.metrics.beginRequest({
      route,
      listenerKind,
      method: request.method ?? "GET",
      httpVersion: request.httpVersion || "1.1",
      acceptEncoding: headerValueToString(request.headers["accept-encoding"]),
      effectiveCompressionMode: compressionModeForListener(this.compression, listenerKind),
      requestBytes: parseContentLengthHeader(request.headers["content-length"]),
    });
    instrumentGatewayResponse(response, (responseBytes) => {
      requestMetrics.finish(response, responseBytes);
    });
    const isBrowserPreviewRequest = url.pathname.startsWith(`${API_PREFIX}/browser/loopback/`);

    if (request.method === "OPTIONS" && url.pathname.startsWith(`${API_PREFIX}/`)) {
      if (isBrowserPreviewRequest && request.headers.origin === "null") {
        this.handleBrowserPreviewCorsPreflight(request, response);
      } else {
        this.handleCorsPreflight(request, response);
      }
      return;
    }

    if (isBrowserPreviewRequest && request.headers.origin === "null") {
      response.setHeader("access-control-allow-origin", "null");
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "Origin");
    } else if (url.pathname.startsWith(`${API_PREFIX}/`) && !this.applyCorsHeaders(request, response)) {
      jsonResponse(response, 403, { error: "Origin not allowed" });
      return;
    }

    // Root-relative requests issued by a preview document (fetch("/api"),
    // runtime-built asset URLs) escape the preview namespace; steer them back
    // via their Referer. Runs before authentication on purpose: the redirect
    // is a deterministic transform of the request's own headers, and the
    // redirected request still has to pass the preview namespace's auth.
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
      const previewPrefix = browserPreviewRefererPrefix(request);
      if (previewPrefix) {
        if (request.method === "OPTIONS" && request.headers.origin === "null") {
          this.handleBrowserPreviewCorsPreflight(request, response);
          return;
        }
        const redirectHeaders: OutgoingHttpHeaders = {
          location: `${previewPrefix}${url.pathname}${url.search}`,
          "cache-control": "no-store",
          vary: appendVary(null, "Referer"),
        };
        if (request.headers.origin === "null") {
          redirectHeaders["access-control-allow-origin"] = "null";
          redirectHeaders["access-control-allow-credentials"] = "true";
          appendHeadersVary(redirectHeaders, "Origin");
        }
        response.writeHead(307, redirectHeaders);
        response.end();
        return;
      }
    }

    if (url.pathname === `${API_PREFIX}/login`) {
      await this.handleLogin(request, response);
      return;
    }

    if (url.pathname === `${API_PREFIX}/agent-test/bootstrap/exchange`) {
      await this.handleAgentTestBootstrapExchange(request, response, listenerKind);
      return;
    }

    if (url.pathname === `${API_PREFIX}/logout`) {
      response.writeHead(303, {
        location: `${API_PREFIX}/login`,
        "set-cookie": `${AUTH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    if (!this.authenticated(request)) {
      if (wantsHtml(request) && request.method === "GET") {
        textResponse(response, 401, loginPage(), "text/html; charset=utf-8");
      } else {
        jsonResponse(response, 401, { error: "Authentication required" });
      }
      return;
    }

    if (url.pathname === `${API_PREFIX}/agent-test/bootstrap`) {
      await this.handleAgentTestBootstrapMint(request, response, listenerKind);
      return;
    }

    if (url.pathname === `${API_PREFIX}/gateway-settings`) {
      await this.handleGatewaySettings(request, response, requestMetrics);
      return;
    }

    if (url.pathname === `${API_PREFIX}/web-client-access`) {
      if (listenerKind !== "control" || !this.webClientControl) {
        jsonResponse(response, 404, { error: "Not found" });
        return;
      }
      await this.handleWebClientAccess(request, response, requestMetrics);
      return;
    }

    if (url.pathname === `${API_PREFIX}/status`) {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" });
        response.end();
        return;
      }
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (url.pathname === `${API_PREFIX}/invoke`) {
      await this.handleInvoke(request, response, requestMetrics);
      return;
    }

    if (url.pathname === `${API_PREFIX}/events`) {
      this.handleEvents(request, response, url);
      return;
    }

    if (url.pathname === `${API_PREFIX}/metrics`) {
      this.handleMetrics(request, response);
      return;
    }

    if (url.pathname === `${API_PREFIX}/client-metrics`) {
      await this.handleClientMetrics(request, response, requestMetrics);
      return;
    }

    if (url.pathname.startsWith(`${API_PREFIX}/proxy/loopback/`)) {
      await this.handleLoopbackProxy(request, response, url);
      return;
    }

    if (url.pathname.startsWith(`${API_PREFIX}/browser/loopback/`)) {
      await this.handleBrowserLoopbackProxy(request, response, url);
      return;
    }

    await this.serveStatic(
      request,
      url,
      response,
      compressionModeForListener(this.compression, listenerKind) !== "off",
    );
  }

  protected async handleGatewaySettings(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    if (request.method === "GET") {
      jsonResponse(response, 200, await this.getTokenSettings());
      return;
    }
    if (request.method !== "PUT") {
      response.writeHead(405, { allow: "GET, PUT" });
      response.end();
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(request);
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
    if (typeof body.token !== "string") {
      jsonResponse(response, 400, { error: "Expected token to be a string" });
      return;
    }

    try {
      const settings = await this.setToken(body.token);
      jsonResponse(response, 200, settings, { "set-cookie": gatewayTokenCookieHeader(settings.token) });
    } catch (error) {
      if (error instanceof GatewayTokenValidationError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      this.logger.error("[RemoteGateway] Failed to persist gateway token:", error);
      jsonResponse(response, 500, { error: "Unable to persist gateway token" });
    }
  }

  protected async handleWebClientAccess(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    if (!this.webClientControl) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method === "GET") {
      jsonResponse(response, 200, this.webClientControl.getStatus());
      return;
    }
    if (request.method === "DELETE") {
      jsonResponse(response, 200, await this.webClientControl.resetServe());
      return;
    }
    if (request.method !== "PUT") {
      response.writeHead(405, { allow: "GET, PUT, DELETE" });
      response.end();
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(request);
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
    if (typeof body.enabled !== "boolean") {
      jsonResponse(response, 400, { error: "Expected enabled to be a boolean" });
      return;
    }
    jsonResponse(response, 200, await this.webClientControl.setEnabled(body.enabled));
  }

  protected async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET") {
      textResponse(response, 200, loginPage(), "text/html; charset=utf-8");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
      return;
    }

    const token = await readLoginToken(request);
    if (!tokenMatches(this.token, token)) {
      textResponse(response, 401, loginPage("Invalid gateway token."), "text/html; charset=utf-8");
      return;
    }

    const cookie = this.agentTestMode
      ? this.agentTestSessionCookie(this.issueAgentTestSession())
      : gatewayTokenCookieHeader(this.token);
    response.writeHead(303, {
      location: "/",
      "set-cookie": cookie,
      "cache-control": "no-store",
    });
    response.end();
  }

  protected agentTestBootstrapAllowed(request: IncomingMessage, listenerKind: ListenerKind): boolean {
    return this.agentTestMode
      && listenerKind === "browser"
      && Boolean(request.socket.remoteAddress && isLoopbackAddress(request.socket.remoteAddress));
  }

  protected async handleAgentTestBootstrapMint(
    request: IncomingMessage,
    response: ServerResponse,
    listenerKind: ListenerKind,
  ): Promise<void> {
    if (!this.agentTestBootstrapAllowed(request, listenerKind)) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    const now = Date.now();
    this.pruneAgentTestCredentials(now);
    while (this.agentTestBootstraps.size >= MAX_AGENT_TEST_BOOTSTRAPS) {
      const oldest = this.agentTestBootstraps.keys().next().value as string | undefined;
      if (!oldest) break;
      this.agentTestBootstraps.delete(oldest);
    }
    const code = randomBytes(32).toString("base64url");
    const expiresAt = now + AGENT_TEST_BOOTSTRAP_TTL_MS;
    this.agentTestBootstraps.set(code, expiresAt);
    jsonResponse(response, 201, { code, expiresAt }, { "cache-control": "no-store" });
  }

  protected async handleAgentTestBootstrapExchange(
    request: IncomingMessage,
    response: ServerResponse,
    listenerKind: ListenerKind,
  ): Promise<void> {
    if (!this.agentTestBootstrapAllowed(request, listenerKind)) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    let body: Record<string, unknown>;
    try {
      ({ body } = await readJsonBody(request, 4096));
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
    const code = typeof body.code === "string" ? body.code : "";
    const expiresAt = this.agentTestBootstraps.get(code);
    this.agentTestBootstraps.delete(code);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      jsonResponse(response, 401, { error: "Bootstrap code is invalid or expired" });
      return;
    }
    const session = this.issueAgentTestSession();
    jsonResponse(response, 200, { ok: true }, {
      "cache-control": "no-store",
      "set-cookie": this.agentTestSessionCookie(session),
    });
  }

  /**
   * Whether a failed command may be retained as a metric label.
   *
   * `hasCommand` is authoritative when the backend provides it. Backends that
   * do not — only test stubs, in practice — fall back to the registry's error
   * contract, which is what this check replaced.
   */
}
