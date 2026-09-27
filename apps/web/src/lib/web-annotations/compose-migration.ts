/**
 * Legacy browser notes in native compose drafts (plan step 09).
 *
 * The backend migrates persisted drafts itself. A dirty in-memory draft that
 * still holds an unmigrated browser note is reconciled through the same
 * idempotent import (`web_annotations_reconcile_draft`) when its persistence
 * resumes or its save conflicts; only the browser notes and their linked
 * attachments change, never the user's text. Migrated references
 * (`migratedTo`) are rendered as links to their thread and are never sent to
 * an agent or consumed on send.
 */
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT,
  type WebAnnotationMigratedReference,
} from "@orkestrator/protocol/web-annotations";
import {
  isTranscriptAnnotation,
  type TranscriptAnnotation,
} from "@/lib/chat/transcript-annotations";
import { webAnnotationCommand } from "./client";

export function hasUnmigratedBrowserNotes(
  annotations: readonly TranscriptAnnotation[] | undefined,
): boolean {
  return (annotations ?? []).some(
    (annotation) => annotation.source === "browser" && !annotation.migratedTo,
  );
}

export function isMigratedReference(annotation: TranscriptAnnotation): boolean {
  return annotation.source === "browser" && Boolean(annotation.migratedTo);
}

/**
 * Replace the named legacy notes with lightweight references and drop only
 * their linked attachments. Returns null when nothing changes.
 */
export function applyMigratedReferences<A extends { annotationId?: string }>(
  annotations: readonly TranscriptAnnotation[],
  attachments: readonly A[],
  references: readonly WebAnnotationMigratedReference[],
): { annotations: TranscriptAnnotation[]; attachments: A[] } | null {
  const mapping = new Map(
    references.map((reference) => [reference.legacyId, reference.annotationId]),
  );
  if (mapping.size === 0) return null;
  let changed = false;
  const nextAnnotations = annotations.map((annotation) => {
    if (annotation.source !== "browser" || annotation.migratedTo || !mapping.has(annotation.id)) {
      return annotation;
    }
    changed = true;
    return {
      id: annotation.id,
      source: "browser" as const,
      text: WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT,
      comment: "",
      migratedTo: mapping.get(annotation.id)!,
    };
  });
  const nextAttachments = attachments.filter(
    (attachment) => !attachment.annotationId || !mapping.has(attachment.annotationId),
  );
  if (nextAttachments.length !== attachments.length) changed = true;
  return changed ? { annotations: nextAnnotations, attachments: nextAttachments } : null;
}

export interface ComposeReconciliation {
  references: WebAnnotationMigratedReference[];
  /** The reconciled annotation list (valid entries only). */
  annotations: TranscriptAnnotation[] | null;
}

/**
 * Run a dirty in-memory draft value through the backend import. Null when
 * the backend does not support it or cannot import now (the draft is left
 * exactly as it was).
 */
export async function reconcileComposeDraftValue(
  environmentId: string,
  value: { annotations?: unknown[] } & Record<string, unknown>,
): Promise<ComposeReconciliation | null> {
  try {
    const result = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.reconcileDraft, {
      environmentId,
      value,
    });
    if (!result || !Array.isArray(result.references)) return null;
    const reconciled = result.value as { annotations?: unknown } | null;
    return {
      references: result.references,
      annotations: Array.isArray(reconciled?.annotations)
        ? reconciled.annotations.filter(isTranscriptAnnotation)
        : null,
    };
  } catch {
    // Older backends, read-only/disabled rollout, or offline: keep the draft.
    return null;
  }
}

/** `save_compose_draft` responses may name notes the backend mapped to threads. */
export function savedMigrationReferences(saved: unknown): WebAnnotationMigratedReference[] {
  if (!saved || typeof saved !== "object") return [];
  const migration = (saved as { webAnnotationMigration?: { references?: unknown } })
    .webAnnotationMigration;
  const references = migration?.references;
  if (!Array.isArray(references)) return [];
  return references.filter(
    (reference): reference is WebAnnotationMigratedReference =>
      Boolean(reference) &&
      typeof reference === "object" &&
      typeof (reference as WebAnnotationMigratedReference).legacyId === "string" &&
      typeof (reference as WebAnnotationMigratedReference).annotationId === "string",
  );
}
