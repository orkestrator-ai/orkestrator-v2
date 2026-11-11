/**
 * The content-free renderer error ring (docs/architecture/logging.md, "Renderer
 * failures in the essential log"). Browser-safe: the renderer builds entries
 * with these lists and the backend checks every entry against them again before
 * anything reaches the essential log.
 *
 * An entry says which kind of failure happened where, how often, and a one-way
 * fingerprint that tells two failures apart. It holds no message and no stack:
 * both can carry transcript text, file contents, paths and URLs, and nobody
 * chose to save this.
 */

/**
 * The backend command a renderer sends its ring's new counts to: a desktop
 * window's own renderer, and a browser tab (or the iOS app's web view) to the
 * backend it is signed in to.
 */
export const RECORD_RENDERER_ERRORS_COMMAND = "record_renderer_errors";

/** Distinct failures one renderer keeps; the least recently seen goes first. */
export const RENDERER_ERROR_RING_SIZE = 100;

/** Entries one write may carry. A ring with more sends the rest next time. */
export const MAX_RENDERER_ERROR_BATCH = 20;

/** A count above this is stored as this. */
export const MAX_RENDERER_ERROR_COUNT = 1_000_000;

/**
 * Built-in error classes, `ChunkLoadError` from the bundler, and `NonErrorThrow`
 * for a thrown value that was not an `Error`. A custom subclass name is
 * application-controlled text, so it is recorded as `Error`.
 */
export const RENDERER_ERROR_CLASSES = [
  "AggregateError",
  "ChunkLoadError",
  "Error",
  "EvalError",
  "NonErrorThrow",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
] as const;

export type RendererErrorClass = (typeof RENDERER_ERROR_CLASSES)[number];

/**
 * Where the failure was caught. The named boundaries contain one view, row or
 * block; `boundary` is any other error boundary; `root` is an error no boundary
 * caught; `recoverable` is one React recovered from on its own; `window` and
 * `rejection` are the window's own error and unhandled-rejection events.
 */
export const RENDERER_ERROR_BOUNDARIES = [
  "boundary",
  "lazy-view",
  "message-row",
  "recoverable",
  "rejection",
  "rich-block",
  "root",
  "window",
] as const;

export type RendererErrorBoundary = (typeof RENDERER_ERROR_BOUNDARIES)[number];

/**
 * The renderer surface the failure happened in. The app has no URL router, so
 * its "route" is which renderer this is: a desktop window's own or a browser
 * tab on the web client. `realm` named a workspace realm inside a window;
 * plan items 6002 and 6003 retired realms, so the current app never sends it,
 * and it stays accepted for reports from older renderers.
 */
export const RENDERER_ERROR_ROUTES = ["browser", "realm", "window"] as const;

export type RendererErrorRoute = (typeof RENDERER_ERROR_ROUTES)[number];

/** FNV-1a over the error class, stack and component stack, as eight hex digits. */
export const RENDERER_ERROR_FINGERPRINT = /^[0-9a-f]{8}$/;

export interface RendererErrorEntry {
  errorClass: RendererErrorClass;
  boundary: RendererErrorBoundary;
  route: RendererErrorRoute;
  fingerprint: string;
  /** Occurrences since this renderer last sent the entry. */
  count: number;
}

const ENTRY_KEYS = ["boundary", "count", "errorClass", "fingerprint", "route"];

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

export function isRendererErrorClass(value: unknown): value is RendererErrorClass {
  return oneOf(RENDERER_ERROR_CLASSES, value);
}

export function isRendererErrorBoundary(value: unknown): value is RendererErrorBoundary {
  return oneOf(RENDERER_ERROR_BOUNDARIES, value);
}

export function isRendererErrorRoute(value: unknown): value is RendererErrorRoute {
  return oneOf(RENDERER_ERROR_ROUTES, value);
}

export function isRendererErrorFingerprint(value: unknown): value is string {
  return typeof value === "string" && RENDERER_ERROR_FINGERPRINT.test(value);
}

/**
 * One entry exactly as sent, or null. Any key beyond the five, and any value
 * outside its list, refuses the entry rather than dropping the extra: a sender
 * that adds a message field is a bug to surface, not to tolerate.
 */
export function parseRendererErrorEntry(value: unknown): RendererErrorEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== ENTRY_KEYS.length || keys.some((key, index) => key !== ENTRY_KEYS[index])) {
    return null;
  }
  const { errorClass, boundary, route, fingerprint, count } = value as Record<string, unknown>;
  if (!isRendererErrorClass(errorClass)) return null;
  if (!isRendererErrorBoundary(boundary)) return null;
  if (!isRendererErrorRoute(route)) return null;
  if (!isRendererErrorFingerprint(fingerprint)) return null;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return null;
  return {
    errorClass,
    boundary,
    route,
    fingerprint,
    count: Math.min(count, MAX_RENDERER_ERROR_COUNT),
  };
}

/** A whole write, or null when it is not a list of at most the batch's valid entries. */
export function parseRendererErrorBatch(value: unknown): RendererErrorEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RENDERER_ERROR_BATCH) {
    return null;
  }
  const entries: RendererErrorEntry[] = [];
  for (const item of value) {
    const entry = parseRendererErrorEntry(item);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries;
}

/**
 * The optional `client` argument: one renderer's upload id, so the backend can
 * give each renderer its own share of the per-minute bound. Random, chosen by
 * the renderer for one tab or window (kept across its reloads), and never
 * written to the log: it identifies no user, device or session.
 */
export const RENDERER_ERROR_CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function isRendererErrorClientId(value: unknown): value is string {
  return typeof value === "string" && RENDERER_ERROR_CLIENT_ID.test(value);
}

/** What the backend answers: how many it logged and how many the rate bound dropped. */
export interface RecordRendererErrorsResult {
  accepted: number;
  dropped: number;
}
