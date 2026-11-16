/**
 * Scoped preview access and the desktop tunnel endpoint (its wire contract is
 * in `preview-tunnel-mux.ts`).
 *
 * Access is always minted by the authenticated control API for one registered
 * service, bound to `(serviceId, backendEpoch, endpointGeneration, surface)`.
 * Secrets in this module travel only to the trusted initiating client — never
 * into snapshots, events, layouts, logs, or application requests.
 */
import type { PreviewScheme } from "./preview-services.js";

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
  /** The tunnel protocol: many connections over one socket (`preview-tunnel-mux.ts`). */
  subprotocol: typeof PREVIEW_TUNNEL_SUBPROTOCOL_V2;
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
// Desktop tunnel endpoint. The wire contract, many upstream connections over
// one authenticated WebSocket per attachment, is in `preview-tunnel-mux.ts`.
// No gateway credential is required or used.
//
// Liveness: the server pings every 30 s and closes a tunnel from which no
// frame arrived in the last interval. A client sends its own WebSocket pings
// (PREVIEW_TUNNEL_CLIENT_PING_MS), so it stays alive while it has stopped
// reading and cannot answer pings queued behind application data.

export const PREVIEW_TUNNEL_PATH = "/__orkestrator/preview/tunnel";
/** The tunnel's only subprotocol; the contract is in `preview-tunnel-mux.ts`. */
export const PREVIEW_TUNNEL_SUBPROTOCOL_V2 = "orkestrator.preview-tunnel.v2";
export const PREVIEW_TUNNEL_HELLO_TIMEOUT_MS = 5_000;
/** Client heartbeat: half the server's 30-second liveness interval. */
export const PREVIEW_TUNNEL_CLIENT_PING_MS = 15_000;

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
