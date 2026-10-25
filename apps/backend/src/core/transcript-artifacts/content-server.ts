/**
 * Dedicated listener for prepared executable artifact documents.
 *
 * It is not the gateway: it has no application routes, no control dispatch,
 * never reads or sets cookies, never redirects, and serves exactly one fixed
 * object per short-lived capability (`/a/<capability>`). The capability is a
 * random 256-bit table key bound to one artifact, revision, prepared-document
 * hash and representation; it is minted only by the authenticated service
 * after its own ownership check, expires, and can be revoked. Capabilities are
 * bearer secrets, so nothing here logs a URL or token.
 *
 * Browser viewer shell. `/s/<capability>` serves the trusted viewer shell for
 * the same capability (content-shell.ts): a fixed hashed relay whose
 * `frame-src` names exactly `/a/<capability>`, framed by the application
 * page in browser mode so the artifact frame cannot navigate anywhere else.
 * It shares the document's expiry, revocation and serve-time authorization
 * and never loads the document's bytes itself. Because the shell has the
 * content origin, every document's `frame-ancestors` also names the content
 * origin (the only non-opaque documents it serves are shells; media and
 * documents are CSP-sandboxed to opaque origins), while the shell's own
 * `frame-ancestors` and the document's still require the application above.
 *
 * Media. `/m/<capability>` serves one environment file (audio, video or a
 * raster image) resolved by an authenticated, confined backend command, with
 * single byte ranges; see media-stream-route.ts.
 *
 * Origin. Desktop and local browser use loopback but a different host name
 * from the application (application on 127.0.0.1 → content on `localhost`,
 * and vice versa), so application cookies are never sent. A different port
 * alone is a different origin but NOT a credential boundary: cookies ignore
 * ports. Hosted deployments must set ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN to a
 * different registrable site (not a cookie-sharing subdomain) that proxies to
 * this listener. The application's real origins are supplied once the
 * gateway has bound (`configureApplicationOrigins`): the loopback content
 * host name is then chosen to differ from every application host, and a
 * hosted content origin that is the same site as the application disables
 * live viewing with a reason instead of serving.
 *
 * Authorization is re-checked on every request through the capability's
 * optional `authorize` callback (the publication, owner and environment
 * still exist and nothing was revoked); a negative or failed answer revokes
 * the capability and fails closed.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { INTERACTIVE_HTML_POLICY } from "@orkestrator/protocol/rich-content-policy";

import type { ArtifactContentServer } from "./contracts.js";
import { sha256Hex } from "./dependency-manifest.js";
import { artifactShellResponse } from "./content-shell.js";
import {
  buildInteractiveCsp,
  normalizeFrameAncestors,
  rebindFrameAncestors,
} from "./interactive-csp.js";
import {
  MEDIA_CAPABILITY_PATTERN,
  MediaCapabilityTable,
  type MintMediaInput,
} from "./media-stream-route.js";

export const CONTENT_CAPABILITY_DEFAULT_TTL_MS = 15 * 60 * 1000;
export const CONTENT_CAPABILITY_MAX_TTL_MS = 60 * 60 * 1000;
export const CONTENT_CAPABILITY_MAX_ENTRIES = 1_024;

const CAPABILITY_PATTERN = /^\/a\/([A-Za-z0-9_-]{43})$/;
const SHELL_PATTERN = /^\/s\/([A-Za-z0-9_-]{43})$/;
const LOAD_TIMEOUT_MS = 10_000;
const AUTHORIZE_TIMEOUT_MS = 5_000;
const LOOPBACK_HOST_NAMES = ["localhost", "127.0.0.1"] as const;

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

/**
 * Approximate registrable domain ("site") of a host name without a public
 * suffix list: IP literals and one/two-label names are their own site;
 * otherwise the last two labels, or three when the second-level label is a
 * common public-suffix pattern (`co.uk`, `com.au`, …). The approximation errs
 * towards "same site", which only ever refuses a configuration.
 */
export function approximateSite(hostname: string): string {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (isIpLiteral(host)) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const second = labels.at(-2)!;
  const take =
    labels.at(-1)!.length === 2 && ["co", "com", "net", "org", "gov", "ac", "edu"].includes(second)
      ? 3
      : 2;
  return labels.slice(-take).join(".");
}

/** Whether two host names could share cookies (same site, or one a domain of the other). */
export function hostsShareSite(left: string, right: string): boolean {
  const a = left.toLowerCase().replace(/^\[|\]$/g, "");
  const b = right.toLowerCase().replace(/^\[|\]$/g, "");
  if (a === b) return true;
  if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  return approximateSite(a) === approximateSite(b);
}

/** Exact origins (scheme://host[:port]) of the application's own pages; others are dropped. */
export function normalizeApplicationOrigins(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!result.includes(url.origin)) result.push(url.origin);
    } catch {
      // Not an origin.
    }
  }
  return result;
}

/** Headers on every response, including errors. */
const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-dns-prefetch-control": "off",
  // Iframe navigations are only CORP-checked under an embedder COEP; the
  // document is meant to be embedded cross-site by the viewer. `cross-origin`
  // keeps a future COEP application working. No-cors reads by other sites
  // gain nothing: the URL is an unguessable bearer capability, and `nosniff`
  // stops the HTML being consumed as script or style.
  "cross-origin-resource-policy": "cross-origin",
  "permissions-policy":
    "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), serial=(), hid=(), clipboard-read=(), clipboard-write=(), fullscreen=(), publickey-credentials-get=()",
} as const;

const ERROR_HEADERS = {
  ...BASE_HEADERS,
  "content-type": "text/plain; charset=utf-8",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
} as const;

export interface ArtifactContentServerOptions {
  /** Trusted viewer origins for `frame-ancestors`. */
  frameAncestors: readonly string[];
  /** Interface to bind; loopback by default. */
  bindHost?: string;
  port?: number;
  /** Host name used in URLs for loopback mode (default `localhost`). */
  loopbackHostname?: string;
  /** Public origin for hosted deployments (a different site); overrides loopback URLs. */
  publicOrigin?: string;
  /** The application's own page origins; the content origin must be a different site. */
  applicationOrigins?: readonly string[];
  maxEntries?: number;
  /** Largest ranged media response body (tests; default 8 MiB). */
  mediaRangeResponseMaxBytes?: number;
  now?: () => number;
  logger?: Pick<Console, "info" | "warn">;
}

interface Capability {
  artifactId: string;
  revision: number;
  preparedSha256: string;
  contentSecurityPolicy: string;
  /** Ancestors permitted to frame the shell (snapshotted at mint, like the document's). */
  shellFrameAncestors: readonly string[];
  load: () => Promise<Uint8Array>;
  authorize?: () => Promise<boolean>;
  expiresAt: number;
  generation: string;
}

function token(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function parsePublicOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Content origin must be http(s)");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Content origin must be a bare origin");
  }
  return url;
}

export class LoopbackArtifactContentServer implements ArtifactContentServer {
  private readonly capabilities = new Map<string, Capability>();
  /** Range-capable media capabilities (`/m/<token>`; media-stream-route.ts). */
  private readonly media: MediaCapabilityTable;
  private readonly byGeneration = new Map<string, string>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private frameAncestors: readonly string[];
  private server: Server | null = null;
  private baseOrigin: string | null = null;
  private allowedHosts = new Set<string>();
  private closed = false;
  private loopbackHostname: string;
  private applicationOrigins: string[] = [];
  /** Set when no safe content origin exists for the configured application origins. */
  private unavailableReason: string | null = null;

  private constructor(private readonly options: ArtifactContentServerOptions) {
    this.maxEntries = Math.max(1, options.maxEntries ?? CONTENT_CAPABILITY_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
    this.media = new MediaCapabilityTable(
      () => this.now(),
      undefined,
      options.mediaRangeResponseMaxBytes,
    );
    this.frameAncestors = options.frameAncestors;
    this.loopbackHostname = (options.loopbackHostname ?? "localhost").toLowerCase();
  }

  static async start(
    options: ArtifactContentServerOptions,
  ): Promise<LoopbackArtifactContentServer> {
    // Validate configuration before binding anything.
    if (options.publicOrigin) parsePublicOrigin(options.publicOrigin);
    rebindFrameAncestors(buildInteractiveCsp([], []), options.frameAncestors);
    const instance = new LoopbackArtifactContentServer(options);
    await instance.listen();
    return instance;
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => {
      this.handle(request, response).catch(() => {
        if (!response.headersSent) this.error(response, 500, "Unavailable");
        else response.destroy();
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    // Upgrades (WebSocket) are never served.
    server.on("upgrade", (_request, socket) => socket.destroy());
    server.on("clientError", (_error, socket) => socket.destroy());
    const bindHost = this.options.bindHost ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, bindHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const port = (server.address() as AddressInfo).port;
    this.options.logger?.info?.("[artifact-content] listening", {
      port,
      hosted: Boolean(this.options.publicOrigin),
    });
    this.configureApplicationOrigins(this.options.applicationOrigins ?? []);
  }

  /**
   * Records the application's real page origins (known once the gateway has
   * bound) and re-derives the content origin so it never shares a site with
   * any of them. Loopback mode picks whichever loopback host name no
   * application origin uses; hosted mode validates the configured origin.
   * When no safe origin exists, live viewing is disabled with a reason.
   * Changing the content origin revokes every outstanding capability.
   */
  configureApplicationOrigins(origins: readonly string[]): {
    available: boolean;
    origin: string | null;
    reason?: string;
  } {
    this.applicationOrigins = normalizeApplicationOrigins(origins);
    const applicationHosts = this.applicationOrigins.map((origin) => new URL(origin).hostname);
    const previous = this.baseOrigin;
    this.unavailableReason = null;
    const port = this.port();
    if (this.options.publicOrigin) {
      const url = parsePublicOrigin(this.options.publicOrigin);
      const clash = applicationHosts.find((host) => hostsShareSite(host, url.hostname));
      if (clash !== undefined) {
        this.unavailableReason = `ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN (${url.host}) is the same site as the application (${clash}); live interactive viewing is disabled until the content origin is a different site`;
        this.baseOrigin = null;
        this.allowedHosts = new Set();
      } else {
        this.baseOrigin = url.origin;
        this.allowedHosts = new Set([url.host.toLowerCase()]);
      }
    } else if (port !== null) {
      const candidates = [
        this.loopbackHostname,
        ...LOOPBACK_HOST_NAMES.filter((name) => name !== this.loopbackHostname),
      ];
      const hostname = candidates.find(
        (candidate) => !applicationHosts.some((host) => hostsShareSite(host, candidate)),
      );
      if (!hostname) {
        this.unavailableReason =
          "The application is served on both loopback host names, so no separate loopback content origin exists; set ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN to a different site";
        this.baseOrigin = null;
        this.allowedHosts = new Set();
      } else {
        this.loopbackHostname = hostname;
        this.baseOrigin = `http://${hostname}:${port}`;
        this.allowedHosts = new Set([`${hostname}:${port}`.toLowerCase()]);
      }
    }
    if (previous !== this.baseOrigin) {
      // Outstanding URLs name the previous origin.
      this.capabilities.clear();
      this.byGeneration.clear();
      this.media.clear();
    }
    if (this.unavailableReason)
      this.options.logger?.warn?.("[artifact-content] live viewing disabled", {
        reason: "content-origin-shares-site",
      });
    return this.status();
  }

  /** Replaces the trusted viewer ancestors applied to every newly served document. */
  setFrameAncestors(frameAncestors: readonly string[]): void {
    rebindFrameAncestors(buildInteractiveCsp([], []), frameAncestors);
    this.frameAncestors = frameAncestors;
  }

  status(): { available: boolean; origin: string | null; reason?: string } {
    if (this.closed)
      return { available: false, origin: null, reason: "The artifact content server is closed" };
    if (this.unavailableReason)
      return { available: false, origin: null, reason: this.unavailableReason };
    return { available: this.baseOrigin !== null, origin: this.baseOrigin };
  }

  origin(): string | null {
    return this.closed || this.unavailableReason ? null : this.baseOrigin;
  }

  /** Bound local port (tests and hosted proxies). */
  port(): number | null {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  mint(input: {
    artifactId: string;
    revision: number;
    preparedSha256: string;
    contentSecurityPolicy: string;
    load: () => Promise<Uint8Array>;
    authorize?: () => Promise<boolean>;
    ttlMs?: number;
  }): { url: string; shellUrl: string; expiresAt: string; generation: string } {
    if (this.unavailableReason) throw new Error(this.unavailableReason);
    if (this.closed || !this.baseOrigin) throw new Error("Artifact content server is closed");
    if (!/^[0-9a-f]{64}$/.test(input.preparedSha256))
      throw new Error("Invalid prepared document hash");
    if (!Number.isInteger(input.revision) || input.revision < 1)
      throw new Error("Invalid revision");
    // Only policies this backend generated are served; ancestors come from
    // configuration plus the content origin itself (the browser viewer shell).
    const contentSecurityPolicy = rebindFrameAncestors(input.contentSecurityPolicy, [
      ...this.frameAncestors,
      this.baseOrigin,
    ]);
    const ttl = Math.min(
      CONTENT_CAPABILITY_MAX_TTL_MS,
      Math.max(1_000, input.ttlMs ?? CONTENT_CAPABILITY_DEFAULT_TTL_MS),
    );
    this.prune();
    const capability = token(32);
    const generation = token(18);
    const expiresAt = this.now() + ttl;
    this.capabilities.set(capability, {
      artifactId: input.artifactId,
      revision: input.revision,
      preparedSha256: input.preparedSha256,
      contentSecurityPolicy,
      shellFrameAncestors: normalizeFrameAncestors(this.frameAncestors),
      load: input.load,
      ...(input.authorize ? { authorize: input.authorize } : {}),
      expiresAt,
      generation,
    });
    this.byGeneration.set(generation, capability);
    return {
      url: `${this.baseOrigin}/a/${capability}`,
      shellUrl: `${this.baseOrigin}/s/${capability}`,
      expiresAt: new Date(expiresAt).toISOString(),
      generation,
    };
  }

  revoke(generation: string): void {
    const capability = this.byGeneration.get(generation);
    if (capability) this.capabilities.delete(capability);
    this.byGeneration.delete(generation);
  }

  revokeArtifact(artifactId: string): void {
    for (const [capability, entry] of Array.from(this.capabilities)) {
      if (entry.artifactId !== artifactId) continue;
      this.capabilities.delete(capability);
      this.byGeneration.delete(entry.generation);
    }
  }

  /** Number of live capabilities (bounded). */
  size(): number {
    return this.capabilities.size;
  }

  /**
   * Mints a media capability (`/m/<token>`) for one file resolved by an
   * authorized backend command. See media-stream-route.ts.
   */
  mintMedia(input: MintMediaInput): { url: string; expiresAt: string; generation: string } {
    if (this.unavailableReason) throw new Error(this.unavailableReason);
    if (this.closed || !this.baseOrigin) throw new Error("Artifact content server is closed");
    return this.media.mint(this.baseOrigin, input);
  }

  revokeMedia(generation: string): void {
    this.media.revoke(generation);
  }

  revokeMediaOwner(ownerKey: string): void {
    this.media.revokeOwner(ownerKey);
  }

  /** Whether a media capability is still live (expired ones are pruned). */
  mediaLive(generation: string): boolean {
    return this.media.isLive(generation);
  }

  /** Number of live media capabilities (bounded). */
  mediaSize(): number {
    return this.media.size();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.media.clear();
    this.capabilities.clear();
    this.byGeneration.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private prune(): void {
    const now = this.now();
    for (const [capability, entry] of Array.from(this.capabilities)) {
      if (entry.expiresAt <= now) {
        this.capabilities.delete(capability);
        this.byGeneration.delete(entry.generation);
      }
    }
    while (this.capabilities.size >= this.maxEntries) {
      const oldest = this.capabilities.keys().next().value as string | undefined;
      if (!oldest) break;
      const entry = this.capabilities.get(oldest);
      this.capabilities.delete(oldest);
      if (entry) this.byGeneration.delete(entry.generation);
    }
  }

  /** True only for an explicit `true` within the bound; errors and timeouts deny. */
  private async authorized(entry: Capability): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => entry.authorize!()),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), AUTHORIZE_TIMEOUT_MS);
        }),
      ]);
      return answer === true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private error(
    response: ServerResponse,
    status: number,
    message: string,
    extra: Record<string, string> = {},
  ): void {
    response.writeHead(status, { ...ERROR_HEADERS, ...extra });
    response.end(message);
  }

  /**
   * The live, unexpired, still-authorized entry for a capability, or null
   * after answering 404 (unknown, revoked, denied) or 410 (expired).
   */
  private async admit(capability: string, response: ServerResponse): Promise<Capability | null> {
    const entry = this.capabilities.get(capability);
    if (!entry) {
      this.error(response, 404, "Not found");
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.capabilities.delete(capability);
      this.byGeneration.delete(entry.generation);
      this.error(response, 410, "Expired");
      return null;
    }
    // Serve-time authorization: minting checked it once; every load checks again.
    if (entry.authorize && !(await this.authorized(entry))) {
      if (this.capabilities.get(capability) === entry) this.revoke(entry.generation);
      this.error(response, 404, "Not found");
      return null;
    }
    return entry;
  }

  /** The browser viewer shell for one capability (content-shell.ts); never the document bytes. */
  private async serveShell(
    request: IncomingMessage,
    response: ServerResponse,
    capability: string,
  ): Promise<void> {
    const entry = await this.admit(capability, response);
    if (!entry) return;
    // Revoked while authorizing, or the origin changed (which clears the table).
    if (!this.capabilities.has(capability) || !this.baseOrigin) {
      this.error(response, 404, "Not found");
      return;
    }
    const shell = artifactShellResponse({
      documentUrl: `${this.baseOrigin}/a/${capability}`,
      frameAncestors: entry.shellFrameAncestors,
      identity: {
        artifactId: entry.artifactId,
        revision: entry.revision,
        generation: entry.generation,
      },
    });
    const body = Buffer.from(shell.html, "utf8");
    response.writeHead(200, {
      ...BASE_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": shell.contentSecurityPolicy,
      "content-length": String(body.byteLength),
    });
    if (request.method === "HEAD") response.end();
    else response.end(body);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = String(request.headers.host ?? "").toLowerCase();
    if (!this.allowedHosts.has(host)) {
      // DNS-rebinding and host confusion: only our own host name is served.
      this.error(response, 421, "Misdirected request");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      this.error(response, 405, "Method not allowed", { allow: "GET, HEAD" });
      return;
    }
    const target = request.url ?? "";
    const mediaMatch = MEDIA_CAPABILITY_PATTERN.exec(target);
    if (mediaMatch) {
      await this.media.serve(
        request,
        response,
        mediaMatch[1]!,
        BASE_HEADERS,
        (status, message, extra) => this.error(response, status, message, extra),
      );
      return;
    }
    const shellMatch = SHELL_PATTERN.exec(target);
    if (shellMatch) {
      await this.serveShell(request, response, shellMatch[1]!);
      return;
    }
    const match = CAPABILITY_PATTERN.exec(target);
    if (!match) {
      this.error(response, 404, "Not found");
      return;
    }
    const capability = match[1]!;
    const entry = await this.admit(capability, response);
    if (!entry) return;
    let bytes: Uint8Array;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      bytes = await Promise.race([
        Promise.resolve().then(() => entry.load()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("load timeout")), LOAD_TIMEOUT_MS);
        }),
      ]);
    } catch {
      this.error(response, 503, "Unavailable");
      return;
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Revoked while loading, or the stored bytes no longer match the capability.
    if (!this.capabilities.has(capability)) {
      this.error(response, 404, "Not found");
      return;
    }
    if (
      bytes.byteLength > INTERACTIVE_HTML_POLICY.maxPreparedBytes ||
      sha256Hex(bytes) !== entry.preparedSha256
    ) {
      this.options.logger?.warn?.(
        "[artifact-content] prepared document integrity mismatch; capability revoked",
        {
          revision: entry.revision,
        },
      );
      this.revoke(entry.generation);
      this.error(response, 500, "Integrity check failed");
      return;
    }
    response.writeHead(200, {
      ...BASE_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": entry.contentSecurityPolicy,
      "content-length": String(bytes.byteLength),
    });
    if (request.method === "HEAD") response.end();
    else response.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
}
