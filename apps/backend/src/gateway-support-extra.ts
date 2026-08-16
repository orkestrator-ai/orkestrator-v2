import * as support from "./gateway-support-core.js";
import {
  API_PREFIX,
  AUTH_COOKIE,
  DYNAMIC_GZIP_LEVEL,
  GatewayTokenValidationError,
  InvalidRequestBodyError,
  MAX_JSON_BODY_BYTES,
  RequestBodyTooLargeError,
  SSE_COMPRESSION_CHUNK_BYTES,
  createBrotliDecompress,
  createGzip,
  createUnzip,
  getGatewayTokenValidationError,
  mkdir,
  normalizeGatewayToken,
  path,
  randomBytes,
  readFile,
  rename,
  rm,
  timingSafeEqual,
  writeFile,
  zlibConstants,
} from "./gateway-support-core.js";
type IncomingHttpHeaders = support.IncomingHttpHeaders;
type IncomingMessage = support.IncomingMessage;
type OutgoingHttpHeaders = support.OutgoingHttpHeaders;
type ServerResponse = support.ServerResponse;
type NetworkInterfaceInfo = support.NetworkInterfaceInfo;
type Transform = support.Transform;
type GatewayTokenSettings = support.GatewayTokenSettings;
type WebClientStatus = support.WebClientStatus;
type BackendInvoker = support.BackendInvoker;
type NetworkInterfaceMap = support.NetworkInterfaceMap;
type ListenerKind = support.ListenerKind;
type GatewayRouteKey = support.GatewayRouteKey;
type GatewayCompressionMode = support.GatewayCompressionMode;
type GatewayStartInfo = support.GatewayStartInfo;
type OrkestratorGatewayOptions = support.OrkestratorGatewayOptions;
type StaticCompressionEncoding = support.StaticCompressionEncoding;
type StaticContentEncoding = support.StaticContentEncoding;
type CompressionEncoding = support.CompressionEncoding;
type ContentEncoding = support.ContentEncoding;
type StaticCompressionOutcome = support.StaticCompressionOutcome;
type GatewayRouteMetrics = support.GatewayRouteMetrics;
type GatewayCommandMetrics = support.GatewayCommandMetrics;
type GatewayEventMetrics = support.GatewayEventMetrics;
type GatewayStreamMetrics = support.GatewayStreamMetrics;
type GatewayReplayMetrics = support.GatewayReplayMetrics;
type GatewayCompressionMetrics = support.GatewayCompressionMetrics;
type GatewayClientBootReport = support.GatewayClientBootReport;
type GatewayRouteSample = support.GatewayRouteSample;
type GatewayRequestMetrics = support.GatewayRequestMetrics;
type DynamicCompressionBufferBudgetSnapshot = support.DynamicCompressionBufferBudgetSnapshot;
type ResponseCompressionContext = support.ResponseCompressionContext;
type PreparedBody = support.PreparedBody;
type DynamicBodyCompressor = support.DynamicBodyCompressor;
type GatewayReconcileReason = support.GatewayReconcileReason;
export type GatewaySupportLayerTypes = [
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
  NetworkInterfaceInfo,
  Transform,
  GatewayTokenSettings,
  WebClientStatus,
  BackendInvoker,
  NetworkInterfaceMap,
  ListenerKind,
  GatewayRouteKey,
  GatewayCompressionMode,
  GatewayStartInfo,
  OrkestratorGatewayOptions,
  StaticCompressionEncoding,
  StaticContentEncoding,
  CompressionEncoding,
  ContentEncoding,
  StaticCompressionOutcome,
  GatewayRouteMetrics,
  GatewayCommandMetrics,
  GatewayEventMetrics,
  GatewayStreamMetrics,
  GatewayReplayMetrics,
  GatewayCompressionMetrics,
  GatewayClientBootReport,
  GatewayRouteSample,
  GatewayRequestMetrics,
  DynamicCompressionBufferBudgetSnapshot,
  ResponseCompressionContext,
  PreparedBody,
  DynamicBodyCompressor,
  GatewayReconcileReason
];
export function getCookie(headers: IncomingHttpHeaders, name: string): string | null {
  const cookieHeader = headers.cookie;
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = cookie.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

export function getBearerToken(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization;
  if (!authorization) return null;
  const [scheme, ...rest] = authorization.split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

export function tokenMatches(actual: string, candidate: string | null): boolean {
  if (!candidate) return false;
  const actualBytes = Buffer.from(actual);
  const candidateBytes = Buffer.from(candidate);
  return actualBytes.length === candidateBytes.length && timingSafeEqual(actualBytes, candidateBytes);
}

export function authFilePath(dataDir: string): string {
  return path.join(dataDir, "gateway-auth.json");
}

export async function loadOrCreateGatewayToken(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayTokenSettings & { authFile: string }> {
  const authFile = authFilePath(dataDir);
  const envToken = env.ORKESTRATOR_GATEWAY_TOKEN?.trim();
  if (envToken) {
    try {
      return {
        token: normalizeGatewayToken(envToken),
        authFile,
        editable: false,
        source: "environment",
      };
    } catch (error) {
      if (error instanceof GatewayTokenValidationError) {
        throw new Error(`Invalid ORKESTRATOR_GATEWAY_TOKEN: ${error.message}`);
      }
      throw error;
    }
  }

  const existing = await readFile(authFile, "utf8")
    .then((contents) => JSON.parse(contents) as { token?: unknown })
    .catch(() => null);
  if (typeof existing?.token === "string" && getGatewayTokenValidationError(existing.token) === null) {
    return { token: normalizeGatewayToken(existing.token), authFile, editable: true, source: "file" };
  }

  const token = randomBytes(32).toString("base64url");
  await persistGatewayToken(authFile, token);
  return { token, authFile, editable: true, source: "file" };
}

export async function persistGatewayToken(authFile: string, token: string): Promise<void> {
  await mkdir(path.dirname(authFile), { recursive: true });
  const temporaryFile = `${authFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify({ token }, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryFile, authFile);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => undefined);
  }
}

export async function readRequestBody(
  request: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<{ body: Buffer; bytes: number }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      tooLarge = true;
    } else {
      chunks.push(buffer);
    }
  }

  if (tooLarge) throw new RequestBodyTooLargeError("Request body is too large");
  return { body: Buffer.concat(chunks), bytes: total };
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<{ body: Record<string, unknown>; bytes: number }> {
  const { body, bytes } = await readRequestBody(request, maxBytes);
  if (body.length === 0) return { body: {}, bytes };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new InvalidRequestBodyError("Malformed JSON request body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidRequestBodyError("Expected JSON object body");
  }
  return { body: parsed as Record<string, unknown>, bytes };
}

export async function readLoginToken(request: IncomingMessage): Promise<string> {
  const contentType = request.headers["content-type"] ?? "";
  const { body } = await readRequestBody(request);

  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(body.toString("utf8")) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : "";
  }

  const params = new URLSearchParams(body.toString("utf8"));
  return params.get("token") ?? "";
}

export function loginPage(message = ""): string {
  const escapedMessage = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Orkestrator Gateway</title>
    <style>
      :root { color-scheme: dark light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #101214; color: #f4f4f5; }
      main { width: min(420px, calc(100vw - 32px)); }
      h1 { font-size: 20px; font-weight: 650; margin: 0 0 16px; }
      p { color: #a1a1aa; line-height: 1.5; margin: 0 0 20px; }
      label { display: block; font-size: 13px; color: #d4d4d8; margin-bottom: 8px; }
      input { box-sizing: border-box; width: 100%; height: 40px; border-radius: 6px; border: 1px solid #3f3f46; background: #18181b; color: #fafafa; padding: 0 12px; }
      button { height: 40px; margin-top: 12px; width: 100%; border: 0; border-radius: 6px; background: #fafafa; color: #18181b; font-weight: 650; cursor: pointer; }
      .error { color: #fca5a5; margin-bottom: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Orkestrator Gateway</h1>
      <p>Enter the gateway token from the host machine to continue.</p>
      ${escapedMessage ? `<p class="error">${escapedMessage}</p>` : ""}
      <form method="post" action="${API_PREFIX}/login">
        <label for="token">Gateway token</label>
        <input id="token" name="token" type="password" autocomplete="current-password" autofocus />
        <button type="submit">Connect</button>
      </form>
    </main>
  </body>
</html>`;
}

export function wantsHtml(request: IncomingMessage): boolean {
  return request.headers.accept?.includes("text/html") ?? false;
}

export function filterGatewayCookie(cookieHeader: string | string[] | undefined): string | undefined {
  const rawCookie = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (!rawCookie) return undefined;

  const cookies = rawCookie
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => {
      const name = cookie.split("=", 1)[0] ?? "";
      return name !== AUTH_COOKIE && name.length > 0;
    });

  return cookies.length > 0 ? cookies.join("; ") : undefined;
}

export function sanitizeTargetRequestHeaders(
  headers: IncomingHttpHeaders,
  target: URL,
  stripOrigin = false,
): IncomingHttpHeaders {
  const sanitized: IncomingHttpHeaders = {
    ...headers,
    host: target.host,
  };
  const forwardedCookie = filterGatewayCookie(headers.cookie);
  if (forwardedCookie) {
    sanitized.cookie = forwardedCookie;
  } else {
    delete sanitized.cookie;
  }
  delete sanitized.authorization;
  delete sanitized.connection;
  delete sanitized["proxy-authorization"];
  const openCodePasswordHeader = sanitized["x-orkestrator-opencode-token"];
  delete sanitized["x-orkestrator-opencode-token"];
  const openCodePassword = Array.isArray(openCodePasswordHeader)
    ? openCodePasswordHeader[0]
    : openCodePasswordHeader;
  if (openCodePassword) {
    // The public gateway consumes its own Bearer Authorization header. Carry
    // OpenCode's per-process credential in a dedicated header across that hop,
    // then translate it into the Basic scheme the upstream server supports.
    sanitized.authorization =
      `Basic ${Buffer.from(`opencode:${openCodePassword}`).toString("base64")}`;
  }
  if (stripOrigin) {
    // This endpoint is an authenticated server-side hop to a loopback API.
    // Forwarding the public browser origin would make the loopback service
    // mistake the gateway for an untrusted direct browser caller.
    delete sanitized.origin;
  }
  return sanitized;
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function proxyPath(proxyPrefix: string, targetPath: string): string {
  const normalizedTargetPath = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  return `${proxyPrefix}${normalizedTargetPath}`;
}

export function rewriteLocationHeader(location: string, target: URL, proxyPrefix?: string): string {
  if (!proxyPrefix) return location;

  try {
    const rewritten = new URL(location, target);
    if (rewritten.port === target.port && isLoopbackHostname(rewritten.hostname)) {
      return proxyPath(proxyPrefix, `${rewritten.pathname}${rewritten.search}${rewritten.hash}`);
    }
  } catch {
    return location;
  }

  return location;
}

export function rewriteCookiePath(proxyPrefix: string, targetPath: string | null): string {
  if (!targetPath || !targetPath.startsWith("/")) return `${proxyPrefix}/`;
  return proxyPath(proxyPrefix, targetPath);
}

export function rewriteSetCookieHeader(header: string, proxyPrefix?: string): string | null {
  if (!proxyPrefix) return header;

  const parts = header.split(";").map((part) => part.trim());
  const [nameValue = "", ...attributes] = parts;
  if (!nameValue) return null;
  const cookieName = nameValue.split("=", 1)[0] ?? "";
  if (cookieName === AUTH_COOKIE) return null;

  let path: string | null = null;
  const rewrittenAttributes: string[] = [];
  for (const attribute of attributes) {
    const [rawName, ...rawValue] = attribute.split("=");
    const name = (rawName ?? "").toLowerCase();
    if (name === "domain") continue;
    if (name === "path") {
      path = rawValue.join("=") || "/";
      continue;
    }
    rewrittenAttributes.push(attribute);
  }

  return [
    nameValue,
    `Path=${rewriteCookiePath(proxyPrefix, path)}`,
    ...rewrittenAttributes,
  ].join("; ");
}

export function rewriteSetCookieHeaders(headers: string | string[], proxyPrefix?: string): string | string[] | undefined {
  const values = Array.isArray(headers) ? headers : [headers];
  const rewritten = values
    .map((header) => rewriteSetCookieHeader(header, proxyPrefix))
    .filter((header): header is string => typeof header === "string" && header.length > 0);

  if (rewritten.length === 0) return undefined;
  return Array.isArray(headers) ? rewritten : rewritten[0];
}

export function sanitizeProxyResponseHeaders(headers: IncomingHttpHeaders, target: URL, proxyPrefix?: string): OutgoingHttpHeaders {
  const sanitized: OutgoingHttpHeaders = { ...headers };
  const rewrittenSetCookie = headers["set-cookie"]
    ? rewriteSetCookieHeaders(headers["set-cookie"], proxyPrefix)
    : undefined;
  if (rewrittenSetCookie) {
    sanitized["set-cookie"] = rewrittenSetCookie;
  } else {
    delete sanitized["set-cookie"];
  }
  if (headers.location) {
    sanitized.location = rewriteLocationHeader(headers.location, target, proxyPrefix);
  }
  delete sanitized.connection;
  delete sanitized["transfer-encoding"];
  // CORS is owned by the gateway. A proxied loopback service must not be able
  // to weaken or replace the origin policy selected for the public client.
  for (const header of Object.keys(sanitized)) {
    if (header.toLowerCase().startsWith("access-control-")) {
      delete sanitized[header];
    }
  }
  return sanitized;
}

export function responseStatusCanHaveBody(method: string | undefined, statusCode: number): boolean {
  return method !== "HEAD"
    && statusCode >= 200
    && statusCode !== 204
    && statusCode !== 205
    && statusCode !== 304;
}

export function canTransformProxyRepresentation(
  method: string | undefined,
  statusCode: number,
  contentRange: string | null,
): boolean {
  return responseStatusCanHaveBody(method, statusCode)
    && statusCode !== 206
    && contentRange === null;
}

export function parseStrictContentLengthHeader(value: string | null): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(value ?? "")) return null;
  const parsed = Number.parseInt(value!, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Removes only the fields defined over the *content-coded* bytes. `Content-MD5`
 * (RFC 2616) and `Content-Digest` (RFC 9530) both cover the body after any
 * content-coding is applied, so an upstream value computed on the identity
 * loopback hop cannot describe a coded representation. `Repr-Digest` and the
 * legacy `Digest` cover the representation before coding and stay valid.
 */
export function stripCodedContentHeaders(headers: OutgoingHttpHeaders): void {
  delete headers["content-md5"];
  delete headers["content-digest"];
}

/**
 * Removes every field calculated over bytes the gateway has replaced. Used only
 * where a body is actually rewritten or recompressed: `ETag` and the
 * representation digests no longer match, and the gateway cannot serve ranges
 * over bytes it produced on the fly.
 */
export function stripTransformedRepresentationHeaders(headers: OutgoingHttpHeaders): void {
  stripCodedContentHeaders(headers);
  delete headers.etag;
  delete headers["repr-digest"];
  delete headers.digest;
  delete headers["accept-ranges"];
}

export type BrowserPreviewContentKind = "html" | "css" | "js";

export function browserPreviewContentKind(contentType: string | string[] | undefined): BrowserPreviewContentKind | null {
  const value = Array.isArray(contentType) ? contentType.join(";") : contentType ?? "";
  // The rewriter decodes and re-encodes as UTF-8; pass other charsets through
  // untouched and let the Referer-based redirect recover their asset requests.
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(value)?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8" && charset !== "us-ascii") return null;
  if (/text\/html/i.test(value)) return "html";
  if (/text\/css/i.test(value)) return "css";
  if (/(?:text|application)\/(?:javascript|x-javascript)/i.test(value)) return "js";
  return null;
}

export function browserPreviewContentDecoder(contentEncoding: string | string[] | undefined): Transform | null | undefined {
  const rawValue = (Array.isArray(contentEncoding) ? contentEncoding.join(",") : contentEncoding)?.trim().toLowerCase();
  if (rawValue?.includes(",")) return undefined;
  const value = rawValue;
  if (!value || value === "identity") return null;
  if (value === "gzip" || value === "x-gzip" || value === "deflate") return createUnzip();
  if (value === "br") return createBrotliDecompress();
  return undefined;
}

/**
 * Keep root-relative development assets inside the browser-preview namespace.
 *
 * Rewriting is deliberately narrow: HTML URL attributes, CSS url()/@import
 * values, and JavaScript module specifiers. Generic string literals stay
 * untouched — values like `split("/")` or router paths are code, not URLs.
 * Requests those produce at runtime are recovered by the gateway's
 * Referer-based preview redirect instead.
 */
export function rewriteBrowserPreviewBody(
  body: string,
  proxyPrefix: string,
  target: URL,
  kind: BrowserPreviewContentKind,
): string {
  const escapedPrefix = proxyPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alreadyProxied = new RegExp(`^(?:${escapedPrefix}(?:/|$)|//)`);
  const rewritePath = (value: string) => alreadyProxied.test(value)
    ? value
    : `${proxyPrefix}${value.startsWith("/") ? value : `/${value}`}`;

  let rewritten = body;
  const rewriteQuotedAfter = (pattern: RegExp) => {
    rewritten = rewritten.replace(
      pattern,
      (_match, before: string, quote: string, value: string) => `${before}${quote}${rewritePath(value)}${quote}`,
    );
  };

  if (kind === "html") {
    rewriteQuotedAfter(/(\b(?:src|href|action|poster)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi);
    rewritten = rewritten.replace(
      /(\b(?:src|href|action|poster)\s*=\s*)(\/(?!\/)[^\s>"']+)/gi,
      (_match, prefix: string, value: string) => `${prefix}${rewritePath(value)}`,
    );
  }
  if (kind === "html" || kind === "css") {
    rewritten = rewritten.replace(
      /(url\(\s*)(["']?)(\/(?!\/)[^)"'\s]+)\2(\s*\))/gi,
      (_match, start: string, quote: string, value: string, end: string) =>
        `${start}${quote}${rewritePath(value)}${quote}${end}`,
    );
    rewriteQuotedAfter(/(@import\s+)(["'])(\/(?!\/)[^"']*)\2/gi);
  }
  if (kind === "html" || kind === "js") {
    rewriteQuotedAfter(/(\bfrom\s*)(["'])(\/(?!\/)[^"'\r\n]*)\2/g);
    rewriteQuotedAfter(/(\bimport\s*\(\s*)(["'])(\/(?!\/)[^"'\r\n]*)\2/g);
    rewriteQuotedAfter(/(\bimport\s+)(["'])(\/(?!\/)[^"'\r\n]*)\2/g);
    rewriteQuotedAfter(/(\bnew\s+URL\s*\(\s*)(["'])(\/(?!\/)[^"'\r\n]*)\2/g);
  }

  const loopbackOrigin = new RegExp(
    `(["'\u0060])http:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${target.port || "80"}(\\/[^"'\u0060\\r\\n]*)?\\1`,
    "g",
  );
  rewritten = rewritten.replace(
    loopbackOrigin,
    (_match, quote: string, pathname = "/") => `${quote}${rewritePath(pathname)}${quote}`,
  );

  return rewritten;
}

/**
 * Resolve the preview namespace a request originated from, based on its
 * Referer. Lets the gateway recover root-relative requests produced by
 * previewed application code that the body rewriter intentionally leaves
 * alone (runtime-built URLs, plain string literals).
 */
export function browserPreviewRefererPrefix(request: IncomingMessage): string | null {
  const referer = request.headers.referer;
  if (!referer) return null;
  try {
    const pathname = new URL(referer).pathname;
    const match = new RegExp(`^${API_PREFIX}/browser/loopback/(\\d{1,5})(?:/|$)`).exec(pathname);
    if (!match) return null;
    const port = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return `${API_PREFIX}/browser/loopback/${port}`;
  } catch {
    return null;
  }
}

export interface EventClientWriter {
  /** Uncompressed bytes accepted from the application but not yet discharged. */
  readonly writableLength: number;
  write(chunk: string): boolean;
  destroy(): void;
}

export type DrainAwareEventClientWriter = EventClientWriter & {
  onDrain(listener: () => void): void;
};

export class IdentityEventClientWriter implements DrainAwareEventClientWriter {
  constructor(readonly response: ServerResponse) {}

  get writableLength(): number {
    return this.response.writableLength;
  }

  write(chunk: string): boolean {
    return this.response.write(chunk);
  }

  destroy(): void {
    this.response.destroy();
  }

  onDrain(listener: () => void): void {
    this.response.on("drain", listener);
  }
}

export class GzipEventClientWriter implements DrainAwareEventClientWriter {
  private readonly compressor = createGzip({
    level: DYNAMIC_GZIP_LEVEL,
    flush: zlibConstants.Z_SYNC_FLUSH,
    finishFlush: zlibConstants.Z_SYNC_FLUSH,
    chunkSize: SSE_COMPRESSION_CHUNK_BYTES,
  });
  private readonly drainListeners = new Set<() => void>();
  private pendingBytes = 0;
  private closed = false;

  constructor(readonly response: ServerResponse) {
    this.compressor.pipe(response);
    this.compressor.once("error", (error) => {
      if (!this.closed) response.destroy(error);
      this.destroy();
    });
    this.compressor.on("drain", () => this.notifyDrain());
    response.on("drain", () => this.notifyDrain());
  }

  get writableLength(): number {
    return this.pendingBytes;
  }

  write(chunk: string): boolean {
    if (this.closed) return false;
    const bytes = Buffer.byteLength(chunk);
    this.pendingBytes += bytes;
    return this.compressor.write(chunk, (error) => {
      this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
      if (error) {
        if (!this.closed) this.response.destroy(error);
        this.destroy();
      }
    });
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingBytes = 0;
    this.compressor.unpipe(this.response);
    this.compressor.destroy();
    if (!this.response.destroyed) this.response.destroy();
    this.drainListeners.clear();
  }

  onDrain(listener: () => void): void {
    this.drainListeners.add(listener);
  }

  private notifyDrain(): void {
    for (const listener of this.drainListeners) listener();
  }
}

export type GatewayEventClient = {
  /**
   * Event-name prefixes this client asked for, or `null` for "everything".
   *
   * Filtering is opt-in so an older client that does not send the parameter
   * keeps its current firehose behavior. It exists because terminal output is
   * namespaced per session: without it, every byte a local terminal produces is
   * also serialized to a remote browser that is looking at another environment.
   */
  prefixes: string[] | null;
  /**
   * Extra prefixes allowed even when excluded. With no base `prefixes`, this
   * also becomes the stream's restrictive allow-list.
   */
  includedPrefixes: string[] | null;
  /** Prefixes omitted unless explicitly restored by `includedPrefixes`. */
  excludedPrefixes: string[] | null;
  /** Sessions whose frames were dropped for this client since its last notice. */
  desyncedSessions: Set<string>;
  /**
   * Non-null from subscription until replay and its concurrent arrivals drain.
   * `emit()` appends here instead of writing live, preventing a later event from
   * overtaking the retained gap.
   */
  handshake?: GatewayReplayHandshake | null;
  /**
   * Whether this stream participates in the authoritative cursor sequence.
   * Terminal-only streams carry their own snapshot protocol and must never see
   * a replay control frame.
   */
  tracksReplayCursor?: boolean;
  /** Highest authoritative revision whose `id` this client has been sent. */
  sentRevision?: number;
  /**
   * Newest revision this client's filter omitted since its last `id`. Flushed as
   * a `gateway.cursor` frame on the keepalive tick — without it a scoped stream's
   * cursor freezes under unrelated traffic and every reconnect reconciles.
   */
  omittedRevision?: number | null;
};

/**
 * Why a client must rehydrate from an authoritative snapshot instead of a gap.
 *
 * These are distinct on purpose: `cursor-expired` is a routine ring overrun,
 * while `cursor-ahead` and `invalid-cursor` mean the client sent something the
 * gateway never issued, and `replay-too-large` means the gap was retained but
 * could not be delivered without overrunning the client's buffer.
 */

export type BufferedGatewayEvent = {
  event: string;
  payload: unknown;
  message: string;
  messageBytes: number;
  droppable: boolean;
  revision: number | null;
};

export type GatewayReplayHandshake = {
  events: BufferedGatewayEvent[];
  bytes: number;
};

/** Parses the opt-in `?events=` subscription filter. Empty/absent means all. */
export function parseEventSubscriptionFilter(value: string | null): string[] | null {
  if (value === null) return null;
  const prefixes = value.split(",").map((prefix) => prefix.trim()).filter(Boolean);
  return prefixes.length > 0 ? prefixes : null;
}

export function eventMatchesSubscription(
  event: string,
  prefixes: string[] | null,
  includedPrefixes: string[] | null = null,
  excludedPrefixes: string[] | null = null,
): boolean {
  if (includedPrefixes?.some((prefix) => event.startsWith(prefix))) return true;
  if (excludedPrefixes?.some((prefix) => event.startsWith(prefix))) return false;
  // `includeEvents` makes an otherwise unscoped stream restrictive. This is
  // what lets one terminal connection opt one session back in after excluding
  // the terminal namespace without also receiving every authoritative event
  // already carried by the main stream.
  if (prefixes === null && includedPrefixes !== null) return false;
  if (prefixes === null) return true;
  return prefixes.some((prefix) => event.startsWith(prefix));
}


