/**
 * One-time migration of the per-browser intent store this client used before
 * the backend owned each document's intent queue (`design_intents`). Entries
 * are read once, imported into the backend, and removed; nothing else reads
 * localStorage for design intents.
 */
const STORAGE_KEY = "orkestrator.design.intents.v1";
/** The legacy store's own bound; anything larger was never written by it. */
const MAX_LEGACY_BYTES = 4 * 1024 * 1024;

type Stored = Record<string, unknown[]>;

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function readAll(): Stored {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_LEGACY_BYTES) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

/**
 * Legacy entries of one canvas: the shared `${backend}|${env}|${canvas}` key
 * and every per-tab `${backend}|${env}|${canvas}|${clientId}` key.
 */
export function readLegacyDrafts(canvasKey: string): { keys: string[]; intents: unknown[] } {
  const all = readAll();
  const keys = Object.keys(all).filter(
    (key) => key === canvasKey || key.startsWith(`${canvasKey}|`),
  );
  const intents = keys.flatMap((key) => (Array.isArray(all[key]) ? all[key] : []));
  return { keys, intents };
}

/** Removes migrated keys; the store itself goes once it is empty. */
export function clearLegacyDrafts(keys: string[]): void {
  const target = storage();
  if (!target || !keys.length) return;
  const all = readAll();
  for (const key of keys) delete all[key];
  try {
    if (Object.keys(all).length) target.setItem(STORAGE_KEY, JSON.stringify(all));
    else target.removeItem(STORAGE_KEY);
  } catch {
    /* A full or blocked store keeps the entries; the backend skips duplicates. */
  }
}
