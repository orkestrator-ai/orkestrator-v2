// The renderer's log level.
//
// The renderer has no process environment, so `ORKESTRATOR_LOG_LEVEL` cannot
// reach it. A localStorage preference raises it instead, for a developer with
// DevTools open: `localStorage.setItem("orkestrator:debug", "1")`, then reload.
//
// The bridge clients receive an SSE frame roughly ten times a second per
// running turn, and the transcript refetch that follows a frame carries the
// whole conversation. A site that fires per frame or per transcript logs at
// `debug` and passes a function for its fields, or guards other work with
// `log.isEnabled("debug")`, so that with the preference off it builds nothing.

import { configureLogger } from "@orkestrator/protocol/logger";

/** localStorage key that raises the renderer's log level to `debug`. */
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
 * Read once, at renderer start. A storage lookup per SSE frame would itself be
 * measurable, and the flag is not meant to change without a reload.
 */
export function applyRendererLogLevel(): void {
  if (readStoredPreference()) configureLogger({ level: "debug" });
}
