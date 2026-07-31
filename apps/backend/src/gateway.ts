import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http, {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { Socket } from "node:net";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pipeline, type Readable, type Transform } from "node:stream";
import { promisify } from "node:util";
import {
  brotliCompress,
  constants as zlibConstants,
  createBrotliDecompress,
  createGzip,
  createUnzip,
  gzip,
} from "node:zlib";
import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";
import {
  GatewayTokenValidationError,
  gatewayTokenCookieHeader,
  getGatewayTokenValidationError,
  normalizeGatewayToken,
} from "@orkestrator/protocol/gateway-token";
import {
  GatewayEventReplay,
  formatGatewayCursor,
  parseGatewayCursor,
  type GatewayCursorParseResult,
  type GatewayReplayFrame,
} from "./gateway-event-replay.js";
import { TerminalWebSocketGateway } from "./terminal-websocket-server.js";

type BackendInvoker = {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown> | unknown;
  /**
   * Whether `command` is in the registry. Metric labels are gated on this so a
   * rejected, network-supplied name can never be retained — testing the error
   * message instead would leak any name rejected for some other reason first,
   * such as during shutdown.
   */
  hasCommand?(command: string): boolean;
};

type NetworkInterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;
type ListenerKind = "control" | "browser";
type GatewayRouteKey =
  | "login"
  | "logout"
  | "status"
  | "gateway-settings"
  | "web-client-access"
  | "invoke"
  | "events"
  | "metrics"
  | "client-metrics"
  | "proxy-loopback"
  | "browser-loopback"
  | "static";

export const GATEWAY_COMPRESSION_MODES = ["off", "body", "on"] as const;
export type GatewayCompressionMode = (typeof GATEWAY_COMPRESSION_MODES)[number];

export interface GatewayStartInfo {
  bindAddress: string;
  port: number;
  url: string;
  token: string;
  authFile: string;
  browserUrl?: string;
  browserError?: string;
}

export interface OrkestratorGatewayOptions {
  backend: BackendInvoker;
  dataDir: string;
  rendererRoot: string;
  rendererDevServerUrl?: string;
  bindAddress?: string;
  fallbackBindAddress?: string;
  port?: number;
  controlBindAddress?: string;
  controlPort?: number;
  env?: NodeJS.ProcessEnv;
  interfaces?: NetworkInterfaceMap;
  logger?: Pick<Console, "debug" | "error" | "info" | "warn">;
  allowNonTailscaleBind?: boolean;
  allowedOrigins?: string[];
  compression?: GatewayCompressionMode;
  keepaliveMs?: number;
  proxyBodyIdleTimeoutMs?: number;
  eventReplay?: {
    frameCapacity?: number;
    maxBytes?: number;
    idleRetentionMs?: number;
    handshakeFrameCapacity?: number;
    handshakeMaxBytes?: number;
  };
  webClientControl?: {
    getStatus(): WebClientStatus;
    setEnabled(enabled: boolean): Promise<WebClientStatus>;
    resetServe(): Promise<WebClientStatus>;
  };
}

const AUTH_COOKIE = "orkestrator_gateway_auth";
const API_PREFIX = "/__orkestrator";
const DEFAULT_GATEWAY_PORT = 34121;
const GATEWAY_PORT_FALLBACK_ATTEMPTS = 20;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_BROWSER_PREVIEW_BODY_BYTES = 8 * 1024 * 1024;
/**
 * Command bodies carry durable snapshots — prompt queues, build pipelines and
 * agent handoffs — whose storage limit is 32 MB each. Every renderer command
 * travels this route, in local desktop mode too, so a cap below the storage
 * limit would make those limits unreachable and turn a legitimately large save
 * into an opaque transport failure. `readRequestBody` discards bytes past the
 * cap rather than buffering them, so a larger ceiling costs nothing until a
 * request actually approaches it.
 */
const MAX_INVOKE_BODY_BYTES = 48 * 1024 * 1024;
const KEEPALIVE_MS = 25_000;
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATED_DOCUMENT_CACHE_CONTROL = "no-cache";
const STATIC_FALLBACK_BROTLI_QUALITY = 4;
const STATIC_FALLBACK_GZIP_LEVEL = 6;
const DYNAMIC_BROTLI_QUALITY = 4;
const DYNAMIC_GZIP_LEVEL = 6;
export const COMPRESSION_MIN_BYTES = 1024;
export const MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES = 48 * 1024 * 1024;
const MAX_DYNAMIC_COMPRESSION_OUTPUT_OVERHEAD_BYTES = 64 * 1024;
export const MAX_CONCURRENT_DYNAMIC_COMPRESSIONS = 8;
export const MAX_DYNAMIC_PROXY_BUFFERED_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_BUFFERED_BODY_CHUNKS = 8192;
/**
 * Aggregate ceiling for decoded browser-preview bodies held across all in-flight
 * preview requests. The per-request bound alone leaves concurrency unbounded, so
 * N simultaneous previews could retain N times the per-request limit.
 */
export const MAX_BROWSER_PREVIEW_DECODED_TOTAL_BYTES = 64 * 1024 * 1024;
/**
 * Idle ceiling for a proxied body that already holds a compression-buffer
 * reservation. Nothing else in the gateway times a proxy out, so an upstream
 * that sends headers and then stalls would hold one of the shared slots until
 * the downstream client gave up. The timer is reset by every chunk, so it only
 * fires on genuine silence.
 */
export const BUFFERED_PROXY_BODY_IDLE_TIMEOUT_MS = 30_000;
const SSE_COMPRESSION_CHUNK_BYTES = 64 * 1024;
export const MAX_STATIC_FALLBACK_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_STATIC_FALLBACK_OUTPUT_BYTES = MAX_STATIC_FALLBACK_SOURCE_BYTES + 64 * 1024;
export const MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS = 4;
/**
 * Events whose payload is a raw byte stream rather than authoritative state.
 *
 * These are the only frames the gateway is allowed to drop under backpressure:
 * a terminal is a view of a stream the backend also keeps in
 * `get_terminal_output_buffer`, so a client that misses frames can resynchronize
 * from that snapshot. Every other event carries state the renderer cannot
 * reconstruct from a buffer and must never be dropped silently.
 */
const DROPPABLE_EVENT_PREFIX = "terminal-output-";
/**
 * Above this many buffered bytes a client is too far behind to keep receiving
 * terminal output. Node buffers everything `write()` cannot flush, so without
 * this a laptop terminal flooding output would grow backend heap for as long as
 * a slow remote browser stayed connected.
 */
const SSE_CLIENT_SOFT_BUFFER_BYTES = 1024 * 1024;
/**
 * Above this a client is hopeless even for authoritative events. The connection
 * is destroyed rather than dropping them: on reconnect the renderer receives
 * `native-event-stream-connected` and refetches, which is correct, whereas a
 * silently skipped state event is not.
 */
const SSE_CLIENT_HARD_BUFFER_BYTES = 8 * 1024 * 1024;
/** Bounds events that arrive after subscription but before replay has drained. */
export const DEFAULT_GATEWAY_REPLAY_HANDSHAKE_FRAME_CAPACITY = 2_048;
export const DEFAULT_GATEWAY_REPLAY_HANDSHAKE_MAX_BYTES = 8 * 1024 * 1024;
const GATEWAY_CONNECTED_EVENT = "gateway.connected";
const GATEWAY_RECONCILE_REQUIRED_EVENT = "gateway.reconcile-required";
const GATEWAY_CURSOR_EVENT = "gateway.cursor";
const CORS_ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const CORS_ALLOWED_HEADERS =
  "Authorization, Content-Type, X-Orkestrator-Codex-Token, X-Orkestrator-Claude-Token, X-Orkestrator-OpenCode-Token";
const GATEWAY_METRIC_MAP_LIMIT = 128;
const GATEWAY_METRIC_LABEL_BYTES = 96;
const GATEWAY_METRIC_TOTAL_LABEL_BYTES = 8 * 1024;
/**
 * Command labels are an allowlist, not free text: anything the backend registry
 * rejects is recorded as `__unknown__`, so the only labels that can ever reach
 * this map are registered command names. The budget therefore has to clear the
 * whole registry — a limit below it silently folds legitimate commands into
 * `__overflow__` in invocation order, which makes the per-command byte and
 * timing breakdown both incomplete and different on every run.
 * `tests/unit/electron/gateway.test.ts` pins these against the real registry.
 */
export const GATEWAY_COMMAND_METRIC_MAP_LIMIT = 512;
export const GATEWAY_COMMAND_METRIC_TOTAL_LABEL_BYTES = 32 * 1024;
const GATEWAY_METRIC_SAMPLE_LIMIT = 32;
const MAX_CLIENT_METRICS_BODY_BYTES = 64 * 1024;
const METRIC_OVERFLOW_KEY = "__overflow__";
const METRIC_INVALID_KEY = "__invalid__";
const METRIC_UNKNOWN_COMMAND_KEY = "__unknown__";
/**
 * Keepalive writes are not an event, but a client dropped while flushing one
 * still needs attributing somewhere. A reserved label keeps that out of the
 * bucket for a real event that happens to be named `events`.
 */
const METRIC_KEEPALIVE_KEY = "__keepalive__";
const METRIC_RESERVED_KEYS: readonly string[] = [
  METRIC_OVERFLOW_KEY,
  METRIC_INVALID_KEY,
  METRIC_UNKNOWN_COMMAND_KEY,
  METRIC_KEEPALIVE_KEY,
];

class InvalidRequestBodyError extends Error {}
class RequestBodyTooLargeError extends Error {}

type StaticCompressionEncoding = "gzip" | "br";
type StaticContentEncoding = "identity" | StaticCompressionEncoding;
export type CompressionEncoding = StaticCompressionEncoding;
export type ContentEncoding = StaticContentEncoding;
/**
 * Why the on-the-fly fallback did or did not produce a coded representation.
 *
 * `not-beneficial` means identity genuinely is the best representation of this
 * asset for this client. `declined` means the server refused to spend the
 * CPU/memory — the source is over the cap, the compression pool is saturated,
 * or a codec failed. The distinction matters only when the client refused
 * identity: `not-beneficial` is a real 406, `declined` is a transient
 * server-side limit that must not be reported as one.
 */
type StaticCompressionOutcome =
  | { status: "compressed"; encoding: StaticCompressionEncoding; buffer: Buffer }
  | { status: "not-beneficial" }
  | { status: "declined" };

type GatewayRouteMetrics = {
  requests: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  statusCodes: Record<string, number>;
  encodings: Record<string, number>;
};

type GatewayCommandMetrics = {
  count: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  failures: number;
};

type GatewayEventMetrics = {
  frames: number;
  wireBytes: number;
  droppedFrames: number;
  droppedClients: number;
};

type GatewayStreamMetrics = {
  open: number;
  connecting: number;
  opened: number;
  closed: number;
  dropped: number;
  stalled: number;
  softDesyncs: number;
  keepalives: number;
};

/**
 * Handshake outcomes, so replay hit and reconciliation rates are observable.
 * Without these a ring that evicts every gap looks identical to one that never
 * has to, and the only symptom is clients quietly refetching everything.
 */
type GatewayReplayMetrics = {
  fresh: number;
  caughtUp: number;
  replayed: number;
  replayedFrames: number;
  reconciled: number;
  reasons: Record<GatewayReconcileReason, number>;
};

type GatewayCompressionMetrics = {
  configuredMode: GatewayCompressionMode;
};

type GatewayClientBootReport = {
  recordedAt: string;
  platform: "desktop-browser" | "ios-wkwebview" | "ipad-wkwebview" | "iphone-wkwebview" | "unknown";
  navigationType: "navigate" | "reload" | "back_forward" | "prerender" | "unknown";
  httpVersion: string | null;
  nextHopProtocol: string | null;
  transferSize: number | null;
  encodedBodySize: number | null;
  decodedBodySize: number | null;
  resourceCount: number | null;
  resourceTransferSize: number | null;
  resourceEncodedBodySize: number | null;
  resourceDecodedBodySize: number | null;
  jsTransferSize: number | null;
  jsDecodedBodySize: number | null;
  cssTransferSize: number | null;
  cssDecodedBodySize: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  firstPaintMs: number | null;
  firstContentfulPaintMs: number | null;
  eventStreamConnectedMs: number | null;
};

type GatewayRouteSample = {
  recordedAt: string;
  route: GatewayRouteKey;
  listenerKind: ListenerKind;
  method: string;
  httpVersion: string;
  acceptEncoding: string | null;
  effectiveCompressionMode: GatewayCompressionMode;
  statusCode: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  contentEncoding: string | null;
  cacheControl: string | null;
  contentType: string | null;
};

function isGatewayCompressionMode(value: string): value is GatewayCompressionMode {
  return GATEWAY_COMPRESSION_MODES.includes(value as GatewayCompressionMode);
}

export function parseGatewayCompressionMode(
  value: string | undefined,
  source = "gateway compression mode",
): GatewayCompressionMode | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (isGatewayCompressionMode(trimmed)) return trimmed;
  throw new Error(`Invalid ${source}: ${value}. Expected one of off, body, on.`);
}

export function resolveGatewayCompressionMode(
  explicit: GatewayCompressionMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
): GatewayCompressionMode {
  return explicit
    ?? parseGatewayCompressionMode(
      env.ORKESTRATOR_GATEWAY_COMPRESSION,
      "ORKESTRATOR_GATEWAY_COMPRESSION",
    )
    ?? "body";
}

export function compressionModeForListener(
  compression: GatewayCompressionMode,
  listenerKind: ListenerKind,
): GatewayCompressionMode {
  return listenerKind === "control" ? "off" : compression;
}

function appendBoundedSample<T>(target: T[], sample: T, limit = GATEWAY_METRIC_SAMPLE_LIMIT): void {
  target.push(sample);
  if (target.length > limit) target.splice(0, target.length - limit);
}

/**
 * A `Map` whose key set is bounded by both entry count and total label bytes.
 *
 * The running byte total matters: recomputing it per miss made every emit for
 * an unseen label walk the whole key set, and `recordEvent` runs once per
 * connected client per frame.
 */
export class BoundedMetricMap<T> {
  private readonly map = new Map<string, T>();
  private labelBytes = 0;

  constructor(
    private readonly limit = GATEWAY_METRIC_MAP_LIMIT,
    private readonly totalLabelBytes = GATEWAY_METRIC_TOTAL_LABEL_BYTES,
  ) {}

  /**
   * Resolves the label this key will actually be recorded under.
   *
   * One slot and its bytes are reserved for overflow from the outset, so both
   * limits stay true after the first overflowing label instead of letting the
   * overflow bucket become an unaccounted (limit + 1)th entry.
   */
  resolveKey(key: string): string {
    if (this.map.has(key)) return key;
    const keyBytes = Buffer.byteLength(key);
    const overflowBytes = Buffer.byteLength(METRIC_OVERFLOW_KEY);
    if (
      this.map.size < this.limit - 1
      && keyBytes <= GATEWAY_METRIC_LABEL_BYTES
      && this.labelBytes + keyBytes <= this.totalLabelBytes - overflowBytes
    ) {
      return key;
    }
    return METRIC_OVERFLOW_KEY;
  }

  get(key: string): T | undefined {
    return this.map.get(key);
  }

  set(key: string, value: T): void {
    if (!this.map.has(key)) this.labelBytes += Buffer.byteLength(key);
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  get usedLabelBytes(): number {
    return this.labelBytes;
  }

  entries(): IterableIterator<[string, T]> {
    return this.map.entries();
  }
}

export function normalizeMetricLabel(value: string): string {
  if (METRIC_RESERVED_KEYS.includes(value)) return value;
  const trimmed = value.trim();
  return (
    Buffer.byteLength(trimmed) <= GATEWAY_METRIC_LABEL_BYTES
    && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(trimmed)
  )
    ? trimmed
    : METRIC_INVALID_KEY;
}

/**
 * Truncates to a byte budget without emitting a replacement character.
 *
 * The cut is walked back to the start of the partial sequence rather than
 * decoding and stripping a trailing U+FFFD, because that cannot tell a decode
 * artifact from a U+FFFD the caller actually sent.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  // If the first dropped byte is a continuation byte (0b10xxxxxx) the cut fell
  // inside a sequence, so walk back to that sequence's lead byte and drop it
  // whole. A sequence split this way can never fit, so no refit check is
  // needed. At most 3 continuation bytes can precede a lead byte.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

export function normalizeContentEncoding(value: string | null): "identity" | "gzip" | "br" | "deflate" | "other" {
  const encoding = value?.trim().toLowerCase() || "identity";
  if (encoding === "identity" || encoding === "gzip" || encoding === "br" || encoding === "deflate") {
    return encoding;
  }
  return "other";
}

export function normalizeHttpMethod(value: string): string {
  const method = value.trim().toUpperCase();
  return (
    method === "DELETE"
    || method === "GET"
    || method === "HEAD"
    || method === "OPTIONS"
    || method === "PATCH"
    || method === "POST"
    || method === "PUT"
  )
    ? method
    : "OTHER";
}

export function normalizeHttpVersion(value: string): string {
  const version = value.trim();
  return version === "1.0" || version === "1.1" || version === "2.0" || version === "3.0"
    ? version
    : "other";
}

/**
 * `q=0` means "not acceptable" (RFC 9110 §12.5.3), so a token weighted that way
 * is a refusal and must not be recorded as support. This label exists to decide
 * whether compression can be turned on for a client, and counting a refusal as
 * support would err in exactly the direction that breaks one.
 */
export function normalizeAcceptEncoding(value: string | null): string | null {
  if (value === null) return null;
  const encodings = new Set<string>();
  for (const entry of value.toLowerCase().split(",")) {
    const [token, ...parameters] = entry.split(";");
    const encoding = token?.trim();
    if (!encoding) continue;
    const refused = parameters.some((parameter) => {
      const [name, weight] = parameter.split("=", 2);
      return name?.trim() === "q" && Number.parseFloat(weight ?? "") === 0;
    });
    if (refused) continue;
    if (encoding === "br" || encoding === "gzip" || encoding === "deflate" || encoding === "identity") {
      encodings.add(encoding);
    } else {
      encodings.add("other");
    }
  }
  return encodings.size > 0 ? [...encodings].sort().join(",") : null;
}

export function normalizeCacheControl(value: string | null): string | null {
  if (value === null) return null;
  const allowed = new Set([
    "immutable",
    "max-age",
    "must-revalidate",
    "no-cache",
    "no-store",
    "no-transform",
    "private",
    "proxy-revalidate",
    "public",
    "s-maxage",
    "stale-if-error",
    "stale-while-revalidate",
  ]);
  const directives = new Set<string>();
  for (const entry of value.toLowerCase().split(",")) {
    const directive = entry.split("=", 1)[0]?.trim();
    if (directive && allowed.has(directive)) directives.add(directive);
    else if (directive) directives.add("other");
  }
  return directives.size > 0 ? [...directives].sort().join(",") : null;
}

export function normalizeContentType(value: string | null): string | null {
  if (value === null) return null;
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("font/")) return "font";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (
    mimeType === "application/javascript"
    || mimeType === "application/json"
    || mimeType === "application/octet-stream"
    || mimeType === "text/css"
    || mimeType === "text/event-stream"
    || mimeType === "text/html"
    || mimeType === "text/javascript"
    || mimeType === "text/plain"
  ) {
    return mimeType;
  }
  return "other";
}

export function normalizeNextHopProtocol(value: unknown): string | null {
  // `stringOrNull` yields null and the optional call then yields undefined, so
  // this must test falsiness rather than `=== null`: reporting an unavailable
  // protocol as "other" would make it indistinguishable from one we simply do
  // not recognise, which is the HTTP/2-vs-1.1 signal being measured. A
  // `WKWebView` with no navigation entry, and any cross-origin navigation
  // without `Timing-Allow-Origin`, both take this path.
  const protocol = stringOrNull(value, 24)?.toLowerCase();
  if (!protocol) return null;
  if (
    protocol === "h2"
    || protocol === "h3"
    || protocol === "http/1.0"
    || protocol === "http/1.1"
    || protocol === "http/2"
    || protocol === "http/3"
    || protocol === "quic"
  ) {
    return protocol;
  }
  return "other";
}

function normalizeStatusMetricKey(statusCode: number): string {
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? String(statusCode)
    : "other";
}

function numberOrNull(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : null;
}

function stringOrNull(value: unknown, maxBytes = 64): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? truncateUtf8(trimmed, maxBytes) : null;
}

function headerValueToString(value: number | string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return String(value);
  return null;
}

function parseContentLengthHeader(value: string | string[] | undefined): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(candidate ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function measureChunkBytes(
  chunk: string | Uint8Array | Buffer | undefined,
  encoding?: BufferEncoding | ((error?: Error | null) => void),
): number {
  if (chunk === undefined) return 0;
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined);
  }
  return chunk.byteLength;
}

function classifyGatewayRoute(pathname: string): GatewayRouteKey {
  if (pathname === `${API_PREFIX}/login`) return "login";
  if (pathname === `${API_PREFIX}/logout`) return "logout";
  if (pathname === `${API_PREFIX}/status`) return "status";
  if (pathname === `${API_PREFIX}/gateway-settings`) return "gateway-settings";
  if (pathname === `${API_PREFIX}/web-client-access`) return "web-client-access";
  if (pathname === `${API_PREFIX}/invoke`) return "invoke";
  if (pathname === `${API_PREFIX}/events`) return "events";
  if (pathname === `${API_PREFIX}/metrics`) return "metrics";
  if (pathname === `${API_PREFIX}/client-metrics`) return "client-metrics";
  if (pathname.startsWith(`${API_PREFIX}/proxy/loopback/`)) return "proxy-loopback";
  if (pathname.startsWith(`${API_PREFIX}/browser/loopback/`)) return "browser-loopback";
  return "static";
}

/**
 * Event names that embed an identifier have unbounded cardinality, so each one
 * would otherwise consume a label slot per terminal, container or environment
 * and push genuinely distinct event names into `__overflow__`. Collapse them to
 * a fixed category the way the terminal families already are.
 */
const PER_ENTITY_EVENT_PREFIXES: readonly [prefix: string, label: string][] = [
  [`${DROPPABLE_EVENT_PREFIX}tmux:`, "terminal-output-tmux"],
  [DROPPABLE_EVENT_PREFIX, "terminal-output"],
  ["claude-state-", "claude-state"],
];

export function normalizeGatewayEventMetricKey(event: string): string {
  for (const [prefix, label] of PER_ENTITY_EVENT_PREFIXES) {
    if (event.startsWith(prefix)) return label;
  }
  return normalizeMetricLabel(event);
}

function sanitizeClientBootReport(
  input: Record<string, unknown>,
  httpVersion: string,
): GatewayClientBootReport {
  const platformValue = stringOrNull(input.platform, 32);
  const platform = (
    platformValue === "desktop-browser"
    || platformValue === "ios-wkwebview"
    || platformValue === "ipad-wkwebview"
    || platformValue === "iphone-wkwebview"
  )
    ? platformValue
    : "unknown";
  const navigationTypeValue = stringOrNull(input.navigationType, 16);
  const navigationType = (
    navigationTypeValue === "navigate"
    || navigationTypeValue === "reload"
    || navigationTypeValue === "back_forward"
    || navigationTypeValue === "prerender"
  )
    ? navigationTypeValue
    : "unknown";
  return {
    recordedAt: new Date().toISOString(),
    platform,
    navigationType,
    httpVersion: normalizeHttpVersion(httpVersion),
    nextHopProtocol: normalizeNextHopProtocol(input.nextHopProtocol),
    transferSize: numberOrNull(input.transferSize),
    encodedBodySize: numberOrNull(input.encodedBodySize),
    decodedBodySize: numberOrNull(input.decodedBodySize),
    resourceCount: numberOrNull(input.resourceCount, 100_000),
    resourceTransferSize: numberOrNull(input.resourceTransferSize),
    resourceEncodedBodySize: numberOrNull(input.resourceEncodedBodySize),
    resourceDecodedBodySize: numberOrNull(input.resourceDecodedBodySize),
    jsTransferSize: numberOrNull(input.jsTransferSize),
    jsDecodedBodySize: numberOrNull(input.jsDecodedBodySize),
    cssTransferSize: numberOrNull(input.cssTransferSize),
    cssDecodedBodySize: numberOrNull(input.cssDecodedBodySize),
    domContentLoadedMs: numberOrNull(input.domContentLoadedMs, 600_000),
    loadEventMs: numberOrNull(input.loadEventMs, 600_000),
    firstPaintMs: numberOrNull(input.firstPaintMs, 600_000),
    firstContentfulPaintMs: numberOrNull(input.firstContentfulPaintMs, 600_000),
    eventStreamConnectedMs: numberOrNull(input.eventStreamConnectedMs, 600_000),
  };
}

export class GatewayMetricsStore {
  private readonly routes = new Map<GatewayRouteKey, GatewayRouteMetrics>();
  private readonly commands = new BoundedMetricMap<GatewayCommandMetrics>(
    GATEWAY_COMMAND_METRIC_MAP_LIMIT,
    GATEWAY_COMMAND_METRIC_TOTAL_LABEL_BYTES,
  );
  private readonly events = new BoundedMetricMap<GatewayEventMetrics>();
  private readonly recentRouteSamples: GatewayRouteSample[] = [];
  private readonly recentClientBootReports: GatewayClientBootReport[] = [];
  private readonly stream: GatewayStreamMetrics = {
    open: 0,
    connecting: 0,
    opened: 0,
    closed: 0,
    dropped: 0,
    stalled: 0,
    softDesyncs: 0,
    keepalives: 0,
  };
  private readonly replay: GatewayReplayMetrics = {
    fresh: 0,
    caughtUp: 0,
    replayed: 0,
    replayedFrames: 0,
    reconciled: 0,
    reasons: {
      "invalid-cursor": 0,
      "prior-generation": 0,
      "cursor-expired": 0,
      "cursor-ahead": 0,
      "replay-too-large": 0,
    },
  };
  private readonly compression: GatewayCompressionMetrics;

  constructor(configuredMode: GatewayCompressionMode) {
    this.compression = { configuredMode };
  }

  setConfiguredCompressionMode(mode: GatewayCompressionMode): void {
    this.compression.configuredMode = mode;
  }

  beginRequest(meta: Omit<GatewayRouteSample, "recordedAt" | "statusCode" | "responseBytes" | "durationMs" | "contentEncoding" | "cacheControl" | "contentType">) {
    const startedAt = Date.now();
    let requestBytes = meta.requestBytes;
    return {
      setRequestBytes(bytes: number) {
        requestBytes = bytes;
      },
      finish: (response: ServerResponse, responseBytes: number) => {
        const durationMs = Math.max(0, Date.now() - startedAt);
        const sample: GatewayRouteSample = {
          recordedAt: new Date().toISOString(),
          ...meta,
          method: normalizeHttpMethod(meta.method),
          httpVersion: normalizeHttpVersion(meta.httpVersion),
          acceptEncoding: normalizeAcceptEncoding(meta.acceptEncoding),
          requestBytes,
          statusCode: response.statusCode,
          responseBytes,
          durationMs,
          contentEncoding: normalizeContentEncoding(
            headerValueToString(response.getHeader("content-encoding")),
          ),
          cacheControl: normalizeCacheControl(headerValueToString(response.getHeader("cache-control"))),
          contentType: normalizeContentType(headerValueToString(response.getHeader("content-type"))),
        };
        this.recordRoute(sample);
      },
    };
  }

  private routeBucket(route: GatewayRouteKey): GatewayRouteMetrics {
    let bucket = this.routes.get(route);
    if (!bucket) {
      bucket = {
        requests: 0,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: 0,
        statusCodes: {},
        encodings: {},
      };
      this.routes.set(route, bucket);
    }
    return bucket;
  }

  private recordRoute(sample: GatewayRouteSample): void {
    const bucket = this.routeBucket(sample.route);
    bucket.requests += 1;
    bucket.requestBytes += sample.requestBytes;
    bucket.responseBytes += sample.responseBytes;
    bucket.durationMs += sample.durationMs;
    const statusCode = normalizeStatusMetricKey(sample.statusCode);
    bucket.statusCodes[statusCode] = (bucket.statusCodes[statusCode] ?? 0) + 1;
    const encoding = normalizeContentEncoding(sample.contentEncoding);
    bucket.encodings[encoding] = (bucket.encodings[encoding] ?? 0) + 1;
    appendBoundedSample(this.recentRouteSamples, sample);
  }

  recordInvoke(
    command: string,
    requestBytes: number,
    responseBytes: number,
    durationMs: number,
    success: boolean,
  ): void {
    const key = this.commands.resolveKey(normalizeMetricLabel(command));
    const bucket = this.commands.get(key) ?? {
      count: 0,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 0,
      failures: 0,
    };
    bucket.count += 1;
    bucket.requestBytes += requestBytes;
    bucket.responseBytes += responseBytes;
    bucket.durationMs += durationMs;
    if (!success) bucket.failures += 1;
    this.commands.set(key, bucket);
  }

  recordEvent(event: string, wireBytes: number): void {
    const key = this.events.resolveKey(normalizeGatewayEventMetricKey(event));
    const bucket = this.events.get(key) ?? {
      frames: 0,
      wireBytes: 0,
      droppedFrames: 0,
      droppedClients: 0,
    };
    bucket.frames += 1;
    bucket.wireBytes += wireBytes;
    this.events.set(key, bucket);
  }

  recordDroppedEventFrame(event: string): void {
    const key = this.events.resolveKey(normalizeGatewayEventMetricKey(event));
    const bucket = this.events.get(key) ?? {
      frames: 0,
      wireBytes: 0,
      droppedFrames: 0,
      droppedClients: 0,
    };
    bucket.droppedFrames += 1;
    this.events.set(key, bucket);
  }

  recordDroppedEventClient(event: string): void {
    const key = this.events.resolveKey(normalizeGatewayEventMetricKey(event));
    const bucket = this.events.get(key) ?? {
      frames: 0,
      wireBytes: 0,
      droppedFrames: 0,
      droppedClients: 0,
    };
    bucket.droppedClients += 1;
    this.events.set(key, bucket);
  }

  recordStreamConnecting(): void {
    this.stream.connecting += 1;
  }

  recordStreamOpened(): void {
    this.stream.connecting = Math.max(0, this.stream.connecting - 1);
    this.stream.open += 1;
    this.stream.opened += 1;
  }

  /**
   * A stream that reached `open` already left `connecting` in
   * `recordStreamOpened`, so this must not decrement it again — that double
   * count would silently undercount concurrent handshakes.
   */
  recordStreamClosed(): void {
    this.stream.open = Math.max(0, this.stream.open - 1);
    this.stream.closed += 1;
  }

  /** Releases the gauge for a handshake that never reached `open`. */
  recordStreamConnectFailed(): void {
    this.stream.connecting = Math.max(0, this.stream.connecting - 1);
  }

  recordStreamDropped(): void {
    this.stream.dropped += 1;
  }

  recordStreamStalled(): void {
    this.stream.stalled += 1;
  }

  recordSoftDesync(): void {
    this.stream.softDesyncs += 1;
  }

  recordKeepalive(): void {
    this.stream.keepalives += 1;
  }

  recordReplayHandshake(
    status: "fresh" | "caught-up" | "replayed" | "reconcile",
    reason: GatewayReconcileReason | null,
    replayedFrames: number,
  ): void {
    if (status === "fresh") this.replay.fresh += 1;
    else if (status === "caught-up") this.replay.caughtUp += 1;
    else if (status === "replayed") {
      this.replay.replayed += 1;
      this.replay.replayedFrames += replayedFrames;
    } else {
      this.replay.reconciled += 1;
      if (reason) this.replay.reasons[reason] += 1;
    }
  }

  recordClientBootReport(report: GatewayClientBootReport): void {
    appendBoundedSample(this.recentClientBootReports, report);
  }

  snapshot() {
    return {
      routes: Object.fromEntries([...this.routes.entries()].sort(([left], [right]) => left.localeCompare(right))),
      commands: Object.fromEntries([...this.commands.entries()].sort(([left], [right]) => left.localeCompare(right))),
      events: Object.fromEntries([...this.events.entries()].sort(([left], [right]) => left.localeCompare(right))),
      stream: { ...this.stream },
      replay: { ...this.replay, reasons: { ...this.replay.reasons } },
      compression: { configuredMode: this.compression.configuredMode },
      recentRouteSamples: [...this.recentRouteSamples],
      recentClientBootReports: [...this.recentClientBootReports],
    };
  }
}

type GatewayRequestMetrics = ReturnType<GatewayMetricsStore["beginRequest"]>;

function instrumentGatewayResponse(
  response: ServerResponse,
  finish: (responseBytes: number) => void,
): void {
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  let responseBytes = 0;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    finish(responseBytes);
  };

  response.write = ((chunk, encoding, callback) => {
    responseBytes += measureChunkBytes(chunk, encoding);
    return (originalWrite as (...args: unknown[]) => boolean)(
      chunk,
      encoding as unknown,
      callback as unknown,
    );
  }) as typeof response.write;

  response.end = ((chunk, encoding, callback) => {
    responseBytes += measureChunkBytes(chunk, encoding);
    return (originalEnd as (...args: unknown[]) => ServerResponse<IncomingMessage>)(
      chunk,
      encoding as unknown,
      callback as unknown,
    );
  }) as typeof response.end;

  response.once("finish", settle);
  response.once("close", settle);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid gateway port: ${value}`);
  }
  return port;
}

function isAddressInUseError(error: unknown): boolean {
  return error instanceof Error
    && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

export function isTailscaleAddress(address: string): boolean {
  const ipv4 = parseIPv4(address);
  if (ipv4) {
    // Tailscale assigns IPv4 addresses from 100.64.0.0/10.
    return ipv4[0] === 100 && ipv4[1] !== undefined && ipv4[1] >= 64 && ipv4[1] <= 127;
  }

  // Tailscale IPv6 addresses use this ULA prefix.
  return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

export function selectTailscaleBindAddress(interfaces: NetworkInterfaceMap = networkInterfaces()): string | null {
  const candidates: NetworkInterfaceInfo[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal && isTailscaleAddress(entry.address)) {
        candidates.push(entry);
      }
    }
  }

  return (
    candidates.find((entry) => entry.family === "IPv4")?.address ??
    candidates[0]?.address ??
    null
  );
}

function formatHostForUrl(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function originMatchesRule(origin: URL, rule: string): boolean {
  if (rule === "*") return true;
  if (origin.origin === rule) return true;

  const wildcard = /^(https?):\/\/\*\.([^/:]+)(?::(\d+))?$/.exec(rule);
  if (!wildcard) return false;
  const [, protocol, hostname, port] = wildcard;
  return origin.protocol === `${protocol}:`
    && origin.hostname.endsWith(`.${hostname}`)
    && origin.hostname !== hostname
    && (port === undefined || origin.port === port);
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    default:
      return "application/octet-stream";
  }
}

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export function appendVary(existing: string | null, value: string): string {
  const values = [
    ...String(existing ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    ...value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  ];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const normalized = entry.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(entry);
  }
  return deduped.join(", ");
}

/**
 * Selects the best representation the client permits.
 *
 * Quality values win first. Brotli wins a quality tie for bounded bodies,
 * followed by gzip and identity. Callers that cannot provide one of the coded
 * forms (SSE, for example, only supports gzip) restrict `available`.
 */
export function negotiateEncoding(
  acceptEncoding: string | null,
  available: readonly ContentEncoding[] = ["br", "gzip", "identity"],
): ContentEncoding {
  const encoded = preferredStaticCompressionEncodings(acceptEncoding)
    .find((encoding) => available.includes(encoding));
  if (encoded) return encoded;
  // RFC 9110 allows a server to use identity even when every advertised
  // representation was refused. Compression is an optimization here, and
  // preserving the rollback path is safer than converting ordinary responses
  // into load-dependent 406s.
  return "identity";
}

function appendResponseVary(response: ServerResponse, value: string): void {
  response.setHeader("vary", appendVary(headerValueToString(response.getHeader("vary")), value));
}

function appendHeadersVary(headers: OutgoingHttpHeaders, value: string): void {
  headers.vary = appendVary(headerValueToString(headers.vary), value);
}

export function isCompressibleContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("text/")
    || normalized === "application/javascript"
    || normalized === "application/json"
    || normalized === "application/manifest+json"
    || normalized === "application/wasm"
    || normalized === "application/xml"
    || normalized === "image/svg+xml"
    || normalized.endsWith("+json")
    || normalized.endsWith("+xml")
  );
}

function isCompressibleStaticContentType(contentType: string): boolean {
  return isCompressibleContentType(contentType);
}

function isImmutableHashedAsset(pathname: string, filePath: string): boolean {
  return pathname.startsWith("/assets/")
    && /-[A-Za-z0-9_-]{8,}\./.test(path.basename(filePath));
}

function httpDateFromMtimeMs(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs / 1000) * 1000).toUTCString();
}

function etagForStaticVariant(
  sourceMtimeMs: number,
  sourceSize: number,
  encoding: StaticContentEncoding,
  variantMtimeMs = sourceMtimeMs,
  variantSize = sourceSize,
): string {
  return `W/"${Math.floor(sourceMtimeMs).toString(16)}-${sourceSize.toString(16)}-${encoding}-${Math.floor(variantMtimeMs).toString(16)}-${variantSize.toString(16)}"`;
}

function staticEncodingQuality(
  acceptEncoding: string | null,
  encoding: StaticContentEncoding,
): number {
  if (!acceptEncoding) return encoding === "identity" ? 1 : 0;
  let specific: number | null = null;
  let wildcard: number | null = null;
  let identity: number | null = null;
  for (const entry of acceptEncoding.split(",")) {
    const [token, ...parameterEntries] = entry.trim().toLowerCase().split(";");
    if (!token) continue;
    let weight = 1;
    for (const parameter of parameterEntries) {
      const [name, rawValue] = parameter.split("=", 2);
      if (name?.trim() !== "q") continue;
      const normalizedValue = rawValue?.trim() ?? "";
      weight = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(normalizedValue)
        ? Number.parseFloat(normalizedValue)
        : 0;
    }
    if (token === encoding) {
      specific = specific === null ? weight : Math.max(specific, weight);
    } else if (token === "*") {
      wildcard = wildcard === null ? weight : Math.max(wildcard, weight);
    } else if (token === "identity") {
      identity = identity === null ? weight : Math.max(identity, weight);
    }
  }
  if (specific !== null) return specific;
  if (encoding === "identity") return identity ?? wildcard ?? 1;
  return wildcard ?? 0;
}

function preferredStaticCompressionEncodings(
  acceptEncoding: string | null,
): StaticCompressionEncoding[] {
  const explicitlyPreferredIdentity = acceptEncoding
    && acceptEncoding
      .split(",")
      .some((entry) => entry.trim().toLowerCase().split(";", 1)[0] === "identity")
    ? staticEncodingQuality(acceptEncoding, "identity")
    : null;
  const encodings = [
    { encoding: "br", quality: staticEncodingQuality(acceptEncoding, "br") },
    { encoding: "gzip", quality: staticEncodingQuality(acceptEncoding, "gzip") },
  ] satisfies Array<{ encoding: StaticCompressionEncoding; quality: number }>;
  const acceptedEncodings = encodings.filter((candidate) => (
    candidate.quality > 0
    && (
      explicitlyPreferredIdentity === null
      || candidate.quality >= explicitlyPreferredIdentity
    )
  ));
  acceptedEncodings.sort((left, right) => {
    if (right.quality !== left.quality) return right.quality - left.quality;
    return left.encoding === "br" ? -1 : 1;
  });
  return acceptedEncodings.map((candidate) => candidate.encoding);
}

function compressedStaticSiblingPath(
  filePath: string,
  encoding: StaticCompressionEncoding,
): string {
  return `${filePath}.${encoding === "br" ? "br" : "gz"}`;
}

function ifNoneMatchMatches(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  const candidates = value
    .split(",")
    .map((entry) => entry.trim());
  if (candidates.includes("*")) return true;
  const currentOpaqueTag = weakEntityTagValue(etag);
  if (currentOpaqueTag === null) return false;
  return candidates.some(
    (candidate) => weakEntityTagValue(candidate) === currentOpaqueTag,
  );
}

function weakEntityTagValue(value: string): string | null {
  const candidate = value.startsWith("W/") ? value.slice(2) : value;
  if (candidate.length < 2 || candidate[0] !== "\"" || candidate.at(-1) !== "\"") {
    return null;
  }
  return candidate;
}

function ifModifiedSinceMatches(header: string | string[] | undefined, mtimeMs: number): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Math.floor(mtimeMs / 1000) * 1000 <= parsed;
}

async function compressStaticBuffer(
  source: Buffer,
  encoding: StaticCompressionEncoding,
): Promise<Buffer> {
  if (encoding === "br") {
    return brotliCompressAsync(source, {
      maxOutputLength: MAX_STATIC_FALLBACK_OUTPUT_BYTES,
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: STATIC_FALLBACK_BROTLI_QUALITY,
      },
    });
  }
  return gzipAsync(source, {
    level: STATIC_FALLBACK_GZIP_LEVEL,
    maxOutputLength: MAX_STATIC_FALLBACK_OUTPUT_BYTES,
  });
}

export async function compressBody(
  source: Buffer | string,
  encoding: CompressionEncoding,
): Promise<Buffer> {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const maxOutputLength = Math.min(
    MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES
      + MAX_DYNAMIC_COMPRESSION_OUTPUT_OVERHEAD_BYTES,
    buffer.byteLength + MAX_DYNAMIC_COMPRESSION_OUTPUT_OVERHEAD_BYTES,
  );
  if (encoding === "br") {
    return brotliCompressAsync(buffer, {
      maxOutputLength,
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: DYNAMIC_BROTLI_QUALITY,
      },
    });
  }
  return gzipAsync(buffer, {
    level: DYNAMIC_GZIP_LEVEL,
    maxOutputLength,
  });
}

let activeDynamicCompressions = 0;

export function canStartDynamicCompression(activeCount: number): boolean {
  return activeCount >= 0 && activeCount < MAX_CONCURRENT_DYNAMIC_COMPRESSIONS;
}

export function isDynamicCompressionSizeEligible(byteLength: number): boolean {
  return Number.isSafeInteger(byteLength)
    && byteLength >= COMPRESSION_MIN_BYTES
    && byteLength <= MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES;
}

export function canBufferBodyChunk(
  currentBytes: number,
  currentChunks: number,
  nextChunkBytes: number,
  maxBytes: number,
): boolean {
  return Number.isSafeInteger(currentBytes)
    && currentBytes >= 0
    && Number.isSafeInteger(currentChunks)
    && currentChunks >= 0
    && Number.isSafeInteger(nextChunkBytes)
    && nextChunkBytes >= 0
    && Number.isSafeInteger(maxBytes)
    && maxBytes >= 0
    && currentChunks < MAX_BUFFERED_BODY_CHUNKS
    && currentBytes + nextChunkBytes <= maxBytes;
}

export type DynamicCompressionBufferBudgetSnapshot = {
  activeCount: number;
  activeBytes: number;
};

export class DynamicCompressionBufferBudget {
  private activeCount = 0;
  private activeBytes = 0;

  constructor(
    private readonly maxCount = MAX_CONCURRENT_DYNAMIC_COMPRESSIONS,
    private readonly maxBytes = MAX_DYNAMIC_PROXY_BUFFERED_SOURCE_BYTES,
  ) {}

  /**
   * Admission is decided against this instance's own ceilings only. Callers own
   * the question of whether a given size is worth compressing at all — folding
   * `isDynamicCompressionSizeEligible` in here would make a budget constructed
   * with a small `maxBytes` silently admit nothing.
   */
  tryReserve(sourceBytes: number): (() => void) | null {
    if (
      !Number.isSafeInteger(sourceBytes)
      || sourceBytes < 0
      || this.activeCount >= this.maxCount
      || this.activeBytes + sourceBytes > this.maxBytes
    ) {
      return null;
    }
    this.activeCount += 1;
    this.activeBytes += sourceBytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.activeBytes = Math.max(0, this.activeBytes - sourceBytes);
    };
  }

  snapshot(): DynamicCompressionBufferBudgetSnapshot {
    return {
      activeCount: this.activeCount,
      activeBytes: this.activeBytes,
    };
  }
}

const dynamicProxyCompressionBufferBudget = new DynamicCompressionBufferBudget();

export function dynamicProxyCompressionBufferSnapshot(): DynamicCompressionBufferBudgetSnapshot {
  return dynamicProxyCompressionBufferBudget.snapshot();
}

export function activeDynamicCompressionCount(): number {
  return activeDynamicCompressions;
}

/**
 * Aggregate byte budget for buffers whose final size is not known in advance.
 * Preview bodies arrive decoded, so they are accounted for incrementally rather
 * than reserved up front the way a declared `Content-Length` can be.
 */
export class AggregateByteBudget {
  private activeBytes = 0;

  constructor(private readonly maxBytes: number) {}

  tryAcquire(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (this.activeBytes + bytes > this.maxBytes) return false;
    this.activeBytes += bytes;
    return true;
  }

  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    this.activeBytes = Math.max(0, this.activeBytes - bytes);
  }

  snapshot(): { activeBytes: number } {
    return { activeBytes: this.activeBytes };
  }
}

const browserPreviewDecodeBudget = new AggregateByteBudget(MAX_BROWSER_PREVIEW_DECODED_TOTAL_BYTES);

export function browserPreviewDecodeSnapshot(): { activeBytes: number } {
  return browserPreviewDecodeBudget.snapshot();
}

/**
 * Allocates the contiguous source buffer for a buffered proxy body. The size is
 * already validated and reserved, but a host under memory pressure can still
 * refuse the allocation, and that must surface as a failed request rather than
 * an unhandled throw inside an event callback.
 */
export function allocateBufferedProxySource(byteLength: number): Buffer | null {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return null;
  try {
    return Buffer.allocUnsafe(byteLength);
  } catch {
    return null;
  }
}

/**
 * Defensive bound on a buffered proxy body. A conforming HTTP client stops
 * reading at the declared `Content-Length`, so this should never reject in
 * practice; it exists so a transport that over-delivers cannot write past the
 * allocation.
 */
export function canAppendToProxySourceBuffer(
  bufferedBytes: number,
  chunkBytes: number,
  capacity: number,
): boolean {
  return Number.isSafeInteger(bufferedBytes)
    && bufferedBytes >= 0
    && Number.isSafeInteger(chunkBytes)
    && chunkBytes >= 0
    && Number.isSafeInteger(capacity)
    && capacity >= 0
    && bufferedBytes + chunkBytes <= capacity;
}

/**
 * A buffered body that finished reading still has to decide whether anyone is
 * left to receive it. Any of these means the response is already spoken for, so
 * the reservation is returned instead of starting a codec nobody will read.
 */
export function shouldAbandonBufferedProxyBody(
  reservationReleased: boolean,
  requestSettled: boolean,
  responseDestroyed: boolean,
): boolean {
  return reservationReleased || requestSettled || responseDestroyed;
}

export function releaseReservationOnResponseSettled(
  response: ServerResponse,
  release: () => void,
): void {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    response.removeListener("finish", settle);
    response.removeListener("close", settle);
    release();
  };
  response.once("finish", settle);
  response.once("close", settle);
}

const staticFallbackCompressions = new Map<string, Promise<StaticCompressionOutcome>>();

export async function readStaticFileWithinLimit(
  filePath: string,
  expectedMtimeMs: number,
  expectedSize: number,
): Promise<Buffer | null> {
  if (expectedSize < 0 || expectedSize > MAX_STATIC_FALLBACK_SOURCE_BYTES) {
    return null;
  }

  try {
    const handle = await open(filePath, "r");
    try {
      const current = await handle.stat();
      if (
        !current.isFile()
        || current.size !== expectedSize
        || current.mtimeMs !== expectedMtimeMs
      ) {
        return null;
      }

      const source = Buffer.allocUnsafe(expectedSize);
      let offset = 0;
      while (offset < source.byteLength) {
        const { bytesRead } = await handle.read(
          source,
          offset,
          source.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) return null;
        offset += bytesRead;
      }

      // Detect growth after fstat without ever allocating or reading more than
      // the configured source limit plus one probe byte.
      const probe = Buffer.allocUnsafe(1);
      const { bytesRead: trailingBytes } = await handle.read(
        probe,
        0,
        1,
        expectedSize,
      );
      return trailingBytes === 0 ? source : null;
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    // Static compression is optional. Races with asset replacement or a read
    // failure fall back to identity rather than exposing filesystem details.
    return null;
  }
}

export async function compressStaticFileWithinLimits(
  filePath: string,
  sourceMtimeMs: number,
  sourceSize: number,
  encodings: StaticCompressionEncoding[],
  requireEncodedRepresentation: boolean,
): Promise<StaticCompressionOutcome> {
  // No encoding the client accepts: identity is the only representation, and
  // that is a property of the request rather than of this server's budget.
  if (encodings.length === 0) return { status: "not-beneficial" };
  if (sourceSize > MAX_STATIC_FALLBACK_SOURCE_BYTES || sourceSize < 0) {
    return { status: "declined" };
  }

  const key = [
    filePath,
    sourceMtimeMs,
    sourceSize,
    encodings.join(","),
    requireEncodedRepresentation ? "required" : "optional",
  ].join("\0");
  const existing = staticFallbackCompressions.get(key);
  if (existing) return existing;
  if (!canStartStaticFallbackCompression(staticFallbackCompressions.size)) {
    return { status: "declined" };
  }

  const compression = (async (): Promise<StaticCompressionOutcome> => {
    const source = await readStaticFileWithinLimit(filePath, sourceMtimeMs, sourceSize);
    if (!source) return { status: "declined" };
    let declined = false;
    for (const encoding of encodings) {
      try {
        const compressed = await compressStaticBuffer(source, encoding);
        if (compressed.byteLength > MAX_STATIC_FALLBACK_OUTPUT_BYTES) {
          // zlib and brotli reject past `maxOutputLength` by throwing, so this
          // is a backstop. Either way the budget, not the asset, is the reason.
          declined = true;
          continue;
        }
        if (!requireEncodedRepresentation && compressed.byteLength >= source.byteLength) {
          continue;
        }
        return { status: "compressed", encoding, buffer: compressed };
      } catch {
        // Compression is an optimization. A codec failure must not prevent the
        // identity representation from being served when the client accepts it.
        declined = true;
      }
    }
    return declined ? { status: "declined" } : { status: "not-beneficial" };
  })();
  staticFallbackCompressions.set(key, compression);
  try {
    return await compression;
  } finally {
    if (staticFallbackCompressions.get(key) === compression) {
      staticFallbackCompressions.delete(key);
    }
  }
}

export function canStartStaticFallbackCompression(activeCount: number): boolean {
  return activeCount >= 0
    && activeCount < MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS;
}

export type ResponseCompressionContext = {
  mode: GatewayCompressionMode;
  acceptEncoding: string | null;
};

const responseCompressionContexts = new WeakMap<ServerResponse, ResponseCompressionContext>();

export type PreparedBody = {
  body: Buffer;
  encoding: ContentEncoding;
  variesByEncoding: boolean;
};

export type DynamicBodyCompressor = (
  source: Buffer | string,
  encoding: CompressionEncoding,
) => Promise<Buffer>;

export async function prepareCompressedBody(
  source: Buffer | string,
  contentType: string | null,
  context: ResponseCompressionContext | undefined,
  existingContentEncoding: string | null = null,
  compressor: DynamicBodyCompressor = compressBody,
): Promise<PreparedBody> {
  const body = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const canNegotiate = context?.mode !== undefined
    && context.mode !== "off"
    && isCompressibleContentType(contentType)
    && normalizeContentEncoding(existingContentEncoding) === "identity";
  if (
    !canNegotiate
    || !isDynamicCompressionSizeEligible(body.byteLength)
  ) {
    return { body, encoding: "identity", variesByEncoding: canNegotiate };
  }

  const encoding = negotiateEncoding(context.acceptEncoding);
  if (encoding === "identity") {
    return { body, encoding, variesByEncoding: true };
  }
  if (!canStartDynamicCompression(activeDynamicCompressions)) {
    return { body, encoding: "identity", variesByEncoding: true };
  }
  activeDynamicCompressions += 1;
  try {
    const compressed = await compressor(body, encoding);
    if (compressed.byteLength >= body.byteLength) {
      return { body, encoding: "identity", variesByEncoding: true };
    }
    return { body: compressed, encoding, variesByEncoding: true };
  } catch {
    // Compression must remain an optional optimization. Codec errors retain a
    // usable identity representation and the same cache variation semantics.
    return { body, encoding: "identity", variesByEncoding: true };
  } finally {
    activeDynamicCompressions -= 1;
  }
}

function writePreparedBody(
  response: ServerResponse,
  statusCode: number,
  headers: OutgoingHttpHeaders,
  prepared: PreparedBody,
): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) response.setHeader(name, value);
  }
  if (prepared.variesByEncoding) appendResponseVary(response, "Accept-Encoding");
  response.setHeader("content-length", prepared.body.byteLength);
  if (prepared.encoding === "identity") {
    response.removeHeader("content-encoding");
  } else {
    response.setHeader("content-encoding", prepared.encoding);
    // Validators supplied for another representation cannot validate the
    // transformed bytes. Dynamic gateway responses are no-store, while proxy
    // callers remove origin validators before reaching this helper.
  }
  response.writeHead(statusCode);
  response.end(prepared.body);
}

export function recoverBodyResponseError(
  response: ServerResponse,
  statusCode: number,
  headers: OutgoingHttpHeaders,
  source: Buffer,
  error: unknown,
): void {
  if (!response.headersSent) {
    writePreparedBody(response, statusCode, headers, {
      body: source,
      encoding: "identity",
      variesByEncoding: true,
    });
  } else {
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

export function settlePreparedBodyResponse(
  response: ServerResponse,
  statusCode: number,
  headers: OutgoingHttpHeaders,
  source: Buffer,
  preparation: Promise<PreparedBody>,
): void {
  void preparation
    .then((prepared) => {
      if (!response.destroyed) writePreparedBody(response, statusCode, headers, prepared);
    })
    .catch((error: unknown) => {
      recoverBodyResponseError(response, statusCode, headers, source, error);
    });
}

export function settleRewrittenProxyBodyResponse(
  response: ServerResponse,
  statusCode: number,
  headers: OutgoingHttpHeaders,
  preparation: Promise<PreparedBody>,
  isSettled: () => boolean,
  finish: () => void,
  fail: (error: Error) => void,
): void {
  void preparation
    .then((prepared) => {
      if (isSettled() || response.destroyed) return;
      headers["content-length"] = prepared.body.byteLength;
      if (prepared.variesByEncoding) appendHeadersVary(headers, "Accept-Encoding");
      if (prepared.encoding === "identity") {
        delete headers["content-encoding"];
      } else {
        headers["content-encoding"] = prepared.encoding;
      }
      response.writeHead(statusCode, headers);
      response.end(prepared.body);
      finish();
    })
    .catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
}

function bodyResponse(
  response: ServerResponse,
  statusCode: number,
  body: Buffer | string,
  headers: OutgoingHttpHeaders,
): void {
  const contentType = headerValueToString(headers["content-type"])
    ?? headerValueToString(response.getHeader("content-type"));
  const existingContentEncoding = headerValueToString(headers["content-encoding"])
    ?? headerValueToString(response.getHeader("content-encoding"));
  const context = responseCompressionContexts.get(response);
  const source = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const shouldCompress = context?.mode !== undefined
    && context.mode !== "off"
    && isDynamicCompressionSizeEligible(source.byteLength)
    && isCompressibleContentType(contentType)
    && normalizeContentEncoding(existingContentEncoding) === "identity";

  if (!shouldCompress) {
    const variesByEncoding = context?.mode !== undefined
      && context.mode !== "off"
      && isCompressibleContentType(contentType)
      && normalizeContentEncoding(existingContentEncoding) === "identity";
    writePreparedBody(response, statusCode, headers, {
      body: source,
      encoding: "identity",
      variesByEncoding,
    });
    return;
  }

  settlePreparedBodyResponse(
    response,
    statusCode,
    headers,
    source,
    prepareCompressedBody(source, contentType, context, existingContentEncoding),
  );
}

function jsonResponse(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  serializedJsonResponse(response, statusCode, JSON.stringify(payload), headers);
}

function serializedJsonResponse(
  response: ServerResponse,
  statusCode: number,
  payload: string,
  headers: OutgoingHttpHeaders = {},
): void {
  bodyResponse(response, statusCode, payload, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
}

function textResponse(response: ServerResponse, statusCode: number, text: string, contentType = "text/plain; charset=utf-8"): void {
  bodyResponse(response, statusCode, text, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
}

function getCookie(headers: IncomingHttpHeaders, name: string): string | null {
  const cookieHeader = headers.cookie;
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = cookie.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function getBearerToken(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization;
  if (!authorization) return null;
  const [scheme, ...rest] = authorization.split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

function tokenMatches(actual: string, candidate: string | null): boolean {
  if (!candidate) return false;
  const actualBytes = Buffer.from(actual);
  const candidateBytes = Buffer.from(candidate);
  return actualBytes.length === candidateBytes.length && timingSafeEqual(actualBytes, candidateBytes);
}

function authFilePath(dataDir: string): string {
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

async function persistGatewayToken(authFile: string, token: string): Promise<void> {
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

async function readRequestBody(
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

async function readJsonBody(
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

async function readLoginToken(request: IncomingMessage): Promise<string> {
  const contentType = request.headers["content-type"] ?? "";
  const { body } = await readRequestBody(request);

  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(body.toString("utf8")) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : "";
  }

  const params = new URLSearchParams(body.toString("utf8"));
  return params.get("token") ?? "";
}

function loginPage(message = ""): string {
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

function wantsHtml(request: IncomingMessage): boolean {
  return request.headers.accept?.includes("text/html") ?? false;
}

function filterGatewayCookie(cookieHeader: string | string[] | undefined): string | undefined {
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

function sanitizeTargetRequestHeaders(
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

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function proxyPath(proxyPrefix: string, targetPath: string): string {
  const normalizedTargetPath = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  return `${proxyPrefix}${normalizedTargetPath}`;
}

function rewriteLocationHeader(location: string, target: URL, proxyPrefix?: string): string {
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

function rewriteCookiePath(proxyPrefix: string, targetPath: string | null): string {
  if (!targetPath || !targetPath.startsWith("/")) return `${proxyPrefix}/`;
  return proxyPath(proxyPrefix, targetPath);
}

function rewriteSetCookieHeader(header: string, proxyPrefix?: string): string | null {
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

function rewriteSetCookieHeaders(headers: string | string[], proxyPrefix?: string): string | string[] | undefined {
  const values = Array.isArray(headers) ? headers : [headers];
  const rewritten = values
    .map((header) => rewriteSetCookieHeader(header, proxyPrefix))
    .filter((header): header is string => typeof header === "string" && header.length > 0);

  if (rewritten.length === 0) return undefined;
  return Array.isArray(headers) ? rewritten : rewritten[0];
}

function sanitizeProxyResponseHeaders(headers: IncomingHttpHeaders, target: URL, proxyPrefix?: string): OutgoingHttpHeaders {
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

function browserPreviewContentKind(contentType: string | string[] | undefined): BrowserPreviewContentKind | null {
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

function browserPreviewContentDecoder(contentEncoding: string | string[] | undefined): Transform | null | undefined {
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
function browserPreviewRefererPrefix(request: IncomingMessage): string | null {
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

type DrainAwareEventClientWriter = EventClientWriter & {
  onDrain(listener: () => void): void;
};

class IdentityEventClientWriter implements DrainAwareEventClientWriter {
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

type GatewayEventClient = {
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
export type GatewayReconcileReason =
  | "invalid-cursor"
  | "prior-generation"
  | "cursor-expired"
  | "cursor-ahead"
  | "replay-too-large";

type BufferedGatewayEvent = {
  event: string;
  payload: unknown;
  message: string;
  messageBytes: number;
  droppable: boolean;
  revision: number | null;
};

type GatewayReplayHandshake = {
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

export class OrkestratorGateway {
  private readonly backend: BackendInvoker;
  private readonly dataDir: string;
  private readonly rendererRoot: string;
  private readonly rendererDevServerUrl?: string;
  private readonly bindAddress?: string;
  private readonly fallbackBindAddress?: string;
  private readonly port?: number;
  private readonly controlBindAddress?: string;
  private readonly controlPort?: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly interfaces?: NetworkInterfaceMap;
  private readonly logger: Pick<Console, "debug" | "error" | "info" | "warn">;
  private readonly allowNonTailscaleBind: boolean;
  private readonly webClientControl: OrkestratorGatewayOptions["webClientControl"];
  private readonly allowedOrigins: string[];
  private readonly compression: GatewayCompressionMode;
  private readonly keepaliveMs: number;
  private readonly proxyBodyIdleTimeoutMs: number;
  private readonly eventReplay: GatewayEventReplay;
  private readonly replayHandshakeFrameCapacity: number;
  private readonly replayHandshakeMaxBytes: number;
  private readonly metrics: GatewayMetricsStore;
  private readonly terminalWebSocket: TerminalWebSocketGateway;
  private servers = new Set<Server>();
  private token = "";
  private authFile = "";
  private clients = new Map<EventClientWriter, GatewayEventClient>();
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
  private droppedTmuxFrames = new WeakMap<EventClientWriter, Map<string, string>>();
  private proxyRequests = new Set<ReturnType<typeof http.request>>();
  private sockets = new Set<Socket>();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private tokenTransition: Promise<unknown> = Promise.resolve();

  constructor(options: OrkestratorGatewayOptions) {
    this.backend = options.backend;
    this.dataDir = options.dataDir;
    this.rendererRoot = options.rendererRoot;
    this.rendererDevServerUrl = options.rendererDevServerUrl;
    this.bindAddress = options.bindAddress;
    this.fallbackBindAddress = options.fallbackBindAddress;
    this.port = options.port;
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
      tokenMatches: (request, suppliedToken) => tokenMatches(
        this.token,
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

  private async listenWithPortFallback(
    bindAddress: string,
    preferredPort: number,
  ): Promise<{ bindAddress: string; port: number; url: string }> {
    if (preferredPort === 0) return this.listen(bindAddress, preferredPort, "browser");

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

  private async listen(
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
      // Authentication is latched when a WebSocket becomes ready. Rotating
      // the credential must therefore revoke every connection authenticated
      // with the previous value rather than waiting for a reconnect.
      this.terminalWebSocket.revokeConnections();
      return { token, editable: true, source: "file" };
    });
  }

  private enqueueTokenOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tokenTransition.catch(() => undefined).then(operation);
    this.tokenTransition = result;
    return result;
  }

  async stop(): Promise<void> {
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

  emit(event: string, payload: unknown): void {
    this.terminalWebSocket.emit(event, payload);
    const droppable = event.startsWith(DROPPABLE_EVENT_PREFIX);
    // Authoritative state is revisioned and retained even while no renderer is
    // mounted. Terminal bytes have their own generation/revision snapshot
    // protocol and must never consume this replay ring.
    const replayFrame = droppable ? null : this.eventReplay.append(event, payload);
    if (this.clients.size === 0) return;
    let message = replayFrame?.message ?? null;
    let messageBytes = replayFrame?.encodedBytes ?? 0;
    for (const [client, state] of this.clients) {
      if (!eventMatchesSubscription(
        event,
        state.prefixes,
        state.includedPrefixes,
        state.excludedPrefixes,
      )) {
        // The revision still happened globally. Remember it so the keepalive can
        // advance this client's cursor; otherwise its next reconnect asks for a
        // window the ring has long since evicted and reconciles for nothing.
        if (replayFrame && state.tracksReplayCursor) {
          state.omittedRevision = replayFrame.revision;
        }
        continue;
      }
      // A matching authoritative frame carries a newer `id` than anything
      // omitted before it, so the pending cursor is already superseded.
      if (replayFrame) state.omittedRevision = null;
      if (message === null) {
        message = `data: ${JSON.stringify({ event, payload })}\n\n`;
        messageBytes = Buffer.byteLength(message);
      }

      if (state.handshake) {
        const projectedFrames = state.handshake.events.length + 1;
        const projectedBytes = state.handshake.bytes + messageBytes;
        if (
          projectedFrames > this.replayHandshakeFrameCapacity
          || projectedBytes > this.replayHandshakeMaxBytes
        ) {
          this.dropBufferedClient(client, event, projectedBytes);
          continue;
        }
        state.handshake.events.push({
          event,
          payload,
          message,
          messageBytes,
          droppable,
          revision: replayFrame?.revision ?? null,
        });
        state.handshake.bytes = projectedBytes;
        continue;
      }

      const written = this.writeEventToClient(
        client,
        state,
        event,
        payload,
        message,
        messageBytes,
        droppable,
      );
      if (written && replayFrame) state.sentRevision = replayFrame.revision;
    }
  }

  /**
   * Advances a client that has only seen revisions its filter omitted.
   *
   * A scoped subscription receives no `id` for events it filtered out, so under
   * sustained unrelated traffic its cursor would freeze while the ring moved on,
   * and every reconnect would reconcile a gap it never actually missed. Flushing
   * on the keepalive tick bounds that drift to one keepalive interval and costs
   * one small frame instead of one per omitted event.
   */
  private flushOmittedCursor(client: EventClientWriter, state: GatewayEventClient): void {
    const omitted = state.omittedRevision;
    if (
      omitted === null
      || omitted === undefined
      || !state.tracksReplayCursor
      || state.handshake
      || omitted <= (state.sentRevision ?? 0)
    ) return;
    state.omittedRevision = null;
    if (!this.writeControlFrame(
      client,
      GATEWAY_CURSOR_EVENT,
      formatGatewayCursor(this.eventReplay.generation, omitted),
      null,
    )) return;
    state.sentRevision = omitted;
  }

  private writeEventToClient(
    client: EventClientWriter,
    state: GatewayEventClient,
    event: string,
    payload: unknown,
    message: string,
    messageBytes: number,
    droppable: boolean,
  ): boolean {
    if (client.writableLength > SSE_CLIENT_HARD_BUFFER_BYTES) {
      this.dropBufferedClient(client, event, client.writableLength);
      return false;
    }

    if (
      droppable
      && client.writableLength + messageBytes > SSE_CLIENT_SOFT_BUFFER_BYTES
    ) {
      this.markTerminalFrameDropped(client, state, event, message, payload);
      return true;
    }
    if (
      state.desyncedSessions.size > 0
      && !this.flushDesyncNotices(client, state)
    ) {
      return false;
    }

    const projectedBytes = client.writableLength + messageBytes;
    if (projectedBytes > SSE_CLIENT_HARD_BUFFER_BYTES) {
      this.dropBufferedClient(client, event, projectedBytes);
      return false;
    }
    // A desync notice may itself consume the last available soft-limit
    // space. Re-check droppable frames after flushing it.
    if (droppable && projectedBytes > SSE_CLIENT_SOFT_BUFFER_BYTES) {
      this.markTerminalFrameDropped(client, state, event, message, payload);
      return true;
    }
    client.write(message);
    this.metrics.recordEvent(event, messageBytes);
    return true;
  }

  private writeControlFrame(
    client: EventClientWriter,
    event: string,
    cursor: string | null,
    payload: unknown,
  ): boolean {
    const message = `${cursor ? `id: ${cursor}\n` : ""}data: ${JSON.stringify({
      event,
      payload,
    })}\n\n`;
    const projectedBytes = client.writableLength + Buffer.byteLength(message);
    if (projectedBytes > SSE_CLIENT_HARD_BUFFER_BYTES) {
      this.dropBufferedClient(client, event, projectedBytes);
      return false;
    }
    client.write(message);
    return true;
  }

  private writeReplayFrame(
    client: EventClientWriter,
    state: GatewayEventClient,
    frame: GatewayReplayFrame,
  ): boolean {
    if (eventMatchesSubscription(
      frame.event,
      state.prefixes,
      state.includedPrefixes,
      state.excludedPrefixes,
    )) {
      return this.writeEventToClient(
        client,
        state,
        frame.event,
        undefined,
        frame.message,
        frame.encodedBytes,
        false,
      );
    }
    // A scoped stream still has to advance through global revisions it omitted,
    // otherwise every reconnect would request the same irrelevant frames.
    return this.writeControlFrame(client, GATEWAY_CURSOR_EVENT, frame.cursor, null);
  }

  /**
   * Whether the whole replay window can be written without tripping the hard
   * buffer limit.
   *
   * Replay is one synchronous loop and neither writer's `writableLength` can
   * fall during it, so the window's bytes accumulate against whatever the socket
   * has not absorbed. Checking up front turns a silent mid-replay destroy into
   * an explicit reconciliation.
   */
  private replayFitsClientBudget(
    client: EventClientWriter,
    frames: readonly GatewayReplayFrame[],
  ): boolean {
    let projected = client.writableLength;
    for (const frame of frames) {
      projected += frame.encodedBytes;
      if (projected > SSE_CLIENT_HARD_BUFFER_BYTES) return false;
    }
    return true;
  }

  private initializeEventReplay(
    client: EventClientWriter,
    state: GatewayEventClient,
    cursor: GatewayCursorParseResult,
  ): void {
    const latestAtSubscribe = this.eventReplay.latestRevision;
    let replay:
      | ReturnType<GatewayEventReplay["since"]>
      | null = null;
    // An invalid cursor is not safe to echo as an SSE id, and advancing to the
    // latest revision here could make a disconnect before reconcile-required
    // permanently skip the snapshot recovery signal.
    let connectedCursor: string | null = cursor.kind === "invalid"
      ? null
      : this.eventReplay.latestCursor;
    let replayStatus: "fresh" | "caught-up" | "replayed" | "reconcile" = "fresh";
    let reconcileReason: GatewayReconcileReason | null = null;
    let requestedRevision: number | null = null;

    if (cursor.kind === "invalid") {
      replayStatus = "reconcile";
      reconcileReason = "invalid-cursor";
    } else if (cursor.kind === "valid") {
      connectedCursor = cursor.raw;
      requestedRevision = cursor.revision;
      if (cursor.generation !== this.eventReplay.generation) {
        replayStatus = "reconcile";
        reconcileReason = "prior-generation";
      } else if (cursor.revision > this.eventReplay.latestRevision) {
        // Ahead of the server is the opposite of expired. Both reconcile, but
        // conflating them hides a corrupt cursor behind a routine ring overrun.
        replayStatus = "reconcile";
        reconcileReason = "cursor-ahead";
      } else {
        replay = this.eventReplay.since(cursor.revision);
        if (!replay.complete) {
          replayStatus = "reconcile";
          reconcileReason = "cursor-expired";
        } else if (!this.replayFitsClientBudget(client, replay.frames)) {
          // Writing the window would overrun the hard buffer partway through and
          // destroy the client with no explanation. Reconciling costs one
          // snapshot instead of a drop/reconnect/drop loop.
          replay = null;
          replayStatus = "reconcile";
          reconcileReason = "replay-too-large";
        } else {
          replayStatus = replay.frames.length > 0 ? "replayed" : "caught-up";
        }
      }
    }

    const replayedFrames = replay?.complete ? replay.frames.length : 0;
    this.metrics.recordReplayHandshake(replayStatus, reconcileReason, replayedFrames);
    if (!this.writeControlFrame(client, GATEWAY_CONNECTED_EVENT, connectedCursor, {
      generation: this.eventReplay.generation,
      revision: latestAtSubscribe,
      status: replayStatus,
      replayed: replayedFrames,
    })) return;
    if (!this.clients.has(client)) return;

    let highestSent = cursor.kind === "valid" ? cursor.revision : latestAtSubscribe;
    if (reconcileReason) {
      const currentCursor = this.eventReplay.latestCursor;
      if (!this.writeControlFrame(
        client,
        GATEWAY_RECONCILE_REQUIRED_EVENT,
        currentCursor,
        {
          reason: reconcileReason,
          requestedCursor: cursor.kind === "absent" ? null : cursor.raw,
          requestedRevision,
          oldestAvailableRevision: this.eventReplay.oldestRevision,
          latestRevision: this.eventReplay.latestRevision,
          generation: this.eventReplay.generation,
        },
      )) return;
      if (!this.clients.has(client)) return;
      highestSent = this.eventReplay.latestRevision;
    } else if (replay) {
      for (const frame of replay.frames) {
        if (!this.clients.has(client)) return;
        if (!this.writeReplayFrame(client, state, frame)) return;
        highestSent = Math.max(highestSent, frame.revision);
      }
    }

    // Stay in buffered mode until the dynamic end of the array. A write can
    // synchronously cause another backend event, and that later event must not
    // overtake an earlier buffered one.
    let index = 0;
    while (state.handshake && index < state.handshake.events.length) {
      const buffered = state.handshake.events[index]!;
      index += 1;
      if (buffered.revision !== null && buffered.revision <= highestSent) continue;
      if (!this.writeEventToClient(
        client,
        state,
        buffered.event,
        buffered.payload,
        buffered.message,
        buffered.messageBytes,
        buffered.droppable,
      )) return;
      if (buffered.revision !== null) highestSent = buffered.revision;
    }
    state.handshake = null;
    // Everything up to `highestSent` now carries an `id` this client has seen,
    // so any cursor omitted during the handshake is already superseded.
    state.sentRevision = highestSent;
    state.omittedRevision = null;
  }

  private markTerminalFrameDropped(
    client: EventClientWriter,
    state: GatewayEventClient,
    event: string,
    message: string,
    payload: unknown,
  ): void {
    const sessionId = event.slice(DROPPABLE_EVENT_PREFIX.length);
    const streamAlreadyStalled = state.desyncedSessions.size > 0;
    state.desyncedSessions.add(sessionId);
    this.metrics.recordDroppedEventFrame(event);
    this.metrics.recordSoftDesync();
    if (!streamAlreadyStalled) this.metrics.recordStreamStalled();
    if (
      !sessionId.startsWith("tmux:")
      || !state.includedPrefixes?.includes(event)
    ) return;
    let frames = this.droppedTmuxFrames.get(client);
    if (!frames) {
      frames = new Map();
      this.droppedTmuxFrames.set(client, frames);
    }
    // A filtered terminal SSE can subscribe to several mounted sessions, so
    // retain at most the newest full-pane frame for each subscribed tmux
    // session. Broader/legacy streams receive the ordinary desync notice
    // instead of accumulating panes for terminals they are not displaying.
    if (
      payload
      && typeof payload === "object"
      && (payload as { full?: unknown }).full === true
    ) {
      frames.set(sessionId, message);
    } else {
      // A line patch cannot recover earlier dropped patches. Force the client
      // through the explicit desync path instead of replaying an incomplete pane.
      frames.delete(sessionId);
    }
  }

  private dropBufferedClient(client: EventClientWriter, event: string, projectedBytes: number): void {
    this.logger.warn(
      `[RemoteGateway] Dropping an event-stream client buffering ${projectedBytes} bytes; it will reconnect and refetch`,
    );
    this.clients.delete(client);
    this.metrics.recordDroppedEventClient(event);
    this.metrics.recordStreamDropped();
    client.destroy();
  }

  /**
   * Tells a recovered client which terminal sessions lost frames.
   *
   * Dropping is only defensible if the client learns about it, so this is the
   * other half of the soft-limit drop: the renderer reacts by replaying
   * `get_terminal_output_buffer`, which is the authoritative window. The notice
   * rides the session's own event rather than a second event name so consumers
   * need no extra subscription and existing filters keep working.
   */
  private flushDesyncNotices(
    client: EventClientWriter,
    state: GatewayEventClient,
  ): boolean {
    for (const sessionId of [...state.desyncedSessions]) {
      const event = `${DROPPABLE_EVENT_PREFIX}${sessionId}`;
      const retainedTmuxFrame = this.droppedTmuxFrames.get(client)?.get(sessionId);
      const recoveryFrame = retainedTmuxFrame
        ?? `data: ${JSON.stringify({ event, payload: { desynced: true } })}\n\n`;
      const projectedBytes = client.writableLength + Buffer.byteLength(recoveryFrame);
      if (projectedBytes > SSE_CLIENT_HARD_BUFFER_BYTES) {
        this.dropBufferedClient(client, event, projectedBytes);
        return false;
      }
      // Retire the session before writing it. A write can emit "drain"
      // synchronously, and the drain handler re-enters here: leaving the session
      // pending across the write recurses on the same frame until the stack dies,
      // taking the recovery path down with it.
      if (retainedTmuxFrame) {
        const retained = this.droppedTmuxFrames.get(client);
        retained?.delete(sessionId);
        if (retained?.size === 0) this.droppedTmuxFrames.delete(client);
      }
      state.desyncedSessions.delete(sessionId);
      client.write(recoveryFrame);
      this.metrics.recordEvent(event, Buffer.byteLength(recoveryFrame));
    }
    return true;
  }

  private authenticated(request: IncomingMessage): boolean {
    const token = getBearerToken(request.headers) ?? getCookie(request.headers, AUTH_COOKIE);
    return tokenMatches(this.token, token);
  }

  private isOriginAllowed(request: IncomingMessage, originValue: string): boolean {
    let origin: URL;
    try {
      origin = new URL(originValue);
    } catch {
      return false;
    }

    // Keep the existing renderer served by the backend working without extra
    // configuration, including when TLS is terminated by Tailscale Serve.
    if (request.headers.host && origin.host === request.headers.host) return true;
    return this.allowedOrigins.some((rule) => originMatchesRule(origin, rule));
  }

  private applyCorsHeaders(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    if (!this.isOriginAllowed(request, origin)) return false;

    response.setHeader("access-control-allow-origin", origin);
    appendResponseVary(response, "Origin");
    return true;
  }

  private handleCorsPreflight(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (!origin || !this.isOriginAllowed(request, origin)) {
      jsonResponse(response, 403, { error: "Origin not allowed" });
      return;
    }

    response.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": CORS_ALLOWED_METHODS,
      "access-control-allow-headers": CORS_ALLOWED_HEADERS,
      "access-control-max-age": "600",
      ...(request.headers["access-control-request-private-network"] === "true"
        ? { "access-control-allow-private-network": "true" }
        : {}),
      vary: appendVary(
        null,
        "Origin, Access-Control-Request-Private-Network",
      ),
    });
    response.end();
  }

  private handleBrowserPreviewCorsPreflight(request: IncomingMessage, response: ServerResponse): void {
    const requestedHeaders = request.headers["access-control-request-headers"];
    const allowedHeaders = Array.isArray(requestedHeaders)
      ? requestedHeaders.join(", ")
      : requestedHeaders?.trim() || CORS_ALLOWED_HEADERS;
    response.writeHead(204, {
      "access-control-allow-origin": "null",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": CORS_ALLOWED_METHODS,
      "access-control-allow-headers": allowedHeaders,
      "access-control-max-age": "600",
      ...(request.headers["access-control-request-private-network"] === "true"
        ? { "access-control-allow-private-network": "true" }
        : {}),
      vary: appendVary(
        null,
        "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
      ),
    });
    response.end();
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    listenerKind: ListenerKind,
  ): Promise<void> {
    responseCompressionContexts.set(response, {
      mode: compressionModeForListener(this.compression, listenerKind),
      acceptEncoding: headerValueToString(request.headers["accept-encoding"]),
    });
    const url = new URL(request.url ?? "/", "http://orkestrator.local");
    const route = classifyGatewayRoute(url.pathname);
    const requestMetrics = this.metrics.beginRequest({
      route,
      listenerKind,
      method: request.method ?? "GET",
      httpVersion: request.httpVersion || "1.1",
      acceptEncoding: headerValueToString(request.headers["accept-encoding"]),
      effectiveCompressionMode: compressionModeForListener(this.compression, listenerKind),
      requestBytes: parseContentLengthHeader(request.headers["content-length"]),
    });
    instrumentGatewayResponse(response, (responseBytes) => {
      requestMetrics.finish(response, responseBytes);
    });
    const isBrowserPreviewRequest = url.pathname.startsWith(`${API_PREFIX}/browser/loopback/`);

    if (request.method === "OPTIONS" && url.pathname.startsWith(`${API_PREFIX}/`)) {
      if (isBrowserPreviewRequest && request.headers.origin === "null") {
        this.handleBrowserPreviewCorsPreflight(request, response);
      } else {
        this.handleCorsPreflight(request, response);
      }
      return;
    }

    if (isBrowserPreviewRequest && request.headers.origin === "null") {
      response.setHeader("access-control-allow-origin", "null");
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "Origin");
    } else if (url.pathname.startsWith(`${API_PREFIX}/`) && !this.applyCorsHeaders(request, response)) {
      jsonResponse(response, 403, { error: "Origin not allowed" });
      return;
    }

    // Root-relative requests issued by a preview document (fetch("/api"),
    // runtime-built asset URLs) escape the preview namespace; steer them back
    // via their Referer. Runs before authentication on purpose: the redirect
    // is a deterministic transform of the request's own headers, and the
    // redirected request still has to pass the preview namespace's auth.
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
      const previewPrefix = browserPreviewRefererPrefix(request);
      if (previewPrefix) {
        if (request.method === "OPTIONS" && request.headers.origin === "null") {
          this.handleBrowserPreviewCorsPreflight(request, response);
          return;
        }
        const redirectHeaders: OutgoingHttpHeaders = {
          location: `${previewPrefix}${url.pathname}${url.search}`,
          "cache-control": "no-store",
          vary: appendVary(null, "Referer"),
        };
        if (request.headers.origin === "null") {
          redirectHeaders["access-control-allow-origin"] = "null";
          redirectHeaders["access-control-allow-credentials"] = "true";
          appendHeadersVary(redirectHeaders, "Origin");
        }
        response.writeHead(307, redirectHeaders);
        response.end();
        return;
      }
    }

    if (url.pathname === `${API_PREFIX}/login`) {
      await this.handleLogin(request, response);
      return;
    }

    if (url.pathname === `${API_PREFIX}/logout`) {
      response.writeHead(303, {
        location: `${API_PREFIX}/login`,
        "set-cookie": `${AUTH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    if (!this.authenticated(request)) {
      if (wantsHtml(request) && request.method === "GET") {
        textResponse(response, 401, loginPage(), "text/html; charset=utf-8");
      } else {
        jsonResponse(response, 401, { error: "Authentication required" });
      }
      return;
    }

    if (url.pathname === `${API_PREFIX}/gateway-settings`) {
      await this.handleGatewaySettings(request, response, requestMetrics);
      return;
    }

    if (url.pathname === `${API_PREFIX}/web-client-access`) {
      if (listenerKind !== "control" || !this.webClientControl) {
        jsonResponse(response, 404, { error: "Not found" });
        return;
      }
      await this.handleWebClientAccess(request, response, requestMetrics);
      return;
    }

    if (url.pathname === `${API_PREFIX}/status`) {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" });
        response.end();
        return;
      }
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (url.pathname === `${API_PREFIX}/invoke`) {
      await this.handleInvoke(request, response, requestMetrics);
      return;
    }

    if (url.pathname === `${API_PREFIX}/events`) {
      this.handleEvents(request, response, url);
      return;
    }

    if (url.pathname === `${API_PREFIX}/metrics`) {
      this.handleMetrics(request, response);
      return;
    }

    if (url.pathname === `${API_PREFIX}/client-metrics`) {
      await this.handleClientMetrics(request, response, requestMetrics);
      return;
    }

    if (url.pathname.startsWith(`${API_PREFIX}/proxy/loopback/`)) {
      await this.handleLoopbackProxy(request, response, url);
      return;
    }

    if (url.pathname.startsWith(`${API_PREFIX}/browser/loopback/`)) {
      await this.handleBrowserLoopbackProxy(request, response, url);
      return;
    }

    await this.serveStatic(
      request,
      url,
      response,
      compressionModeForListener(this.compression, listenerKind) !== "off",
    );
  }

  private async handleGatewaySettings(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    if (request.method === "GET") {
      jsonResponse(response, 200, await this.getTokenSettings());
      return;
    }
    if (request.method !== "PUT") {
      response.writeHead(405, { allow: "GET, PUT" });
      response.end();
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(request);
      body = parsed.body;
      requestMetrics.setRequestBytes(parsed.bytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        jsonResponse(response, 413, { error: error.message });
        return;
      }
      if (error instanceof InvalidRequestBodyError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
    if (typeof body.token !== "string") {
      jsonResponse(response, 400, { error: "Expected token to be a string" });
      return;
    }

    try {
      const settings = await this.setToken(body.token);
      jsonResponse(response, 200, settings, { "set-cookie": gatewayTokenCookieHeader(settings.token) });
    } catch (error) {
      if (error instanceof GatewayTokenValidationError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      this.logger.error("[RemoteGateway] Failed to persist gateway token:", error);
      jsonResponse(response, 500, { error: "Unable to persist gateway token" });
    }
  }

  private async handleWebClientAccess(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    if (!this.webClientControl) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method === "GET") {
      jsonResponse(response, 200, this.webClientControl.getStatus());
      return;
    }
    if (request.method === "DELETE") {
      jsonResponse(response, 200, await this.webClientControl.resetServe());
      return;
    }
    if (request.method !== "PUT") {
      response.writeHead(405, { allow: "GET, PUT, DELETE" });
      response.end();
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(request);
      body = parsed.body;
      requestMetrics.setRequestBytes(parsed.bytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        jsonResponse(response, 413, { error: error.message });
        return;
      }
      if (error instanceof InvalidRequestBodyError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
    if (typeof body.enabled !== "boolean") {
      jsonResponse(response, 400, { error: "Expected enabled to be a boolean" });
      return;
    }
    jsonResponse(response, 200, await this.webClientControl.setEnabled(body.enabled));
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET") {
      textResponse(response, 200, loginPage(), "text/html; charset=utf-8");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
      return;
    }

    const token = await readLoginToken(request);
    if (!tokenMatches(this.token, token)) {
      textResponse(response, 401, loginPage("Invalid gateway token."), "text/html; charset=utf-8");
      return;
    }

    response.writeHead(303, {
      location: "/",
      "set-cookie": gatewayTokenCookieHeader(this.token),
      "cache-control": "no-store",
    });
    response.end();
  }

  /**
   * Whether a failed command may be retained as a metric label.
   *
   * `hasCommand` is authoritative when the backend provides it. Backends that
   * do not — only test stubs, in practice — fall back to the registry's error
   * contract, which is what this check replaced.
   */
  private commandIsRegistered(command: string, errorMessage: string): boolean {
    const hasCommand = this.backend.hasCommand;
    if (hasCommand) return hasCommand.call(this.backend, command);
    return !errorMessage.startsWith("Unknown backend command:");
  }

  private async handleInvoke(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    let body: Record<string, unknown>;
    let requestBytes = 0;
    try {
      const parsed = await readJsonBody(request, MAX_INVOKE_BODY_BYTES);
      body = parsed.body;
      requestBytes = parsed.bytes;
      requestMetrics.setRequestBytes(parsed.bytes);
    } catch (error) {
      // Without these branches an oversized or malformed body escapes to the
      // generic server catch and surfaces as a 500, which reads as a backend
      // fault rather than as a request the caller can correct.
      if (error instanceof RequestBodyTooLargeError) {
        jsonResponse(response, 413, { error: error.message });
        return;
      }
      if (error instanceof InvalidRequestBodyError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
    const command = body.command;
    const args = body.args;
    if (typeof command !== "string") {
      jsonResponse(response, 400, { error: "Expected command to be a string" });
      return;
    }
    const safeArgs = args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};
    const startedAt = Date.now();

    try {
      const result = await this.backend.invoke(command, safeArgs);
      const responseBody = JSON.stringify({ result });
      this.metrics.recordInvoke(
        command,
        requestBytes,
        Buffer.byteLength(responseBody),
        Math.max(0, Date.now() - startedAt),
        true,
      );
      serializedJsonResponse(response, 200, responseBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const responseBody = JSON.stringify({ error: message });
      // Never retain the rejected, network-supplied value: a syntactically
      // valid token-like string is just as sensitive as an obviously malformed
      // label. Gate on registry membership rather than on the error text, so a
      // name rejected before the registry is even consulted — during shutdown,
      // say — still cannot become a label.
      const metricCommand = this.commandIsRegistered(command, message)
        ? command
        : METRIC_UNKNOWN_COMMAND_KEY;
      this.metrics.recordInvoke(
        metricCommand,
        requestBytes,
        Buffer.byteLength(responseBody),
        Math.max(0, Date.now() - startedAt),
        false,
      );
      serializedJsonResponse(response, 500, responseBody);
    }
  }

  private handleEvents(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }

    this.metrics.recordStreamConnecting();
    const compressionContext = responseCompressionContexts.get(response);
    const useGzip = compressionContext?.mode === "on"
      && negotiateEncoding(
        compressionContext.acceptEncoding,
        ["gzip", "identity"],
      ) === "gzip";
    const headers: OutgoingHttpHeaders = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    if (compressionContext?.mode === "on") {
      appendHeadersVary(headers, "Accept-Encoding");
    }
    if (useGzip) headers["content-encoding"] = "gzip";

    let client: DrainAwareEventClientWriter;
    try {
      response.writeHead(200, headers);
      client = useGzip
        ? new GzipEventClientWriter(response)
        : new IdentityEventClientWriter(response);
      if (useGzip) {
        // Prime the compressor independently so a quiet stream's connected
        // frame is emitted in a sync-flushed gzip block immediately instead of
        // waiting for the first application event.
        client.write(": compression-priming\n\n");
      }
    } catch (error) {
      // A handshake that never reaches `open` still has to release the gauge,
      // otherwise `connecting` climbs for the lifetime of the process.
      this.metrics.recordStreamConnectFailed();
      throw error;
    }
    const state: GatewayEventClient = {
      prefixes: parseEventSubscriptionFilter(url.searchParams.get("events")),
      includedPrefixes: parseEventSubscriptionFilter(
        url.searchParams.get("includeEvents"),
      ),
      excludedPrefixes: parseEventSubscriptionFilter(
        url.searchParams.get("excludeEvents"),
      ),
      desyncedSessions: new Set(),
      handshake: { events: [], bytes: 0 },
      tracksReplayCursor: false,
      sentRevision: 0,
      omittedRevision: null,
    };
    const explicitSince = url.searchParams.get("since")?.trim() ?? "";
    const lastEventIdHeader = Array.isArray(request.headers["last-event-id"])
      ? request.headers["last-event-id"][0]
      : request.headers["last-event-id"];
    const lastEventId = typeof lastEventIdHeader === "string" ? lastEventIdHeader.trim() : "";
    // A native EventSource reuses its original URL while advancing
    // Last-Event-ID on automatic retries. Prefer that newer browser-owned
    // cursor; direct-fetch clients still fall back to the explicit query.
    // Blank in either position means "no cursor", not a malformed one — a
    // client that always appends `since=` must not be forced to reconcile.
    const rawCursor = lastEventId || explicitSince || null;
    const isTerminalOnly = state.prefixes === null
      && state.includedPrefixes?.every((prefix) => prefix.startsWith(DROPPABLE_EVENT_PREFIX))
      && state.excludedPrefixes?.some((prefix) => DROPPABLE_EVENT_PREFIX.startsWith(prefix));
    // Subscribe before inspecting the ring. `emit()` buffers into this state
    // until replay drains, closing the replay/live race. Everything from here
    // until the handshake settles is guarded: a throw after the client is in the
    // map but before its `close` handler exists would leak both the client and
    // the `connecting` gauge for the lifetime of the process.
    this.clients.set(client, state);
    try {
      client.write(": connected\n\n");
      if (isTerminalOnly) {
        // Terminal streams use their own revisioned snapshot protocol. They are
        // deliberately absent from the authoritative gateway replay sequence.
        state.handshake = null;
      } else {
        state.tracksReplayCursor = true;
        this.initializeEventReplay(client, state, parseGatewayCursor(rawCursor));
      }
    } catch (error) {
      this.clients.delete(client);
      this.metrics.recordStreamConnectFailed();
      client.destroy();
      throw error;
    }
    this.metrics.recordStreamOpened();
    // A client only ever falls behind after a write was refused, so "drained"
    // is the earliest safe moment to tell it what it missed — waiting for the
    // next event would leave a quiet session desynced indefinitely.
    client.onDrain(() => {
      if (this.clients.get(client) !== state || state.desyncedSessions.size === 0) return;
      this.flushDesyncNotices(client, state);
    });

    // A keepalive is a write like any other, so it has to respect the same hard
    // limit. Otherwise a stream with no event traffic keeps a client that is
    // already hopelessly behind — and its buffer — alive indefinitely.
    this.keepalive ??= setInterval(() => {
      for (const [client, clientState] of [...this.clients]) {
        if (client.writableLength > SSE_CLIENT_HARD_BUFFER_BYTES) {
          this.dropBufferedClient(client, METRIC_KEEPALIVE_KEY, client.writableLength);
          continue;
        }
        // Before the comment, so a scoped stream that received nothing this
        // interval still leaves with a current cursor.
        this.flushOmittedCursor(client, clientState);
        if (!this.clients.has(client)) continue;
        this.metrics.recordKeepalive();
        client.write(": keepalive\n\n");
      }
    }, this.keepaliveMs);
    this.keepalive.unref?.();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.clients.delete(client);
      client.destroy();
      this.metrics.recordStreamClosed();
    };
    request.once("close", close);
    response.once("close", close);
  }

  private handleMetrics(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }
    const snapshot = this.metrics.snapshot();
    jsonResponse(response, 200, {
      ...snapshot,
      // Ring occupancy and eviction are otherwise invisible: a ring dropping
      // every gap looks exactly like one that never needed to retain anything.
      replay: { ...snapshot.replay, ring: this.eventReplay.getStats() },
    });
  }

  private async handleClientMetrics(
    request: IncomingMessage,
    response: ServerResponse,
    requestMetrics: GatewayRequestMetrics,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(request, MAX_CLIENT_METRICS_BODY_BYTES);
      body = parsed.body;
      requestMetrics.setRequestBytes(parsed.bytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        jsonResponse(response, 413, { error: error.message });
        return;
      }
      if (error instanceof InvalidRequestBodyError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      throw error;
    }

    this.metrics.recordClientBootReport(sanitizeClientBootReport(body, request.httpVersion || "1.1"));
    jsonResponse(response, 202, { ok: true });
  }

  private async handleLoopbackProxy(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const prefix = `${API_PREFIX}/proxy/loopback/`;
    const remaining = url.pathname.slice(prefix.length);
    const slashIndex = remaining.indexOf("/");
    const rawPort = slashIndex >= 0 ? remaining.slice(0, slashIndex) : remaining;
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      jsonResponse(response, 400, { error: "Invalid loopback proxy port" });
      return;
    }

    const restPath = slashIndex >= 0 ? remaining.slice(slashIndex) : "/";
    const targetPath = `${restPath}${url.search}`;
    await this.proxyToTarget(
      request,
      response,
      new URL(`http://127.0.0.1:${port}${targetPath}`),
      `${API_PREFIX}/proxy/loopback/${port}`,
      false,
      true,
    );
  }

  private async handleBrowserLoopbackProxy(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const prefix = `${API_PREFIX}/browser/loopback/`;
    const remaining = url.pathname.slice(prefix.length);
    const slashIndex = remaining.indexOf("/");
    const rawPort = slashIndex >= 0 ? remaining.slice(0, slashIndex) : remaining;
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      jsonResponse(response, 400, { error: "Invalid browser preview port" });
      return;
    }

    const restPath = slashIndex >= 0 ? remaining.slice(slashIndex) : "/";
    const targetPath = `${restPath}${url.search}`;
    await this.proxyToTarget(
      request,
      response,
      new URL(`http://127.0.0.1:${port}${targetPath}`),
      `${API_PREFIX}/browser/loopback/${port}`,
      true,
    );
  }

  private async proxyToTarget(
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    proxyPrefix?: string,
    browserPreview = false,
    stripOrigin = false,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      let activeProxyResponse: IncomingMessage | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        // Keep-alive sockets outlive individual requests; drop this
        // request's disconnect handler so they do not accumulate.
        request.socket.removeListener("close", cancelProxyForDisconnect);
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        if (!response.headersSent) {
          jsonResponse(response, 502, { error: error.message });
        } else {
          response.destroy(error);
        }
        finish();
      };
      const targetHeaders = sanitizeTargetRequestHeaders(request.headers, target, stripOrigin);
      // The gateway owns representation negotiation on the remote-facing hop.
      // Keeping the loopback hop decoded prevents double compression and lets
      // preview rewriting enforce its decoded-byte bound.
      targetHeaders["accept-encoding"] = "identity";
      const proxyRequest = http.request({
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: targetHeaders,
      }, (proxyResponse) => {
        activeProxyResponse = proxyResponse;
        const responseHeaders = sanitizeProxyResponseHeaders(proxyResponse.headers, target, proxyPrefix);
        const responseStatus = proxyResponse.statusCode ?? 502;
        const contentRange = headerValueToString(proxyResponse.headers["content-range"]);
        const transformableRepresentation = canTransformProxyRepresentation(
          request.method,
          responseStatus,
          contentRange,
        );
        const compressionContext = responseCompressionContexts.get(response);
        const upstreamContentEncoding = headerValueToString(proxyResponse.headers["content-encoding"]);
        const upstreamIsIdentity = normalizeContentEncoding(upstreamContentEncoding) === "identity";
        const contentType = headerValueToString(proxyResponse.headers["content-type"]);
        const cacheControl = headerValueToString(proxyResponse.headers["cache-control"]);
        const transformAllowed = !cacheControl
          ?.toLowerCase()
          .split(",")
          .some((directive) => directive.trim() === "no-transform");
        if (browserPreview) {
          delete responseHeaders["x-frame-options"];
          delete responseHeaders["content-security-policy"];
          delete responseHeaders["content-security-policy-report-only"];
          if (request.headers.origin === "null") {
            responseHeaders["access-control-allow-origin"] = "null";
            responseHeaders["access-control-allow-credentials"] = "true";
            appendHeadersVary(responseHeaders, "Origin");
          } else {
            responseHeaders["access-control-allow-origin"] = "*";
          }
        }

        const previewContentKind = browserPreview && proxyPrefix && transformableRepresentation
          ? browserPreviewContentKind(proxyResponse.headers["content-type"])
          : null;
        if (browserPreview && proxyPrefix && previewContentKind) {
          const decoder = browserPreviewContentDecoder(proxyResponse.headers["content-encoding"]);
          if (decoder === undefined) {
            proxyResponse.destroy();
            fail(new Error("Browser preview response used an unsupported content encoding"));
            return;
          }

          const contentLengthHeader = proxyResponse.headers["content-length"];
          const contentLengthValue = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader;
          const contentLength = Number.parseInt(contentLengthValue ?? "", 10);
          if (Number.isFinite(contentLength) && contentLength > MAX_BROWSER_PREVIEW_BODY_BYTES) {
            proxyResponse.destroy();
            fail(new Error(`Browser preview response exceeded ${MAX_BROWSER_PREVIEW_BODY_BYTES} bytes`));
            return;
          }

          const chunks: Buffer[] = [];
          let sourceBytes = 0;
          let decodedBytes = 0;
          let bodySettled = false;
          // Decoded preview bodies have no declared size to reserve up front, so
          // the aggregate ceiling is charged per chunk and returned once the
          // downstream response settles — the point at which both the chunk list
          // and the rewritten copy become unreachable.
          let acquiredPreviewBytes = 0;
          let previewBytesReleased = false;
          const releasePreviewBytes = () => {
            previewBytesReleased = true;
            // Zero the running total rather than guarding on the flag alone, so
            // a second call releases nothing and any byte charged between two
            // calls is still returned by the later one.
            const outstanding = acquiredPreviewBytes;
            acquiredPreviewBytes = 0;
            browserPreviewDecodeBudget.release(outstanding);
          };
          releaseReservationOnResponseSettled(response, releasePreviewBytes);
          const bodyStream: Readable = decoder ? proxyResponse.pipe(decoder) : proxyResponse;
          const abortBody = (error: Error) => {
            if (bodySettled) return;
            bodySettled = true;
            releasePreviewBytes();
            decoder?.destroy();
            proxyResponse.destroy();
            fail(error);
          };

          if (decoder) {
            proxyResponse.on("data", (chunk: Buffer | string) => {
              sourceBytes += Buffer.byteLength(chunk);
              if (sourceBytes > MAX_BROWSER_PREVIEW_BODY_BYTES) {
                abortBody(new Error(`Browser preview response exceeded ${MAX_BROWSER_PREVIEW_BODY_BYTES} bytes`));
              }
            });
            decoder.once("error", (error) => abortBody(error));
          }

          bodyStream.on("data", (chunk: Buffer | string) => {
            // A decoder can emit buffered output after the downstream response
            // has gone; charging the shared budget then would strand bytes that
            // nothing is left to release.
            if (bodySettled || previewBytesReleased) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (!canBufferBodyChunk(
              decodedBytes,
              chunks.length,
              buffer.byteLength,
              MAX_BROWSER_PREVIEW_BODY_BYTES,
            )) {
              abortBody(new Error(`Browser preview response exceeded ${MAX_BROWSER_PREVIEW_BODY_BYTES} decoded bytes`));
              return;
            }
            if (!browserPreviewDecodeBudget.tryAcquire(buffer.byteLength)) {
              abortBody(new Error(
                `Browser preview decoding exceeded the shared ${MAX_BROWSER_PREVIEW_DECODED_TOTAL_BYTES} byte budget`,
              ));
              return;
            }
            acquiredPreviewBytes += buffer.byteLength;
            decodedBytes += buffer.byteLength;
            chunks.push(buffer);
          });
          bodyStream.once("end", () => {
            if (bodySettled) return;
            const rewritten = Buffer.from(rewriteBrowserPreviewBody(
              Buffer.concat(chunks).toString("utf8"),
              proxyPrefix,
              target,
              previewContentKind,
            ));
            if (rewritten.byteLength > MAX_BROWSER_PREVIEW_BODY_BYTES) {
              bodySettled = true;
              releasePreviewBytes();
              decoder?.destroy();
              proxyResponse.destroy();
              fail(new Error(`Browser preview response exceeded ${MAX_BROWSER_PREVIEW_BODY_BYTES} rewritten bytes`));
              return;
            }
            bodySettled = true;
            delete responseHeaders["content-encoding"];
            stripTransformedRepresentationHeaders(responseHeaders);
            settleRewrittenProxyBodyResponse(
              response,
              proxyResponse.statusCode ?? 502,
              responseHeaders,
              prepareCompressedBody(
                rewritten,
                contentType,
                compressionContext,
              ),
              () => settled,
              finish,
              fail,
            );
          });
          proxyResponse.once("error", (error) => abortBody(error));
          proxyResponse.once("aborted", () => abortBody(new Error("Browser preview response was aborted")));
          return;
        }

        const isEventStream = contentType
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() === "text/event-stream";
        const contentLengthValue = headerValueToString(proxyResponse.headers["content-length"]);
        const contentLength = parseStrictContentLengthHeader(contentLengthValue);
        const canTransform = upstreamIsIdentity
          && transformAllowed
          && compressionContext?.mode !== undefined
          && compressionContext.mode !== "off";
        const canTransformBody = canTransform && transformableRepresentation;
        const bodylessMetadataCouldDescribeCodedBytes = canTransform
          && (request.method === "HEAD" || responseStatus === 304)
          && !isEventStream
          && isCompressibleContentType(contentType)
          && contentLength !== null
          && isDynamicCompressionSizeEligible(contentLength)
          && negotiateEncoding(compressionContext.acceptEncoding) !== "identity";
        if (bodylessMetadataCouldDescribeCodedBytes) {
          // Nothing is transformed here, so the response keeps the metadata that
          // describes the identity representation its retained Content-Length
          // already describes — including `ETag`, which RFC 9110 requires a 304
          // to carry, and `Accept-Ranges`, because ranged GETs are passed
          // through untransformed (see canTransformProxyRepresentation). Only
          // the content-coded digests are dropped: a corresponding GET may
          // select a coded representation those values cannot describe.
          stripCodedContentHeaders(responseHeaders);
        }

        if (canTransformBody && isEventStream && compressionContext.mode === "on") {
          appendHeadersVary(responseHeaders, "Accept-Encoding");
          if (
            negotiateEncoding(
              compressionContext.acceptEncoding,
              ["gzip", "identity"],
            ) === "gzip"
          ) {
            delete responseHeaders["content-length"];
            stripTransformedRepresentationHeaders(responseHeaders);
            responseHeaders["content-encoding"] = "gzip";
            response.writeHead(responseStatus, responseHeaders);
            const compressor = createGzip({
              level: DYNAMIC_GZIP_LEVEL,
              flush: zlibConstants.Z_SYNC_FLUSH,
              finishFlush: zlibConstants.Z_SYNC_FLUSH,
              chunkSize: SSE_COMPRESSION_CHUNK_BYTES,
            });
            const destroyCompressor = () => compressor.destroy();
            response.once("close", destroyCompressor);
            pipeline(proxyResponse, compressor, response, (error) => {
              response.removeListener("close", destroyCompressor);
              if (error) {
                proxyRequest.destroy(error);
                fail(error);
                return;
              }
              finish();
            });
            return;
          }
        }

        const shouldBufferBody = canTransformBody
          && !isEventStream
          && isCompressibleContentType(contentType)
          && contentLength !== null
          && isDynamicCompressionSizeEligible(contentLength);

        if (canTransform && !isEventStream && isCompressibleContentType(contentType)) {
          appendHeadersVary(responseHeaders, "Accept-Encoding");
        }

        const releaseBufferReservation = shouldBufferBody
          ? dynamicProxyCompressionBufferBudget.tryReserve(contentLength!)
          : null;
        if (releaseBufferReservation) {
          // The declared length is validated before admission, and the aggregate
          // budget is reserved before allocating. A single contiguous source
          // buffer avoids retaining a chunk list and then duplicating it with
          // Buffer.concat while the codec is running.
          const sourceBuffer = allocateBufferedProxySource(contentLength!);
          if (!sourceBuffer) {
            releaseBufferReservation();
            proxyResponse.destroy();
            fail(new Error(`Could not allocate ${contentLength!} bytes for the proxied response`));
            return;
          }
          let bytes = 0;
          let bodySettled = false;
          let reservationReleased = false;
          let reservationOwnedByResponse = false;
          let idleTimer: ReturnType<typeof setTimeout> | null = null;
          const clearIdleTimer = () => {
            if (!idleTimer) return;
            clearTimeout(idleTimer);
            idleTimer = null;
          };
          const releaseReservation = () => {
            if (reservationReleased) return;
            reservationReleased = true;
            releaseBufferReservation();
          };
          const releaseWhileBuffering = () => {
            if (bodySettled) return;
            bodySettled = true;
            clearIdleTimer();
            releaseReservation();
          };
          response.once("close", releaseWhileBuffering);
          const abortBody = (error: Error) => {
            if (bodySettled) return;
            bodySettled = true;
            clearIdleTimer();
            response.removeListener("close", releaseWhileBuffering);
            releaseReservation();
            proxyResponse.destroy();
            fail(error);
          };
          // Reset on every chunk: a slow upstream is fine, a silent one is not.
          // Without this the reservation would be held until the downstream
          // client gave up, starving every other proxied response of a slot.
          const idleTimeoutMs = this.proxyBodyIdleTimeoutMs;
          const armIdleTimer = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => {
              idleTimer = null;
              abortBody(new Error(`Proxied response stalled for ${idleTimeoutMs} ms`));
            }, idleTimeoutMs);
            idleTimer.unref?.();
          };
          armIdleTimer();
          proxyResponse.on("data", (chunk: Buffer | string) => {
            if (bodySettled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (!canAppendToProxySourceBuffer(bytes, buffer.byteLength, sourceBuffer.byteLength)) {
              abortBody(new Error(
                `Proxied response exceeded its declared ${sourceBuffer.byteLength} bytes`,
              ));
              return;
            }
            buffer.copy(sourceBuffer, bytes);
            bytes += buffer.byteLength;
            armIdleTimer();
          });
          proxyResponse.once("end", () => {
            if (bodySettled) return;
            bodySettled = true;
            clearIdleTimer();
            response.removeListener("close", releaseWhileBuffering);
            if (shouldAbandonBufferedProxyBody(reservationReleased, settled, response.destroyed)) {
              releaseReservation();
              // Nothing downstream is left to write to, so resolve the proxy
              // promise here rather than depending on a close event that may
              // already have been consumed.
              finish();
              return;
            }
            const source = sourceBuffer.subarray(0, bytes);
            void prepareCompressedBody(
              source,
              contentType,
              compressionContext,
              upstreamContentEncoding,
            ).then((prepared) => {
              if (settled || response.destroyed) {
                // The client left while the codec ran. The upstream has already
                // ended, so settle here instead of waiting on a close event.
                finish();
                return;
              }
              responseHeaders["content-length"] = prepared.body.byteLength;
              if (prepared.encoding === "identity") {
                delete responseHeaders["content-encoding"];
              } else {
                responseHeaders["content-encoding"] = prepared.encoding;
                stripTransformedRepresentationHeaders(responseHeaders);
              }
              reservationOwnedByResponse = true;
              releaseReservationOnResponseSettled(response, releaseReservation);
              response.writeHead(responseStatus, responseHeaders);
              response.end(prepared.body);
              finish();
            }).catch((error: unknown) => {
              fail(error instanceof Error ? error : new Error(String(error)));
            }).finally(() => {
              if (!reservationOwnedByResponse) releaseReservation();
            });
          });
          proxyResponse.once("error", (error) => abortBody(error));
          proxyResponse.once("aborted", () => abortBody(new Error("Proxied response was aborted")));
          return;
        }

        response.writeHead(responseStatus, responseHeaders);
        pipeline(proxyResponse, response, (error) => {
          if (error) {
            proxyRequest.destroy(error);
            fail(error);
            return;
          }
          finish();
        });
      });
      this.proxyRequests.add(proxyRequest);
      proxyRequest.once("close", () => {
        this.proxyRequests.delete(proxyRequest);
      });

      proxyRequest.once("error", fail);

      const cancelProxyForDisconnect = () => {
        if (!settled && !response.writableFinished) {
          const disconnectError = new Error("Proxy client disconnected");
          this.logger.debug("[RemoteGateway] Proxy client disconnected; aborting upstream request");
          // Settle first: destroying the response re-enters this handler via
          // its own "close" event, and a throwing destroy must not leave the
          // proxy promise dangling.
          finish();
          activeProxyResponse?.socket.destroy(disconnectError);
          activeProxyResponse?.destroy(disconnectError);
          proxyRequest.socket?.destroy(disconnectError);
          proxyRequest.destroy(disconnectError);
          response.destroy(disconnectError);
        }
      };
      // "close" fires for premature client disconnects as well as normal
      // completion; the settled/writableFinished guard makes the latter a
      // no-op. The socket listener is required (response "close" alone is not
      // reliably emitted on abrupt disconnects) and is removed in finish().
      request.socket.once("close", cancelProxyForDisconnect);
      response.once("close", cancelProxyForDisconnect);

      // Piping an already-ended request stream suppresses client-socket
      // close events under Bun, which would leave disconnected proxy
      // requests streaming forever; only pipe when a body can exist.
      const hasRequestBody = request.headers["content-length"] !== undefined
        || request.headers["transfer-encoding"] !== undefined;
      if (hasRequestBody) {
        request.pipe(proxyRequest);
      } else {
        proxyRequest.end();
      }
    });
  }

  private async serveStatic(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    allowCompression: boolean,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }

    if (this.rendererDevServerUrl) {
      const target = new URL(this.rendererDevServerUrl);
      target.pathname = url.pathname;
      target.search = url.search;
      await this.proxyToTarget(request, response, target);
      return;
    }

    const root = path.resolve(this.rendererRoot);
    const decodedPath = decodeURIComponent(url.pathname);
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    let filePath = path.resolve(root, relativePath);

    if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
      textResponse(response, 403, "Forbidden");
      return;
    }

    let fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || fileStat.isDirectory()) {
      if (path.extname(relativePath)) {
        textResponse(response, 404, "Not found");
        return;
      }
      filePath = path.join(root, "index.html");
      fileStat = await stat(filePath).catch(() => null);
    }

    if (!fileStat?.isFile()) {
      textResponse(response, 404, "Renderer build not found");
      return;
    }

    const contentType = mimeType(filePath);
    const lastModified = httpDateFromMtimeMs(fileStat.mtimeMs);
    const cacheControl = isImmutableHashedAsset(url.pathname, filePath)
      ? IMMUTABLE_ASSET_CACHE_CONTROL
      : REVALIDATED_DOCUMENT_CACHE_CONTROL;
    const acceptEncoding = headerValueToString(request.headers["accept-encoding"]);
    const preferredEncodings = allowCompression && isCompressibleStaticContentType(contentType)
      ? preferredStaticCompressionEncodings(acceptEncoding)
      : [];
    const identityQuality = allowCompression
      ? staticEncodingQuality(acceptEncoding, "identity")
      : 1;
    let selectedEncoding: StaticContentEncoding = "identity";
    let bodyPath = filePath;
    let bodyLength = fileStat.size;
    let bodyBuffer: Buffer | null = null;
    let omitContentLength = false;
    let variantMtimeMs = fileStat.mtimeMs;
    let variantSize = fileStat.size;

    for (const encoding of preferredEncodings) {
      const siblingPath = compressedStaticSiblingPath(filePath, encoding);
      const siblingStat = await stat(siblingPath).catch(() => null);
      if (
        siblingStat?.isFile()
        && siblingStat.mtimeMs >= fileStat.mtimeMs
        && siblingStat.size < fileStat.size
      ) {
        selectedEncoding = encoding;
        bodyPath = siblingPath;
        bodyLength = siblingStat.size;
        variantMtimeMs = siblingStat.mtimeMs;
        variantSize = siblingStat.size;
        break;
      }
    }

    if (selectedEncoding === "identity" && request.method !== "HEAD") {
      const outcome = await compressStaticFileWithinLimits(
        filePath,
        fileStat.mtimeMs,
        fileStat.size,
        preferredEncodings,
        identityQuality <= 0,
      );
      if (outcome.status === "compressed") {
        selectedEncoding = outcome.encoding;
        bodyLength = outcome.buffer.byteLength;
        bodyBuffer = outcome.buffer;
      }
    }

    if (
      selectedEncoding === "identity"
      && request.method === "HEAD"
      && identityQuality <= 0
      && preferredEncodings[0]
      && fileStat.size <= MAX_STATIC_FALLBACK_SOURCE_BYTES
    ) {
      // Identity is forbidden, so GET necessarily answers with a coded form and
      // its encoding is known without generating the body. The coded length is
      // not, and HEAD must not pay that CPU/memory cost to learn it, so the one
      // field HTTP lets a HEAD omit is omitted. When identity *is* acceptable
      // the identity metadata below is already accurate for HEAD, so nothing is
      // withheld and the response stays usable for revalidation and sizing.
      selectedEncoding = preferredEncodings[0];
      omitContentLength = true;
    }

    if (selectedEncoding === "identity" && identityQuality <= 0) {
      if (preferredEncodings.length === 0) {
        response.writeHead(406, {
          "cache-control": "no-store",
          vary: "Accept-Encoding",
        });
        response.end();
        return;
      }
      // A coded representation was both acceptable and requested, but this
      // server declined to produce one (source over the fallback cap, the
      // compression pool saturated, or a codec failure). RFC 9110 §12.5.3
      // permits sending an unacceptable identity representation instead. A 406
      // here would claim the asset can never be represented acceptably, which
      // is false, and would make the status depend on unrelated load.
    }

    const headers: OutgoingHttpHeaders = {
      "cache-control": cacheControl,
      "content-type": contentType,
      "last-modified": lastModified,
      etag: etagForStaticVariant(
        fileStat.mtimeMs,
        fileStat.size,
        selectedEncoding,
        variantMtimeMs,
        variantSize,
      ),
    };
    if (!omitContentLength) headers["content-length"] = bodyLength;
    appendHeadersVary(headers, "Accept-Encoding");
    if (selectedEncoding !== "identity") {
      headers["content-encoding"] = selectedEncoding;
    }

    if (ifNoneMatchMatches(request.headers["if-none-match"], String(headers.etag))) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    if (
      request.headers["if-none-match"] === undefined
      && ifModifiedSinceMatches(request.headers["if-modified-since"], fileStat.mtimeMs)
    ) {
      response.writeHead(304, headers);
      response.end();
      return;
    }

    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      if (omitContentLength) response.flushHeaders();
      response.end();
      return;
    }
    if (bodyBuffer) {
      response.end(bodyBuffer);
      return;
    }
    const bodyStream = createReadStream(bodyPath);
    bodyStream.on("error", () => {
      // The framing was committed by writeHead above, so a read failure here
      // cannot be turned into an error status. Destroying the socket makes the
      // truncation visible to the client rather than letting it cache a short
      // body as a complete, immutable asset.
      bodyStream.destroy();
      response.destroy();
    });
    // pipe() only unpipes on client abort; it leaves the descriptor open until
    // GC. Close it eagerly so an aborting client cannot exhaust the table.
    response.on("close", () => bodyStream.destroy());
    bodyStream.pipe(response);
  }
}
