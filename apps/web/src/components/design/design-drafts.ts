import type { DesignIntent } from "@/stores/designStore";

/**
 * Per-client persistence for unsettled design intents: drafts that were never
 * sent, operation tokens whose outcome is not yet known, and rejected edits the
 * user has not reviewed. Restored intents never run without an explicit Resume.
 */
const STORAGE_KEY = "orkestrator.design.intents.v1";
export const DRAFT_LIMITS = { perCanvas: 8, perClient: 32, bytes: 2 * 1024 * 1024 } as const;

type Stored = Record<string, Array<Omit<DesignIntent, "restored" | "blocked">>>;

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
    if (!raw || raw.length > DRAFT_LIMITS.bytes * 2) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

/** Persistable: anything whose outcome is not a verified success or deliberate discard. */
export function isPersistable(intent: DesignIntent): boolean {
  if (intent.phase !== "settled") return true;
  return (
    intent.outcome !== "committed" && intent.outcome !== "no-op" && intent.outcome !== "canceled"
  );
}

export function loadDrafts(key: string): DesignIntent[] {
  const entries = readAll()[key];
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(
      (entry) =>
        entry && typeof entry.id === "string" && entry.descriptor && typeof entry.lane === "string",
    )
    .slice(0, DRAFT_LIMITS.perCanvas)
    .map((entry) => ({ ...entry, restored: true }));
}

/**
 * Saves a canvas's unsettled intents. Returns false (keeping the previous
 * stored set) when accepted work would exceed bounds. Tokenless drafts are
 * best-effort; leaving them out never strands a prepared backend operation.
 */
export function saveDrafts(key: string, intents: DesignIntent[]): boolean {
  const target = storage();
  if (!target) return false;
  const all = readAll();
  const unsettled = intents.filter(isPersistable);
  const accepted = unsettled.filter((intent) => intent.token || intent.outcome === "unknown");
  if (accepted.length > DRAFT_LIMITS.perCanvas) return false;
  const available = DRAFT_LIMITS.perCanvas - accepted.length;
  const persisted = [
    ...accepted,
    ...unsettled.filter((intent) => !accepted.includes(intent)).slice(0, available),
  ].map(({ restored: _restored, blocked: _blocked, ...rest }) => rest);
  if (persisted.length) all[key] = persisted;
  else delete all[key];
  const total = Object.values(all).reduce((count, entries) => count + entries.length, 0);
  if (total > DRAFT_LIMITS.perClient) {
    const otherCount = total - persisted.length;
    if (otherCount + accepted.length > DRAFT_LIMITS.perClient) return false;
    all[key] = persisted.slice(0, DRAFT_LIMITS.perClient - otherCount);
  }
  const serialized = JSON.stringify(all);
  if (serialized.length > DRAFT_LIMITS.bytes) return false;
  try {
    if (Object.keys(all).length) target.setItem(STORAGE_KEY, serialized);
    else target.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function draftKeys(): string[] {
  return Object.keys(readAll());
}
