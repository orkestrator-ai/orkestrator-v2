import http, { type Server } from "node:http";
import type { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_GATEWAY_RELAYED_REPLAY_FRAME_CAPACITY,
  DEFAULT_GATEWAY_RELAYED_REPLAY_MAX_BYTES,
  GatewayEventReplay,
} from "./gateway-event-replay.js";
import { TerminalWebSocketGateway } from "./terminal-websocket-server.js";
import type { LegacyLoopbackPortAccess, PreviewRuntime } from "./core/preview-runtime.js";
import { PreviewAdmission } from "./preview-admission.js";
import { PreviewMetrics } from "./preview-metrics.js";
import { PreviewTunnelServer } from "./preview-tunnel-server.js";
import type { GatewayAuth } from "./gateway-auth.js";
import { GatewayCredentialThrottle } from "./gateway-credential-throttle.js";
import { GatewayHostPolicy } from "./gateway-host-policy.js";
import { GatewayTrafficSummary } from "./gateway-traffic-summary.js";
import { BrowserSessionStore, gatewayRequestCredential } from "./gateway-sessions.js";
import { NodeEventMultiplexer } from "./core/nodes/index.js";
import {
  KEEPALIVE_MS,
  BUFFERED_PROXY_BODY_IDLE_TIMEOUT_MS,
  DEFAULT_GATEWAY_REPLAY_HANDSHAKE_FRAME_CAPACITY,
  DEFAULT_GATEWAY_REPLAY_HANDSHAKE_MAX_BYTES,
  resolveGatewayCompressionMode,
  GatewayMetricsStore,
  parseAllowedOrigins,
} from "./gateway-internals.js";
import type {
  BackendInvoker,
  NetworkInterfaceMap,
  GatewayCompressionMode,
  OrkestratorGatewayOptions,
  EventClientWriter,
  GatewayEventClient,
} from "./gateway-internals.js";

/**
 * The credential and origin checks the terminal WebSocket gateway runs on each
 * upgrade. They belong to `GatewayAuth`, which is built after this context, so
 * the facade passes callbacks bound late to it.
 */
export type GatewayCredentialChecks = Pick<
  GatewayAuth,
  | "gatewayCredentialMatches"
  | "gatewayCredentialExpiresAt"
  | "requestCredentialMatches"
  | "isOriginAllowed"
>;

/**
 * State shared by the gateway's collaborators: resolved options, listeners,
 * the durable credential, agent-test sessions, event-stream clients, the replay
 * ring, metrics and the terminal WebSocket and preview services. Built once by
 * `OrkestratorGateway`.
 */
export class GatewayContext {
  readonly backend: BackendInvoker;
  readonly dataDir: string;
  readonly rendererRoot: string;
  readonly rendererDevServerUrl?: string;
  readonly bindAddress?: string;
  readonly fallbackBindAddress?: string;
  readonly port?: number;
  readonly strictPort: boolean;
  readonly agentTestMode: boolean;
  readonly agentTestProfile?: string;
  readonly controlBindAddress?: string;
  readonly controlPort?: number;
  readonly loopbackClientPort?: number;
  readonly backendHello: OrkestratorGatewayOptions["backendHello"];
  readonly nodeHooks: OrkestratorGatewayOptions["nodeHooks"];
  readonly env: NodeJS.ProcessEnv;
  readonly interfaces?: NetworkInterfaceMap;
  readonly allowNonTailscaleBind: boolean;
  readonly webClientControl: OrkestratorGatewayOptions["webClientControl"];
  readonly hostUpdaterControl: OrkestratorGatewayOptions["hostUpdaterControl"];
  readonly allowedOrigins: string[];
  readonly hostPolicy: GatewayHostPolicy;
  readonly credentialThrottle = new GatewayCredentialThrottle();
  readonly compression: GatewayCompressionMode;
  readonly keepaliveMs: number;
  /**
   * `/__orkestrator/nodes/events` (plan item 5005); `null` without the relay
   * and workspace hooks, so the route answers 404 as on an older command node.
   */
  readonly nodeEventMultiplexer: NodeEventMultiplexer | null;
  readonly proxyBodyIdleTimeoutMs: number;
  readonly eventReplay: GatewayEventReplay;
  /** Relayed node events only, with its own generation and revisions. */
  readonly relayedEventReplay: GatewayEventReplay;
  readonly replayHandshakeFrameCapacity: number;
  readonly replayHandshakeMaxBytes: number;
  readonly metrics: GatewayMetricsStore;
  /** Per-second connection and request counts; logs `traffic.burst` on a spike. */
  readonly traffic: GatewayTrafficSummary;
  readonly terminalWebSocket: TerminalWebSocketGateway;
  /** Backend-owned preview services, when this gateway fronts a full backend. */
  readonly previews?: PreviewRuntime;
  readonly previewMetrics: PreviewMetrics;
  readonly previewTunnel?: PreviewTunnelServer;
  /** Legacy `/__orkestrator/browser/loopback/<port>/` concurrency (per port, overall). */
  readonly legacyPreviewAdmission = new PreviewAdmission("http", {
    perService: 32,
    perBackend: 128,
  });
  readonly browserPreviewHeadersTimeoutMs: number;
  readonly legacyPreviewPortAccess: (
    port: number,
    environmentId: string | null,
  ) => Promise<LegacyLoopbackPortAccess>;
  servers = new Set<Server>();
  /** Set once the loopback client listener is serving. */
  loopbackClientUrl: string | null = null;
  token = "";
  authFile = "";
  agentTestBootstraps = new Map<string, number>();
  /** Opaque browser sessions behind the gateway cookie (login form and agent-test links). */
  readonly browserSessions: BrowserSessionStore;
  clients = new Map<EventClientWriter, GatewayEventClient>();
  /**
   * Latest full-pane tmux frame dropped for each lagging client/session.
   *
   * Interactive tmux output is already a complete repaint, not an incremental
   * byte stream. Keeping only the newest refused frame makes recovery exact
   * without retaining an unbounded history or requiring the renderer to call
   * the ordinary PTY snapshot API. A remote browser may multiplex several
   * actively mounted terminals on one filtered stream, so retention is bounded
   * to one frame per subscribed tmux session rather than one frame per socket.
   */
  droppedTmuxFrames = new WeakMap<EventClientWriter, Map<string, Buffer>>();
  proxyRequests = new Set<ReturnType<typeof http.request>>();
  sockets = new Set<Socket>();
  keepalive: ReturnType<typeof setInterval> | null = null;
  tokenTransition: Promise<unknown> = Promise.resolve();

  constructor(
    options: OrkestratorGatewayOptions,
    private readonly credentials: GatewayCredentialChecks,
  ) {
    this.backend = options.backend;
    this.traffic = new GatewayTrafficSummary({
      ...options.trafficSummary,
      openSockets: () => this.sockets.size,
    });
    this.dataDir = options.dataDir;
    this.rendererRoot = options.rendererRoot;
    this.rendererDevServerUrl = options.rendererDevServerUrl;
    this.bindAddress = options.bindAddress;
    this.fallbackBindAddress = options.fallbackBindAddress;
    this.port = options.port;
    this.strictPort = options.strictPort ?? false;
    this.agentTestMode = options.agentTestMode ?? false;
    this.agentTestProfile = options.agentTestProfile?.trim() || undefined;
    this.browserSessions = new BrowserSessionStore(this.agentTestMode);
    this.controlBindAddress = options.controlBindAddress;
    this.controlPort = options.controlPort;
    this.loopbackClientPort = options.loopbackClientPort;
    this.backendHello = options.backendHello;
    this.nodeHooks = options.nodeHooks;
    this.env = options.env ?? process.env;
    this.interfaces = options.interfaces;
    this.allowNonTailscaleBind = options.allowNonTailscaleBind ?? false;
    this.webClientControl = options.webClientControl;
    this.hostUpdaterControl = options.hostUpdaterControl;
    this.compression = resolveGatewayCompressionMode(options.compression, this.env);
    this.keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
    const nodeHooks = options.nodeHooks;
    this.nodeEventMultiplexer =
      nodeHooks?.relayTarget && nodeHooks.relayWorkspaceOpen
        ? new NodeEventMultiplexer({
            relayTarget: (nodeId) => nodeHooks.relayTarget?.(nodeId) ?? null,
            workspaceOpen: (workspaceId, nodeId) =>
              nodeHooks.relayWorkspaceOpen?.(workspaceId, nodeId) ?? false,
            keepaliveMs: this.keepaliveMs,
            ...options.nodeEventMultiplexer,
          })
        : null;
    this.proxyBodyIdleTimeoutMs =
      options.proxyBodyIdleTimeoutMs ?? BUFFERED_PROXY_BODY_IDLE_TIMEOUT_MS;
    this.browserPreviewHeadersTimeoutMs = options.browserPreviewHeadersTimeoutMs ?? 30_000;
    this.previews = options.previews;
    const previews = this.previews;
    this.legacyPreviewPortAccess =
      options.legacyPreviewPortAccess ??
      (previews
        ? (port, environmentId) => previews.legacyLoopbackPortAccess(port, environmentId)
        : async () => "unknown" as const);
    this.previewMetrics = this.previews?.metrics ?? new PreviewMetrics();
    if (this.previews) {
      this.previewTunnel = new PreviewTunnelServer({
        runtime: this.previews,
        metrics: this.previewMetrics,
      });
      const tunnel = this.previewTunnel;
      this.previews.tunnelReady = () => tunnel.listening && this.servers.size > 0;
      this.previewMetrics.gauge("tunnel.sockets", () => tunnel.stats().sockets);
      this.previewMetrics.gauge("tunnel.queued_bytes", () => tunnel.stats().aggregateQueuedBytes);
      this.previewMetrics.gauge("tunnel.active", () => tunnel.stats().admission.active);
      this.previewMetrics.gauge(
        "legacy.http_active",
        () => this.legacyPreviewAdmission.stats().active,
      );
    }
    this.eventReplay = new GatewayEventReplay(randomBytes(16).toString("hex"), options.eventReplay);
    this.relayedEventReplay = new GatewayEventReplay(randomBytes(16).toString("hex"), {
      frameCapacity: DEFAULT_GATEWAY_RELAYED_REPLAY_FRAME_CAPACITY,
      maxBytes: DEFAULT_GATEWAY_RELAYED_REPLAY_MAX_BYTES,
      ...options.relayedEventReplay,
    });
    this.replayHandshakeFrameCapacity = Math.max(
      1,
      options.eventReplay?.handshakeFrameCapacity ??
        DEFAULT_GATEWAY_REPLAY_HANDSHAKE_FRAME_CAPACITY,
    );
    this.replayHandshakeMaxBytes = Math.max(
      0,
      options.eventReplay?.handshakeMaxBytes ?? DEFAULT_GATEWAY_REPLAY_HANDSHAKE_MAX_BYTES,
    );
    this.allowedOrigins = (
      options.allowedOrigins ?? parseAllowedOrigins(this.env.ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS)
    )
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean);
    this.hostPolicy = new GatewayHostPolicy(this.allowedOrigins);
    this.metrics = new GatewayMetricsStore(this.compression);
    this.terminalWebSocket = new TerminalWebSocketGateway({
      backend: this.backend,
      // A token sent in the authenticate frame is a bearer; otherwise the
      // upgrade's own headers decide, where a cookie only carries a session.
      tokenMatches: (request, suppliedToken) =>
        suppliedToken !== undefined
          ? this.credentials.gatewayCredentialMatches(suppliedToken, request)
          : this.credentials.requestCredentialMatches(request),
      credentialExpiresAt: (request, suppliedToken) =>
        this.credentials.gatewayCredentialExpiresAt(
          suppliedToken ?? gatewayRequestCredential(request.headers),
        ),
      onCredentialRevoked: (request, suppliedToken, close) => {
        const credential = suppliedToken ?? gatewayRequestCredential(request.headers);
        return credential ? this.onCredentialRevoked(credential, close) : () => {};
      },
      originAllowed: (request) =>
        Boolean(
          request.headers.origin &&
          this.credentials.isOriginAllowed(request, request.headers.origin),
        ),
      metrics: this.metrics,
      maxSockets: options.terminalWebSocket?.maxSockets,
      maxChannelsPerSocket: options.terminalWebSocket?.maxChannelsPerSocket,
      maxChannels: options.terminalWebSocket?.maxChannels,
    });
  }

  /**
   * Calls `listener` when this credential's client grant or browser session ends.
   * Rotation ends a durable token, and whoever latched one is revoked directly.
   */
  onCredentialRevoked(credential: string, listener: () => void): () => void {
    const unsubscribeGrant = credential.startsWith("okg_")
      ? this.nodeHooks?.onGrantRevoked?.(credential, listener)
      : null;
    return unsubscribeGrant ?? this.browserSessions.onRevoke(credential, listener);
  }
}
