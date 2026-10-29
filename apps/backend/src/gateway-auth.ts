import type { Duplex } from "node:stream";
import { CONTROLLER_HEADER } from "@orkestrator/protocol/command-nodes";
import {
  isWorkspaceExcludedCommand,
  NODE_RELAY_PREFIX,
  parseRelayPath,
  relayHttp,
  relayUpgrade,
} from "./core/nodes/index.js";

/** Routes a client grant (leaf workspace) may use: the client API only. */
const GRANT_ALLOWED_PATHS = [
  /^\/__orkestrator\/hello$/,
  /^\/__orkestrator\/status$/,
  /^\/__orkestrator\/invoke$/,
  /^\/__orkestrator\/events$/,
  /^\/__orkestrator\/client-metrics$/,
  /^\/__orkestrator\/proxy\/loopback\/\d+(?:\/.*)?$/,
  /^\/__orkestrator\/browser\/loopback\/\d+(?:\/.*)?$/,
];
import type { GatewayContext } from "./gateway-context.js";
import type { GatewayHandlers } from "./gateway-handlers.js";
import type { GatewayLifecycle } from "./gateway-lifecycle.js";
import type { GatewayProxy } from "./gateway-proxy.js";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import {
  GatewayTokenValidationError,
  gatewayTokenCookieHeader,
} from "@orkestrator/protocol/gateway-token";
import {
  AUTH_COOKIE,
  API_PREFIX,
  AGENT_TEST_BOOTSTRAP_TTL_MS,
  AGENT_TEST_SESSION_IDLE_TTL_MS,
  AGENT_TEST_SESSION_MAX_LIFETIME_MS,
  MAX_AGENT_TEST_BOOTSTRAPS,
  MAX_AGENT_TEST_SESSIONS,
  CORS_ALLOWED_METHODS,
  CORS_ALLOWED_HEADERS,
  InvalidRequestBodyError,
  RequestBodyTooLargeError,
  compressionModeForListener,
  headerValueToString,
  parseContentLengthHeader,
  classifyGatewayRoute,
  instrumentGatewayResponse,
  isLoopbackAddress,
  originMatchesRule,
  appendVary,
  appendResponseVary,
  appendHeadersVary,
  responseCompressionContexts,
  jsonResponse,
  textResponse,
  getCookie,
  getBearerToken,
  tokenMatches,
  readJsonBody,
  readLoginToken,
  loginPage,
  wantsHtml,
  browserPreviewRefererPrefix,
} from "./gateway-internals.js";
import type { ListenerKind, GatewayRequestMetrics } from "./gateway-internals.js";
import { parseHostUpdaterReport } from "@orkestrator/protocol/host-maintenance";
import {
  BACKEND_CAPABILITIES,
  BACKEND_HELLO_PATH,
  BACKEND_HELLO_SCHEMA_VERSION,
  CLIENT_API_VERSION,
  parseBackendProfile,
  type BackendHello,
} from "@orkestrator/protocol/backend-profile";
import { parseBackendId } from "@orkestrator/protocol/federation";

/** A host updater report is a handful of bounded fields. */
const HOST_UPDATER_REPORT_MAX_BYTES = 16 * 1024;

/**
 * The route handlers `handle` dispatches to. `GatewayHandlers` calls back into
 * `GatewayAuth` for credential checks, so the facade builds this class first
 * and passes these as callbacks bound late to its `GatewayHandlers`.
 */
export type GatewayRouteHandlers = Pick<
  GatewayHandlers,
  | "handleInvoke"
  | "handleEvents"
  | "handleMetrics"
  | "handleClientMetrics"
  | "handleLoopbackProxy"
  | "handleBrowserLoopbackProxy"
>;

/** Request routing, CORS, credentials, login and the agent-test session flow. */
export class GatewayAuth {
  constructor(
    private readonly ctx: GatewayContext,
    private readonly lifecycle: GatewayLifecycle,
    private readonly handlers: GatewayRouteHandlers,
    private readonly proxy: GatewayProxy,
  ) {}

  authenticated(request: IncomingMessage): boolean {
    const credential = getBearerToken(request.headers) ?? getCookie(request.headers, AUTH_COOKIE);
    return this.gatewayCredentialMatches(credential);
  }

  /** The request is authenticated by a client grant (a leaf workspace), not the gateway token. */
  private authenticatedByGrant(request: IncomingMessage): boolean {
    const credential = getBearerToken(request.headers) ?? getCookie(request.headers, AUTH_COOKIE);
    return Boolean(credential && this.grantExpiresAt(credential) !== null);
  }

  private grantExpiresAt(candidate: string): number | null {
    if (!candidate.startsWith("okg_")) return null;
    return this.ctx.nodeHooks?.authenticateGrant?.(candidate) ?? null;
  }

  /**
   * Terminal upgrades relayed to a leaf (`/__orkestrator/nodes/<id>/terminal`).
   * The caller must already be authenticated here, from an allowed origin.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? "/", "http://orkestrator.local");
    if (!parseRelayPath(url.pathname)) return false;
    const origin = request.headers.origin;
    if (
      !this.ctx.nodeHooks?.relayTarget ||
      (origin && !this.isOriginAllowed(request, origin)) ||
      !this.authenticated(request) ||
      this.authenticatedByGrant(request)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return true;
    }
    const resolve = this.ctx.nodeHooks.relayTarget.bind(this.ctx.nodeHooks);
    if (!relayUpgrade(request, socket, head, url, resolve)) socket.destroy();
    return true;
  }

  private authenticatedWithAgentTestSession(request: IncomingMessage): boolean {
    if (!this.ctx.agentTestMode) return false;
    const credential = getBearerToken(request.headers) ?? getCookie(request.headers, AUTH_COOKIE);
    return Boolean(
      credential &&
      !tokenMatches(this.ctx.token, credential) &&
      this.ctx.agentTestSessions.has(credential),
    );
  }

  gatewayCredentialMatches(candidate: string | null): boolean {
    if (tokenMatches(this.ctx.token, candidate)) return true;
    if (candidate && this.grantExpiresAt(candidate) !== null) return true;
    if (!this.ctx.agentTestMode || !candidate) return false;
    const session = this.ctx.agentTestSessions.get(candidate);
    if (session === undefined) return false;
    const now = Date.now();
    if (session.expiresAt <= now || session.absoluteExpiresAt <= now) {
      this.ctx.agentTestSessions.delete(candidate);
      return false;
    }
    return true;
  }

  /**
   * Current deadline for a credential already accepted by
   * `gatewayCredentialMatches`. Durable gateway tokens have no session
   * deadline; agent-test session cookies are bounded by both clocks.
   */
  gatewayCredentialExpiresAt(candidate: string | null): number | null {
    if (tokenMatches(this.ctx.token, candidate)) return null;
    if (candidate) {
      const grantExpiry = this.grantExpiresAt(candidate);
      if (grantExpiry !== null) return grantExpiry;
    }
    if (!this.ctx.agentTestMode || !candidate) return null;
    const session = this.ctx.agentTestSessions.get(candidate);
    return session ? Math.min(session.expiresAt, session.absoluteExpiresAt) : null;
  }

  refreshAgentTestSession(candidate: string, now = Date.now()): boolean {
    const session = this.ctx.agentTestSessions.get(candidate);
    if (!session || session.expiresAt <= now || session.absoluteExpiresAt <= now) {
      this.ctx.agentTestSessions.delete(candidate);
      return false;
    }
    session.expiresAt = Math.min(now + AGENT_TEST_SESSION_IDLE_TTL_MS, session.absoluteExpiresAt);
    return true;
  }

  pruneAgentTestCredentials(now = Date.now()): void {
    for (const [code, expiresAt] of this.ctx.agentTestBootstraps) {
      if (expiresAt <= now) this.ctx.agentTestBootstraps.delete(code);
    }
    for (const [session, expiry] of this.ctx.agentTestSessions) {
      if (expiry.expiresAt <= now || expiry.absoluteExpiresAt <= now) {
        this.ctx.agentTestSessions.delete(session);
      }
    }
  }

  /**
   * The session that dies soonest. `refreshAgentTestSession` slides `expiresAt`
   * in place, so Map insertion order no longer tracks the deadline the way it did
   * when every session had one fixed TTL: evicting the first key would drop the
   * session a browser is actively using and keep idle ones that lapse seconds
   * later. Ties keep the earlier-inserted entry, which is the old behaviour.
   */
  private nearestAgentTestSession(): string | undefined {
    let nearest: string | undefined;
    let deadline = Number.POSITIVE_INFINITY;
    for (const [session, expiry] of this.ctx.agentTestSessions) {
      const effective = Math.min(expiry.expiresAt, expiry.absoluteExpiresAt);
      if (effective < deadline) {
        deadline = effective;
        nearest = session;
      }
    }
    return nearest;
  }

  issueAgentTestSession(now = Date.now()): string {
    this.pruneAgentTestCredentials(now);
    while (this.ctx.agentTestSessions.size >= MAX_AGENT_TEST_SESSIONS) {
      const evicted = this.nearestAgentTestSession();
      if (!evicted) break;
      this.ctx.agentTestSessions.delete(evicted);
    }
    const session = randomBytes(32).toString("base64url");
    this.ctx.agentTestSessions.set(session, {
      expiresAt: now + AGENT_TEST_SESSION_IDLE_TTL_MS,
      absoluteExpiresAt: now + AGENT_TEST_SESSION_MAX_LIFETIME_MS,
    });
    return session;
  }

  /**
   * A browser-session cookie, deliberately without Max-Age: the server owns the
   * sliding idle window and its absolute cap, so a fixed client-side expiry
   * would only be able to disagree with it.
   */
  agentTestSessionCookie(session: string): string {
    return `${AUTH_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`;
  }

  agentTestLoginHint(): string {
    if (!this.ctx.agentTestMode) return "";
    const profile = this.ctx.agentTestProfile ?? "<profile>";
    return `Development profile "${profile}". On the host, run mise run dev:login --profile ${profile} and open the single-use URL it prints.`;
  }

  isOriginAllowed(request: IncomingMessage, originValue: string): boolean {
    let origin: URL;
    try {
      origin = new URL(originValue);
    } catch {
      return false;
    }

    // Keep the existing renderer served by the backend working without extra
    // configuration, including when TLS is terminated by Tailscale Serve.
    if (request.headers.host && origin.host === request.headers.host) return true;
    if (this.ctx.allowedOrigins.some((rule) => originMatchesRule(origin, rule))) return true;
    // Portals of attached command nodes reach this leaf directly.
    return this.ctx.nodeHooks?.isPortalOriginAllowed(originValue) ?? false;
  }

  applyCorsHeaders(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    if (!this.isOriginAllowed(request, origin)) return false;

    response.setHeader("access-control-allow-origin", origin);
    appendResponseVary(response, "Origin");
    return true;
  }

  handleCorsPreflight(request: IncomingMessage, response: ServerResponse): void {
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
      vary: appendVary(null, "Origin, Access-Control-Request-Private-Network"),
    });
    response.end();
  }

  handleBrowserPreviewCorsPreflight(request: IncomingMessage, response: ServerResponse): void {
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

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    listenerKind: ListenerKind,
  ): Promise<void> {
    responseCompressionContexts.set(response, {
      mode: compressionModeForListener(this.ctx.compression, listenerKind),
      acceptEncoding: headerValueToString(request.headers["accept-encoding"]),
    });
    const url = new URL(request.url ?? "/", "http://orkestrator.local");
    const route = classifyGatewayRoute(url.pathname);
    const requestMetrics = this.ctx.metrics.beginRequest({
      route,
      listenerKind,
      method: request.method ?? "GET",
      httpVersion: request.httpVersion || "1.1",
      acceptEncoding: headerValueToString(request.headers["accept-encoding"]),
      effectiveCompressionMode: compressionModeForListener(this.ctx.compression, listenerKind),
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
    } else if (
      url.pathname.startsWith(`${API_PREFIX}/`) &&
      !this.applyCorsHeaders(request, response)
    ) {
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

    if (url.pathname === `${API_PREFIX}/agent-test/login`) {
      this.handleAgentTestLoginLink(request, response, url, listenerKind);
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
        textResponse(
          response,
          401,
          loginPage("", this.agentTestLoginHint()),
          "text/html; charset=utf-8",
        );
      } else {
        jsonResponse(response, 401, { error: "Authentication required" });
      }
      return;
    }

    const controllerId = headerValueToString(request.headers[CONTROLLER_HEADER]);
    if (controllerId) this.ctx.nodeHooks?.noteControllerContact(controllerId);

    // A client grant opens a leaf workspace: the client API only, never
    // administration, the relay or this node's own settings.
    const viaGrant = this.authenticatedByGrant(request);
    if (viaGrant && !GRANT_ALLOWED_PATHS.some((pattern) => pattern.test(url.pathname))) {
      jsonResponse(response, 403, { error: "A workspace grant cannot use this route." });
      return;
    }

    if (url.pathname.startsWith(NODE_RELAY_PREFIX)) {
      const resolve = this.ctx.nodeHooks?.relayTarget;
      if (
        !resolve ||
        !(await relayHttp(request, response, url, resolve.bind(this.ctx.nodeHooks)))
      ) {
        jsonResponse(response, 404, { error: "Not found" });
      }
      return;
    }

    if (url.pathname === `${API_PREFIX}/agent-test/session`) {
      this.handleAgentTestSession(request, response, listenerKind);
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
      if (listenerKind !== "control" || !this.ctx.webClientControl) {
        jsonResponse(response, 404, { error: "Not found" });
        return;
      }
      await this.handleWebClientAccess(request, response, requestMetrics);
      return;
    }

    if (url.pathname === `${API_PREFIX}/host-updater`) {
      if (listenerKind !== "control" || !this.ctx.hostUpdaterControl) {
        jsonResponse(response, 404, { error: "Not found" });
        return;
      }
      await this.handleHostUpdater(request, response, requestMetrics);
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

    if (url.pathname === BACKEND_HELLO_PATH) {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" });
        response.end();
        return;
      }
      await this.handleHello(response, listenerKind);
      return;
    }

    if (url.pathname === `${API_PREFIX}/invoke`) {
      await this.handlers.handleInvoke(
        request,
        response,
        requestMetrics,
        viaGrant
          ? { refuseCommand: isWorkspaceExcludedCommand }
          : controllerId
            ? { controllerId }
            : undefined,
      );
      return;
    }

    if (url.pathname === `${API_PREFIX}/events`) {
      this.handlers.handleEvents(request, response, url);
      return;
    }

    if (url.pathname === `${API_PREFIX}/metrics`) {
      this.handlers.handleMetrics(request, response);
      return;
    }

    if (url.pathname === `${API_PREFIX}/client-metrics`) {
      await this.handlers.handleClientMetrics(request, response, requestMetrics);
      return;
    }

    if (url.pathname.startsWith(`${API_PREFIX}/proxy/loopback/`)) {
      await this.handlers.handleLoopbackProxy(request, response, url);
      return;
    }

    if (url.pathname.startsWith(`${API_PREFIX}/browser/loopback/`)) {
      await this.handlers.handleBrowserLoopbackProxy(request, response, url);
      return;
    }

    await this.proxy.serveStatic(
      request,
      url,
      response,
      compressionModeForListener(this.ctx.compression, listenerKind) !== "off",
    );
  }

  /**
   * The authenticated client handshake: safe identity, version and
   * capability metadata, plus which kind of listener answered. A managed SSH
   * route verifies `endpointRole` is `client` before it trusts the forward.
   * Never paths, the auth file, the token or the process ID.
   */
  async handleHello(response: ServerResponse, listenerKind: ListenerKind): Promise<void> {
    if (!this.ctx.backendHello) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    const identity = await this.ctx.backendHello();
    const capabilities: Record<string, number> = {
      [BACKEND_CAPABILITIES.backendProfile]: 1,
      [BACKEND_CAPABILITIES.summaryReads]: 1,
    };
    if (this.ctx.loopbackClientUrl) capabilities[BACKEND_CAPABILITIES.loopbackClientGateway] = 1;
    if (identity.nodeMode) {
      capabilities[BACKEND_CAPABILITIES.nodeAttachment] = 1;
      capabilities[BACKEND_CAPABILITIES.publicActionRelay] = 1;
    }
    const hello: BackendHello = {
      schemaVersion: BACKEND_HELLO_SCHEMA_VERSION,
      installationId: parseBackendId(identity.installationId, "installationId"),
      generation: identity.generation,
      appVersion: identity.appVersion,
      clientApi: { minVersion: 1, maxVersion: CLIENT_API_VERSION },
      capabilities,
      profile: parseBackendProfile(identity.profile),
      endpointRole: listenerKind === "control" ? "control" : "client",
    };
    if (identity.nodeMode) hello.nodeMode = identity.nodeMode;
    jsonResponse(response, 200, hello, { "cache-control": "no-store" });
  }

  async handleGatewaySettings(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    // Agent-test sessions intentionally keep the durable gateway token out of
    // the browser. Do not let that scoped credential read or rotate it here.
    if (this.authenticatedWithAgentTestSession(request)) {
      jsonResponse(response, 403, { error: "Gateway settings require the durable credential" });
      return;
    }
    if (request.method === "GET") {
      jsonResponse(response, 200, await this.lifecycle.getTokenSettings());
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
      const settings = await this.lifecycle.setToken(body.token);
      jsonResponse(response, 200, settings, {
        "set-cookie": gatewayTokenCookieHeader(settings.token),
      });
    } catch (error) {
      if (error instanceof GatewayTokenValidationError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      this.ctx.logger.error("[RemoteGateway] Failed to persist gateway token:", error);
      jsonResponse(response, 500, { error: "Unable to persist gateway token" });
    }
  }

  async handleWebClientAccess(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    if (!this.ctx.webClientControl) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method === "GET") {
      jsonResponse(response, 200, this.ctx.webClientControl.getStatus());
      return;
    }
    if (request.method === "DELETE") {
      jsonResponse(response, 200, await this.ctx.webClientControl.resetServe());
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
    jsonResponse(response, 200, await this.ctx.webClientControl.setEnabled(body.enabled));
  }

  async handleHostUpdater(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    const control = this.ctx.hostUpdaterControl;
    if (!control) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method === "GET") {
      jsonResponse(response, 200, await control.snapshot());
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(request, HOST_UPDATER_REPORT_MAX_BYTES);
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
    const report = parseHostUpdaterReport(body);
    if (!report) {
      jsonResponse(response, 400, { error: "Malformed host updater report" });
      return;
    }
    jsonResponse(response, 200, control.report(report));
  }

  async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET") {
      textResponse(
        response,
        200,
        loginPage("", this.agentTestLoginHint()),
        "text/html; charset=utf-8",
      );
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
      return;
    }

    let token: string;
    try {
      token = await readLoginToken(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        textResponse(
          response,
          413,
          loginPage("Login request is too large.", this.agentTestLoginHint()),
          "text/html; charset=utf-8",
        );
        return;
      }
      throw error;
    }
    if (!tokenMatches(this.ctx.token, token)) {
      textResponse(
        response,
        401,
        loginPage("Invalid gateway token.", this.agentTestLoginHint()),
        "text/html; charset=utf-8",
      );
      return;
    }

    const cookie = this.ctx.agentTestMode
      ? this.agentTestSessionCookie(this.issueAgentTestSession())
      : gatewayTokenCookieHeader(this.ctx.token);
    response.writeHead(303, {
      location: "/",
      "set-cookie": cookie,
      "cache-control": "no-store",
    });
    response.end();
  }

  agentTestBootstrapAllowed(request: IncomingMessage, listenerKind: ListenerKind): boolean {
    return (
      this.ctx.agentTestMode &&
      listenerKind === "browser" &&
      Boolean(request.socket.remoteAddress && isLoopbackAddress(request.socket.remoteAddress))
    );
  }

  async handleAgentTestBootstrapMint(
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
    while (this.ctx.agentTestBootstraps.size >= MAX_AGENT_TEST_BOOTSTRAPS) {
      const oldest = this.ctx.agentTestBootstraps.keys().next().value as string | undefined;
      if (!oldest) break;
      this.ctx.agentTestBootstraps.delete(oldest);
    }
    const code = randomBytes(32).toString("base64url");
    const expiresAt = now + AGENT_TEST_BOOTSTRAP_TTL_MS;
    this.ctx.agentTestBootstraps.set(code, expiresAt);
    jsonResponse(response, 201, { code, expiresAt }, { "cache-control": "no-store" });
  }

  /**
   * Detects an agent-test cookie session and renews it only after explicit
   * browser activity. Ordinary API polling deliberately does not touch the
   * idle clock.
   */
  handleAgentTestSession(
    request: IncomingMessage,
    response: ServerResponse,
    listenerKind: ListenerKind,
  ): void {
    if (!this.agentTestBootstrapAllowed(request, listenerKind)) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    const session = getCookie(request.headers, AUTH_COOKIE);
    if (!session || !this.ctx.agentTestSessions.has(session)) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method === "GET") {
      jsonResponse(response, 200, { active: true }, { "cache-control": "no-store" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
      return;
    }
    if (!this.refreshAgentTestSession(session)) {
      jsonResponse(response, 401, { error: "Agent-test session expired" });
      return;
    }
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }

  async handleAgentTestBootstrapExchange(
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
    if (!this.consumeAgentTestBootstrap(typeof body.code === "string" ? body.code : "")) {
      jsonResponse(response, 401, { error: "Bootstrap code is invalid or expired" });
      return;
    }
    const session = this.issueAgentTestSession();
    jsonResponse(
      response,
      200,
      { ok: true },
      {
        "cache-control": "no-store",
        "set-cookie": this.agentTestSessionCookie(session),
      },
    );
  }

  /** Redeems a bootstrap code exactly once, whichever route presented it. */
  consumeAgentTestBootstrap(code: string): boolean {
    const expiresAt = this.ctx.agentTestBootstraps.get(code);
    this.ctx.agentTestBootstraps.delete(code);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  /**
   * One-shot browser login link for agent-driven QA.
   *
   * Only the single-use bootstrap code travels in the URL, never the durable
   * gateway token, and only on a dev profile's loopback browser listener. It is
   * consumed by the first request that presents it and answered with a redirect
   * to the app, so the credential neither survives in the address bar nor
   * travels onward in a Referer.
   */
  handleAgentTestLoginLink(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    listenerKind: ListenerKind,
  ): void {
    if (!this.agentTestBootstrapAllowed(request, listenerKind)) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }
    if (!this.consumeAgentTestBootstrap(url.searchParams.get("code") ?? "")) {
      textResponse(
        response,
        401,
        loginPage(
          "That login link was already used or has expired. Mint a fresh one.",
          this.agentTestLoginHint(),
        ),
        "text/html; charset=utf-8",
      );
      return;
    }
    response.writeHead(303, {
      location: "/",
      "set-cookie": this.agentTestSessionCookie(this.issueAgentTestSession()),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    response.end();
  }

  /**
   * Whether a failed command may be retained as a metric label.
   *
   * `hasCommand` is authoritative when the backend provides it. Backends that
   * do not — only test stubs, in practice — fall back to the registry's error
   * contract, which is what this check replaced.
   */
}
