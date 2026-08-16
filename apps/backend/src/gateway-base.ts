import http, { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { GatewayEventReplay } from "./gateway-event-replay.js";
import { TerminalWebSocketGateway } from "./terminal-websocket-server.js";
import type { GatewayTokenSettings } from "@orkestrator/protocol/web-client";
import { GatewayTokenValidationError, normalizeGatewayToken } from "@orkestrator/protocol/gateway-token";
import { AUTH_COOKIE, DEFAULT_GATEWAY_PORT, GATEWAY_PORT_FALLBACK_ATTEMPTS, KEEPALIVE_MS, BUFFERED_PROXY_BODY_IDLE_TIMEOUT_MS, DEFAULT_GATEWAY_REPLAY_HANDSHAKE_FRAME_CAPACITY, DEFAULT_GATEWAY_REPLAY_HANDSHAKE_MAX_BYTES, resolveGatewayCompressionMode, GatewayMetricsStore, parsePort, isAddressInUseError, isTailscaleAddress, selectTailscaleBindAddress, formatHostForUrl, isLoopbackAddress, parseAllowedOrigins, jsonResponse, getCookie, getBearerToken, authFilePath, loadOrCreateGatewayToken, persistGatewayToken } from "./gateway-internals.js";
import type { BackendInvoker, NetworkInterfaceMap, ListenerKind, GatewayCompressionMode, GatewayStartInfo, OrkestratorGatewayOptions, EventClientWriter, GatewayEventClient, GatewayRequestMetrics } from "./gateway-internals.js";

export abstract class GatewayBase {
  protected readonly backend: BackendInvoker;
  protected readonly dataDir: string;
  protected readonly rendererRoot: string;
  protected readonly rendererDevServerUrl?: string;
  protected readonly bindAddress?: string;
  protected readonly fallbackBindAddress?: string;
  protected readonly port?: number;
  protected readonly strictPort: boolean;
  protected readonly agentTestMode: boolean;
  protected readonly controlBindAddress?: string;
  protected readonly controlPort?: number;
  protected readonly env: NodeJS.ProcessEnv;
  protected readonly interfaces?: NetworkInterfaceMap;
  protected readonly logger: Pick<Console, "debug" | "error" | "info" | "warn">;
  protected readonly allowNonTailscaleBind: boolean;
  protected readonly webClientControl: OrkestratorGatewayOptions["webClientControl"];
  protected readonly allowedOrigins: string[];
  protected readonly compression: GatewayCompressionMode;
  protected readonly keepaliveMs: number;
  protected readonly proxyBodyIdleTimeoutMs: number;
  protected readonly eventReplay: GatewayEventReplay;
  protected readonly replayHandshakeFrameCapacity: number;
  protected readonly replayHandshakeMaxBytes: number;
  protected readonly metrics: GatewayMetricsStore;
  protected readonly terminalWebSocket: TerminalWebSocketGateway;
  protected servers = new Set<Server>();
  protected token = "";
  protected authFile = "";
  protected agentTestBootstraps = new Map<string, number>();
  protected agentTestSessions = new Map<string, number>();
  protected clients = new Map<EventClientWriter, GatewayEventClient>();
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
  protected droppedTmuxFrames = new WeakMap<EventClientWriter, Map<string, string>>();
  protected proxyRequests = new Set<ReturnType<typeof http.request>>();
  protected sockets = new Set<Socket>();
  protected keepalive: ReturnType<typeof setInterval> | null = null;
  protected tokenTransition: Promise<unknown> = Promise.resolve();

  protected abstract gatewayCredentialMatches(candidate: string | null): boolean;
  protected abstract isOriginAllowed(
    request: IncomingMessage,
    originValue: string,
  ): boolean;
  protected abstract handle(
    request: IncomingMessage,
    response: ServerResponse,
    listenerKind: ListenerKind,
  ): Promise<void>;
  protected abstract handleInvoke(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void>;
  protected abstract handleEvents(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): void;
  protected abstract handleMetrics(
    request: IncomingMessage,
    response: ServerResponse,
  ): void;
  protected abstract handleClientMetrics(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void>;
  protected abstract handleLoopbackProxy(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void>;
  protected abstract handleBrowserLoopbackProxy(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void>;
  protected abstract serveStatic(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    allowCompression: boolean,
  ): Promise<void>;
  protected abstract proxyToTarget(
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    proxyPrefix?: string,
    browserPreview?: boolean,
    stripOrigin?: boolean,
  ): Promise<void>;

  constructor(options: OrkestratorGatewayOptions) {
    this.backend = options.backend;
    this.dataDir = options.dataDir;
    this.rendererRoot = options.rendererRoot;
    this.rendererDevServerUrl = options.rendererDevServerUrl;
    this.bindAddress = options.bindAddress;
    this.fallbackBindAddress = options.fallbackBindAddress;
    this.port = options.port;
    this.strictPort = options.strictPort ?? false;
    this.agentTestMode = options.agentTestMode ?? false;
    this.controlBindAddress = options.controlBindAddress;
    this.controlPort = options.controlPort;
    this.env = options.env ?? process.env;
    this.interfaces = options.interfaces;
    this.logger = options.logger ?? console;
    this.allowNonTailscaleBind = options.allowNonTailscaleBind ?? false;
    this.webClientControl = options.webClientControl;
    this.compression = resolveGatewayCompressionMode(options.compression, this.env);
    this.keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
    this.proxyBodyIdleTimeoutMs = options.proxyBodyIdleTimeoutMs ?? BUFFERED_PROXY_BODY_IDLE_TIMEOUT_MS;
    this.eventReplay = new GatewayEventReplay(
      randomBytes(16).toString("hex"),
      options.eventReplay,
    );
    this.replayHandshakeFrameCapacity = Math.max(
      1,
      options.eventReplay?.handshakeFrameCapacity
        ?? DEFAULT_GATEWAY_REPLAY_HANDSHAKE_FRAME_CAPACITY,
    );
    this.replayHandshakeMaxBytes = Math.max(
      0,
      options.eventReplay?.handshakeMaxBytes
        ?? DEFAULT_GATEWAY_REPLAY_HANDSHAKE_MAX_BYTES,
    );
    this.allowedOrigins = (
      options.allowedOrigins ?? parseAllowedOrigins(this.env.ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS)
    )
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean);
    this.metrics = new GatewayMetricsStore(this.compression);
    this.terminalWebSocket = new TerminalWebSocketGateway({
      backend: this.backend,
      tokenMatches: (request, suppliedToken) => this.gatewayCredentialMatches(
        suppliedToken ?? getBearerToken(request.headers) ?? getCookie(request.headers, AUTH_COOKIE),
      ),
      originAllowed: (request) => Boolean(
        request.headers.origin && this.isOriginAllowed(request, request.headers.origin),
      ),
      logger: this.logger,
    });
  }

  async start(): Promise<GatewayStartInfo | null> {
    if (this.env.ORKESTRATOR_GATEWAY_DISABLED === "1") {
      this.logger.info("[RemoteGateway] Disabled by ORKESTRATOR_GATEWAY_DISABLED=1");
      return null;
    }

    const tailscaleBindAddress = selectTailscaleBindAddress(this.interfaces);
    const bindAddress = this.bindAddress
      ?? this.env.ORKESTRATOR_GATEWAY_HOST
      ?? tailscaleBindAddress
      ?? this.fallbackBindAddress;
    if (!bindAddress && !this.controlBindAddress) {
      this.logger.warn("[RemoteGateway] No Tailscale address found; gateway not started");
      return null;
    }
    const usingFallback = !this.bindAddress
      && !this.env.ORKESTRATOR_GATEWAY_HOST
      && !tailscaleBindAddress
      && this.fallbackBindAddress === bindAddress;
    if (usingFallback) {
      this.logger.warn(`[RemoteGateway] No Tailscale address found; falling back to ${this.fallbackBindAddress}`);
    }
    const safeLoopbackFallback = usingFallback && bindAddress !== undefined && isLoopbackAddress(bindAddress);
    if (bindAddress && !this.allowNonTailscaleBind && !safeLoopbackFallback && !isTailscaleAddress(bindAddress)) {
      throw new Error(`Refusing to bind gateway to non-Tailscale address: ${bindAddress}`);
    }

    const port = this.port ?? parsePort(this.env.ORKESTRATOR_GATEWAY_PORT, DEFAULT_GATEWAY_PORT);
    const auth = await this.enqueueTokenOperation(() => loadOrCreateGatewayToken(this.dataDir, this.env));
    this.token = auth.token;
    this.authFile = auth.authFile;

    let controlListener: { bindAddress: string; port: number; url: string } | null = null;
    if (this.controlBindAddress) {
      if (!isLoopbackAddress(this.controlBindAddress)) {
        throw new Error(`Control listener must use a loopback address: ${this.controlBindAddress}`);
      }
      controlListener = await this.listen(this.controlBindAddress, this.controlPort ?? 0, "control");
      this.logger.info(`[BackendControl] Listening on ${controlListener.url}`);
    }

    let browserListener: { bindAddress: string; port: number; url: string } | null = null;
    let browserError: string | undefined;
    if (bindAddress) {
      try {
        browserListener = await this.listenWithPortFallback(bindAddress, port);
        this.logger.info(`[RemoteGateway] Listening on ${browserListener.url}`);
      } catch (error) {
        if (!controlListener) throw error;
        browserError = error instanceof Error ? error.message : String(error);
        this.logger.error(`[RemoteGateway] Browser listener unavailable: ${browserError}`);
      }
    } else {
      browserError = "No Tailscale address was found";
      this.logger.warn(`[RemoteGateway] ${browserError}; desktop control listener remains available`);
    }

    const primaryListener = controlListener ?? browserListener;
    if (!primaryListener) return null;
    this.logger.info(`[RemoteGateway] Auth token stored at ${this.authFile}`);

    return {
      ...primaryListener,
      token: this.token,
      authFile: this.authFile,
      browserUrl: browserListener?.url,
      browserError,
    };
  }

  protected async listenWithPortFallback(
    bindAddress: string,
    preferredPort: number,
  ): Promise<{ bindAddress: string; port: number; url: string }> {
    if (preferredPort === 0) return this.listen(bindAddress, preferredPort, "browser");
    if (this.strictPort) return this.listen(bindAddress, preferredPort, "browser");

    for (let offset = 0; offset <= GATEWAY_PORT_FALLBACK_ATTEMPTS; offset += 1) {
      const candidatePort = preferredPort + offset;
      if (candidatePort > 65535) break;

      try {
        const listener = await this.listen(bindAddress, candidatePort, "browser");
        if (candidatePort !== preferredPort) {
          this.logger.warn(
            `[RemoteGateway] Port ${preferredPort} was in use; listening on ${candidatePort} instead`,
          );
        }
        return listener;
      } catch (error) {
        if (!isAddressInUseError(error)) throw error;
      }
    }

    const listener = await this.listen(bindAddress, 0, "browser");
    this.logger.warn(
      `[RemoteGateway] Port ${preferredPort} and nearby ports were in use; listening on ${listener.port} instead`,
    );
    return listener;
  }

  protected async listen(
    bindAddress: string,
    port: number,
    listenerKind: ListenerKind,
  ): Promise<{ bindAddress: string; port: number; url: string }> {
    const server = createServer((request, response) => {
      this.handle(request, response, listenerKind).catch((error: unknown) => {
        this.logger.error("[RemoteGateway] Request failed:", error);
        if (!response.headersSent) {
          jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
        } else {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      try {
        if (!this.terminalWebSocket.handleUpgrade(request, socket, head)) socket.destroy();
      } catch {
        this.logger.warn("[RemoteGateway] WebSocket upgrade failed");
        socket.destroy();
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bindAddress, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      server.close();
      throw error;
    }

    this.servers.add(server);
    const address = server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : port;
    return {
      bindAddress,
      port: resolvedPort,
      url: `http://${formatHostForUrl(bindAddress)}:${resolvedPort}/`,
    };
  }

  async getTokenSettings(): Promise<GatewayTokenSettings> {
    return this.enqueueTokenOperation(async () => {
      const auth = await loadOrCreateGatewayToken(this.dataDir, this.env);
      this.authFile = auth.authFile;
      return {
        token: this.token || auth.token,
        editable: auth.editable,
        source: auth.source,
      };
    });
  }

  async setToken(value: string): Promise<GatewayTokenSettings> {
    return this.enqueueTokenOperation(async () => {
      const envToken = this.env.ORKESTRATOR_GATEWAY_TOKEN?.trim();
      if (envToken) {
        throw new GatewayTokenValidationError(
          "Gateway token is managed by ORKESTRATOR_GATEWAY_TOKEN and cannot be changed here",
        );
      }

      const token = normalizeGatewayToken(value);
      const authFile = authFilePath(this.dataDir);
      await persistGatewayToken(authFile, token);
      this.token = token;
      this.authFile = authFile;
      this.agentTestBootstraps.clear();
      this.agentTestSessions.clear();
      // Authentication is latched when a WebSocket becomes ready. Rotating
      // the credential must therefore revoke every connection authenticated
      // with the previous value rather than waiting for a reconnect.
      this.terminalWebSocket.revokeConnections();
      return { token, editable: true, source: "file" };
    });
  }

  protected enqueueTokenOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tokenTransition.catch(() => undefined).then(operation);
    this.tokenTransition = result;
    return result;
  }

  async stop(): Promise<void> {
    this.agentTestBootstraps.clear();
    this.agentTestSessions.clear();
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    for (const client of this.clients.keys()) {
      client.destroy();
    }
    this.clients.clear();
    this.eventReplay.releaseRetained();
    this.terminalWebSocket.close();
    for (const proxyRequest of this.proxyRequests) {
      proxyRequest.destroy(new Error("Remote gateway stopped"));
    }
    this.proxyRequests.clear();
    const servers = [...this.servers];
    if (servers.length === 0) return;
    // Destroy active sockets before awaiting close callbacks. A streaming
    // response can otherwise keep a listener's close callback pending forever.
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(callbackFallback);
        if (error) reject(error);
        else resolve();
      };
      // Bun's Node-HTTP compatibility layer can omit the close callback after a
      // WebSocket upgrade even once every tracked raw socket is destroyed. The
      // listener has already stopped accepting and all connections below are
      // force-closed, so bound that bookkeeping wait instead of hanging backend
      // shutdown forever.
      const callbackFallback = setTimeout(() => settle(), 250);
      callbackFallback.unref?.();
      server.close((error) => settle(error ?? undefined));
      // Explicitly disabling remote access must also revoke active keep-alive,
      // static-file, and streaming proxy connections. `server.close()` alone
      // waits indefinitely for active responses to finish.
      server.closeAllConnections();
    })));
    this.sockets.clear();
    this.servers.clear();
  }

}
