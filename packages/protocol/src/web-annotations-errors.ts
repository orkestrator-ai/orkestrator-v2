/**
 * Typed web annotation failures that survive every transport.
 *
 * Command errors reach clients as a single message string (the gateway sends
 * `{ error: message }`; desktop IPC forwards `Error.message`). A failure keeps
 * its stable human prefix (`Web annotation capacity exceeded: ...`) for
 * backward compatibility and appends one machine-readable, content-free
 * trailer:
 *
 *   Web annotation capacity exceeded: environment has 2000 of 2000 annotations
 *   [web-annotation-error {"code":"capacity","resource":"annotations","used":2000,"limit":2000}]
 *
 * Clients call `parseWebAnnotationError` to get the typed detail and the
 * message without the trailer. The trailer never carries user text, page
 * content, paths, or URLs: only closed-vocabulary codes, ids, and numbers.
 */

/** Prefix of every optimistic-concurrency failure; callers refetch and retry. */
export const WEB_ANNOTATION_CONFLICT = "Web annotation revision conflict:";
/** Prefix of every quota failure; the caller keeps its draft and shows usage. */
export const WEB_ANNOTATION_CAPACITY = "Web annotation capacity exceeded:";
/** Prefix used when storage for an environment cannot be trusted. */
export const WEB_ANNOTATION_DEGRADED = "Web annotation storage degraded:";
/** Prefix used when the backend rollout switch refuses an operation. */
export const WEB_ANNOTATION_UNAVAILABLE = "Web annotations unavailable:";

export const WEB_ANNOTATION_ERROR_CODES = Object.freeze([
  "conflict",
  "capacity",
  "degraded",
  "not-found",
  "read-only",
  "archived",
  "disabled",
  "unsupported-version",
  "upgrade-required",
] as const);
export type WebAnnotationErrorCode = (typeof WEB_ANNOTATION_ERROR_CODES)[number];

export const WEB_ANNOTATION_CAPACITY_RESOURCES = Object.freeze([
  "annotations",
  "requests",
  "metadata-bytes",
  "image-bytes",
  "image-size",
  "image-dimensions",
  "thread-entries",
  "thread-bytes",
  "drafts",
  "draft-text",
  "record-bytes",
  "queued-writes",
  "preparations",
  "request-annotations",
  "instruction",
  "desired-outcome",
  "result-revisions",
  "payload",
] as const);
export type WebAnnotationCapacityResource = (typeof WEB_ANNOTATION_CAPACITY_RESOURCES)[number];

export interface WebAnnotationErrorDetail {
  code: WebAnnotationErrorCode;
  /** Capacity failures: which bound was hit. */
  resource?: WebAnnotationCapacityResource;
  /** Capacity failures: current usage in the resource's unit (count or bytes). */
  used?: number;
  /** Capacity failures: the enforced bound in the same unit. */
  limit?: number;
  /** Capacity failures: the amount the refused operation would have added. */
  requested?: number;
  /**
   * `thread-entries` / `thread-bytes`: the thread can be continued with
   * `web_annotation_archive`. Clients offer "Continue in a new note".
   */
  archivable?: boolean;
  /** `archived`: the continuation that replaced the archived thread. */
  continuationId?: string;
  /** `disabled` / `read-only`: the active rollout mode. */
  mode?: "enabled" | "read-only" | "disabled";
  /** `unsupported-version`: which persisted format was newer than supported. */
  format?: "manifest" | "drafts" | "record" | "annotation";
}

const TRAILER_OPEN = " [web-annotation-error ";
const TRAILER_CLOSE = "]";
const MAX_TRAILER_CHARS = 1_000;
const CODES = new Set<string>(WEB_ANNOTATION_ERROR_CODES);
const RESOURCES = new Set<string>(WEB_ANNOTATION_CAPACITY_RESOURCES);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function sanitizeDetail(value: unknown): WebAnnotationErrorDetail | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.code !== "string" || !CODES.has(input.code)) return null;
  const detail: WebAnnotationErrorDetail = { code: input.code as WebAnnotationErrorCode };
  if (typeof input.resource === "string" && RESOURCES.has(input.resource)) {
    detail.resource = input.resource as WebAnnotationCapacityResource;
  }
  for (const key of ["used", "limit", "requested"] as const) {
    const number = input[key];
    if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) {
      detail[key] = number;
    }
  }
  if (input.archivable === true) detail.archivable = true;
  if (typeof input.continuationId === "string" && SAFE_ID.test(input.continuationId)) {
    detail.continuationId = input.continuationId;
  }
  if (input.mode === "enabled" || input.mode === "read-only" || input.mode === "disabled") {
    detail.mode = input.mode;
  }
  if (
    input.format === "manifest" ||
    input.format === "drafts" ||
    input.format === "record" ||
    input.format === "annotation"
  ) {
    detail.format = input.format;
  }
  return detail;
}

/** Append the typed trailer to a human message. Unknown fields are dropped. */
export function formatWebAnnotationError(
  message: string,
  detail: WebAnnotationErrorDetail,
): string {
  const safe = sanitizeDetail(detail);
  if (!safe) return message;
  const base = stripWebAnnotationErrorTrailer(message);
  return `${base}${TRAILER_OPEN}${JSON.stringify(safe)}${TRAILER_CLOSE}`;
}

/** The human message without a typed trailer. */
export function stripWebAnnotationErrorTrailer(message: string): string {
  const index = message.lastIndexOf(TRAILER_OPEN);
  if (index < 0 || !message.endsWith(TRAILER_CLOSE)) return message;
  return message.slice(0, index);
}

function prefixCode(message: string): WebAnnotationErrorCode | null {
  if (message.includes(WEB_ANNOTATION_CONFLICT)) return "conflict";
  if (message.includes(WEB_ANNOTATION_CAPACITY)) return "capacity";
  if (message.includes(WEB_ANNOTATION_DEGRADED)) return "degraded";
  if (message.includes(WEB_ANNOTATION_UNAVAILABLE)) return "disabled";
  return null;
}

/**
 * Typed detail of a web annotation failure message, or null when the message
 * is not a web annotation failure. Older backends without trailers still get
 * a code from the stable prefix.
 */
export function parseWebAnnotationError(message: unknown): {
  detail: WebAnnotationErrorDetail | null;
  message: string;
} {
  const text =
    typeof message === "string"
      ? message
      : message instanceof Error
        ? message.message
        : typeof message === "object" &&
            message !== null &&
            typeof (message as { message?: unknown }).message === "string"
          ? (message as { message: string }).message
          : String(message);
  const index = text.lastIndexOf(TRAILER_OPEN);
  if (index >= 0 && text.endsWith(TRAILER_CLOSE)) {
    const raw = text.slice(index + TRAILER_OPEN.length, text.length - TRAILER_CLOSE.length);
    if (raw.length <= MAX_TRAILER_CHARS) {
      try {
        const detail = sanitizeDetail(JSON.parse(raw));
        if (detail) return { detail, message: text.slice(0, index) };
      } catch {
        // Fall through to the prefix classification.
      }
    }
  }
  const code = prefixCode(text);
  return { detail: code ? { code } : null, message: text };
}
