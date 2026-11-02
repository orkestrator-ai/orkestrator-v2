import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import {
  rejectPreviewUpgrade,
  writePreviewError,
} from "@orkestrator/protocol/node/preview-forward";

/**
 * How the forward reaches its service. The transport manager supplies these
 * over the group's tunnel; `publicOrigin` is the origin the browser used.
 */
export interface ExternalForwardUpstream {
  /** The service's port on the backend machine; the preferred local port. */
  applicationPort(): number;
  /** False once the service's group is closed or has no attachment. */
  available(): boolean;
  forwardRequest(
    request: IncomingMessage,
    response: ServerResponse,
    publicOrigin: string,
  ): Promise<void>;
  forwardUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
    publicOrigin: string,
  ): Promise<void>;
}

/** Timer seam for the idle shutdown (tests fire it directly). */
export interface ExternalForwardTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ExternalForwardOptions {
  /** Close after this long with no open connection. */
  idleMs?: number;
  onIdle: () => void;
  timers?: ExternalForwardTimers;
}

const REAL_TIMERS: ExternalForwardTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_IDLE_MS = 10 * 60_000;
const EPHEMERAL_ATTEMPTS = 8;
// Fetch's bad-port list.
// https://fetch.spec.whatwg.org/#port-blocking
export const BROWSER_RESTRICTED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

/**
 * Fetch Metadata check for the uncredentialed forward. Requests from the
 * user's own loopback sites (any port, as a locally run server would accept)
 * pass. From any other site only a top-level document navigation does, so a
 * link to the forward still works while another site's fetches, frames,
 * writes and WebSockets are refused. Without Fetch Metadata a foreign
 * `Origin` is refused; `Origin: null` never counts as loopback.
 */
export function externalForwardSiteViolation(request: IncomingMessage, upgrade: boolean): boolean {
  if (Array.isArray(request.headers.origin)) return true;
  const origin = header(request, "origin");
  const site = header(request, "sec-fetch-site")?.toLowerCase();
  const method = request.method ?? "GET";
  const safe = !upgrade && (method === "GET" || method === "HEAD" || method === "OPTIONS");
  if (!safe) {
    if (origin !== undefined) return !LOOPBACK_ORIGIN.test(origin);
    return site === "cross-site";
  }
  if (site === undefined) return origin !== undefined && !LOOPBACK_ORIGIN.test(origin);
  if (site !== "cross-site" || (origin !== undefined && LOOPBACK_ORIGIN.test(origin))) return false;
  const mode = header(request, "sec-fetch-mode")?.toLowerCase();
  const destination = header(request, "sec-fetch-dest")?.toLowerCase();
  const prefetch = /\bprefetch\b/i.test(header(request, "sec-purpose") ?? "");
  return mode !== "navigate" || destination !== "document" || prefetch;
}

/** Strict loopback authority, serialized exactly as a browser Origin header. */
export function externalForwardOrigin(host: string | undefined, port: number): string | null {
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host)) return null;
  try {
    const url = new URL(`http://${host}`);
    return Number(url.port || 80) === port ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * A loopback listener that lets the user's own browser open a remote service
 * at `http://localhost:<port>`, the way a dev server running on this machine
 * would be opened. Root-relative URLs, WebSockets and `localhost`'s secure
 * context all work unchanged, and the page never shares a host with the
 * Orkestrator gateway, so the gateway's cookie never reaches it.
 *
 * Unlike the in-app ingress it carries no credential: an external browser
 * cannot be made to send one. It is bounded instead by being loopback-only,
 * accepting only a loopback `Host` (no DNS rebinding), refusing foreign-site
 * subresources and writes, and closing once idle. That is the exposure of a
 * dev server run locally. Where exclusive binding is supported, it prefers
 * the service's own browser-safe port so absolute `localhost` URLs and OAuth callbacks keep working, and binds 127.0.0.1 and
 * ::1 together so `localhost` can never reach another local server on the
 * other address family. macOS/BSD always use an OS-assigned port.
 */
export class PreviewExternalForward {
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Socket>();
  private idleTimer: unknown = null;
  private boundPort = 0;
  private closed = false;

  constructor(
    private readonly upstream: ExternalForwardUpstream,
    private readonly options: ExternalForwardOptions,
  ) {}

  private get timers(): ExternalForwardTimers {
    return this.options.timers ?? REAL_TIMERS;
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.timers.clear(this.idleTimer);
    this.idleTimer = null;
  }

  get port(): number {
    return this.boundPort;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Prefer a browser-safe service port where loopback binding is exclusive. */
  async listen(): Promise<number> {
    const preferred = this.upstream.applicationPort();
    // BSD's SO_REUSEADDR permits a specific-address listener to shadow a
    // wildcard server. An OS-assigned port avoids taking over its traffic.
    if (
      (process.platform === "linux" || process.platform === "win32") &&
      preferred > 0 &&
      !BROWSER_RESTRICTED_PORTS.has(preferred) &&
      (await this.bindBoth(preferred))
    )
      return this.ready(preferred);
    for (let attempt = 0; attempt < EPHEMERAL_ATTEMPTS; attempt += 1) {
      if (this.closed) break;
      const first = await this.bind("127.0.0.1", 0);
      const port = (first.address() as AddressInfo).port;
      if (!BROWSER_RESTRICTED_PORTS.has(port) && (await this.bindFamily("::1", port)))
        return this.ready(port);
      await this.closeServers();
    }
    throw new Error("No free loopback port for the external preview.");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    for (const socket of Array.from(this.sockets)) socket.destroy();
    await this.closeServers();
  }

  private ready(port: number): number {
    if (this.closed) {
      void this.closeServers();
      throw new Error("The external preview was closed while starting.");
    }
    this.boundPort = port;
    this.armIdle();
    return port;
  }

  private async bindBoth(port: number): Promise<boolean> {
    try {
      await this.bind("127.0.0.1", port);
    } catch {
      return false;
    }
    if (await this.bindFamily("::1", port)) return true;
    await this.closeServers();
    return false;
  }

  /** Bind ::1 too; a host without IPv6 loopback has nothing to shadow. */
  private async bindFamily(address: string, port: number): Promise<boolean> {
    try {
      await this.bind(address, port);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT";
    }
  }

  private bind(address: string, port: number): Promise<Server> {
    const server = createServer((request, response) => void this.handleRequest(request, response));
    server.on(
      "upgrade",
      (request: IncomingMessage, socket: Socket, head: Buffer) =>
        void this.handleUpgrade(request, socket, head),
    );
    server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      this.clearIdle();
      socket.once("close", () => {
        this.sockets.delete(socket);
        if (this.sockets.size === 0) this.armIdle();
      });
    });
    server.maxConnections = 128;
    server.headersTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    return new Promise<Server>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        this.servers.push(server);
        resolve(server);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, address);
    });
  }

  private armIdle(): void {
    if (this.closed || this.boundPort === 0) return;
    this.clearIdle();
    this.idleTimer = this.timers.set(() => {
      this.idleTimer = null;
      if (this.sockets.size === 0) this.options.onIdle();
    }, this.options.idleMs ?? DEFAULT_IDLE_MS);
  }

  private async closeServers(): Promise<void> {
    const servers = this.servers.splice(0);
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            const fallback = setTimeout(resolve, 250);
            fallback.unref?.();
            server.close(() => {
              clearTimeout(fallback);
              resolve();
            });
            server.closeAllConnections?.();
          }),
      ),
    );
  }

  /** The origin the browser used, or null for a Host that is not this forward on loopback. */
  private publicOrigin(request: IncomingMessage): string | null {
    return externalForwardOrigin(request.headers.host, this.boundPort);
  }

  private authorize(
    request: IncomingMessage,
    upgrade: boolean,
  ): { origin: string } | { denied: "forbidden" | "backend-unavailable" } {
    const origin = this.publicOrigin(request);
    if (!origin || externalForwardSiteViolation(request, upgrade)) return { denied: "forbidden" };
    if (this.closed || !this.upstream.available()) return { denied: "backend-unavailable" };
    return { origin };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const decision = this.authorize(request, false);
    if ("denied" in decision) {
      writePreviewError(response, decision.denied);
      return;
    }
    await this.upstream
      .forwardRequest(request, response, decision.origin)
      .catch(() => writePreviewError(response, "internal"));
  }

  private async handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
    socket.on("error", () => undefined);
    const decision = this.authorize(request, true);
    if ("denied" in decision) {
      rejectPreviewUpgrade(socket, decision.denied);
      return;
    }
    await this.upstream
      .forwardUpgrade(request, socket, head, decision.origin)
      .catch(() => rejectPreviewUpgrade(socket, "internal"));
  }
}

export interface ExternalPreviewRoutes {
  /** The window's connection is to another machine. */
  remote: boolean;
  /** Whether the backend can publish private HTTPS origins right now. */
  publicationAvailable: () => Promise<boolean>;
  /** Open through the private origin's one-use sign-in. */
  publish: () => Promise<void>;
  /** Open a local forward and return its URL. */
  forward: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;
}

/**
 * Pick how a service opens in the user's own browser. A private origin, when
 * the operator configured one, keeps services isolated from each other; a
 * remote service without one is forwarded to `localhost`. A local service
 * keeps the private-origin path, whose error explains the missing setup.
 */
export async function openServiceInExternalBrowser(routes: ExternalPreviewRoutes): Promise<void> {
  if (routes.remote && !(await routes.publicationAvailable().catch(() => false))) {
    await routes.openExternal(await routes.forward());
    return;
  }
  await routes.publish();
}
