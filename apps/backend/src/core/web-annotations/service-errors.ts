/**
 * Typed web annotation service failures.
 *
 * Every error keeps its stable human prefix (clients and tests match on it)
 * and carries a content-free `WebAnnotationErrorDetail` both as a property and
 * as the message trailer produced by `formatWebAnnotationError`, so the typed
 * code and usage totals survive the command transport, which forwards only
 * `Error.message`.
 */
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_CONFLICT,
  WEB_ANNOTATION_DEGRADED,
  WEB_ANNOTATION_UNAVAILABLE,
  formatWebAnnotationError,
  parseWebAnnotationError,
  type WebAnnotationCapacityResource,
  type WebAnnotationErrorDetail,
  type WebAnnotationRolloutMode,
} from "@orkestrator/protocol/web-annotations";

export class WebAnnotationServiceError extends Error {
  readonly detail: WebAnnotationErrorDetail | undefined;
  constructor(message: string, detail?: WebAnnotationErrorDetail) {
    super(detail ? formatWebAnnotationError(message, detail) : message);
    this.name = "WebAnnotationServiceError";
    this.detail = detail;
  }
}

export function conflictError(message: string): WebAnnotationServiceError {
  return new WebAnnotationServiceError(`${WEB_ANNOTATION_CONFLICT} ${message}`, {
    code: "conflict",
  });
}

/**
 * Keyword → resource for capacity messages that do not name one explicitly
 * (callers in other layers pass only text). Order matters: most specific first.
 */
const RESOURCE_HINTS: Array<[RegExp, WebAnnotationCapacityResource]> = [
  [/thread text/i, "thread-bytes"],
  [/thread has/i, "thread-entries"],
  [/environment images|image quota/i, "image-bytes"],
  [/image dimensions/i, "image-dimensions"],
  [/image exceeds/i, "image-size"],
  [/metadata/i, "metadata-bytes"],
  [/saved drafts/i, "drafts"],
  [/draft text/i, "draft-text"],
  [/a request holds/i, "request-annotations"],
  [/\brequests\b/i, "requests"],
  [/\bannotations\b|annotation limit/i, "annotations"],
  [/queued annotation writes/i, "queued-writes"],
  [/being prepared/i, "preparations"],
  [/instruction exceeds/i, "instruction"],
  [/desired outcome/i, "desired-outcome"],
  [/\bresults\b/i, "result-revisions"],
  [/record exceeds/i, "record-bytes"],
  [/payload is too large/i, "payload"],
];

/** Infer `used`/`limit` from the conventional "<used> of <limit>" phrasing. */
export function inferCapacityDetail(message: string): WebAnnotationErrorDetail {
  const detail: WebAnnotationErrorDetail = { code: "capacity" };
  for (const [pattern, resource] of RESOURCE_HINTS) {
    if (pattern.test(message)) {
      detail.resource = resource;
      break;
    }
  }
  const usage = /(\d+) of (\d+)/.exec(message);
  if (usage) {
    detail.used = Number(usage[1]);
    detail.limit = Number(usage[2]);
  } else {
    const bound = /(?:exceeds|holds 1 to) (\d+)/.exec(message);
    if (bound) detail.limit = Number(bound[1]);
  }
  if (detail.resource === "thread-entries" || detail.resource === "thread-bytes") {
    detail.archivable = true;
  }
  return detail;
}

export function capacityError(
  message: string,
  detail?: Omit<WebAnnotationErrorDetail, "code">,
): WebAnnotationServiceError {
  const text = `${WEB_ANNOTATION_CAPACITY} ${message}`;
  return new WebAnnotationServiceError(
    text,
    detail ? { code: "capacity", ...detail } : inferCapacityDetail(message),
  );
}

export function notFound(what: string): WebAnnotationServiceError {
  return new WebAnnotationServiceError(`${what} not found in this environment`, {
    code: "not-found",
  });
}

export function degradedError(reason: string): WebAnnotationServiceError {
  return new WebAnnotationServiceError(`${WEB_ANNOTATION_DEGRADED} ${reason}`, {
    code: "degraded",
  });
}

export function archivedError(
  continuationId: string | null | undefined,
): WebAnnotationServiceError {
  return new WebAnnotationServiceError(
    `${WEB_ANNOTATION_CONFLICT} this thread is archived; continue in its continuation thread`,
    { code: "archived", ...(continuationId ? { continuationId } : {}) },
  );
}

export function rolloutError(mode: WebAnnotationRolloutMode): WebAnnotationServiceError {
  return new WebAnnotationServiceError(
    mode === "disabled"
      ? `${WEB_ANNOTATION_UNAVAILABLE} web annotations are disabled on this backend`
      : `${WEB_ANNOTATION_UNAVAILABLE} web annotations are read-only on this backend (recovery mode)`,
    { code: mode === "disabled" ? "disabled" : "read-only", mode },
  );
}

/**
 * Content-free code for metrics and logs. Never returns message text: an
 * unknown failure is `other`.
 */
export function errorOutcome(error: unknown): string {
  if (error instanceof WebAnnotationServiceError && error.detail) return error.detail.code;
  const parsed = parseWebAnnotationError(error);
  if (parsed.detail) return parsed.detail.code;
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Invalid web_annotation")) return "invalid";
  if (/not found/i.test(message)) return "not-found";
  return "other";
}
