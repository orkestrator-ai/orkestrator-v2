import type { DesignViewport } from "./design-viewport";

/**
 * Small per-client view preferences (pan, zoom, selected frame, panels) keyed
 * by backend/environment/canvas. No HTML, drafts or execution state.
 */
export interface DesignViewPrefs {
  viewport?: DesignViewport;
  frameId?: string | null;
  layers?: boolean;
  layersWidth?: number;
  history?: boolean;
}

const STORAGE_KEY = "orkestrator.design.view.v1";
const MAX_ENTRIES = 64;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function readAll(): Record<string, DesignViewPrefs & { at?: number }> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, DesignViewPrefs & { at?: number }>)
      : {};
  } catch {
    return {};
  }
}

export function loadViewPrefs(key: string): DesignViewPrefs {
  const entry = readAll()[key];
  return entry && typeof entry === "object" ? entry : {};
}

/** Throttled write; the latest value for a key wins. */
export function saveViewPrefs(key: string, prefs: DesignViewPrefs, delayMs = 400) {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      try {
        const all = readAll();
        all[key] = { ...all[key], ...prefs, at: Date.now() };
        const entries = Object.entries(all)
          .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
          .slice(0, MAX_ENTRIES);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
      } catch {
        // Preferences are best effort.
      }
    }, delayMs),
  );
}
