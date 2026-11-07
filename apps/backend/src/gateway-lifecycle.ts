import { createServer } from "node:http";
import { PREVIEW_TUNNEL_PATH } from "@orkestrator/protocol/preview-access";
import { TERMINAL_WEBSOCKET_PATH } from "@orkestrator/protocol/terminal-websocket";
import { NODE_RELAY_PREFIX } from "./core/nodes/index.js";
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
import { assertGatewayBindAllowed } from "./gateway-bind-policy.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("gateway");

/**
 * Where an accepted request goes: `GatewayAuth.handle`. `GatewayAuth` calls
 * back into this class for the token settings, so the facade passes a callback
 * bound late to it.
 */
export type GatewayRequestRouter = Pick<GatewayAuth, "handle"> &
  Partial<Pick<GatewayAuth, "handleUpgrade">>;

/** The loopback client gateway binds IPv4 loopback only. */
const LOOPBACK_CLIENT_BIND_ADDRESS = "127.0.0.1";

/**
 * How long an idle keep-alive connection stays open. It must outlast the idle
 * timeout of a reverse proxy in front, so the proxy is always the side that
 * closes. Tailscale Serve keeps idle upstream connections for 90 s (`getTransport`
 * in ipn/ipnlocal/serve.go). If the gateway closes first, a POST that Serve has
 * just put on that connection fails, Go will not replay it, and the client gets
 * an empty-bodied 502. Bun closes about a second after this value.
 *
 * `headersTimeout` is left alone: on Bun 1.4 it neither ends an idle connection
 * at its default 60 s nor limits a slow request.
 */
export const GATEWAY_KEEP_ALIVE_TIMEOUT_MS = 120_000;

/** Listeners, the durable gateway token, and shutdown. */
export class GatewayLifecycle {
  constructor(
    private readonly ctx: GatewayContext,
    private readonly router: GatewayRequestRouter,
  ) {}

  async start(): Promise<GatewayStartInfo | null> {
    if (this.ctx.env.ORKESTRATOR_GATEWAY_DISABLED === "1") {
      log.info("disabled", { source: "ORKESTRATOR_GATEWAY_DISABLED" });
      return null;
    }

    const tailscaleBindAddress = selectTailscaleBindAddress(this.ctx.interfaces);
    const bindAddress =
      this.ctx.bindAddress ??
      this.ctx.env.ORKESTRATOR_GATEWAY_HOST ??
      tailscaleBindAddress ??
      this.ctx.fallbackBindAddress;
    if (!bindAddress && !this.ctx.controlBindAddress && this.ctx.loopbackClientPort === undefined) {
      log.warn("tailscale.no-address");
      return null;
    }
    const usingFallback =
      !this.ctx.bindAddress &&
      !this.ctx.env.ORKESTRATOR_GATEWAY_HOST &&
      !tailscaleBindAddress &&
      this.ctx.fallbackBindAddress === bindAddress;
    if (usingFallback) {
      log.warn("tailscale.no-address-fallback", { bindAddress: this.ctx.fallbackBindAddress });
    }
    const safeLoopbackFallback =
      usingFallback && bindAddress !== undefined && isLoopbackAddress(bindAddress);
    if (bindAddress) {
      assertGatewayBindAllowed(bindAddress, {
        allowNonTailscaleBind: this.ctx.allowNonTailscaleBind,
        safeLoopbackFallback,
      });
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
      log.info("control.listening", { url: controlListener.url });
    }

    let browserListener: { bindAddress: string; port: number; url: string } | null = null;
    let browserError: string | undefined;
    let browserFailure: unknown;
    if (bindAddress) {
      try {
        browserListener = await this.listenWithPortFallback(bindAddress, port);
        log.info("browser.listening", { url: browserListener.url });
      } catch (error) {
        if (!controlListener && this.ctx.loopbackClientPort === undefined) throw error;
        browserFailure = error;
        browserError = error instanceof Error ? error.message : String(error);
        log.error("browser.unavailable", { error: formatLogError(error) });
      }
    } else {
      browserError = "No Tailscale address was found";
      log.warn("browser.unavailable-degraded", {
        reason: "no-tailscale-address",
        remaining: controlListener ? "desktop-control" : "loopback-client",
      });
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
        log.info("loopback.listening", { url: loopbackClientListener.url });
      } catch (error) {
        loopbackClientError = error instanceof Error ? error.message : String(error);
        log.error("loopback.unavailable", {
          address: LOOPBACK_CLIENT_BIND_ADDRESS,
          port: this.ctx.loopbackClientPort,
          error: formatLogError(error),
        });
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
    log.info("auth-token.stored", { file: this.ctx.authFile });

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
          log.warn("port.fallback", { preferredPort, port: candidatePort });
        }
        return listener;
      } catch (error) {
        if (!isAddressInUseError(error)) throw error;
      }
    }

    const listener = await this.listen(bindAddress, 0, "browser");
    log.warn("port.fallback-distant", { preferredPort, port: listener.port });
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
        log.error("request.failed", { listener: listenerKind, error: formatLogError(error) });
        if (!response.headersSent) {
          jsonResponse(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    server.keepAliveTimeout = GATEWAY_KEEP_ALIVE_TIMEOUT_MS;
    server.on("connection", (socket) => {
      this.ctx.traffic.noteConnection(listenerKind);
      this.ctx.sockets.add(socket);
      // Who ended the connection: a FIN from the client arrives as `end`
      // while this side is still writable; anything else is the gateway's
      // own close (keep-alive timeout, `connection: close`, shutdown).
      // Prepended so they run before the HTTP server's own handlers, which
      // end the socket on `end`. Bun reports a reset only as `error`, never
      // as `close(hadError)`, so the error flag is kept separately.
      let peerEndedFirst = false;
      let failed = false;
      socket.prependOnceListener("end", () => {
        if (!socket.writableEnded) peerEndedFirst = true;
      });
      socket.prependListener("error", () => {
        failed = true;
      });
      socket.once("close", (hadError: boolean) => {
        this.ctx.sockets.delete(socket);
        this.ctx.traffic.noteSocketClosed(
          socket,
          hadError || failed ? "error" : peerEndedFirst ? "peer" : "server",
        );
      });
    });
    server.on("upgrade", (request, socket, head) => {
      try {
        // Upgrades bypass the HTTP request callback. Count them once here,
        // including rejected upgrades, using only fixed route labels.
        const pathname = new URL(request.url ?? "/", "http://orkestrator.local").pathname;
        const route =
          pathname === TERMINAL_WEBSOCKET_PATH
            ? "upgrade-terminal"
            : pathname === PREVIEW_TUNNEL_PATH
              ? "upgrade-preview-tunnel"
              : pathname.startsWith(NODE_RELAY_PREFIX)
                ? "upgrade-node-relay"
                : "upgrade-other";
        this.ctx.traffic.noteRequest(request, route);
        if (!this.ctx.hostPolicy.allows(request.headers.host)) {
          socket.end("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n");
          return;
        }
        // Exact-path routing: the preview tunnel claims only its own path and
        // never steals terminal upgrades; everything unclaimed is destroyed.
        if (this.ctx.previewTunnel?.handleUpgrade(request, socket, head)) return;
        // A leaf workspace's terminal relayed through this command node.
        if (this.router.handleUpgrade?.(request, socket, head)) return;
        if (!this.ctx.terminalWebSocket.handleUpgrade(request, socket, head)) socket.destroy();
      } catch {
        log.warn("websocket.upgrade-failed");
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
      this.ctx.credentialThrottle.reset();
      // Every browser session was signed in under the previous token.
      this.ctx.browserSessions.revokeAll();
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
    this.ctx.traffic.flush();
    this.ctx.agentTestBootstraps.clear();
    this.ctx.browserSessions.revokeAll();
    if (this.ctx.keepalive) {
      clearInterval(this.ctx.keepalive);
      this.ctx.keepalive = null;
    }
    for (const client of this.ctx.clients.keys()) {
      client.destroy();
    }
    this.ctx.clients.clear();
    this.ctx.nodeEventMultiplexer?.closeAll();
    this.ctx.eventReplay.releaseRetained();
    this.ctx.relayedEventReplay.releaseRetained();
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
