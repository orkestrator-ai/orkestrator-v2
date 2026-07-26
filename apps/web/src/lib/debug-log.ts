// Debug logging gate for the renderer's hot paths.
//
// The bridge clients receive an SSE frame roughly ten times a second per
// running turn, and the transcript refetch that follows a frame carries the
// whole conversation. Logging either unconditionally means the console holds a
// reference to every frame and every transcript for the life of the tab, which
// is the same cost the bridge-side `debugLog` gate exists to avoid — just
// moved into the browser.
//
// Diagnostics that fire per frame or per transcript therefore go through
// `rendererDebugLog`. Anything that happens at most once per user action can
// keep using `console.*` directly.

/** localStorage key that turns renderer debug logging on. */
export const DEBUG_LOG_STORAGE_KEY = "orkestrator:debug";

/**
 * Whether the stored preference enables debug logging.
 *
 * Exported so the parsing is testable without reloading the module. Any value
 * except the conventional "off" spellings enables it, matching the bridge's
 * `CLAUDE_BRIDGE_DEBUG` handling.
 */
export function readDebugPreference(raw: string | null | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return false;
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

function readStoredPreference(): boolean {
  try {
    return readDebugPreference(globalThis.localStorage?.getItem(DEBUG_LOG_STORAGE_KEY));
  } catch {
    // localStorage throws in a sandboxed frame or when storage is disabled.
    return false;
  }
}

/**
 * Read once at module load. A storage lookup per SSE frame would itself be
 * measurable, and the flag is not meant to change without a reload.
 */
export const isRendererDebugLoggingEnabled: boolean = readStoredPreference();

/**
 * Log only when the debug preference is set.
 *
 * Callers on a per-frame path must guard argument construction with
 * `isRendererDebugLoggingEnabled` rather than relying on this to discard it —
 * the point is to avoid building the payload, not just the write.
 */
export function rendererDebugLog(...args: unknown[]): void {
  if (!isRendererDebugLoggingEnabled) return;
  console.debug(...args);
}
