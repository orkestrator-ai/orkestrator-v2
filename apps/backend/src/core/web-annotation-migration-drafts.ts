/**
 * Pure helpers over legacy native compose-draft values for the web
 * annotation migration: find unmigrated browser notes, replace migrated ones
 * with lightweight references, and derive draft identities. Nothing here does
 * I/O or logs draft content.
 */
import { createHash } from "node:crypto";
import { WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT } from "@orkestrator/protocol/web-annotations";

const LEGACY_TEXT_CHARS = 12_000;
const LEGACY_COMMENT_CHARS = 2_000;

export interface LegacyBrowserAnnotation {
  id: string;
  text: string;
  comment: string;
  screenshotPath: string | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Valid, not-yet-migrated `source: "browser"` annotations in a native compose
 * draft value. Migrated references (`migratedTo`) are skipped.
 */
export function extractLegacyBrowserAnnotations(value: unknown): LegacyBrowserAnnotation[] {
  if (!isRecord(value) || !Array.isArray(value.annotations)) return [];
  const attachments = Array.isArray(value.attachments) ? value.attachments : [];
  const found: LegacyBrowserAnnotation[] = [];
  const seen = new Set<string>();
  for (const item of value.annotations) {
    if (
      !isRecord(item) ||
      item.source !== "browser" ||
      item.migratedTo !== undefined ||
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      item.id.length > 200 ||
      typeof item.text !== "string" ||
      !item.text.trim() ||
      item.text.length > LEGACY_TEXT_CHARS ||
      typeof item.comment !== "string" ||
      item.comment.length > LEGACY_COMMENT_CHARS ||
      (item.screenshotPath !== undefined &&
        (typeof item.screenshotPath !== "string" || item.screenshotPath.length > 4_096)) ||
      seen.has(item.id)
    ) {
      continue;
    }
    seen.add(item.id);
    const linked = attachments.find(
      (attachment) =>
        isRecord(attachment) &&
        attachment.annotationId === item.id &&
        typeof attachment.path === "string" &&
        attachment.path.length <= 4_096,
    ) as Record<string, unknown> | undefined;
    found.push({
      id: item.id,
      text: item.text,
      comment: item.comment,
      screenshotPath:
        (item.screenshotPath as string | undefined) ?? (linked?.path as string | undefined) ?? null,
    });
  }
  return found;
}

/**
 * Remove imported browser annotations and only their linked attachments.
 * Every other field and array element is preserved in its original order.
 */
export function removeLegacyBrowserAnnotations(value: unknown, ids: ReadonlySet<string>): unknown {
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = { ...value };
  if (Array.isArray(value.annotations)) {
    next.annotations = value.annotations.filter(
      (item) =>
        !(
          isRecord(item) &&
          item.source === "browser" &&
          typeof item.id === "string" &&
          ids.has(item.id)
        ),
    );
  }
  if (Array.isArray(value.attachments)) {
    next.attachments = value.attachments.filter(
      (item) =>
        !(isRecord(item) && typeof item.annotationId === "string" && ids.has(item.annotationId)),
    );
  }
  return next;
}

/**
 * Replace migrated legacy browser annotations with lightweight references
 * (`migratedTo` names the thread; the text is a fixed neutral placeholder so
 * no client can resurrect the note into a new prompt) and remove only their
 * linked attachments. Every other field and element keeps its order.
 */
export function replaceLegacyBrowserAnnotations(
  value: unknown,
  mapping: ReadonlyMap<string, string>,
): unknown {
  if (!isRecord(value) || mapping.size === 0) return value;
  const next: Record<string, unknown> = { ...value };
  if (Array.isArray(value.annotations)) {
    next.annotations = value.annotations.map((item) => {
      if (
        !isRecord(item) ||
        item.source !== "browser" ||
        item.migratedTo !== undefined ||
        typeof item.id !== "string" ||
        !mapping.has(item.id)
      ) {
        return item;
      }
      return {
        id: item.id,
        source: "browser",
        text: WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT,
        comment: "",
        migratedTo: mapping.get(item.id)!,
      };
    });
  }
  if (Array.isArray(value.attachments)) {
    next.attachments = value.attachments.filter(
      (item) =>
        !(
          isRecord(item) &&
          typeof item.annotationId === "string" &&
          mapping.has(item.annotationId)
        ),
    );
  }
  return next;
}

/** True when a value holds at least one unmigrated browser annotation. */
export function hasUnmigratedBrowserAnnotations(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.annotations) &&
    value.annotations.some(
      (item) => isRecord(item) && item.source === "browser" && item.migratedTo === undefined,
    )
  );
}

/** `<namespace>:<environmentId>:<encoded session key>` → session key. */
export function composeDraftSessionKey(draftKey: string, environmentId: string): string | null {
  const marker = `:${environmentId}:`;
  const index = draftKey.indexOf(marker);
  if (index <= 0) return null;
  try {
    return decodeURIComponent(draftKey.slice(index + marker.length));
  } catch {
    return null;
  }
}

/**
 * A trusted, neutral title. The legacy comment was typed into the page's own
 * UI and stays untrusted `legacy-page-comment` evidence; it never becomes a
 * title (which clients render as trusted chrome). A short digest of the
 * import identity distinguishes several imported notes in a list.
 */
export function legacyTitle(environmentId: string, legacyId: string): string {
  return `Imported browser note ${sha(`${environmentId}\0${legacyId}`).slice(0, 6)}`;
}

/** Stable thread id of a legacy note: identity is (environmentId, legacyId). */
export function legacyAnnotationId(environmentId: string, legacyId: string): string {
  return `legacy-${sha(`${environmentId}\0${legacyId}`).slice(0, 32)}`;
}

export function pendingDispatchRequestId(pendingDispatch: unknown): string | undefined {
  if (!isRecord(pendingDispatch)) return undefined;
  const id = pendingDispatch.requestId;
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : undefined;
}
