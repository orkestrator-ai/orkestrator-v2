import http, { type Server } from "node:http";
import type { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { GatewayEventReplay } from "./gateway-event-replay.js";
import { TerminalWebSocketGateway } from "./terminal-websocket-server.js";
import type { PreviewRuntime } from "./core/preview-runtime.js";
import { PreviewAdmission } from "./preview-admission.js";
import { PreviewMetrics } from "./preview-metrics.js";
import { PreviewTunnelServer } from "./preview-tunnel-server.js";
import type { GatewayAuth } from "./gateway-auth.js";
import {
  AUTH_COOKIE,
  KEEPALIVE_MS,
  BUFFERED_PROXY_BODY_IDLE_TIMEOUT_MS,
  DEFAULT_GATEWAY_REPLAY_HANDSHAKE_FRAME_CAPACITY,
  DEFAULT_GATEWAY_REPLAY_HANDSHAKE_MAX_BYTES,
  resolveGatewayCompressionMode,
  GatewayMetricsStore,
  parseAllowedOrigins,
  getCookie,
  getBearerToken,
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
  "gatewayCredentialMatches" | "gatewayCredentialExpiresAt" | "isOriginAllowed"
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
  readonly logger: Pick<Console, "debug" | "error" | "info" | "warn">;
  readonly allowNonTailscaleBind: boolean;
  readonly webClientControl: OrkestratorGatewayOptions["webClientControl"];
  readonly hostUpdaterControl: OrkestratorGatewayOptions["hostUpdaterControl"];
  readonly allowedOrigins: string[];
  readonly compression: GatewayCompressionMode;
  readonly keepaliveMs: number;
  readonly proxyBodyIdleTimeoutMs: number;
  readonly eventReplay: GatewayEventReplay;
  readonly replayHandshakeFrameCapacity: number;
  readonly replayHandshakeMaxBytes: number;
  readonly metrics: GatewayMetricsStore;
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
  servers = new Set<Server>();
  /** Set once the loopback client listener is serving. */
  loopbackClientUrl: string | null = null;
  token = "";
  authFile = "";
  agentTestBootstraps = new Map<string, number>();
  /**
   * `expiresAt` slides with activity; `absoluteExpiresAt` never moves, so a
   * continuously polled browser cannot hold a session open indefinitely.
   */
  agentTestSessions = new Map<string, { expiresAt: number; absoluteExpiresAt: number }>();
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
  droppedTmuxFrames = new WeakMap<EventClientWriter, Map<string, string>>();
  proxyRequests = new Set<ReturnType<typeof http.request>>();
  sockets = new Set<Socket>();
  keepalive: ReturnType<typeof setInterval> | null = null;
  tokenTransition: Promise<unknown> = Promise.resolve();

  constructor(
    options: OrkestratorGatewayOptions,
    private readonly credentials: GatewayCredentialChecks,
  ) {
    this.backend = options.backend;
    this.dataDir = options.dataDir;
    this.rendererRoot = options.rendererRoot;
    this.rendererDevServerUrl = options.rendererDevServerUrl;
    this.bindAddress = options.bindAddress;
    this.fallbackBindAddress = options.fallbackBindAddress;
    this.port = options.port;
    this.strictPort = options.strictPort ?? false;
    this.agentTestMode = options.agentTestMode ?? false;
    this.agentTestProfile = options.agentTestProfile?.trim() || undefined;
    this.controlBindAddress = options.controlBindAddress;
    this.controlPort = options.controlPort;
    this.loopbackClientPort = options.loopbackClientPort;
    this.backendHello = options.backendHello;
    this.nodeHooks = options.nodeHooks;
    this.env = options.env ?? process.env;
    this.interfaces = options.interfaces;
    this.logger = options.logger ?? console;
    this.allowNonTailscaleBind = options.allowNonTailscaleBind ?? false;
    this.webClientControl = options.webClientControl;
    this.hostUpdaterControl = options.hostUpdaterControl;
    this.compression = resolveGatewayCompressionMode(options.compression, this.env);
    this.keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
    this.proxyBodyIdleTimeoutMs =
      options.proxyBodyIdleTimeoutMs ?? BUFFERED_PROXY_BODY_IDLE_TIMEOUT_MS;
    this.browserPreviewHeadersTimeoutMs = options.browserPreviewHeadersTimeoutMs ?? 30_000;
    this.previews = options.previews;
    this.previewMetrics = this.previews?.metrics ?? new PreviewMetrics();
    if (this.previews) {
      this.previewTunnel = new PreviewTunnelServer({
        runtime: this.previews,
        metrics: this.previewMetrics,
        logger: options.logger ?? console,
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
    this.metrics = new GatewayMetricsStore(this.compression);
    this.terminalWebSocket = new TerminalWebSocketGateway({
      backend: this.backend,
      tokenMatches: (request, suppliedToken) =>
        this.credentials.gatewayCredentialMatches(
          suppliedToken ??
            getBearerToken(request.headers) ??
            getCookie(request.headers, AUTH_COOKIE),
        ),
      credentialExpiresAt: (request, suppliedToken) =>
        this.credentials.gatewayCredentialExpiresAt(
          suppliedToken ??
            getBearerToken(request.headers) ??
            getCookie(request.headers, AUTH_COOKIE),
        ),
      originAllowed: (request) =>
        Boolean(
          request.headers.origin &&
          this.credentials.isOriginAllowed(request, request.headers.origin),
        ),
      logger: this.logger,
      metrics: this.metrics,
      maxSockets: options.terminalWebSocket?.maxSockets,
      maxChannelsPerSocket: options.terminalWebSocket?.maxChannelsPerSocket,
      maxChannels: options.terminalWebSocket?.maxChannels,
    });
  }
}
