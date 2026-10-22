/**
 * The remote gateway.
 *
 * A facade over collaborators that share one `GatewayContext`
 * (`gateway-context.ts`: resolved options, listeners, the durable credential,
 * agent-test sessions, event-stream clients, the replay ring and metrics):
 *
 * - `gateway-lifecycle.ts`: listeners, the durable gateway token, and shutdown.
 * - `gateway-events.ts`: SSE fan-out, the replay handshake, and bounded
 *   per-client buffering.
 * - `gateway-auth.ts`: request routing, CORS, credentials, login and the
 *   agent-test session flow.
 * - `gateway-handlers.ts`: the invoke, event-stream, metrics and loopback-proxy
 *   routes.
 * - `gateway-proxy.ts`: the reverse proxy to loopback targets and the static
 *   renderer.
 *
 * Each part takes the context and the parts it calls; none extends another
 * (`tests/unit/inheritance-chains.test.ts`). Three calls run against the build
 * order, so the constructor passes them as callbacks bound late to the
 * collaborator that implements them: the terminal WebSocket's credential and
 * origin checks (context -> auth), request routing (lifecycle -> auth), and the
 * route handlers (auth -> handlers).
 */
export * from "./gateway-support.js";
export { createSseGzipCompressor, startProxiedEventStreamGzip } from "./gateway-proxy.js";

import type { GatewayTokenSettings } from "@orkestrator/protocol/web-client";
import { GatewayAuth, type GatewayRouteHandlers } from "./gateway-auth.js";
import { GatewayContext } from "./gateway-context.js";
import type { GatewayEventReplay } from "./gateway-event-replay.js";
import { GatewayEvents } from "./gateway-events.js";
import { GatewayHandlers } from "./gateway-handlers.js";
import type {
  EventClientWriter,
  GatewayEventClient,
  GatewayMetricsStore,
  GatewayStartInfo,
  OrkestratorGatewayOptions,
} from "./gateway-internals.js";
import { GatewayLifecycle } from "./gateway-lifecycle.js";
import { GatewayProxy } from "./gateway-proxy.js";
import type { TerminalWebSocketGateway } from "./terminal-websocket-server.js";

export class OrkestratorGateway {
  private readonly context: GatewayContext;
  private readonly lifecycle: GatewayLifecycle;
  private readonly events: GatewayEvents;
  private readonly proxy: GatewayProxy;
  private readonly auth: GatewayAuth;
  private readonly handlers: GatewayHandlers;

  constructor(options: OrkestratorGatewayOptions) {
    this.context = new GatewayContext(options, {
      gatewayCredentialMatches: (candidate) => this.auth.gatewayCredentialMatches(candidate),
      gatewayCredentialExpiresAt: (candidate) => this.auth.gatewayCredentialExpiresAt(candidate),
      isOriginAllowed: (request, originValue) => this.auth.isOriginAllowed(request, originValue),
    });
    this.lifecycle = new GatewayLifecycle(this.context, {
      handle: (request, response, listenerKind) =>
        this.auth.handle(request, response, listenerKind),
      handleUpgrade: (request, socket, head) => this.auth.handleUpgrade(request, socket, head),
    });
    this.events = new GatewayEvents(this.context);
    this.proxy = new GatewayProxy(this.context);
    const routes: GatewayRouteHandlers = {
      handleInvoke: (...args) => this.handlers.handleInvoke(...args),
      handleEvents: (...args) => this.handlers.handleEvents(...args),
      handleMetrics: (...args) => this.handlers.handleMetrics(...args),
      handleClientMetrics: (...args) => this.handlers.handleClientMetrics(...args),
      handleLoopbackProxy: (...args) => this.handlers.handleLoopbackProxy(...args),
      handleBrowserLoopbackProxy: (...args) => this.handlers.handleBrowserLoopbackProxy(...args),
    };
    this.auth = new GatewayAuth(this.context, this.lifecycle, routes, this.proxy);
    this.handlers = new GatewayHandlers(this.context, this.events, this.auth, this.proxy);
  }

  start(): Promise<GatewayStartInfo | null> {
    return this.lifecycle.start();
  }

  getTokenSettings(): Promise<GatewayTokenSettings> {
    return this.lifecycle.getTokenSettings();
  }

  setToken(value: string): Promise<GatewayTokenSettings> {
    return this.lifecycle.setToken(value);
  }

  stop(): Promise<void> {
    return this.lifecycle.stop();
  }

  emit(event: string, payload: unknown): void {
    this.events.emit(event, payload);
  }

  // -------------------------------------------------------------------------
  // Internals the gateway suites reach through casts
  // (`gateway as unknown as { clients, eventReplay, ... }`). Each returns the
  // collaborator's own instance or method, so a test sees the live state.

  protected get clients(): Map<EventClientWriter, GatewayEventClient> {
    return this.context.clients;
  }

  protected get eventReplay(): GatewayEventReplay {
    return this.context.eventReplay;
  }

  protected get metrics(): GatewayMetricsStore {
    return this.context.metrics;
  }

  protected get terminalWebSocket(): TerminalWebSocketGateway {
    return this.context.terminalWebSocket;
  }

  protected get agentTestBootstraps(): Map<string, number> {
    return this.context.agentTestBootstraps;
  }

  protected get agentTestSessions(): GatewayContext["agentTestSessions"] {
    return this.context.agentTestSessions;
  }

  protected get replayHandshakeFrameCapacity(): number {
    return this.context.replayHandshakeFrameCapacity;
  }

  protected get replayHandshakeMaxBytes(): number {
    return this.context.replayHandshakeMaxBytes;
  }

  /** A test narrows the handshake byte bound on a live gateway. */
  protected set replayHandshakeMaxBytes(value: number) {
    (this.context as { replayHandshakeMaxBytes: number }).replayHandshakeMaxBytes = value;
  }

  protected flushDesyncNotices(
    ...args: Parameters<GatewayEvents["flushDesyncNotices"]>
  ): ReturnType<GatewayEvents["flushDesyncNotices"]> {
    return this.events.flushDesyncNotices(...args);
  }

  protected initializeEventReplay(
    ...args: Parameters<GatewayEvents["initializeEventReplay"]>
  ): ReturnType<GatewayEvents["initializeEventReplay"]> {
    return this.events.initializeEventReplay(...args);
  }

  protected writeReplayFrame(
    ...args: Parameters<GatewayEvents["writeReplayFrame"]>
  ): ReturnType<GatewayEvents["writeReplayFrame"]> {
    return this.events.writeReplayFrame(...args);
  }

  protected handleEvents(
    ...args: Parameters<GatewayHandlers["handleEvents"]>
  ): ReturnType<GatewayHandlers["handleEvents"]> {
    return this.handlers.handleEvents(...args);
  }

  protected gatewayCredentialMatches(
    ...args: Parameters<GatewayAuth["gatewayCredentialMatches"]>
  ): ReturnType<GatewayAuth["gatewayCredentialMatches"]> {
    return this.auth.gatewayCredentialMatches(...args);
  }

  protected issueAgentTestSession(
    ...args: Parameters<GatewayAuth["issueAgentTestSession"]>
  ): ReturnType<GatewayAuth["issueAgentTestSession"]> {
    return this.auth.issueAgentTestSession(...args);
  }

  protected refreshAgentTestSession(
    ...args: Parameters<GatewayAuth["refreshAgentTestSession"]>
  ): ReturnType<GatewayAuth["refreshAgentTestSession"]> {
    return this.auth.refreshAgentTestSession(...args);
  }
}
