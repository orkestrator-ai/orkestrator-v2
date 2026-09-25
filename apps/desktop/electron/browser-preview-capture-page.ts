/**
 * Shared basics of trusted capture in Electron main: the web contents surface
 * capture needs, the bounded page-script runner, host-chosen error messages,
 * and page identity derived from the actual view URL (never from the page).
 */
import type { BrowserPreviewCaptureErrorCode } from "@orkestrator/protocol/browser-preview";
import type { WebAnnotationPageIdentity } from "@orkestrator/protocol/web-annotations";
import {
  isWebAnnotationId,
  sanitizeWebAnnotationUrl,
} from "@orkestrator/protocol/web-annotations-validation";

/** Scripts run in a dedicated isolated world: the page cannot read or replace the runtime. */
export const BROWSER_PREVIEW_CAPTURE_WORLD_ID = 1_047;
const PAGE_SCRIPT_TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const GATEWAY_PREVIEW_PATH = /^\/__orkestrator\/browser\/loopback\/([1-9]\d{0,4})(\/.*)?$/;
const GATEWAY_ROUTE_PREFIX = /^\/__orkestrator\/browser\/loopback\/[1-9]\d{0,4}(\/.*)?$/;

export const CAPTURE_ERROR_MESSAGES: Record<BrowserPreviewCaptureErrorCode, string> = {
  "stale-session": "The page selection is no longer valid. Start the capture again.",
  navigation: "The page navigated before the capture finished.",
  "target-removed": "The selected target was removed from the page.",
  "too-large": "The selection or screenshot is too large. Try a smaller target.",
  "spool-full": "Too many captures are waiting to be saved. Save or discard one first.",
  unsupported: "This selection can't be captured here. Try Region or Page.",
  "capture-failed": "The capture could not be completed.",
};

export class CaptureFailure extends Error {
  constructor(readonly code: BrowserPreviewCaptureErrorCode) {
    super(CAPTURE_ERROR_MESSAGES[code]);
  }
}

export interface CaptureImageLike {
  getSize(): { width: number; height: number };
  resize(options: {
    width: number;
    height: number;
    quality?: "good" | "better" | "best";
  }): CaptureImageLike;
  toDataURL(): string;
  toBitmap?(): Buffer;
  /** Electron `NativeImage.crop`; used for region crops. */
  crop?(rect: { x: number; y: number; width: number; height: number }): CaptureImageLike;
}

export interface CaptureNativeImageApi {
  createFromBitmap(buffer: Buffer, options: { width: number; height: number }): CaptureImageLike;
  /** Electron `nativeImage.createFromBuffer`; used to crop a spooled PNG. */
  createFromBuffer?(buffer: Buffer): CaptureImageLike;
}

/** Electron `webContents.enableDeviceEmulation` parameters used for responsive sets. */
export interface CaptureDeviceEmulation {
  screenPosition: "desktop" | "mobile";
  screenSize: { width: number; height: number };
  viewPosition: { x: number; y: number };
  deviceScaleFactor: number;
  viewSize: { width: number; height: number };
  scale: number;
}

export interface CaptureWebContents {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  executeJavaScriptInIsolatedWorld?(
    worldId: number,
    scripts: Array<{ code: string }>,
    userGesture?: boolean,
  ): Promise<unknown>;
  capturePage(): Promise<CaptureImageLike>;
  getURL(): string;
  getTitle?(): string;
  getZoomFactor?(): number;
  isDestroyed(): boolean;
  focus?(): void;
  enableDeviceEmulation?(parameters: CaptureDeviceEmulation): void;
  disableDeviceEmulation?(): void;
}

export interface CapturePreviewHandle {
  contents: CaptureWebContents;
  generation: number;
  visible: boolean;
  /** True while the main frame is loading. */
  loading?: boolean;
  /** Present for service previews; null when the transport cannot map the URL. */
  describeService?: (url: string) => { serviceId: string; path: string; displayUrl: string } | null;
  /** Navigate within the preview's own scope (the manager re-validates the URL). */
  navigate?: (url: string) => Promise<void>;
  /** Current view size in CSS pixels, for responsive emulation. */
  viewSize?: () => { width: number; height: number };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000
    ? value
    : null;
}

/** Run a script with a deadline; a hung page cannot stall main or leak a rejection. */
export function runInPage(contents: CaptureWebContents, code: string): Promise<unknown> {
  const execution =
    typeof contents.executeJavaScriptInIsolatedWorld === "function"
      ? contents.executeJavaScriptInIsolatedWorld(
          BROWSER_PREVIEW_CAPTURE_WORLD_ID,
          [{ code }],
          false,
        )
      : contents.executeJavaScript(code, false);
  const guarded = Promise.resolve(execution);
  guarded.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The page did not respond")), PAGE_SCRIPT_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([guarded, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function parseJson(value: unknown, maxChars: number): unknown {
  if (typeof value !== "string" || value.length > maxChars) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Page identity

function sanitizedServiceIdentity(
  serviceId: string,
  described: { path: string; displayUrl: string },
): {
  service: WebAnnotationPageIdentity["service"];
  sanitized: ReturnType<typeof sanitizeWebAnnotationUrl>;
  absolute: boolean;
} {
  const absolute = /^https?:\/\//i.test(described.displayUrl);
  const path = described.path.startsWith("/") ? described.path : `/${described.path}`;
  const sanitized = sanitizeWebAnnotationUrl(
    absolute ? described.displayUrl : `http://service.invalid${path}`,
  );
  return {
    service: isWebAnnotationId(serviceId) ? { kind: "service", serviceId } : { kind: "unknown" },
    sanitized,
    absolute,
  };
}

/**
 * Durable page identity from the actual view URL. Gateway prefixes and
 * token-like parameters never survive; service previews use the transport's
 * application address, never the runtime ingress URL.
 */
export function browserPreviewPageIdentity(
  url: string,
  title: string,
  describeService?: CapturePreviewHandle["describeService"],
): { page: WebAnnotationPageIdentity; removedParameters: number } {
  const boundedTitle = title.slice(0, 500);
  if (describeService) {
    const described = describeService(url);
    if (!described) {
      return {
        page: {
          service: { kind: "unknown" },
          route: "/",
          displayUrl: "",
          title: boundedTitle,
          requiresNavigation: true,
        },
        removedParameters: 0,
      };
    }
    const { service, sanitized, absolute } = sanitizedServiceIdentity(
      described.serviceId,
      described,
    );
    return {
      page: {
        service,
        route: sanitized.route,
        displayUrl: absolute ? sanitized.displayUrl : sanitized.route,
        title: boundedTitle,
        requiresNavigation: sanitized.requiresNavigation,
      },
      removedParameters: sanitized.removedParameters,
    };
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      page: {
        service: { kind: "unknown" },
        route: "/",
        displayUrl: "",
        title: boundedTitle,
        requiresNavigation: true,
      },
      removedParameters: 0,
    };
  }
  const gateway = GATEWAY_PREVIEW_PATH.exec(parsed.pathname);
  if (gateway && (parsed.protocol === "https:" || parsed.protocol === "http:")) {
    const port = Number(gateway[1]);
    const sanitized = sanitizeWebAnnotationUrl(url, { routePrefix: GATEWAY_ROUTE_PREFIX });
    return {
      page: {
        service: port >= 1 && port <= 65_535 ? { kind: "port", port } : { kind: "unknown" },
        route: sanitized.route,
        displayUrl: `http://localhost:${port}${sanitized.route}`.slice(0, 4_000),
        title: boundedTitle,
        requiresNavigation: sanitized.requiresNavigation,
      },
      removedParameters: sanitized.removedParameters,
    };
  }
  const sanitized = sanitizeWebAnnotationUrl(url);
  const loopback = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  const port = loopback ? Number(parsed.port || 80) : 0;
  return {
    page: {
      service:
        loopback && port >= 1 && port <= 65_535 ? { kind: "port", port } : { kind: "unknown" },
      route: sanitized.route,
      displayUrl: sanitized.displayUrl,
      title: boundedTitle,
      requiresNavigation: sanitized.requiresNavigation,
    },
    removedParameters: sanitized.removedParameters,
  };
}

/** Same logical route: path and query, plus a hash only when it is a hash route. */
export function sameBrowserPreviewRoute(left: string, right: string): boolean {
  const key = (route: string) => {
    const index = route.indexOf("#");
    const base = index >= 0 ? route.slice(0, index) : route;
    const hash = index >= 0 ? route.slice(index) : "";
    return `${base}#${/^#!?\//.test(hash) ? hash.replace(/^#!?/, "") : ""}`;
  };
  return key(left) === key(right);
}

/**
 * The view URL for a stored app-relative route in the same preview scope, or
 * null when the route cannot be addressed safely. The origin (and a gateway
 * prefix) always come from the current view URL, never from the route.
 */
export function browserPreviewRouteUrl(currentUrl: string, route: string): string | null {
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) return null;
  if (route.length > 4_000 || /[\u0000-\u001f\u007f\\]/.test(route)) return null;
  let current: URL;
  try {
    current = new URL(currentUrl);
  } catch {
    return null;
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") return null;
  const gateway = GATEWAY_PREVIEW_PATH.exec(current.pathname);
  const prefix = gateway ? `/__orkestrator/browser/loopback/${gateway[1]}` : "";
  let next: URL;
  try {
    next = new URL(`${current.origin}${prefix}${route}`);
  } catch {
    return null;
  }
  return next.origin === current.origin ? next.toString() : null;
}
