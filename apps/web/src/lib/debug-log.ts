// The renderer's log level.
//
// The renderer has no process environment, so `ORKESTRATOR_LOG_LEVEL` cannot
// reach it. A localStorage preference raises it instead: Settings → Debug →
// Renderer Debug Logging sets it and reloads, or by hand in DevTools,
// `localStorage.setItem("orkestrator:debug", "1")`, then reload. It belongs to
// this window's storage, not the host, so another client sets its own.
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
 * except the conventional "off" spellings enables it. (The bridges are
 * stricter: `ORKESTRATOR_BRIDGE_DEBUG` is enabled only by `1`.)
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

let activeAtStart = false;

/**
 * Read once, at renderer start. A storage lookup per SSE frame would itself be
 * measurable, and the flag is not meant to change without a reload.
 */
export function applyRendererLogLevel(): void {
  activeAtStart = readStoredPreference();
  if (activeAtStart) configureLogger({ level: "debug" });
}

/** Whether this renderer started with debug logging on: what is in force now. */
export function rendererDebugLoggingActive(): boolean {
  return activeAtStart;
}

interface PreferenceStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Sets or clears the preference in this window's storage and reloads, because
 * the level is read only at start. False when storage refused the write, in
 * which case nothing reloads.
 */
export function setRendererDebugPreference(
  enabled: boolean,
  {
    storage,
    reload = () => globalThis.location.reload(),
  }: { storage?: PreferenceStorage; reload?: () => void } = {},
): boolean {
  try {
    storage ??= globalThis.localStorage;
    if (enabled) storage.setItem(DEBUG_LOG_STORAGE_KEY, "1");
    else storage.removeItem(DEBUG_LOG_STORAGE_KEY);
  } catch {
    return false;
  }
  reload();
  return true;
}

interface DesktopWindowApi {
  setRendererDebugLogging?(enabled: boolean): Promise<boolean>;
}

/** Whether this window runs in the desktop app, which has a Help → Open Developer Tools. */
export function canOfferDeveloperTools(
  api: DesktopWindowApi | undefined = globalThis.window?.orkestrator?.window,
): boolean {
  return typeof api?.setRendererDebugLogging === "function";
}

/**
 * Tells the desktop's main process what this renderer started with, so Help
 * offers Open Developer Tools only while it is on. Off is reported too, so a
 * reload that turned it off takes the item away. A browser tab has no main
 * process and an older desktop no route; both are a no-op.
 */
export function reportRendererDebugLogging(
  api: DesktopWindowApi | undefined = globalThis.window?.orkestrator?.window,
): void {
  if (!canOfferDeveloperTools(api)) return;
  try {
    void api!.setRendererDebugLogging!(activeAtStart).catch(() => undefined);
  } catch {
    // The menu item is a convenience; the renderer must start regardless.
  }
}

interface NativeShellApi {
  setWebInspectable?(enabled: boolean): Promise<unknown>;
}

/** Whether this page runs in the iOS app, whose shell can open it to Safari's Web Inspector. */
export function canOfferWebInspector(
  shell: NativeShellApi | undefined = globalThis.window?.orkestratorNativeShell,
): boolean {
  return typeof shell?.setWebInspectable === "function";
}

/**
 * The iOS counterpart of `reportRendererDebugLogging`: tells the app's shell
 * what this renderer started with, so its web view is inspectable from a
 * Mac's Safari only while debug logging is on in this page. Off is reported
 * too. Anywhere else, and in an older app, this is a no-op.
 */
export function reportWebInspectable(
  shell: NativeShellApi | undefined = globalThis.window?.orkestratorNativeShell,
): void {
  if (!canOfferWebInspector(shell)) return;
  try {
    void shell!.setWebInspectable!(activeAtStart).catch(() => undefined);
  } catch {
    // Inspection is a convenience; the renderer must start regardless.
  }
}
