import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Transform } from "node:stream";
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
  getGatewayTokenValidationError,
  normalizeGatewayToken,
} from "@orkestrator/protocol/gateway-token";

export type BackendInvoker = {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown> | unknown;
  /**
   * Whether `command` is in the registry. Metric labels are gated on this so a
   * rejected, network-supplied name can never be retained — testing the error
   * message instead would leak any name rejected for some other reason first,
   * such as during shutdown.
   */
  hasCommand?(command: string): boolean;
};

export type NetworkInterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;
export type ListenerKind = "control" | "browser";
export type GatewayRouteKey =
  | "login"
  | "agent-test-bootstrap"
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
  /** Fail on an occupied requested browser port instead of attaching nearby. */
  strictPort?: boolean;
  /** Enables the loopback-only, single-use browser bootstrap used by agent tests. */
  agentTestMode?: boolean;
  /**
   * Development profile name, shown on the agent-test login page so an agent
   * that lands there can mint its own link instead of hunting for the token.
   */
  agentTestProfile?: string;
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

export const AUTH_COOKIE = "orkestrator_gateway_auth";
export const API_PREFIX = "/__orkestrator";
/**
 * Lifetime of a minted bootstrap code. It is generous enough that a slow agent
 * can mint a link, decide what to do, and open it, and short enough that a code
 * captured from a tool transcript is dead before anyone could reuse it. The
 * code is single-use regardless, so this only bounds the unused window.
 */
export const AGENT_TEST_BOOTSTRAP_TTL_MS = 120_000;
/**
 * Idle timeout for an exchanged agent-test browser session. Explicit keyboard
 * or pointer activity renews it; background API polling does not.
 */
export const AGENT_TEST_SESSION_IDLE_TTL_MS = 30 * 60_000;
/** Hard ceiling on a session regardless of activity. */
export const AGENT_TEST_SESSION_MAX_LIFETIME_MS = 12 * 60 * 60_000;
export const MAX_AGENT_TEST_BOOTSTRAPS = 16;
export const MAX_AGENT_TEST_SESSIONS = 32;
export const DEFAULT_GATEWAY_PORT = 34121;
export const GATEWAY_PORT_FALLBACK_ATTEMPTS = 20;
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
export const MAX_BROWSER_PREVIEW_BODY_BYTES = 8 * 1024 * 1024;
/**
 * Command bodies carry durable snapshots — prompt queues, build pipelines and
 * agent handoffs — whose storage limit is 32 MB each. Every renderer command
 * travels this route, in local desktop mode too, so a cap below the storage
 * limit would make those limits unreachable and turn a legitimately large save
 * into an opaque transport failure. `readRequestBody` discards bytes past the
 * cap rather than buffering them, so a larger ceiling costs nothing until a
 * request actually approaches it.
 */
export const MAX_INVOKE_BODY_BYTES = 48 * 1024 * 1024;
export const KEEPALIVE_MS = 25_000;
export const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const REVALIDATED_DOCUMENT_CACHE_CONTROL = "no-cache";
export const STATIC_FALLBACK_BROTLI_QUALITY = 4;
export const STATIC_FALLBACK_GZIP_LEVEL = 6;
export const DYNAMIC_BROTLI_QUALITY = 4;
export const DYNAMIC_GZIP_LEVEL = 6;
export const COMPRESSION_MIN_BYTES = 1024;
export const MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES = 48 * 1024 * 1024;
export const MAX_DYNAMIC_COMPRESSION_OUTPUT_OVERHEAD_BYTES = 64 * 1024;
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
export const SSE_COMPRESSION_CHUNK_BYTES = 64 * 1024;
export const MAX_STATIC_FALLBACK_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_STATIC_FALLBACK_OUTPUT_BYTES = MAX_STATIC_FALLBACK_SOURCE_BYTES + 64 * 1024;
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
export const DROPPABLE_EVENT_PREFIX = "terminal-output-";
/**
 * Above this many buffered bytes a client is too far behind to keep receiving
 * terminal output. Node buffers everything `write()` cannot flush, so without
 * this a laptop terminal flooding output would grow backend heap for as long as
 * a slow remote browser stayed connected.
 */
export const SSE_CLIENT_SOFT_BUFFER_BYTES = 1024 * 1024;
/**
 * Above this a client is hopeless even for authoritative events. The connection
 * is destroyed rather than dropping them: on reconnect the renderer receives
 * `native-event-stream-connected` and refetches, which is correct, whereas a
 * silently skipped state event is not.
 */
export const SSE_CLIENT_HARD_BUFFER_BYTES = 8 * 1024 * 1024;
/** Bounds events that arrive after subscription but before replay has drained. */
export const DEFAULT_GATEWAY_REPLAY_HANDSHAKE_FRAME_CAPACITY = 2_048;
export const DEFAULT_GATEWAY_REPLAY_HANDSHAKE_MAX_BYTES = 8 * 1024 * 1024;
export const GATEWAY_CONNECTED_EVENT = "gateway.connected";
export const GATEWAY_RECONCILE_REQUIRED_EVENT = "gateway.reconcile-required";
export const GATEWAY_CURSOR_EVENT = "gateway.cursor";
export const CORS_ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
export const CORS_ALLOWED_HEADERS =
  "Authorization, Content-Type, X-Orkestrator-Codex-Token, X-Orkestrator-Claude-Token, X-Orkestrator-OpenCode-Token, X-Orkestrator-Acp-Token";
export const GATEWAY_METRIC_MAP_LIMIT = 128;
export const GATEWAY_METRIC_LABEL_BYTES = 96;
export const GATEWAY_METRIC_TOTAL_LABEL_BYTES = 8 * 1024;
/**
 * Command labels are an allowlist, not free text: anything the backend registry
 * rejects is recorded as `__unknown__`, so the only labels that can ever reach
 * this map are registered command names. The budget therefore has to clear the
 * whole registry — a limit below it silently folds legitimate commands into
 * `__overflow__` in invocation order, which makes the per-command byte and
 * timing breakdown both incomplete and different on every run.
 * `tests/unit/electron/gateway-support-extra.test.ts` pins these against the real registry.
 */
export const GATEWAY_COMMAND_METRIC_MAP_LIMIT = 512;
export const GATEWAY_COMMAND_METRIC_TOTAL_LABEL_BYTES = 32 * 1024;
export const GATEWAY_METRIC_SAMPLE_LIMIT = 32;
export const MAX_CLIENT_METRICS_BODY_BYTES = 64 * 1024;
export const METRIC_OVERFLOW_KEY = "__overflow__";
export const METRIC_INVALID_KEY = "__invalid__";
export const METRIC_UNKNOWN_COMMAND_KEY = "__unknown__";
/**
 * Keepalive writes are not an event, but a client dropped while flushing one
 * still needs attributing somewhere. A reserved label keeps that out of the
 * bucket for a real event that happens to be named `events`.
 */
export const METRIC_KEEPALIVE_KEY = "__keepalive__";
export const METRIC_RESERVED_KEYS: readonly string[] = [
  METRIC_OVERFLOW_KEY,
  METRIC_INVALID_KEY,
  METRIC_UNKNOWN_COMMAND_KEY,
  METRIC_KEEPALIVE_KEY,
];

export class InvalidRequestBodyError extends Error {}
export class RequestBodyTooLargeError extends Error {}

export type StaticCompressionEncoding = "gzip" | "br";
export type StaticContentEncoding = "identity" | StaticCompressionEncoding;
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
export type StaticCompressionOutcome =
  | { status: "compressed"; encoding: StaticCompressionEncoding; buffer: Buffer }
  | { status: "not-beneficial" }
  | { status: "declined" };

export type GatewayRouteMetrics = {
  requests: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  statusCodes: Record<string, number>;
  encodings: Record<string, number>;
};

export type GatewayCommandMetrics = {
  count: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  failures: number;
};

export type GatewayEventMetrics = {
  frames: number;
  wireBytes: number;
  droppedFrames: number;
  droppedClients: number;
};

export type GatewayStreamMetrics = {
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
export type GatewayReplayMetrics = {
  fresh: number;
  caughtUp: number;
  replayed: number;
  replayedFrames: number;
  reconciled: number;
  reasons: Record<GatewayReconcileReason, number>;
};

export type GatewayCompressionMetrics = {
  configuredMode: GatewayCompressionMode;
};

export type GatewayClientBootReport = {
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

export type GatewayRouteSample = {
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

export function isGatewayCompressionMode(value: string): value is GatewayCompressionMode {
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

export function appendBoundedSample<T>(target: T[], sample: T, limit = GATEWAY_METRIC_SAMPLE_LIMIT): void {
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

export function normalizeStatusMetricKey(statusCode: number): string {
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? String(statusCode)
    : "other";
}

export function numberOrNull(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : null;
}

export function stringOrNull(value: unknown, maxBytes = 64): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? truncateUtf8(trimmed, maxBytes) : null;
}

export function headerValueToString(value: number | string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return String(value);
  return null;
}

export function parseContentLengthHeader(value: string | string[] | undefined): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(candidate ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function measureChunkBytes(
  chunk: string | Uint8Array | Buffer | undefined,
  encoding?: BufferEncoding | ((error?: Error | null) => void),
): number {
  if (chunk === undefined) return 0;
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined);
  }
  return chunk.byteLength;
}

export function classifyGatewayRoute(pathname: string): GatewayRouteKey {
  if (pathname === `${API_PREFIX}/login`) return "login";
  // Covers minting, the POST exchange, and the one-shot login link: all three
  // are the same bootstrap credential, and none may be served as static.
  if (pathname.startsWith(`${API_PREFIX}/agent-test/`)) return "agent-test-bootstrap";
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
export const PER_ENTITY_EVENT_PREFIXES: readonly [prefix: string, label: string][] = [
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

export function sanitizeClientBootReport(
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

export type GatewayRequestMetrics = ReturnType<GatewayMetricsStore["beginRequest"]>;

export function instrumentGatewayResponse(
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

export function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid gateway port: ${value}`);
  }
  return port;
}

export function isAddressInUseError(error: unknown): boolean {
  return error instanceof Error
    && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

export function parseIPv4(address: string): number[] | null {
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

export function formatHostForUrl(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

export function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function originMatchesRule(origin: URL, rule: string): boolean {
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

export function mimeType(filePath: string): string {
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

export const brotliCompressAsync = promisify(brotliCompress);
export const gzipAsync = promisify(gzip);

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

export function appendResponseVary(response: ServerResponse, value: string): void {
  response.setHeader("vary", appendVary(headerValueToString(response.getHeader("vary")), value));
}

export function appendHeadersVary(headers: OutgoingHttpHeaders, value: string): void {
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

export function isCompressibleStaticContentType(contentType: string): boolean {
  return isCompressibleContentType(contentType);
}

export function isImmutableHashedAsset(pathname: string, filePath: string): boolean {
  return pathname.startsWith("/assets/")
    && /-[A-Za-z0-9_-]{8,}\./.test(path.basename(filePath));
}

export function httpDateFromMtimeMs(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs / 1000) * 1000).toUTCString();
}

export function etagForStaticVariant(
  sourceMtimeMs: number,
  sourceSize: number,
  encoding: StaticContentEncoding,
  variantMtimeMs = sourceMtimeMs,
  variantSize = sourceSize,
): string {
  return `W/"${Math.floor(sourceMtimeMs).toString(16)}-${sourceSize.toString(16)}-${encoding}-${Math.floor(variantMtimeMs).toString(16)}-${variantSize.toString(16)}"`;
}

export function staticEncodingQuality(
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

export function preferredStaticCompressionEncodings(
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

export function compressedStaticSiblingPath(
  filePath: string,
  encoding: StaticCompressionEncoding,
): string {
  return `${filePath}.${encoding === "br" ? "br" : "gz"}`;
}

export function ifNoneMatchMatches(
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

export function weakEntityTagValue(value: string): string | null {
  const candidate = value.startsWith("W/") ? value.slice(2) : value;
  if (candidate.length < 2 || candidate[0] !== "\"" || candidate.at(-1) !== "\"") {
    return null;
  }
  return candidate;
}

export function ifModifiedSinceMatches(header: string | string[] | undefined, mtimeMs: number): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Math.floor(mtimeMs / 1000) * 1000 <= parsed;
}

export async function compressStaticBuffer(
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

export let activeDynamicCompressions = 0;

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

export const dynamicProxyCompressionBufferBudget = new DynamicCompressionBufferBudget();

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

export const browserPreviewDecodeBudget = new AggregateByteBudget(MAX_BROWSER_PREVIEW_DECODED_TOTAL_BYTES);

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

export const staticFallbackCompressions = new Map<string, Promise<StaticCompressionOutcome>>();

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

export const responseCompressionContexts = new WeakMap<ServerResponse, ResponseCompressionContext>();

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

export function writePreparedBody(
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

export function bodyResponse(
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

export function jsonResponse(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  serializedJsonResponse(response, statusCode, JSON.stringify(payload), headers);
}

export function serializedJsonResponse(
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

export function textResponse(response: ServerResponse, statusCode: number, text: string, contentType = "text/plain; charset=utf-8"): void {
  bodyResponse(response, statusCode, text, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
}


export type GatewayReconcileReason =
  | "invalid-cursor"
  | "prior-generation"
  | "cursor-expired"
  | "cursor-ahead"
  | "replay-too-large";

export {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  networkInterfaces,
  path,
  randomBytes,
  timingSafeEqual,
  promisify,
  brotliCompress,
  zlibConstants,
  createBrotliDecompress,
  createGzip,
  createUnzip,
  gzip,
  GatewayTokenValidationError,
  getGatewayTokenValidationError,
  normalizeGatewayToken,
};

export type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
  NetworkInterfaceInfo,
  Transform,
  GatewayTokenSettings,
  WebClientStatus,
};
