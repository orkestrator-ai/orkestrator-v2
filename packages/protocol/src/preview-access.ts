/**
 * Scoped preview access and the desktop tunnel wire contract.
 *
 * Access is always minted by the authenticated control API for one registered
 * service, bound to `(serviceId, backendEpoch, endpointGeneration, surface)`.
 * Secrets in this module travel only to the trusted initiating client — never
 * into snapshots, events, layouts, logs, or application requests.
 */
import {
  isOpaquePreviewId,
  isPreviewErrorCategory,
  PREVIEW_LIMITS,
  previewError,
  type PreviewError,
  type PreviewScheme,
} from "./preview-services.js";

export const PREVIEW_SURFACES = [
  "desktop-tunnel",
  "browser-top-level",
  "browser-embedded",
] as const;
export type PreviewSurface = (typeof PREVIEW_SURFACES)[number];

export function isPreviewSurface(value: unknown): value is PreviewSurface {
  return typeof value === "string" && (PREVIEW_SURFACES as readonly string[]).includes(value);
}

export interface PreviewAttachmentRequest {
  serviceId: string;
  surface: PreviewSurface;
  /**
   * Bounded, non-secret client identity used only for per-client admission
   * (for example a window scope hash). Never used for authorization.
   */
  clientKey?: string;
  /** App-relative path the browser bootstrap should land on. */
  path?: string;
}

export interface PreviewTunnelDescriptor {
  path: typeof PREVIEW_TUNNEL_PATH;
  subprotocol: typeof PREVIEW_TUNNEL_SUBPROTOCOL;
  /** Attachment-scoped secret, presented in-band in HELLO. */
  credential: string;
}

export interface PreviewBootstrapDescriptor {
  /** Absolute `https://bootstrap.<domain>/bootstrap` URL; the only POST target. */
  action: string;
  /** One-use grant; POST body only, never a URL. */
  grant: string;
  /** The service's public origin the browser lands on. */
  origin: string;
  expiresAt: string;
}

export interface PreviewAttachmentDescriptor {
  attachmentId: string;
  serviceId: string;
  environmentId: string;
  backendInstanceId: string;
  backendEpoch: string;
  endpointGeneration: number;
  surface: PreviewSurface;
  applicationPort: number;
  scheme: PreviewScheme;
  /** Absolute lease end; renewal cannot extend past it. */
  expiresAt: string;
  /** Idle deadline; renew before it to keep the attachment. */
  idleExpiresAt: string;
  tunnel?: PreviewTunnelDescriptor;
  bootstrap?: PreviewBootstrapDescriptor;
}

/** Runtime attachment state visible in diagnostics (never includes secrets). */
export interface PreviewAttachmentSummary {
  attachmentId: string;
  serviceId: string;
  surface: PreviewSurface;
  endpointGeneration: number;
  state: "active" | "expired" | "revoked" | "released";
  activeResources: number;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Browser bootstrap

export const PREVIEW_BOOTSTRAP_PATH = "/bootstrap";
/** Reserved prefix on every service host; never forwarded upstream. */
export const PREVIEW_RESERVED_PREFIX = "/__orkestrator_preview/";
export const PREVIEW_SESSION_PATH = "/__orkestrator_preview/session";
export const PREVIEW_SESSION_COOKIE = "__Host-orkestrator-preview";
export const PREVIEW_SESSION_CODE_TTL_MS = 30_000;

/** Electron local ingress credential header, injected by main per service session. */
export const PREVIEW_INGRESS_HEADER = "x-orkestrator-preview-ingress";

/**
 * Cookie names an application may never set or receive through the preview
 * transport. Upstream `Set-Cookie` fields using them are dropped and inbound
 * `Cookie` pairs with them are stripped before forwarding.
 */
export const PREVIEW_RESERVED_COOKIE_NAMES: readonly string[] = [
  PREVIEW_SESSION_COOKIE,
  "orkestrator_gateway_auth",
  "orkestrator_agent_test_session",
];

export function isReservedPreviewCookieName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return (
    PREVIEW_RESERVED_COOKIE_NAMES.some((reserved) => reserved.toLowerCase() === lower) ||
    lower.startsWith("__host-orkestrator") ||
    lower.startsWith("__secure-orkestrator")
  );
}

// ---------------------------------------------------------------------------
// Desktop tunnel wire contract (v1)
//
// connecting -> authenticating -> opening -> open -> closing -> closed
//
// 1. Client opens a WebSocket to PREVIEW_TUNNEL_PATH offering exactly
//    PREVIEW_TUNNEL_SUBPROTOCOL. No gateway credential is required or used.
// 2. Client sends HELLO {attachmentId, credential}. Server answers READY or
//    closes with 4401/4403/4410.
// 3. Client sends OPEN (no fields: the destination is the attachment's
//    service). Server connects to the verified binding for the attachment's
//    endpoint generation and answers OPEN_OK or OPEN_FAILED.
// 4. After OPEN_OK, binary messages (<= 32 KiB) carry ordered bytes in both
//    directions. EOF half-closes one direction. CANCEL or any WebSocket close
//    tears down both legs. Nothing is replayed after a disconnect.
//
// Any unknown, duplicate, out-of-order, or oversized frame closes with 4400.

export const PREVIEW_TUNNEL_PATH = "/__orkestrator/preview/tunnel";
export const PREVIEW_TUNNEL_SUBPROTOCOL = "orkestrator.preview-tunnel.v1";
export const PREVIEW_TUNNEL_VERSION = 1;
export const PREVIEW_TUNNEL_HELLO_TIMEOUT_MS = 5_000;

export const PREVIEW_TUNNEL_CLOSE = {
  normal: 1000,
  protocol: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  timeout: 4408,
  generationChanged: 4409,
  revoked: 4410,
  capacity: 4429,
  upstreamFailed: 4502,
} as const;

export type PreviewTunnelClientFrame =
  | { type: "hello"; version: number; attachmentId: string; credential: string }
  | { type: "open" }
  | { type: "eof" }
  | { type: "cancel" };

export type PreviewTunnelServerFrame =
  | { type: "ready"; serviceId: string; endpointGeneration: number; expiresAt: string }
  | { type: "open-ok" }
  | { type: "open-failed"; error: PreviewError }
  | { type: "eof" }
  | { type: "error"; error: PreviewError };

const CREDENTIAL = /^[A-Za-z0-9_-]{32,128}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function parseControl(text: string): Record<string, unknown> | null {
  if (typeof text !== "string" || text.length > PREVIEW_LIMITS.controlFrameMaxBytes) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Strict: unknown types, extra fields (e.g. a host or port), and oversize frames are rejected. */
export function parsePreviewTunnelClientFrame(text: string): PreviewTunnelClientFrame | null {
  const frame = parseControl(text);
  if (!frame) return null;
  switch (frame.type) {
    case "hello":
      return exactKeys(frame, ["type", "version", "attachmentId", "credential"]) &&
        frame.version === PREVIEW_TUNNEL_VERSION &&
        isOpaquePreviewId(frame.attachmentId) &&
        typeof frame.credential === "string" &&
        CREDENTIAL.test(frame.credential)
        ? {
            type: "hello",
            version: PREVIEW_TUNNEL_VERSION,
            attachmentId: frame.attachmentId,
            credential: frame.credential,
          }
        : null;
    case "open":
    case "eof":
    case "cancel":
      return exactKeys(frame, ["type"]) ? { type: frame.type } : null;
    default:
      return null;
  }
}

export function parsePreviewTunnelServerFrame(text: string): PreviewTunnelServerFrame | null {
  const frame = parseControl(text);
  if (!frame) return null;
  const isError = (value: unknown): value is PreviewError =>
    !!value &&
    typeof value === "object" &&
    isPreviewErrorCategory((value as PreviewError).category) &&
    typeof (value as PreviewError).message === "string" &&
    (value as PreviewError).message.length <= 1_000;
  switch (frame.type) {
    case "ready":
      return typeof frame.serviceId === "string" &&
        Number.isSafeInteger(frame.endpointGeneration) &&
        typeof frame.expiresAt === "string"
        ? {
            type: "ready",
            serviceId: frame.serviceId,
            endpointGeneration: frame.endpointGeneration as number,
            expiresAt: frame.expiresAt,
          }
        : null;
    case "open-ok":
    case "eof":
      return { type: frame.type };
    case "open-failed":
    case "error":
      return isError(frame.error)
        ? {
            type: frame.type,
            error: previewError(frame.error.category, { message: frame.error.message }),
          }
        : null;
    default:
      return null;
  }
}

export function encodePreviewTunnelFrame(
  frame: PreviewTunnelClientFrame | PreviewTunnelServerFrame,
): string {
  return JSON.stringify(frame);
}
