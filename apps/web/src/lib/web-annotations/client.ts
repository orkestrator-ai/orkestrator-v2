/**
 * Typed renderer client for the backend web annotation service.
 *
 * Every call goes through the existing authenticated `invoke` transport. The
 * backend owns annotations; this module only shapes requests, classifies the
 * contract's typed errors, and derives stable operation identities so a
 * retry after a lost response can be recognized instead of repeated.
 */
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_CONFLICT,
  WEB_ANNOTATION_CONTRACT_VERSION,
  WEB_ANNOTATION_DEGRADED,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_UNAVAILABLE,
  parseWebAnnotationError,
  type WebAnnotationCapabilities,
  type WebAnnotationCapacityResource,
  type WebAnnotationCommandArgs,
  type WebAnnotationCommandResults,
  type WebAnnotationErrorCode,
  type WebAnnotationErrorDetail,
  type WebAnnotationRolloutMode,
} from "@orkestrator/protocol/web-annotations";
import { invoke } from "@/lib/native/backend";

export type WebAnnotationCommandName = keyof WebAnnotationCommandArgs;

export function webAnnotationCommand<K extends WebAnnotationCommandName>(
  command: K,
  args: WebAnnotationCommandArgs[K],
): Promise<WebAnnotationCommandResults[K]> {
  return invoke<WebAnnotationCommandResults[K]>(command, args as Record<string, unknown>);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** Typed codes from the error trailer, plus transport-level kinds. */
export type WebAnnotationErrorKind = WebAnnotationErrorCode | "unsupported" | "other";

const UNSUPPORTED_COMMAND =
  /unknown (backend )?command|unsupported command|command not found|no handler for|not a registered command/i;

/**
 * Typed detail of a failure (see `web-annotations-errors.ts`) and its human
 * message with the machine trailer removed. The trailer is never shown.
 */
export function webAnnotationErrorDetail(error: unknown): {
  detail: WebAnnotationErrorDetail | null;
  message: string;
} {
  const parsed = parseWebAnnotationError(errorMessage(error));
  // Read-only and disabled share one prefix; older backends omit the trailer.
  if (
    parsed.detail?.code === "disabled" &&
    !parsed.detail.mode &&
    /read-only/i.test(parsed.message)
  ) {
    return {
      detail: { ...parsed.detail, code: "read-only", mode: "read-only" },
      message: parsed.message,
    };
  }
  return parsed;
}

/** Classify a failure by its typed trailer or the contract's stable prefixes. */
export function classifyWebAnnotationError(error: unknown): WebAnnotationErrorKind {
  const { detail, message } = webAnnotationErrorDetail(error);
  if (detail) return detail.code;
  if (UNSUPPORTED_COMMAND.test(message)) return "unsupported";
  return "other";
}

export function isWebAnnotationConflict(error: unknown): boolean {
  return classifyWebAnnotationError(error) === "conflict";
}

const TRANSIENT =
  /disconnect|network|failed to fetch|fetch failed|timed? ?out|econn|socket|offline|not connected|unreachable|temporarily|\b50[234]\b/i;

/**
 * A transport failure that may succeed unchanged later (reconnect, backend
 * restart). Typed domain errors and validation failures are never transient:
 * those need the user, so automatic retries stop.
 */
export function isTransientWebAnnotationError(error: unknown): boolean {
  const { detail, message } = webAnnotationErrorDetail(error);
  if (detail) return false;
  return TRANSIENT.test(message);
}

const CAPACITY_RESOURCE_LABELS: Record<WebAnnotationCapacityResource, string> = {
  annotations: "notes in this environment",
  requests: "agent requests in this environment",
  "metadata-bytes": "note storage in this environment",
  "image-bytes": "image storage in this environment",
  "image-size": "image size",
  "image-dimensions": "image dimensions",
  "thread-entries": "entries in this note's discussion",
  "thread-bytes": "text in this note's discussion",
  drafts: "unsaved drafts",
  "draft-text": "draft length",
  "record-bytes": "record size",
  "queued-writes": "pending changes",
  preparations: "requests being prepared",
  "request-annotations": "notes in one request",
  instruction: "instruction length",
  "desired-outcome": "desired outcome length",
  "result-revisions": "result revisions",
  payload: "request size",
};

const BYTE_RESOURCES = new Set<WebAnnotationCapacityResource>([
  "metadata-bytes",
  "image-bytes",
  "image-size",
  "thread-bytes",
  "record-bytes",
  "payload",
]);

function formatQuantity(resource: WebAnnotationCapacityResource | undefined, value: number) {
  if (resource && BYTE_RESOURCES.has(resource)) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return value.toLocaleString("en-US");
}

function capacityMessage(detail: WebAnnotationErrorDetail, fallback: string): string {
  const resource = detail.resource;
  const usage =
    detail.used !== undefined && detail.limit !== undefined
      ? ` (${formatQuantity(resource, detail.used)} of ${formatQuantity(resource, detail.limit)})`
      : detail.limit !== undefined
        ? ` (limit ${formatQuantity(resource, detail.limit)})`
        : "";
  if (resource === "thread-entries" || resource === "thread-bytes") {
    return detail.archivable
      ? `This note's discussion is full${usage}. Archive it and continue in a new note; your text is kept.`
      : `This note's discussion is full${usage}. Your text is kept.`;
  }
  if (!resource) return fallback ? `Capacity reached: ${fallback}` : "Annotation capacity reached.";
  return `Limit reached for ${CAPACITY_RESOURCE_LABELS[resource]}${usage}. Your text is kept.`;
}

function stripPrefix(message: string): string {
  for (const prefix of [
    WEB_ANNOTATION_CONFLICT,
    WEB_ANNOTATION_CAPACITY,
    WEB_ANNOTATION_DEGRADED,
    WEB_ANNOTATION_UNAVAILABLE,
  ]) {
    const index = message.indexOf(prefix);
    if (index >= 0) return message.slice(index + prefix.length).trim();
  }
  return message.trim();
}

/** Friendly text for any web annotation failure; never shows the typed trailer. */
export function describeWebAnnotationError(error: unknown): string {
  const { detail, message } = webAnnotationErrorDetail(error);
  const rest = stripPrefix(message);
  switch (detail?.code) {
    case "conflict":
      return rest ? `This changed elsewhere: ${rest}` : "This changed elsewhere.";
    case "capacity":
      return capacityMessage(detail, rest);
    case "degraded":
      return rest ? `Annotation storage is degraded: ${rest}` : "Annotation storage is degraded.";
    case "not-found":
      return "This note or record no longer exists.";
    case "read-only":
      return "Web annotations are read-only on this backend (recovery mode). You can read and resolve notes and manage requests already sent; new notes and requests are paused.";
    case "disabled":
      return "Web annotations are turned off on this backend.";
    case "archived":
      return "This note was archived and continues in a new note.";
    case "unsupported-version":
      return "This was saved by a newer version of Orkestrator. Update Orkestrator to change it.";
    case "upgrade-required":
      return "This change needs a newer version of Orkestrator. Update the app; your text is kept.";
    default:
      return message;
  }
}

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** A fresh client-generated operation id (one per user intent, reused on retry). */
export function newWebAnnotationOperationId(prefix = "op"): string {
  return boundedId(`${prefix}-${randomId()}`);
}

const ID_UNSAFE = /[^A-Za-z0-9._:-]/g;

/** Coerce an arbitrary seed into the contract's id alphabet and length. */
export function boundedId(value: string): string {
  const cleaned = value.replace(ID_UNSAFE, "-").replace(/^[^A-Za-z0-9]+/, "");
  return (cleaned || "id").slice(0, WEB_ANNOTATION_LIMITS.idChars);
}

/**
 * Operation ids derived from the desktop capture id. They are stable across
 * renderer restarts, so a retry after a lost response can query the receipt
 * of the original attempt instead of creating a duplicate annotation.
 */
export function captureOperationIds(captureId: string) {
  return {
    asset: boundedId(`wa-asset:${captureId}`),
    /** Region crop staged next to its source screenshot. */
    cropAsset: boundedId(`wa-crop:${captureId}`),
    create: boundedId(`wa-create:${captureId}`),
    replace: boundedId(`wa-replace:${captureId}`),
    result: boundedId(`wa-result:${captureId}`),
  };
}

/** Strip a PNG data URL prefix; the backend expects bare base64. */
export function pngBase64FromDataUrl(dataUrl: string): string {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) throw new Error("The capture image is not a PNG");
  const base64 = dataUrl.slice(prefix.length);
  if (!base64) throw new Error("The capture image is empty");
  return base64;
}

export type CapabilityFetch =
  | { status: "available"; capabilities: WebAnnotationCapabilities }
  | { status: "unavailable"; reason: string }
  | { status: "error"; error: string };

function isCapabilities(value: unknown): value is WebAnnotationCapabilities {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WebAnnotationCapabilities>;
  return (
    record.contractVersion === WEB_ANNOTATION_CONTRACT_VERSION &&
    typeof record.storage === "string" &&
    typeof record.operations === "object" &&
    record.operations !== null &&
    Array.isArray(record.targets)
  );
}

/**
 * Discover backend support. An older backend (unknown command, missing or
 * incompatible payload) is an explicit "unavailable" state: the client makes
 * no annotation writes against it.
 */
export async function fetchWebAnnotationCapabilities(
  environmentId?: string,
): Promise<CapabilityFetch> {
  try {
    const result = await webAnnotationCommand(
      WEB_ANNOTATION_COMMANDS.capabilities,
      environmentId ? { environmentId } : {},
    );
    if (!isCapabilities(result)) {
      return {
        status: "unavailable",
        reason: "This backend does not support web annotations. Update the backend to use them.",
      };
    }
    return { status: "available", capabilities: result };
  } catch (error) {
    if (classifyWebAnnotationError(error) === "unsupported") {
      return {
        status: "unavailable",
        reason: "This backend does not support web annotations. Update the backend to use them.",
      };
    }
    return { status: "error", error: describeWebAnnotationError(error) };
  }
}

/** Capability switches the UI enables only when every layer agrees. */
export interface WebAnnotationFeatureFlags {
  /** Backend rollout mode; `enabled` when an older backend does not report one. */
  mode: WebAnnotationRolloutMode;
  read: boolean;
  /** Create feedback: new notes, replies, edits, titles, deletes. */
  author: boolean;
  /** Unsent editor drafts (kept in read-only recovery mode so typing is not lost). */
  drafts: boolean;
  capture: boolean;
  dispatch: boolean;
  batch: boolean;
  comparison: boolean;
  /** Accept/resolve and reopen. */
  resolve: boolean;
  /** Inspect, stop, and recover requests already sent. */
  recover: boolean;
  /** Archive a full thread and continue in a linked new one. */
  archive: boolean;
  maxRequestAnnotations: number;
}

export const NO_WEB_ANNOTATION_FEATURES: WebAnnotationFeatureFlags = Object.freeze({
  mode: "enabled",
  read: false,
  author: false,
  drafts: false,
  capture: false,
  dispatch: false,
  batch: false,
  comparison: false,
  resolve: false,
  recover: false,
  archive: false,
  maxRequestAnnotations: 1,
});

export function webAnnotationFeatures(
  capabilities: WebAnnotationCapabilities | null,
  desktopCapture: boolean,
): WebAnnotationFeatureFlags {
  if (!capabilities) return NO_WEB_ANNOTATION_FEATURES;
  const mode: WebAnnotationRolloutMode = capabilities.mode ?? "enabled";
  if (capabilities.storage === "unavailable" || mode === "disabled") {
    return { ...NO_WEB_ANNOTATION_FEATURES, mode };
  }
  const writable = capabilities.storage === "ready";
  const operations = capabilities.operations;
  const enabled = mode === "enabled";
  const author = writable && enabled && operations.author;
  const dispatch = writable && enabled && operations.dispatch;
  return {
    mode,
    read: operations.read,
    author,
    // Older backends without a rollout mode tie drafts to authoring.
    drafts: operations.read && writable && (capabilities.mode ? true : author),
    capture: author && operations.captureAccept && desktopCapture,
    dispatch,
    batch: dispatch && operations.batch,
    comparison: author && operations.comparison && desktopCapture,
    resolve: writable && (operations.resolve ?? author),
    recover: operations.read && (operations.recover ?? dispatch),
    archive: author && operations.archive === true,
    maxRequestAnnotations: Math.max(
      1,
      Math.min(
        WEB_ANNOTATION_LIMITS.briefAnnotations,
        operations.batch ? capabilities.maxRequestAnnotations : 1,
      ),
    ),
  };
}
