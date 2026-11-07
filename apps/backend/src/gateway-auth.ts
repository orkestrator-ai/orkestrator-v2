import type { Duplex } from "node:stream";
import { CONTROLLER_HEADER } from "@orkestrator/protocol/command-nodes";
import {
  admitsWorkspaceCommand,
  NODE_RELAY_PREFIX,
  parseRelayPath,
  relayHttp,
  relayUpgrade,
} from "./core/nodes/index.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { MULTIPLEXED_RELAY_EVENTS_PATH } from "@orkestrator/protocol/multiplexed-relay-events";

const log = createLogger("gateway");

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
import { GatewayTokenValidationError } from "@orkestrator/protocol/gateway-token";
import type { GuessPeer } from "./gateway-credential-throttle.js";
import { REFUSED_HOST_MESSAGE } from "./gateway-host-policy.js";
import {
  clearedGatewayCookies,
  gatewayRequestCredential,
  gatewaySessionCookie,
  getGatewayAuthCookie,
  requestIsHttps,
} from "./gateway-sessions.js";
import {
  API_PREFIX,
  AGENT_TEST_BOOTSTRAP_TTL_MS,
  BROWSER_PREVIEW_SANDBOX_CSP,
  MAX_AGENT_TEST_BOOTSTRAPS,
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
  getBearerToken,
  tokenMatches,
  readJsonBody,
  readLoginToken,
  loginPage,
  loginPageResponse,
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

function throttledMessage(retryAfterSeconds: number): string {
  return `Too many wrong gateway tokens. Try again in ${retryAfterSeconds} ${retryAfterSeconds === 1 ? "second" : "seconds"}.`;
}

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
    return this.requestCredentialMatches(request);
  }

  /**
   * A bearer header may carry any gateway credential. The cookie only ever
   * carries a browser session or a client grant: the durable token in a cookie
   * (what older gateways issued) is refused, because a cookie is sent to every
   * port on the host and so is never the place for it.
   */
  requestCredentialMatches(request: IncomingMessage): boolean {
    const bearer = getBearerToken(request.headers);
    if (bearer) return this.gatewayCredentialMatches(bearer, request);
    return this.cookieCredentialMatches(getGatewayAuthCookie(request.headers));
  }

  private cookieCredentialMatches(candidate: string | null): boolean {
    if (!candidate) return false;
    if (this.grantExpiresAt(candidate) !== null) return true;
    return this.ctx.browserSessions.matches(candidate);
  }

  /** The request is authenticated by a client grant (a leaf workspace), not the gateway token. */
  private authenticatedByGrant(request: IncomingMessage): boolean {
    const credential = gatewayRequestCredential(request.headers);
    return Boolean(credential && this.grantExpiresAt(credential) !== null);
  }

  /** Only the durable token, sent as a bearer header, may read or rotate itself. */
  private authenticatedWithDurableBearer(request: IncomingMessage): boolean {
    return tokenMatches(this.ctx.token, getBearerToken(request.headers));
  }

  /**
   * The workspace allow-list a client grant and the relay share: only
   * commands this backend defines with `access: "workspace"`, failing closed.
   */
  private admitsWorkspaceCommand(command: string, path: "grant" | "relay"): boolean {
    const backend = this.ctx.backend;
    return admitsWorkspaceCommand(command, path, {
      accessOf: backend.commandAccess?.bind(backend),
      isRegistered: backend.hasCommand?.bind(backend),
    });
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

  /**
   * Grants and sessions are random, so they are tried first and never count as
   * guesses; only what is left can be an attempt at the durable token.
   */
  gatewayCredentialMatches(candidate: string | null, request: GuessPeer): boolean {
    if (!candidate) return false;
    if (this.grantExpiresAt(candidate) !== null) return true;
    if (this.ctx.browserSessions.matches(candidate)) return true;
    return this.durableCredentialOutcome(candidate, request) === "match";
  }

  /**
   * A lapsed random credential must not spend the durable-token guess budget.
   * Durable tokens are user chosen, so exempt a credential shape only when the
   * configured token cannot have that shape. Otherwise it still needs throttling.
   * Apply this to stale cookies too, including the legacy-token migration check.
   */
  private durableCredentialOutcome(candidate: string, request: GuessPeer) {
    for (const shape of [/^[A-Za-z0-9_-]{43}$/, /^okg_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/]) {
      if (shape.test(candidate) && !shape.test(this.ctx.token)) return "wrong";
    }
    return this.ctx.credentialThrottle.check(this.ctx.token, candidate, request);
  }

  /**
   * Current deadline for a credential already accepted by
   * `gatewayCredentialMatches`. Durable gateway tokens have no session
   * deadline; browser sessions are bounded by both of their clocks.
   */
  gatewayCredentialExpiresAt(candidate: string | null): number | null {
    if (tokenMatches(this.ctx.token, candidate)) return null;
    if (candidate) {
      const grantExpiry = this.grantExpiresAt(candidate);
      if (grantExpiry !== null) return grantExpiry;
    }
    return candidate ? this.ctx.browserSessions.expiresAt(candidate) : null;
  }

  pruneAgentTestBootstraps(now = Date.now()): void {
    for (const [code, expiresAt] of this.ctx.agentTestBootstraps) {
      if (expiresAt <= now) this.ctx.agentTestBootstraps.delete(code);
    }
  }

  /** Mints a browser session and the cookie that carries it to this request's browser. */
  issueSessionCookie(request: IncomingMessage): string {
    return gatewaySessionCookie(this.ctx.browserSessions.issue(), requestIsHttps(request));
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
    // A wildcard, never `null` with credentials: every sandboxed document
    // shares the `null` origin, so a credentialed grant to it would let any
    // preview read another port's authenticated responses (M2).
    response.writeHead(204, {
      "access-control-allow-origin": "*",
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
    this.ctx.traffic.noteRequest(
      request,
      url.pathname.startsWith(NODE_RELAY_PREFIX) ? "node-relay" : route,
    );
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
    if (!this.ctx.hostPolicy.allows(request.headers.host)) {
      jsonResponse(response, 421, { error: REFUSED_HOST_MESSAGE });
      return;
    }
    const isBrowserPreviewRequest = url.pathname.startsWith(`${API_PREFIX}/browser/loopback/`);
    // Legacy previews serve agent-controlled HTML on the gateway's own origin.
    // Sandboxing every response keeps such a document opaque-origin even when
    // it is opened top-level, outside the client's sandboxed iframe, so it can
    // never call gateway routes as the signed-in user. Error and login pages
    // under the prefix get it too: nothing there needs the gateway origin.
    if (isBrowserPreviewRequest) {
      response.setHeader("content-security-policy", BROWSER_PREVIEW_SANDBOX_CSP);
    }

    if (request.method === "OPTIONS" && url.pathname.startsWith(`${API_PREFIX}/`)) {
      if (isBrowserPreviewRequest && request.headers.origin === "null") {
        this.handleBrowserPreviewCorsPreflight(request, response);
      } else {
        this.handleCorsPreflight(request, response);
      }
      return;
    }

    if (isBrowserPreviewRequest && request.headers.origin === "null") {
      response.setHeader("access-control-allow-origin", "*");
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
          redirectHeaders["access-control-allow-origin"] = "*";
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
      const session = getGatewayAuthCookie(request.headers);
      if (session) this.ctx.browserSessions.revoke(session);
      response.writeHead(303, {
        location: `${API_PREFIX}/login`,
        "set-cookie": clearedGatewayCookies(requestIsHttps(request)),
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    if (!this.authenticated(request)) {
      this.refuseUnauthenticated(request, response);
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

    // Several relayed leaves' main streams on one request (plan item 5005).
    // Without the hooks it answers 404 below, as an older command node does.
    if (url.pathname === MULTIPLEXED_RELAY_EVENTS_PATH && this.ctx.nodeEventMultiplexer) {
      this.ctx.nodeEventMultiplexer.serve(request, response, url);
      return;
    }

    if (url.pathname.startsWith(NODE_RELAY_PREFIX)) {
      const resolve = this.ctx.nodeHooks?.relayTarget;
      if (
        !resolve ||
        !(await relayHttp(request, response, url, resolve.bind(this.ctx.nodeHooks), (command) =>
          this.admitsWorkspaceCommand(command, "relay"),
        ))
      ) {
        jsonResponse(response, 404, { error: "Not found" });
      }
      return;
    }

    if (url.pathname === `${API_PREFIX}/session`) {
      this.handleBrowserSession(request, response);
      return;
    }

    if (url.pathname === `${API_PREFIX}/agent-test/session`) {
      if (!this.agentTestBootstrapAllowed(request, listenerKind)) {
        jsonResponse(response, 404, { error: "Not found" });
        return;
      }
      this.handleBrowserSession(request, response);
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
          ? { refuseCommand: (command: string) => !this.admitsWorkspaceCommand(command, "grant") }
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
   * A browser whose cookie no longer authenticates gets the login page with a
   * reason, never a blank failure. A cookie holding the durable token (what
   * gateways before opaque sessions issued) is also expired on the way, so the
   * token stops travelling to every other port on this host. Expiring it answers
   * whether the value was the token, so that comparison is throttled like any
   * other. A bearer refused by the throttle is told to wait, not that it is wrong.
   */
  private refuseUnauthenticated(request: IncomingMessage, response: ServerResponse): void {
    const throttle = this.ctx.credentialThrottle;
    const bearer = getBearerToken(request.headers);
    if (bearer && this.durableCredentialOutcome(bearer, request) === "throttled") {
      const retryAfter = throttle.retryAfterSeconds(request);
      jsonResponse(
        response,
        429,
        { error: throttledMessage(retryAfter) },
        { "retry-after": String(retryAfter) },
      );
      return;
    }
    const staleCookie = getGatewayAuthCookie(request.headers);
    if (staleCookie && this.durableCredentialOutcome(staleCookie, request) === "match") {
      response.setHeader("set-cookie", clearedGatewayCookies(requestIsHttps(request)));
    }
    if (wantsHtml(request) && request.method === "GET") {
      const notice = staleCookie
        ? "Your browser session has ended. Enter the gateway token to sign in again."
        : "";
      loginPageResponse(response, 401, loginPage(notice, this.agentTestLoginHint()));
    } else {
      jsonResponse(response, 401, { error: "Authentication required" });
    }
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
      capabilities[BACKEND_CAPABILITIES.nodeMailSteer] = 1;
      capabilities[BACKEND_CAPABILITIES.nodeMailTurnOrigin] = 1;
      capabilities[BACKEND_CAPABILITIES.nodeCoordinatorMail] = 1;
      capabilities[BACKEND_CAPABILITIES.nodeCoordinatorBuildOrigin] = 1;
      capabilities[BACKEND_CAPABILITIES.coordinatorNotices] = 1;
      capabilities[BACKEND_CAPABILITIES.nodeMailAttachments] = 1;
      capabilities[BACKEND_CAPABILITIES.nodeMailReturn] = 1;
      capabilities[BACKEND_CAPABILITIES.ticketSync] = 1;
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
    if (identity.buildCommit) hello.buildCommit = identity.buildCommit;
    // Contract domains are a top-level field, never capabilities, and the
    // schema version stays 1 (§11.2 "Negotiation"). Always present, empty
    // until a domain has defined commands, so a peer can tell this backend
    // from a pre-contract one.
    hello.domains = { ...identity.domains };
    jsonResponse(response, 200, hello, { "cache-control": "no-store" });
  }

  async handleGatewaySettings(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    // Browser sessions exist to keep the durable token out of the browser, and
    // a cookie reaches every port on this host. Revealing or rotating the
    // token therefore takes the token itself, as a bearer header (Electron,
    // the hosted client, the CLI), never a cookie, a session or a grant.
    if (!this.authenticatedWithDurableBearer(request)) {
      jsonResponse(response, 403, {
        error:
          "The gateway token is only shown or changed in the desktop app or a client signed in with the token.",
      });
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
      // Rotation revokes every browser session; the caller is a bearer client
      // and gets no cookie.
      const settings = await this.lifecycle.setToken(body.token);
      jsonResponse(response, 200, settings);
    } catch (error) {
      if (error instanceof GatewayTokenValidationError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      log.error("auth-token.persist-failed", { error: formatLogError(error) });
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
      loginPageResponse(response, 200, loginPage("", this.agentTestLoginHint()));
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
        loginPageResponse(
          response,
          413,
          loginPage("Login request is too large.", this.agentTestLoginHint()),
        );
        return;
      }
      throw error;
    }
    // An empty submission is not a guess.
    const outcome = token
      ? this.ctx.credentialThrottle.check(this.ctx.token, token, request)
      : "wrong";
    if (outcome === "throttled") {
      const retryAfter = this.ctx.credentialThrottle.retryAfterSeconds(request);
      response.setHeader("retry-after", String(retryAfter));
      loginPageResponse(
        response,
        429,
        loginPage(throttledMessage(retryAfter), this.agentTestLoginHint()),
      );
      return;
    }
    if (outcome === "wrong") {
      loginPageResponse(
        response,
        401,
        loginPage("Invalid gateway token.", this.agentTestLoginHint()),
      );
      return;
    }

    response.writeHead(303, {
      location: "/",
      "set-cookie": this.issueSessionCookie(request),
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
    this.pruneAgentTestBootstraps(now);
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
   * Detects a cookie session and renews its idle clock, only after explicit
   * browser activity: ordinary API polling deliberately does not touch it, so
   * an unattended tab still lapses. A bearer client has no session here.
   */
  handleBrowserSession(request: IncomingMessage, response: ServerResponse): void {
    const session = getBearerToken(request.headers) ? null : getGatewayAuthCookie(request.headers);
    if (!session || !this.ctx.browserSessions.has(session)) {
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
    if (!this.ctx.browserSessions.refresh(session)) {
      jsonResponse(response, 401, { error: "Browser session expired" });
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
    jsonResponse(
      response,
      200,
      { ok: true },
      {
        "cache-control": "no-store",
        "set-cookie": this.issueSessionCookie(request),
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
      loginPageResponse(
        response,
        401,
        loginPage(
          "That login link was already used or has expired. Mint a fresh one.",
          this.agentTestLoginHint(),
        ),
      );
      return;
    }
    response.writeHead(303, {
      location: "/",
      "set-cookie": this.issueSessionCookie(request),
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
