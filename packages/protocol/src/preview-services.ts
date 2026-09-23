/**
 * Backend-owned preview service contract.
 *
 * A preview service is a stable identity for one application listening in an
 * environment: "environment A / web / container port 3000". It is deliberately
 * not a URL and not a host port. Host bindings, local listener ports, grants and
 * attachment secrets are runtime-only and never appear in a definition, a
 * durable tab, or a broad event.
 *
 * The backend registry is authoritative. Clients cache snapshots keyed by
 * `(backendInstanceId, backendEpoch, registryRevision)` and treat the
 * `preview-services-changed` event as a compact invalidation, never as state.
 */

/** Bumped when a wire shape in this module changes incompatibly. */
export const PREVIEW_PROTOCOL_VERSION = 1;
/** Schema version stamped on every persisted definition. */
export const PREVIEW_DEFINITION_SCHEMA_VERSION = 1;

/** Compact invalidation. Payload is {@link PreviewServicesChangedEvent}. */
export const PREVIEW_SERVICES_CHANGED_EVENT = "preview-services-changed";

/**
 * Conservative starting budgets from the implementation plan (step 02). They
 * are admission limits for the preview feature only; they do not change any
 * unrelated gateway, command-body, or agent transport limit.
 */
export const PREVIEW_LIMITS = {
  definitionsPerEnvironment: 32,
  definitionsPerBackend: 1_024,
  snapshotMaxBytes: 2 * 1024 * 1024,
  labelMaxBytes: 120,
  identifierMaxBytes: 128,
  navigationMaxBytes: 8_192,
  grantTtlMs: 60_000,
  grantsPendingPerClientService: 8,
  grantsPendingPerBackend: 256,
  sessionIdleMs: 30 * 60_000,
  sessionAbsoluteMs: 8 * 60 * 60_000,
  httpActivePerService: 32,
  httpActivePerBackend: 128,
  headerMaxBytes: 32 * 1024,
  headerMaxFields: 100,
  upgradesPerService: 8,
  upgradesPerBackend: 128,
  /**
   * Desktop tunnel connections carry HTTP/1.1 keep-alive connections as well as
   * application sockets. Chromium opens up to six HTTP/1.1 connections per
   * origin, so the tunnel budget is separate from (and larger than) the
   * published-origin upgrade budget. Each tunnel is exactly one resource.
   */
  tunnelsPerService: 16,
  tunnelsPerBackend: 128,
  tunnelHandshakesPending: 32,
  tunnelFrameMaxBytes: 32 * 1024,
  tunnelQueueMaxBytesPerDirection: 256 * 1024,
  tunnelQueueMaxBytesAggregate: 64 * 1024 * 1024,
  controlFrameMaxBytes: 8 * 1024,
  controlFramesPendingPerConnection: 32,
  connectTimeoutMs: 10_000,
  responseHeadersTimeoutMs: 30_000,
  bodyIdleTimeoutMs: 60_000,
  cleanupGraceMs: 5_000,
  uploadMaxBytes: 128 * 1024 * 1024,
  downloadMaxBytes: 512 * 1024 * 1024,
  rewriteBodyMaxBytes: 8 * 1024 * 1024,
  rewriteChunksMax: 8_192,
  rewriteAggregateMaxBytes: 64 * 1024 * 1024,
  probeConcurrency: 4,
  probeQueueMax: 64,
  attachmentsPerService: 16,
  attachmentsPerBackend: 256,
  mutationOperationRetention: 256,
  tombstoneRetention: 256,
} as const;

export type PreviewLimits = { readonly [K in keyof typeof PREVIEW_LIMITS]: number };

/**
 * Validated ceilings an operator may raise a budget to. A configured value
 * outside `[1, ceiling]` is rejected rather than silently clamped, so an
 * override typo cannot quietly remove a bound.
 */
export const PREVIEW_LIMIT_CEILINGS: PreviewLimits = {
  ...PREVIEW_LIMITS,
  definitionsPerEnvironment: 128,
  definitionsPerBackend: 4_096,
  httpActivePerService: 256,
  httpActivePerBackend: 1_024,
  upgradesPerService: 64,
  upgradesPerBackend: 1_024,
  tunnelsPerService: 64,
  tunnelsPerBackend: 1_024,
  uploadMaxBytes: 1024 * 1024 * 1024,
  downloadMaxBytes: 8 * 1024 * 1024 * 1024,
  sessionAbsoluteMs: 24 * 60 * 60_000,
};

/** Apply validated overrides; throws on unknown keys or out-of-range values. */
export function resolvePreviewLimits(overrides: Record<string, unknown> = {}): PreviewLimits {
  const limits: Record<string, number> = { ...PREVIEW_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in PREVIEW_LIMITS)) throw new Error(`Unknown preview limit: ${key}`);
    const ceiling = PREVIEW_LIMIT_CEILINGS[key as keyof PreviewLimits];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new Error(`Preview limit ${key} must be an integer between 1 and ${ceiling}`);
    }
    limits[key] = value;
  }
  return limits as PreviewLimits;
}

// ---------------------------------------------------------------------------
// Definitions

/**
 * - `container`: an application port inside an owned Docker container, reached
 *   through its published host binding (or the optional relay).
 * - `worktree`: a loopback listener on the backend machine associated with a
 *   local worktree environment.
 * - `backend-host`: an explicitly registered backend loopback port. The
 *   association with an environment is a user statement, not proof of
 *   ownership, and is labelled as such in diagnostics.
 */
export const PREVIEW_TARGET_KINDS = ["container", "worktree", "backend-host"] as const;
export type PreviewTargetKind = (typeof PREVIEW_TARGET_KINDS)[number];

export const PREVIEW_SCHEMES = ["http", "https"] as const;
export type PreviewScheme = (typeof PREVIEW_SCHEMES)[number];

/** Loopback address family for backend-local targets. */
export const PREVIEW_ADDRESS_FAMILIES = ["ipv4", "ipv6", "auto"] as const;
export type PreviewAddressFamily = (typeof PREVIEW_ADDRESS_FAMILIES)[number];

/**
 * Where a definition came from. Generated definitions carry a deterministic
 * `provenanceKey` so repeated seeding updates rather than duplicates them; a
 * user edit to a generated definition flips `userOverride` and seeding then
 * leaves the edited fields alone.
 */
export const PREVIEW_PROVENANCE_KINDS = ["entry-port", "port-mapping", "user"] as const;
export type PreviewProvenanceKind = (typeof PREVIEW_PROVENANCE_KINDS)[number];

export interface PreviewServiceDefinition {
  schemaVersion: typeof PREVIEW_DEFINITION_SCHEMA_VERSION;
  /** Backend-issued opaque identity. Never a port, URL or credential. */
  serviceId: string;
  environmentId: string;
  label: string;
  targetKind: PreviewTargetKind;
  /** The port the application itself listens on (container port for containers). */
  applicationPort: number;
  scheme: PreviewScheme;
  /** Backend-loopback targets only. Containers resolve the family from Docker. */
  addressFamily: PreviewAddressFamily;
  /** HTTPS targets: the name the certificate must be valid for. */
  tlsServerName?: string;
  /** Safe, app-relative path used for HTTP readiness observation. TCP-only when absent. */
  readinessPath?: string;
  provenance: PreviewProvenanceKind;
  provenanceKey?: string;
  userOverride: boolean;
  /** The environment's primary service, opened by the environment browser button. */
  entry: boolean;
  enabled: boolean;
  /** Monotonic per definition; compare-and-set updates must quote it. */
  definitionRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** Mutable configuration accepted by register/update. */
export interface PreviewServiceInput {
  environmentId: string;
  label: string;
  targetKind: PreviewTargetKind;
  applicationPort: number;
  scheme?: PreviewScheme;
  addressFamily?: PreviewAddressFamily;
  tlsServerName?: string;
  readinessPath?: string;
  entry?: boolean;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Runtime

export const PREVIEW_ENDPOINT_STATES = [
  "unresolved",
  "resolving",
  "available",
  "unavailable",
  "revoked",
] as const;
export type PreviewEndpointState = (typeof PREVIEW_ENDPOINT_STATES)[number];

export const PREVIEW_TRANSPORT_KINDS = [
  "published-port",
  "backend-loopback",
  "container-relay",
] as const;
export type PreviewTransportKind = (typeof PREVIEW_TRANSPORT_KINDS)[number];

export type PreviewLayerState = "unknown" | "pending" | "ok" | "failed" | "skipped";

export interface PreviewReadinessLayer {
  state: PreviewLayerState;
  /** Safe failure category when `state === "failed"`. */
  failure?: PreviewErrorCategory;
}

/**
 * Readiness in independent layers. A 401/403/404 is a *reachable* HTTP
 * response (`http.state === "ok"` with its status class), never "server down".
 * This is deliberately separate from the native view's page `loading` flag.
 */
export interface PreviewReadiness {
  environment: PreviewReadinessLayer & { lifecycle?: "running" | "stopped" | "missing" | "other" };
  binding: PreviewReadinessLayer;
  tcp: PreviewReadinessLayer;
  tls: PreviewReadinessLayer;
  http: PreviewReadinessLayer & { statusClass?: "1xx" | "2xx" | "3xx" | "4xx" | "5xx" };
  /** ISO time of the most recent observation, or null when never observed. */
  observedAt: string | null;
}

/**
 * Safe endpoint description for the trusted client. It may name the resolved
 * host port for diagnostics, but never carries a credential.
 */
export interface PreviewEndpointSnapshot {
  backendEpoch: string;
  endpointGeneration: number;
  state: PreviewEndpointState;
  transportKind: PreviewTransportKind | null;
  addressFamily: "ipv4" | "ipv6" | null;
  /** For diagnostics: host port on the backend machine. */
  hostPort: number | null;
  /** Short container id the binding was verified against. */
  containerId: string | null;
  /** How ownership was established. */
  ownership: "owned-container" | "managed-process" | "user-registered" | null;
  readiness: PreviewReadiness;
  failure: PreviewError | null;
}

export interface PreviewServiceSnapshot {
  definition: PreviewServiceDefinition;
  endpoint: PreviewEndpointSnapshot;
}

export interface PreviewServiceTombstone {
  serviceId: string;
  environmentId: string;
  registryRevision: number;
}

export interface PreviewRegistrySnapshot {
  backendInstanceId: string;
  backendEpoch: string;
  registryRevision: number;
  environmentId: string | null;
  /** True when the caller's `known` revision is current; `services` is then empty. */
  notModified: boolean;
  services: PreviewServiceSnapshot[];
  /** Recent deletions; a full snapshot stays authoritative after they expire. */
  tombstones: PreviewServiceTombstone[];
  /** Oldest revision the tombstone window covers. Older cursors must refetch. */
  tombstoneFloor: number;
}

export interface PreviewServicesChangedEvent {
  backendInstanceId: string;
  backendEpoch: string;
  registryRevision: number;
  environmentIds: string[];
  /** Service ids whose endpoint generation changed or was revoked. */
  revokedServiceIds: string[];
}

/** Durable reference stored in a browser tab. */
export interface PreviewServiceRef {
  backendInstanceId: string;
  environmentId: string;
  serviceId: string;
  /** App-relative path, query and fragment ("/", "/a?b#c"). */
  path: string;
}

// ---------------------------------------------------------------------------
// Capabilities

export interface PreviewSurfaceCapability {
  available: boolean;
  /** Operator-visible reason when unavailable. Never a secret. */
  reason?: string;
}

export interface PreviewCapabilities {
  protocolVersion: number;
  backendInstanceId: string;
  backendEpoch: string;
  /** Service registry commands are usable. */
  registry: PreviewSurfaceCapability;
  targets: PreviewTargetKind[];
  /** New scoped access issuance (the operational kill switch). */
  access: PreviewSurfaceCapability;
  surfaces: {
    /** Electron local ingress over the authenticated backend tunnel. */
    desktopTunnel: PreviewSurfaceCapability & { upstreamSchemes: PreviewScheme[] };
    /** Private HTTPS origin for normal browsers (top-level). */
    browserTopLevel: PreviewSurfaceCapability & { upstreamSchemes: PreviewScheme[] };
    /** Embedded iframe/WKWebView modes; advertised only per proven platform. */
    browserEmbedded: PreviewSurfaceCapability & { platforms: string[] };
    /** Existing gateway path proxy, with its documented limitations. */
    legacyPath: PreviewSurfaceCapability;
  };
  relay: PreviewSurfaceCapability;
  limits: PreviewLimits;
}

// ---------------------------------------------------------------------------
// Errors

export const PREVIEW_ERROR_CATEGORIES = [
  "unsupported",
  "not-found",
  "environment-stopped",
  "target-unmapped",
  "target-unverified",
  "connection-refused",
  "dns-failed",
  "tls-failed",
  "connect-timeout",
  "headers-timeout",
  "generation-changed",
  "access-expired",
  "forbidden",
  "capacity-exceeded",
  "configuration-conflict",
  "invalid-request",
  "backend-unavailable",
  "internal",
] as const;
export type PreviewErrorCategory = (typeof PREVIEW_ERROR_CATEGORIES)[number];

export type PreviewFailureLayer =
  | "request"
  | "registry"
  | "environment"
  | "binding"
  | "tcp"
  | "tls"
  | "http"
  | "access"
  | "transport";

export interface PreviewError {
  category: PreviewErrorCategory;
  /**
   * Whether *resolving or attaching again* may succeed. It never licenses
   * retrying an application request or mutation.
   */
  retryable: boolean;
  layer: PreviewFailureLayer;
  message: string;
}

export type PreviewResult<T> = { ok: true; value: T } | { ok: false; error: PreviewError };

/** Marker so an error can survive the IPC/HTTP `Error.message` flattening. */
export const PREVIEW_ERROR_MARKER = "PreviewError:";

const ERROR_DEFAULTS: Record<
  PreviewErrorCategory,
  { retryable: boolean; layer: PreviewFailureLayer; message: string }
> = {
  unsupported: {
    retryable: false,
    layer: "request",
    message: "This preview mode is not supported by the connected backend.",
  },
  "not-found": {
    retryable: false,
    layer: "registry",
    message: "The preview service no longer exists.",
  },
  "environment-stopped": {
    retryable: true,
    layer: "environment",
    message: "The environment is not running. Start it to preview this service.",
  },
  "target-unmapped": {
    retryable: true,
    layer: "binding",
    message: "The application port is not published from the container.",
  },
  "target-unverified": {
    retryable: false,
    layer: "binding",
    message: "The service target could not be verified as belonging to this environment.",
  },
  "connection-refused": {
    retryable: true,
    layer: "tcp",
    message: "Nothing is accepting connections on the application port.",
  },
  "dns-failed": {
    retryable: true,
    layer: "tcp",
    message: "The preview host name could not be resolved.",
  },
  "tls-failed": {
    retryable: false,
    layer: "tls",
    message: "The service's TLS certificate could not be verified.",
  },
  "connect-timeout": {
    retryable: true,
    layer: "tcp",
    message: "Connecting to the application timed out.",
  },
  "headers-timeout": {
    retryable: true,
    layer: "http",
    message: "The application did not respond in time.",
  },
  "generation-changed": {
    retryable: true,
    layer: "binding",
    message: "The service endpoint changed. Reconnecting uses the new endpoint.",
  },
  "access-expired": {
    retryable: true,
    layer: "access",
    message: "Preview access expired. Reconnect to continue.",
  },
  forbidden: {
    retryable: false,
    layer: "access",
    message: "This preview request is not authorized.",
  },
  "capacity-exceeded": {
    retryable: true,
    layer: "transport",
    message: "The preview is at capacity. Retry shortly.",
  },
  "configuration-conflict": {
    retryable: false,
    layer: "registry",
    message: "The service configuration changed elsewhere. Refresh and try again.",
  },
  "invalid-request": {
    retryable: false,
    layer: "request",
    message: "The preview request is invalid.",
  },
  "backend-unavailable": {
    retryable: true,
    layer: "transport",
    message: "The backend connection is unavailable.",
  },
  internal: {
    retryable: true,
    layer: "transport",
    message: "The preview failed unexpectedly.",
  },
};

export function isPreviewErrorCategory(value: unknown): value is PreviewErrorCategory {
  return (
    typeof value === "string" && (PREVIEW_ERROR_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Build a safe error. `message` overrides must never contain raw socket text or URLs. */
export function previewError(
  category: PreviewErrorCategory,
  overrides: Partial<Omit<PreviewError, "category">> = {},
): PreviewError {
  return { category, ...ERROR_DEFAULTS[category], ...overrides };
}

/** An `Error` whose message round-trips the category through string-only transports. */
export class PreviewServiceError extends Error {
  constructor(readonly preview: PreviewError) {
    super(`${PREVIEW_ERROR_MARKER}${preview.category}: ${preview.message}`);
    this.name = "PreviewServiceError";
  }
}

export function previewFailure(
  category: PreviewErrorCategory,
  overrides: Partial<Omit<PreviewError, "category">> = {},
): PreviewServiceError {
  return new PreviewServiceError(previewError(category, overrides));
}

/** Recover a category from any thrown value, including flattened transport errors. */
export function previewErrorFromUnknown(error: unknown): PreviewError | null {
  if (error instanceof PreviewServiceError) return error.preview;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const index = message.indexOf(PREVIEW_ERROR_MARKER);
  if (index < 0) return null;
  const rest = message.slice(index + PREVIEW_ERROR_MARKER.length);
  const separator = rest.indexOf(":");
  const category = separator < 0 ? rest : rest.slice(0, separator);
  if (!isPreviewErrorCategory(category)) return null;
  const detail = separator < 0 ? "" : rest.slice(separator + 1).trim();
  return previewError(category, detail ? { message: detail } : {});
}

/**
 * A *specifically unsupported* command from an old backend. Authentication,
 * network, and malformed responses must not be mistaken for this.
 */
export function isUnknownPreviewCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Unknown (?:backend )?command:?\s*(?:get_preview_|register_preview_|resolve_preview_|create_preview_)/i.test(
    message,
  );
}

// ---------------------------------------------------------------------------
// Validation helpers (pure; shared by backend and clients)

const OPAQUE_ID = /^[A-Za-z0-9_-]{8,128}$/;

export function isOpaquePreviewId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validatePreviewLabel(value: unknown): string {
  if (typeof value !== "string")
    throw previewFailure("invalid-request", { message: "Label is required." });
  const label = value.trim();
  if (!label || CONTROL_CHARS.test(label) || utf8ByteLength(label) > PREVIEW_LIMITS.labelMaxBytes) {
    throw previewFailure("invalid-request", {
      message: `Label must be 1–${PREVIEW_LIMITS.labelMaxBytes} bytes without control characters.`,
    });
  }
  return label;
}

/** Strict decimal 1–65535; rejects "03000", "3e3", " 80", and overflow. */
export function parsePreviewPort(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9]\d{0,4}$/.test(value)) return null;
  const port = Number(value);
  return port <= 65_535 ? port : null;
}

/**
 * Canonical app-relative navigation: "/" + path, optional query and fragment.
 * Rejects authority-changing forms ("//host", "/\\host"), backslashes, control
 * characters, and oversize input. Decoding is left to the application.
 */
export function normalizePreviewPath(value: unknown): string {
  if (value === undefined || value === null || value === "") return "/";
  if (typeof value !== "string")
    throw previewFailure("invalid-request", { message: "Invalid path." });
  if (utf8ByteLength(value) > PREVIEW_LIMITS.navigationMaxBytes) {
    throw previewFailure("invalid-request", { message: "Path is too long." });
  }
  if (CONTROL_CHARS.test(value) || value.includes("\\")) {
    throw previewFailure("invalid-request", { message: "Path contains invalid characters." });
  }
  const path = value.startsWith("/")
    ? value
    : value.startsWith("?") || value.startsWith("#")
      ? `/${value}`
      : null;
  if (path === null || path.startsWith("//")) {
    throw previewFailure("invalid-request", { message: "Path must be app-relative." });
  }
  return path;
}

/** Readiness path: like navigation but without a fragment and bounded tighter. */
export function normalizeReadinessPath(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const path = normalizePreviewPath(value);
  if (path.includes("#") || utf8ByteLength(path) > 512) {
    throw previewFailure("invalid-request", {
      message: "Readiness path must be a short path without a fragment.",
    });
  }
  return path;
}

export function validateTlsServerName(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !/^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
      value,
    )
  ) {
    throw previewFailure("invalid-request", { message: "TLS server name must be a DNS name." });
  }
  return value.toLowerCase();
}

function member<T extends string>(
  list: readonly T[],
  value: unknown,
  field: string,
  fallback?: T,
): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value === "string" && (list as readonly string[]).includes(value)) return value as T;
  throw previewFailure("invalid-request", { message: `Invalid ${field}.` });
}

/** Validate untrusted register/update input. Unknown fields are ignored, not merged. */
export function validatePreviewServiceInput(
  value: unknown,
): Required<
  Pick<
    PreviewServiceInput,
    | "environmentId"
    | "label"
    | "targetKind"
    | "applicationPort"
    | "scheme"
    | "addressFamily"
    | "entry"
    | "enabled"
  >
> &
  Pick<PreviewServiceInput, "tlsServerName" | "readinessPath"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw previewFailure("invalid-request", { message: "Service input must be an object." });
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.environmentId !== "string" ||
    !input.environmentId ||
    utf8ByteLength(input.environmentId) > 256
  ) {
    throw previewFailure("invalid-request", { message: "Invalid environment id." });
  }
  const port = parsePreviewPort(input.applicationPort);
  if (port === null)
    throw previewFailure("invalid-request", { message: "Application port must be 1–65535." });
  const scheme = member(PREVIEW_SCHEMES, input.scheme, "scheme", "http");
  const tlsServerName = validateTlsServerName(input.tlsServerName);
  if (scheme === "http" && tlsServerName) {
    throw previewFailure("invalid-request", {
      message: "A TLS server name requires an HTTPS service.",
    });
  }
  return {
    environmentId: input.environmentId,
    label: validatePreviewLabel(input.label),
    targetKind: member(PREVIEW_TARGET_KINDS, input.targetKind, "target kind"),
    applicationPort: port,
    scheme,
    addressFamily: member(PREVIEW_ADDRESS_FAMILIES, input.addressFamily, "address family", "auto"),
    ...(tlsServerName ? { tlsServerName } : {}),
    ...(input.readinessPath !== undefined
      ? { readinessPath: normalizeReadinessPath(input.readinessPath) }
      : {}),
    entry: input.entry === undefined ? false : input.entry === true,
    enabled: input.enabled === undefined ? true : input.enabled === true,
  };
}

export function isPreviewServiceRef(value: unknown): value is PreviewServiceRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  if (
    !isOpaquePreviewId(ref.backendInstanceId) ||
    !isOpaquePreviewId(ref.serviceId) ||
    typeof ref.environmentId !== "string" ||
    !ref.environmentId ||
    ref.environmentId.length > 256
  ) {
    return false;
  }
  try {
    return normalizePreviewPath(ref.path) === ref.path;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// URL intent

/**
 * Where a URL came from. A container terminal's `localhost:3000` means the
 * application port 3000 *inside that container*; the same text typed into the
 * address bar in manual mode means backend host port 3000. The resolver never
 * guesses between them.
 */
export type PreviewUrlSource =
  | "container-terminal"
  | "worktree-terminal"
  | "address-bar"
  | "agent-link";

export interface PreviewUrlIntent {
  source: PreviewUrlSource;
  environmentId: string;
  scheme: PreviewScheme;
  host: "localhost" | "127.0.0.1" | "::1" | "0.0.0.0";
  port: number;
  path: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Parse a user- or terminal-provided loopback URL once, by documented rules.
 * `0.0.0.0` is accepted only from a container terminal, as a bind-address hint.
 */
export function parsePreviewUrlIntent(
  raw: string,
  source: PreviewUrlSource,
  environmentId: string,
): PreviewUrlIntent {
  if (
    typeof raw !== "string" ||
    utf8ByteLength(raw) > PREVIEW_LIMITS.navigationMaxBytes ||
    CONTROL_CHARS.test(raw)
  ) {
    throw previewFailure("invalid-request", { message: "Invalid preview address." });
  }
  const match = /^(https?):\/\/([^/?#]*)([/?#].*)?$/i.exec(raw.trim());
  if (!match)
    throw previewFailure("invalid-request", {
      message: "Only http and https loopback addresses are supported.",
    });
  const scheme = match[1]!.toLowerCase() as PreviewScheme;
  const authority = match[2]!;
  if (authority.includes("@")) {
    throw previewFailure("invalid-request", {
      message: "Addresses with embedded credentials are not allowed.",
    });
  }
  const hostPort = /^(\[[^\]]+\]|[^:]+)(?::([^:]*))?$/.exec(authority);
  if (!hostPort) throw previewFailure("invalid-request", { message: "Invalid preview address." });
  const hostText = hostPort[1]!.toLowerCase();
  const portText = hostPort[2];
  let host: PreviewUrlIntent["host"];
  if (LOOPBACK_HOSTS.has(hostText)) {
    host = hostText === "[::1]" ? "::1" : (hostText as PreviewUrlIntent["host"]);
  } else if (hostText === "0.0.0.0" && source === "container-terminal") {
    host = "0.0.0.0";
  } else {
    throw previewFailure("invalid-request", {
      message: "Previews address loopback services on the selected backend.",
    });
  }
  const port =
    portText === undefined || portText === ""
      ? portText === ""
        ? null
        : scheme === "https"
          ? 443
          : 80
      : parsePreviewPort(portText);
  if (port === null) throw previewFailure("invalid-request", { message: "Port must be 1–65535." });
  return { source, environmentId, scheme, host, port, path: normalizePreviewPath(match[3] ?? "/") };
}

/**
 * Drop query and fragment for anything that may reach a log, metric label, or
 * diagnostic export. Paths are kept only as a bounded prefix.
 */
export function redactPreviewPath(path: string): string {
  const cut = path.search(/[?#]/);
  const bare = cut < 0 ? path : path.slice(0, cut);
  return bare.length > 64 ? `${bare.slice(0, 64)}…` : bare;
}

/** Deterministic JSON for fixtures and conditional-read comparisons. */
export function stablePreviewJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
  });
}

export function emptyPreviewReadiness(): PreviewReadiness {
  return {
    environment: { state: "unknown" },
    binding: { state: "unknown" },
    tcp: { state: "unknown" },
    tls: { state: "skipped" },
    http: { state: "unknown" },
    observedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Durable browser-tab targets
//
// Browser tabs persist one string (`browserData.url`) in layout version 3.
// Service tabs encode their reference as an `orkestrator-preview:` URI rather
// than adding a field: every v3 reader keeps the string verbatim through
// restore, merge, and save, so an older client can never strip the service
// identity by rewriting the tab. Older clients show it as an unsupported
// address (safe, read-only); nothing is silently downgraded to a stale port.

export const PREVIEW_TAB_URI_PREFIX = "orkestrator-preview://";

export type PreviewTabTarget =
  | { kind: "service"; ref: PreviewServiceRef }
  | { kind: "intent"; environmentId: string; source: PreviewUrlSource; url: string }
  | { kind: "url"; url: string };

export function formatPreviewServiceUri(ref: PreviewServiceRef): string {
  const path = normalizePreviewPath(ref.path);
  return `${PREVIEW_TAB_URI_PREFIX}service/${ref.backendInstanceId}/${encodeURIComponent(ref.environmentId)}/${ref.serviceId}${path}`;
}

/** An unresolved terminal/agent link awaiting a service choice or registration. */
export function formatPreviewIntentUri(intent: {
  environmentId: string;
  source: PreviewUrlSource;
  url: string;
}): string {
  return `${PREVIEW_TAB_URI_PREFIX}intent/${encodeURIComponent(intent.environmentId)}/${intent.source}?url=${encodeURIComponent(intent.url)}`;
}

const SERVICE_URI =
  /^orkestrator-preview:\/\/service\/([A-Za-z0-9_-]{8,128})\/([^/?#]+)\/([A-Za-z0-9_-]{8,128})([/?#].*)?$/;
const INTENT_URI = /^orkestrator-preview:\/\/intent\/([^/?#]+)\/([a-z-]+)\?url=([^#]*)$/;

export function parsePreviewTabTarget(value: string | undefined | null): PreviewTabTarget {
  const text = value ?? "";
  if (!text.startsWith(PREVIEW_TAB_URI_PREFIX)) return { kind: "url", url: text };
  try {
    const service = SERVICE_URI.exec(text);
    if (service) {
      const ref: PreviewServiceRef = {
        backendInstanceId: service[1]!,
        environmentId: decodeURIComponent(service[2]!),
        serviceId: service[3]!,
        path: normalizePreviewPath(service[4] ?? "/"),
      };
      if (isPreviewServiceRef(ref)) return { kind: "service", ref };
    }
    const intent = INTENT_URI.exec(text);
    if (
      intent &&
      (["container-terminal", "worktree-terminal", "address-bar", "agent-link"] as const).includes(
        intent[2] as PreviewUrlSource,
      )
    ) {
      return {
        kind: "intent",
        environmentId: decodeURIComponent(intent[1]!),
        source: intent[2] as PreviewUrlSource,
        url: decodeURIComponent(intent[3]!),
      };
    }
  } catch {
    // Malformed encodings fall through to an unsupported plain address.
  }
  return { kind: "url", url: text };
}
