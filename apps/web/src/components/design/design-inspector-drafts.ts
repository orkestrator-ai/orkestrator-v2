/**
 * Bounded in-memory retention of unsent inspector drafts, so values survive
 * inspection refresh, target switches, and inspector remounts. Client-only;
 * never persisted and never treated as committed state.
 */

export const INSPECTOR_DRAFT_LIMIT = 16;

export interface InspectorDraftTarget {
  environmentKey: string;
  frameId: string;
  selector: string;
  /** Backend structure identity; absent on v1 backends. */
  structureId?: string;
}

export interface InspectorDraft {
  /** Draft value per property; null removes the inline declaration. */
  values: Record<string, string | null>;
  /** Authored baseline observed when each property was first edited. */
  bases: Record<string, string>;
}

interface Entry extends InspectorDraft {
  target: InspectorDraftTarget;
}

// Map insertion order doubles as least-recently-used order.
const drafts = new Map<string, Entry>();

export function inspectorDraftKey(target: InspectorDraftTarget): string {
  return JSON.stringify([
    target.environmentKey,
    target.frameId,
    target.selector,
    target.structureId ?? null,
  ]);
}

export function readInspectorDraft(target: InspectorDraftTarget): InspectorDraft | undefined {
  const key = inspectorDraftKey(target);
  const entry = drafts.get(key);
  if (!entry) return undefined;
  drafts.delete(key);
  drafts.set(key, entry);
  return { values: { ...entry.values }, bases: { ...entry.bases } };
}

/** Stores a draft; an empty draft deletes the entry. Evicts the oldest beyond the limit. */
export function writeInspectorDraft(
  target: InspectorDraftTarget,
  draft: InspectorDraft | undefined,
) {
  const key = inspectorDraftKey(target);
  drafts.delete(key);
  if (!draft || Object.keys(draft.values).length === 0) return;
  drafts.set(key, {
    target: { ...target },
    values: { ...draft.values },
    bases: { ...draft.bases },
  });
  while (drafts.size > INSPECTOR_DRAFT_LIMIT) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

/**
 * A draft left for the same element path under a different structure identity
 * (the frame changed structurally). It is offered, never applied automatically.
 */
export function findEarlierInspectorDraft(
  target: InspectorDraftTarget,
): { target: InspectorDraftTarget; draft: InspectorDraft } | undefined {
  const key = inspectorDraftKey(target);
  let found: Entry | undefined;
  for (const [candidateKey, entry] of drafts) {
    if (
      candidateKey !== key &&
      entry.target.environmentKey === target.environmentKey &&
      entry.target.frameId === target.frameId &&
      entry.target.selector === target.selector
    )
      found = entry;
  }
  return found
    ? {
        target: { ...found.target },
        draft: { values: { ...found.values }, bases: { ...found.bases } },
      }
    : undefined;
}

export function inspectorDraftCount(): number {
  return drafts.size;
}

export function clearInspectorDrafts() {
  drafts.clear();
}
