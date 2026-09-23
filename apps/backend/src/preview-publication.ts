import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
  PREVIEW_BOOTSTRAP_PATH,
  PREVIEW_RESERVED_PREFIX,
  PREVIEW_SESSION_COOKIE,
  PREVIEW_SESSION_PATH,
} from "@orkestrator/protocol/preview-access";
import { rejectPreviewUpgrade } from "@orkestrator/protocol/preview-forward";
import {
  crossSiteViolation,
  pairsFromRaw,
  readCookie,
} from "@orkestrator/protocol/preview-header-policy";
import { previewErrorFromUnknown } from "@orkestrator/protocol/preview-services";

import type { PreviewPublicationPort } from "./core/preview-access.js";
import type { PreviewRuntime } from "./core/preview-runtime.js";
import type { PreviewSettings } from "./core/storage-preview-services.js";
import { isLoopbackAddress, isTailscaleAddress } from "./gateway-internals.js";
import { PreviewHttpProxy } from "./preview-http-proxy.js";

export interface PreviewPublicationStatus {
  enabled: boolean;
  available: boolean;
  reason?: string;
  domain: string | null;
  listening: { address: string; port: number } | null;
  certificate: { validTo: string; coversHosts: boolean } | null;
}

export interface PreviewPublicationOptions {
  runtime: PreviewRuntime;
  logger: Pick<Console, "info" | "warn">;
  /** Certificate files are re-read on this interval and hot-swapped when changed. */
  certificateCheckMs?: number;
  /** Test seam for the certificate expiry clock. */
  now?: () => number;
}

const MAX_BOOTSTRAP_BODY_BYTES = 4 * 1024;
const DOMAIN =
  /^(?=.{1,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
} as const;

function page(response: ServerResponse, status: number, title: string, detail: string): void {
  const escape = (value: string) =>
    value.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font:14px system-ui;margin:3rem;max-width:36rem"><h1 style="font-size:18px">${escape(title)}</h1><p>${escape(detail)}</p></body>`,
  );
}

function hostOf(request: IncomingMessage): { name: string; port: number | null } | null {
  const host = request.headers.host;
  if (typeof host !== "string" || host.length > 255) return null;
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(host);
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), port: match[2] ? Number(match[2]) : null };
}

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const type = String(request.headers["content-type"] ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (type !== "application/x-www-form-urlencoded") {
      reject(new Error("unsupported content type"));
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BOOTSTRAP_BODY_BYTES) {
        request.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    request.once("error", reject);
  });
}

/**
 * Private HTTPS preview origins for normal browsers.
 *
 * One separate listener serves `s-<id>.<domain>` service hosts and a dedicated
 * `bootstrap.<domain>` authority. It has no control dispatch at all: the
 * Orkestrator API, renderer, and agent bridges are never reachable through it.
 * Hosts are derived from the stable service identity, so a hostname is never
 * reused for a different service. DNS and the certificate are operator
 * provisioned (see the decision record); without them publication stays
 * unavailable and desktop transport is unaffected.
 */
export class PreviewPublicationManager implements PreviewPublicationPort {
  private server: Server | null = null;
  private settings: PreviewSettings["publication"] | null = null;
  private certificate: { cert: string; key: string; validTo: string; coversHosts: boolean } | null =
    null;
  private reason: string | undefined = "Private preview publication is not configured.";
  private readonly proxy: PreviewHttpProxy;
  private certificateTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sockets = new Set<Duplex>();
  private readonly hostToService = new Map<string, string>();
  private listening: { address: string; port: number } | null = null;
  private boundPort: number | null = null;
  private readonly unsubscribe: () => void;
  private reconfiguring: Promise<void> = Promise.resolve();

  constructor(private readonly options: PreviewPublicationOptions) {
    this.proxy = new PreviewHttpProxy({
      runtime: options.runtime,
      metrics: options.runtime.metrics,
      upstream: { ca: () => options.runtime.upstreamCa() },
    });
    options.runtime.publicationStatus = () => this.capability();
    options.runtime.publicationDetail = () => this.status();
    options.runtime.metrics.gauge("publication.sockets", () => this.sockets.size);
    options.runtime.metrics.gauge("publication.http_active", () => this.proxy.stats().http.active);
    options.runtime.metrics.gauge(
      "publication.upgrades_active",
      () => this.proxy.stats().upgrades.active,
    );
    this.unsubscribe = options.runtime.onSettingsChanged(() => {
      void this.reconfigure().catch((error: unknown) => {
        options.logger.warn(
          `[previews] Publication reconfiguration failed: ${error instanceof Error ? error.message : "error"}`,
        );
      });
    });
  }

  status(): PreviewPublicationStatus {
    return {
      enabled: this.settings?.enabled ?? false,
      available: this.reason === undefined && this.listening !== null,
      ...(this.reason ? { reason: this.reason } : {}),
      domain: this.settings?.domain ?? null,
      listening: this.listening,
      certificate: this.certificate
        ? { validTo: this.certificate.validTo, coversHosts: this.certificate.coversHosts }
        : null,
    };
  }

  private capability(): { available: boolean; reason?: string } {
    const status = this.status();
    return status.available
      ? { available: true }
      : { available: false, reason: status.reason ?? "Unavailable." };
  }

  // PreviewPublicationPort ---------------------------------------------------

  private publicPortNumber(): number {
    return this.settings?.publicPort ?? this.listening?.port ?? 443;
  }

  private publicPort(): string {
    const port = this.publicPortNumber();
    return port === 443 ? "" : `:${port}`;
  }

  bootstrapAction(): string | null {
    if (!this.status().available || !this.settings?.domain) return null;
    return `https://bootstrap.${this.settings.domain}${this.publicPort()}${PREVIEW_BOOTSTRAP_PATH}`;
  }

  hostFor(serviceId: string): string | null {
    const domain = this.settings?.domain;
    if (!domain) return null;
    const instance = this.options.runtime.registry.backendInstanceId;
    const label = createHash("sha256")
      .update(`${instance}:${serviceId}`)
      .digest("hex")
      .slice(0, 20);
    const host = `s-${label}.${domain}`;
    this.hostToService.set(host, serviceId);
    return host;
  }

  originFor(serviceId: string): string | null {
    if (!this.status().available) return null;
    if (!this.options.runtime.registry.getDefinition(serviceId)) return null;
    const host = this.hostFor(serviceId);
    return host ? `https://${host}${this.publicPort()}` : null;
  }

  private serviceForHost(host: string): string | null {
    const cached = this.hostToService.get(host);
    if (cached && this.options.runtime.registry.getDefinition(cached)) return cached;
    // Recompute from the registry (bounded by the definition limit).
    for (const definition of this.options.runtime.registry.snapshot().services) {
      if (this.hostFor(definition.definition.serviceId) === host)
        return definition.definition.serviceId;
    }
    return null;
  }

  // Lifecycle ----------------------------------------------------------------

  start(): Promise<void> {
    return this.reconfigure();
  }

  reconfigure(): Promise<void> {
    this.reconfiguring = this.reconfiguring.catch(() => undefined).then(() => this.apply());
    return this.reconfiguring;
  }

  private async apply(): Promise<void> {
    const settings = this.options.runtime.effectiveSettings().publication;
    // The upstream CA is read per connection by the proxy; it never requires
    // re-binding the listener.
    const listenerKey = (value: PreviewSettings["publication"] | null) =>
      value ? JSON.stringify({ ...value, upstreamCaFile: null }) : "";
    if (this.server && listenerKey(settings) === listenerKey(this.settings)) {
      this.settings = settings;
      return;
    }
    const rebinding = this.settings === null && this.boundPort !== null;
    await this.close();
    if (!rebinding) this.boundPort = null;
    this.settings = settings;
    this.hostToService.clear();
    if (!settings.enabled) {
      this.reason = "Private preview publication is disabled.";
      return;
    }
    if (!settings.domain || !DOMAIN.test(settings.domain)) {
      this.reason =
        "Set a preview domain (for example preview.example.ts.net) with wildcard DNS on your private network.";
      return;
    }
    if (!settings.certFile || !settings.keyFile) {
      this.reason = `Provide a certificate and key covering *.${settings.domain}.`;
      return;
    }
    const address = settings.listenAddress ?? "127.0.0.1";
    // Never public ingress: loopback (fronted by Tailscale Serve TCP forwarding)
    // or a tailnet address only.
    if (!isLoopbackAddress(address) && !isTailscaleAddress(address)) {
      this.reason = "The preview listener may bind only to loopback or a Tailscale address.";
      return;
    }
    try {
      await this.loadCertificate(settings);
    } catch (error) {
      this.reason = `The preview certificate could not be loaded: ${error instanceof Error ? error.message : "error"}.`;
      return;
    }
    if (!this.certificate?.coversHosts) {
      this.reason = `The certificate does not cover bootstrap.${settings.domain} and *.${settings.domain}.`;
      return;
    }
    const server = createServer(
      { cert: this.certificate.cert, key: this.certificate.key, minVersion: "TLSv1.2" },
      (request, response) => void this.handle(request, response),
    );
    server.on(
      "upgrade",
      (request: IncomingMessage, socket: Duplex, head: Buffer) =>
        void this.handleUpgrade(request, socket, head),
    );
    server.on("secureConnection", (socket: Duplex) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("tlsClientError", () => undefined);
    server.headersTimeout = 30_000;
    server.requestTimeout = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.boundPort ?? settings.port ?? 8443, address, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.reason = `The preview listener could not bind: ${error instanceof Error ? error.message : "error"}.`;
      server.close();
      return;
    }
    this.server = server;
    const bound = server.address() as AddressInfo;
    // Renewals re-bind the same port even when the configured port is ephemeral.
    this.boundPort = bound.port;
    this.listening = { address: bound.address, port: bound.port };
    this.reason = undefined;
    this.options.runtime.publication = this;
    this.certificateTimer = setInterval(
      () => void this.refreshCertificate(),
      this.options.certificateCheckMs ?? 60_000,
    );
    this.certificateTimer.unref?.();
    this.options.logger.info(
      `[previews] Private preview origins listening on ${bound.address}:${bound.port} for *.${settings.domain}`,
    );
  }

  private async loadCertificate(settings: PreviewSettings["publication"]): Promise<void> {
    const [cert, key] = await Promise.all([
      readFile(settings.certFile!, "utf8"),
      readFile(settings.keyFile!, "utf8"),
    ]);
    const x509 = new X509Certificate(cert);
    const now = this.options.now?.() ?? Date.now();
    if (Date.parse(x509.validTo) <= now) throw new Error(`certificate expired ${x509.validTo}`);
    const coversHosts =
      Boolean(x509.checkHost(`bootstrap.${settings.domain}`)) &&
      Boolean(x509.checkHost(`s-0123456789abcdef0123.${settings.domain}`));
    this.certificate = { cert, key, validTo: x509.validTo, coversHosts };
  }

  /** Renewal: hot-swap the context without touching other listeners. */
  private async refreshCertificate(): Promise<void> {
    const settings = this.settings;
    const server = this.server;
    if (!settings || !server || !this.certificate) return;
    const previous = this.certificate;
    try {
      await this.loadCertificate(settings);
    } catch (error) {
      this.certificate = previous;
      const expired = Date.parse(previous.validTo) <= (this.options.now?.() ?? Date.now());
      if (expired) {
        this.reason = "The preview certificate expired and could not be renewed.";
        this.options.runtime.publication = null;
      }
      this.options.logger.warn(
        `[previews] Certificate refresh failed: ${error instanceof Error ? error.message : "error"}`,
      );
      return;
    }
    if (this.certificate.cert !== previous.cert || this.certificate.key !== previous.key) {
      if (!this.certificate.coversHosts) {
        this.certificate = previous;
        this.options.logger.warn(
          "[previews] Ignoring a renewed certificate that does not cover the preview hosts",
        );
        return;
      }
      // Bun's HTTPS server supports neither setSecureContext nor SNICallback,
      // so renewal re-binds only this listener on the same address and port.
      // Preview sessions are server-side and survive; gateway listeners are
      // untouched. In-flight preview connections reconnect.
      this.settings = null;
      await this.reconfigure();
      this.options.logger.info(
        `[previews] Reloaded preview certificate (valid to ${this.certificate?.validTo ?? "unknown"})`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.options.runtime.publication === this) this.options.runtime.publication = null;
    if (this.certificateTimer) clearInterval(this.certificateTimer);
    this.certificateTimer = null;
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (!server) return;
    for (const socket of Array.from(this.sockets)) socket.destroy();
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(resolve, 250);
      fallback.unref?.();
      server.close(() => {
        clearTimeout(fallback);
        resolve();
      });
      server.closeAllConnections?.();
    });
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.reconfiguring.catch(() => undefined);
    await this.close();
  }

  // Routing ------------------------------------------------------------------

  /** Exact authority to service before any application routing. */
  private route(
    request: IncomingMessage,
  ): { kind: "bootstrap" } | { kind: "service"; serviceId: string; host: string } | null {
    const domain = this.settings?.domain;
    const host = hostOf(request);
    const port = host?.port ?? 443;
    if (!domain || !host || (port !== this.publicPortNumber() && port !== this.listening?.port)) {
      return null;
    }
    if (host.name === `bootstrap.${domain}`) return { kind: "bootstrap" };
    if (!host.name.endsWith(`.${domain}`)) return null;
    const serviceId = this.serviceForHost(host.name);
    return serviceId ? { kind: "service", serviceId, host: host.name } : null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = this.route(request);
    if (!route) {
      // Unknown Host values are refused even if DNS resolves them here.
      page(
        response,
        421,
        "Unknown preview host",
        "This address does not belong to a published preview.",
      );
      return;
    }
    const url = new URL(request.url ?? "/", "https://preview.invalid");
    if (route.kind === "bootstrap") {
      await this.bootstrap(request, response, url);
      return;
    }
    if (url.pathname === PREVIEW_SESSION_PATH) {
      this.session(response, url, route.serviceId);
      return;
    }
    if (url.pathname.startsWith(PREVIEW_RESERVED_PREFIX)) {
      page(response, 404, "Not found", "Reserved preview path.");
      return;
    }
    const headers = pairsFromRaw(request.rawHeaders);
    let access;
    try {
      access = this.options.runtime.access.authenticateSession(
        readCookie(headers, PREVIEW_SESSION_COOKIE),
        route.serviceId,
      );
    } catch (error) {
      const category = previewErrorFromUnknown(error)?.category ?? "forbidden";
      this.options.runtime.metrics.increment("http.rejected", category);
      page(
        response,
        401,
        "Preview access expired",
        "Open this preview again from Orkestrator to sign in.",
      );
      return;
    }
    const publicOrigin = `https://${route.host}${this.publicPort()}`;
    if (crossSiteViolation(request.method ?? "GET", headers, publicOrigin, false)) {
      this.options.runtime.metrics.increment("http.rejected", "forbidden");
      page(
        response,
        403,
        "Cross-site request refused",
        "Writes to a preview must come from the preview itself.",
      );
      return;
    }
    await this.proxy.handleRequest(request, response, {
      access,
      publicOrigin,
      forwardedFor: request.socket.remoteAddress,
    });
  }

  private async bootstrap(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (url.pathname !== PREVIEW_BOOTSTRAP_PATH || request.method !== "POST") {
      page(response, 405, "Preview sign-in", "Open previews from Orkestrator.");
      return;
    }
    let form: URLSearchParams;
    try {
      form = await readForm(request);
    } catch {
      page(response, 400, "Invalid sign-in request", "Open the preview again from Orkestrator.");
      return;
    }
    try {
      const { code, origin } = this.options.runtime.access.consumeBootstrapGrant(
        form.get("attachment"),
        form.get("grant"),
      );
      this.options.runtime.metrics.increment("bootstrap.completed");
      response.writeHead(303, {
        ...SECURITY_HEADERS,
        location: `${origin}${PREVIEW_SESSION_PATH}?code=${encodeURIComponent(code)}`,
      });
      response.end();
    } catch (error) {
      const category = previewErrorFromUnknown(error)?.category ?? "forbidden";
      this.options.runtime.metrics.increment("bootstrap.failed", category);
      page(
        response,
        category === "access-expired" ? 410 : 403,
        category === "access-expired" ? "This preview link expired" : "Preview sign-in refused",
        "Sign-in links work once and expire after a minute. Open the preview again from Orkestrator.",
      );
    }
  }

  private session(response: ServerResponse, url: URL, serviceId: string): void {
    try {
      const { session, path } = this.options.runtime.access.consumeSessionCode(
        url.searchParams.get("code"),
        serviceId,
      );
      response.writeHead(303, {
        ...SECURITY_HEADERS,
        // Host-only, HttpOnly, Secure: siblings cannot set or shadow it and
        // application script cannot read it. It never authenticates control routes.
        "set-cookie": `${PREVIEW_SESSION_COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        location: path,
      });
      response.end();
    } catch {
      page(response, 403, "Preview sign-in refused", "Open the preview again from Orkestrator.");
    }
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    socket.on("error", () => undefined);
    const route = this.route(request);
    if (!route || route.kind !== "service") {
      rejectPreviewUpgrade(socket, "not-found");
      return;
    }
    const headers = pairsFromRaw(request.rawHeaders);
    let access;
    try {
      access = this.options.runtime.access.authenticateSession(
        readCookie(headers, PREVIEW_SESSION_COOKIE),
        route.serviceId,
      );
    } catch {
      rejectPreviewUpgrade(socket, "access-expired");
      return;
    }
    const publicOrigin = `https://${route.host}${this.publicPort()}`;
    // Cross-site WebSocket hijacking: upgrades must come from the service's own origin.
    if (crossSiteViolation("GET", headers, publicOrigin, true)) {
      rejectPreviewUpgrade(socket, "forbidden");
      return;
    }
    await this.proxy.handleUpgrade(request, socket, head, {
      access,
      publicOrigin,
      forwardedFor: request.socket.remoteAddress,
    });
  }
}
