/**
 * Bounded local copy of unsaved annotation editor text.
 *
 * The backend draft is the authority, but text typed while the backend is
 * unreachable would otherwise live only in React state and vanish on unmount
 * or reload. Each editor (environment + editor id) keeps at most one entry,
 * written on every change and removed once the backend holds the same text.
 * `baseRevision` is the backend draft revision the text was typed against, so
 * restoring it can never silently overwrite a newer server draft.
 */
import { WEB_ANNOTATION_LIMITS } from "@orkestrator/protocol/web-annotations";

const KEY = "orkestrator.web-annotations.local-drafts.v1";
/** Editors with unsaved local text kept at once (oldest dropped first). */
export const MAX_LOCAL_DRAFTS = 32;
/** Unsaved local text older than this is dropped. */
export const LOCAL_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LocalDraft {
  text: string;
  baseRevision: number;
  updatedAt: number;
}

function key(environmentId: string, editorId: string) {
  return `${environmentId}\u0000${editorId}`;
}

function read(): Record<string, LocalDraft> {
  try {
    const raw = window.localStorage?.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, LocalDraft>)
      : {};
  } catch {
    return {};
  }
}

function write(record: Record<string, LocalDraft>) {
  const cutoff = Date.now() - LOCAL_DRAFT_TTL_MS;
  const entries = Object.entries(record)
    .filter(
      ([, draft]) =>
        draft &&
        typeof draft.text === "string" &&
        typeof draft.baseRevision === "number" &&
        typeof draft.updatedAt === "number" &&
        draft.updatedAt >= cutoff,
    )
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_LOCAL_DRAFTS);
  try {
    window.localStorage?.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage full or unavailable: the text still lives in the open editor.
  }
}

export function readLocalDraft(environmentId: string, editorId: string): LocalDraft | null {
  const draft = read()[key(environmentId, editorId)];
  if (!draft || typeof draft.text !== "string" || typeof draft.baseRevision !== "number") {
    return null;
  }
  if (Date.now() - draft.updatedAt > LOCAL_DRAFT_TTL_MS) return null;
  return draft;
}

export function writeLocalDraft(
  environmentId: string,
  editorId: string,
  text: string,
  baseRevision: number,
) {
  const record = read();
  record[key(environmentId, editorId)] = {
    text: text.slice(0, WEB_ANNOTATION_LIMITS.entryChars),
    baseRevision,
    updatedAt: Date.now(),
  };
  write(record);
}

export function clearLocalDraft(environmentId: string, editorId: string) {
  const record = read();
  const id = key(environmentId, editorId);
  if (!(id in record)) return;
  delete record[id];
  write(record);
}
