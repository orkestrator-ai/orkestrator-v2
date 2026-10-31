import { createServer } from "node:http";
import type { GatewayTokenSettings } from "@orkestrator/protocol/web-client";
import {
  GatewayTokenValidationError,
  normalizeGatewayToken,
} from "@orkestrator/protocol/gateway-token";
import type { GatewayAuth } from "./gateway-auth.js";
import type { GatewayContext } from "./gateway-context.js";
import {
  DEFAULT_GATEWAY_PORT,
  GATEWAY_PORT_FALLBACK_ATTEMPTS,
  parsePort,
  isAddressInUseError,
  isTailscaleAddress,
  selectTailscaleBindAddress,
  formatHostForUrl,
  isLoopbackAddress,
  jsonResponse,
  authFilePath,
  loadOrCreateGatewayToken,
  persistGatewayToken,
} from "./gateway-internals.js";
import type { ListenerKind, GatewayStartInfo } from "./gateway-internals.js";
import { DEFAULT_CONTROL_MCP_PORT } from "./fixed-ports.js";

/**
 * Where an accepted request goes: `GatewayAuth.handle`. `GatewayAuth` calls
 * back into this class for the token settings, so the facade passes a callback
 * bound late to it.
 */
export type GatewayRequestRouter = Pick<GatewayAuth, "handle"> &
  Partial<Pick<GatewayAuth, "handleUpgrade">>;

/** The loopback client gateway binds IPv4 loopback only. */
const LOOPBACK_CLIENT_BIND_ADDRESS = "127.0.0.1";

/** Listeners, the durable gateway token, and shutdown. */
export class GatewayLifecycle {
  constructor(
    private readonly ctx: GatewayContext,
    private readonly router: GatewayRequestRouter,
  ) {}

  async start(): Promise<GatewayStartInfo | null> {
    if (this.ctx.env.ORKESTRATOR_GATEWAY_DISABLED === "1") {
      this.ctx.logger.info("[RemoteGateway] Disabled by ORKESTRATOR_GATEWAY_DISABLED=1");
      return null;
    }

    const tailscaleBindAddress = selectTailscaleBindAddress(this.ctx.interfaces);
    const bindAddress =
      this.ctx.bindAddress ??
      this.ctx.env.ORKESTRATOR_GATEWAY_HOST ??
      tailscaleBindAddress ??
      this.ctx.fallbackBindAddress;
    if (!bindAddress && !this.ctx.controlBindAddress && this.ctx.loopbackClientPort === undefined) {
      this.ctx.logger.warn("[RemoteGateway] No Tailscale address found; gateway not started");
      return null;
    }
    const usingFallback =
      !this.ctx.bindAddress &&
      !this.ctx.env.ORKESTRATOR_GATEWAY_HOST &&
      !tailscaleBindAddress &&
      this.ctx.fallbackBindAddress === bindAddress;
    if (usingFallback) {
      this.ctx.logger.warn(
        `[RemoteGateway] No Tailscale address found; falling back to ${this.ctx.fallbackBindAddress}`,
      );
    }
    const safeLoopbackFallback =
      usingFallback && bindAddress !== undefined && isLoopbackAddress(bindAddress);
    if (
      bindAddress &&
      !this.ctx.allowNonTailscaleBind &&
      !safeLoopbackFallback &&
      !isTailscaleAddress(bindAddress)
    ) {
      throw new Error(`Refusing to bind gateway to non-Tailscale address: ${bindAddress}`);
    }

    const port =
      this.ctx.port ?? parsePort(this.ctx.env.ORKESTRATOR_GATEWAY_PORT, DEFAULT_GATEWAY_PORT);
    const auth = await this.enqueueTokenOperation(() =>
      loadOrCreateGatewayToken(this.ctx.dataDir, this.ctx.env),
    );
    this.ctx.token = auth.token;
    this.ctx.authFile = auth.authFile;

    let controlListener: { bindAddress: string; port: number; url: string } | null = null;
    if (this.ctx.controlBindAddress) {
      if (!isLoopbackAddress(this.ctx.controlBindAddress)) {
        throw new Error(
          `Control listener must use a loopback address: ${this.ctx.controlBindAddress}`,
        );
      }
      controlListener = await this.listen(
        this.ctx.controlBindAddress,
        this.ctx.controlPort ?? 0,
        "control",
      );
      this.ctx.logger.info(`[BackendControl] Listening on ${controlListener.url}`);
    }

    let browserListener: { bindAddress: string; port: number; url: string } | null = null;
    let browserError: string | undefined;
    let browserFailure: unknown;
    if (bindAddress) {
      try {
        browserListener = await this.listenWithPortFallback(bindAddress, port);
        this.ctx.logger.info(`[RemoteGateway] Listening on ${browserListener.url}`);
      } catch (error) {
        if (!controlListener && this.ctx.loopbackClientPort === undefined) throw error;
        browserFailure = error;
        browserError = error instanceof Error ? error.message : String(error);
        this.ctx.logger.error(`[RemoteGateway] Browser listener unavailable: ${browserError}`);
      }
    } else {
      browserError = "No Tailscale address was found";
      this.ctx.logger.warn(
        `[RemoteGateway] ${browserError}; ${controlListener ? "desktop control" : "loopback client"} listener remains available`,
      );
    }

    // The SSH forwarding target. An additional listener, never a change to
    // the browser listener's bind policy, and never a control listener: it
    // routes as "browser", so control-only routes stay 404 here.
    let loopbackClientListener: { bindAddress: string; port: number; url: string } | null = null;
    let loopbackClientError: string | undefined;
    if (this.ctx.loopbackClientPort !== undefined) {
      try {
        loopbackClientListener = await this.listen(
          LOOPBACK_CLIENT_BIND_ADDRESS,
          this.ctx.loopbackClientPort,
          "browser",
        );
        this.ctx.loopbackClientUrl = loopbackClientListener.url;
        this.ctx.logger.info(
          `[RemoteGateway] Loopback client gateway listening on ${loopbackClientListener.url}`,
        );
      } catch (error) {
        loopbackClientError = error instanceof Error ? error.message : String(error);
        this.ctx.logger.error(
          `[RemoteGateway] Loopback client gateway unavailable on ${LOOPBACK_CLIENT_BIND_ADDRESS}:${this.ctx.loopbackClientPort}: ${loopbackClientError}`,
        );
      }
    }

    const primaryListener = controlListener ?? browserListener ?? loopbackClientListener;
    if (!primaryListener) {
      if (browserFailure) throw browserFailure;
      if (loopbackClientError) {
        throw new Error(`Loopback client gateway unavailable: ${loopbackClientError}`);
      }
      return null;
    }
    this.ctx.logger.info(`[RemoteGateway] Auth token stored at ${this.ctx.authFile}`);

    return {
      ...primaryListener,
      token: this.ctx.token,
      authFile: this.ctx.authFile,
      ...(controlListener ? { controlUrl: controlListener.url } : {}),
      browserUrl: browserListener?.url,
      browserError,
      ...(loopbackClientListener ? { loopbackClientUrl: loopbackClientListener.url } : {}),
      ...(loopbackClientError ? { loopbackClientError } : {}),
    };
  }

  async listenWithPortFallback(
    bindAddress: string,
    preferredPort: number,
  ): Promise<{ bindAddress: string; port: number; url: string }> {
    if (preferredPort === 0) return this.listen(bindAddress, preferredPort, "browser");
    if (this.ctx.strictPort) return this.listen(bindAddress, preferredPort, "browser");

    const skippedPorts = this.fallbackSkippedPorts();
    for (let offset = 0; offset <= GATEWAY_PORT_FALLBACK_ATTEMPTS; offset += 1) {
      const candidatePort = preferredPort + offset;
      if (candidatePort > 65535) break;
      // The port asked for is still tried: only the fallback keeps off these.
      if (offset > 0 && skippedPorts.has(candidatePort)) continue;

      try {
        const listener = await this.listen(bindAddress, candidatePort, "browser");
        if (candidatePort !== preferredPort) {
          this.ctx.logger.warn(
            `[RemoteGateway] Port ${preferredPort} was in use; listening on ${candidatePort} instead`,
          );
        }
        return listener;
      } catch (error) {
        if (!isAddressInUseError(error)) throw error;
      }
    }

    const listener = await this.listen(bindAddress, 0, "browser");
    this.ctx.logger.warn(
      `[RemoteGateway] Port ${preferredPort} and nearby ports were in use; listening on ${listener.port} instead`,
    );
    return listener;
  }

  /**
   * Ports the fallback must leave free, taken or not. The fixed ports belong to
   * the default data directory's backend, which may not have started yet, and a
   * Control MCP waiting out a taken port rebinds as soon as it frees. The
   * loopback client listener binds after this one.
   */
  private fallbackSkippedPorts(): Set<number> {
    const ports = new Set([DEFAULT_GATEWAY_PORT, DEFAULT_CONTROL_MCP_PORT]);
    const controlMcpPort = Number(this.ctx.env.ORKESTRATOR_CONTROL_MCP_PORT);
    if (Number.isInteger(controlMcpPort) && controlMcpPort > 0) ports.add(controlMcpPort);
    if (this.ctx.loopbackClientPort) ports.add(this.ctx.loopbackClientPort);
    return ports;
  }

  async listen(
    bindAddress: string,
    port: number,
    listenerKind: ListenerKind,
  ): Promise<{ bindAddress: string; port: number; url: string }> {
    const server = createServer((request, response) => {
      this.router.handle(request, response, listenerKind).catch((error: unknown) => {
        this.ctx.logger.error("[RemoteGateway] Request failed:", error);
        if (!response.headersSent) {
          jsonResponse(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    server.on("connection", (socket) => {
      this.ctx.sockets.add(socket);
      socket.once("close", () => this.ctx.sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      try {
        // Exact-path routing: the preview tunnel claims only its own path and
        // never steals terminal upgrades; everything unclaimed is destroyed.
        if (this.ctx.previewTunnel?.handleUpgrade(request, socket, head)) return;
        // A leaf workspace's terminal relayed through this command node.
        if (this.router.handleUpgrade?.(request, socket, head)) return;
        if (!this.ctx.terminalWebSocket.handleUpgrade(request, socket, head)) socket.destroy();
      } catch {
        this.ctx.logger.warn("[RemoteGateway] WebSocket upgrade failed");
        socket.destroy();
      }
    });

    let resolvedPort = port;
    for (let attempt = 0; ; attempt += 1) {
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
      const address = server.address();
      resolvedPort = typeof address === "object" && address ? address.port : port;
      // Linux's ephemeral range can include our fixed ports. Check every
      // port-0 browser bind, including the last resort after nearby fallback.
      if (
        port !== 0 ||
        listenerKind !== "browser" ||
        !this.fallbackSkippedPorts().has(resolvedPort)
      ) {
        break;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (attempt >= 31) throw new Error("Unable to allocate an unreserved gateway port");
    }
    this.ctx.servers.add(server);
    return {
      bindAddress,
      port: resolvedPort,
      url: `http://${formatHostForUrl(bindAddress)}:${resolvedPort}/`,
    };
  }

  async getTokenSettings(): Promise<GatewayTokenSettings> {
    return this.enqueueTokenOperation(async () => {
      const auth = await loadOrCreateGatewayToken(this.ctx.dataDir, this.ctx.env);
      this.ctx.authFile = auth.authFile;
      return {
        token: this.ctx.token || auth.token,
        editable: auth.editable,
        source: auth.source,
      };
    });
  }

  async setToken(value: string): Promise<GatewayTokenSettings> {
    return this.enqueueTokenOperation(async () => {
      const envToken = this.ctx.env.ORKESTRATOR_GATEWAY_TOKEN?.trim();
      if (envToken) {
        throw new GatewayTokenValidationError(
          "Gateway token is managed by ORKESTRATOR_GATEWAY_TOKEN and cannot be changed here",
        );
      }

      const token = normalizeGatewayToken(value);
      const authFile = authFilePath(this.ctx.dataDir);
      await persistGatewayToken(authFile, token);
      this.ctx.token = token;
      this.ctx.authFile = authFile;
      this.ctx.agentTestBootstraps.clear();
      this.ctx.agentTestSessions.clear();
      // Authentication is latched when a WebSocket becomes ready. Rotating
      // the credential must therefore revoke every connection authenticated
      // with the previous value rather than waiting for a reconnect.
      this.ctx.terminalWebSocket.revokeConnections();
      // HTTP streaming and proxy requests also latch authentication when they
      // start. Revoke them on rotation so possession of the previous durable
      // token cannot keep an already-open channel alive.
      for (const client of Array.from(this.ctx.clients.keys())) client.destroy();
      this.ctx.clients.clear();
      for (const proxyRequest of Array.from(this.ctx.proxyRequests)) {
        proxyRequest.destroy(new Error("Gateway credential rotated"));
      }
      this.ctx.proxyRequests.clear();
      // Preview access was issued under the previous control credential.
      // Revoke it (closing tunnels and published-origin sessions); clients
      // reauthorize through the new credential.
      this.ctx.previews?.access.revokeAll("credential-rotated");
      this.ctx.previewTunnel?.closeAll();
      return { token, editable: true, source: "file" };
    });
  }

  enqueueTokenOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.ctx.tokenTransition.catch(() => undefined).then(operation);
    this.ctx.tokenTransition = result;
    return result;
  }

  async stop(): Promise<void> {
    this.ctx.agentTestBootstraps.clear();
    this.ctx.agentTestSessions.clear();
    if (this.ctx.keepalive) {
      clearInterval(this.ctx.keepalive);
      this.ctx.keepalive = null;
    }
    for (const client of this.ctx.clients.keys()) {
      client.destroy();
    }
    this.ctx.clients.clear();
    this.ctx.eventReplay.releaseRetained();
    this.ctx.terminalWebSocket.close();
    this.ctx.previewTunnel?.close();
    for (const proxyRequest of this.ctx.proxyRequests) {
      proxyRequest.destroy(new Error("Remote gateway stopped"));
    }
    this.ctx.proxyRequests.clear();
    const servers = [...this.ctx.servers];
    if (servers.length === 0) return;
    // Destroy active sockets before awaiting close callbacks. A streaming
    // response can otherwise keep a listener's close callback pending forever.
    for (const socket of this.ctx.sockets) socket.destroy();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
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
          }),
      ),
    );
    this.ctx.sockets.clear();
    this.ctx.servers.clear();
    this.ctx.loopbackClientUrl = null;
  }
}
