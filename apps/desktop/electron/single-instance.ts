import type { BrowserWindow } from "electron";

type SingleInstanceApp = Pick<
  Electron.App,
  "requestSingleInstanceLock" | "quit" | "on"
>;

type FocusableWindow = Pick<BrowserWindow, "isMinimized" | "restore" | "focus">;

/**
 * Claims the single-instance lock, or quits.
 *
 * Two instances would share one `userData` directory: each spawns its own
 * backend against the same storage, and the second silently takes a fallback
 * port and starts a duplicate set of bridge processes. The lock is scoped to
 * `userData`, so a dev build and a packaged build (which share it) exclude each
 * other too — which is why `app.setPath("userData", ...)` must already have run.
 *
 * Returns whether this process is the primary instance. The caller must skip
 * *all* startup work when it is not: `app.quit()` is asynchronous, so module
 * evaluation continues after this returns.
 */
export function claimSingleInstanceLock(app: SingleInstanceApp): boolean {
  const isPrimaryInstance = app.requestSingleInstanceLock();
  if (!isPrimaryInstance) app.quit();
  return isPrimaryInstance;
}

/**
 * Surfaces the existing window when a second launch is attempted.
 *
 * Without this the second launch quits silently and the user sees nothing
 * happen, which reads as the app being broken rather than already running.
 */
export function registerSecondInstanceFocus(
  app: Pick<Electron.App, "on">,
  getWindow: () => FocusableWindow | null,
): void {
  app.on("second-instance", () => {
    const window = getWindow();
    // Startup may not have created the window yet, or it may have been closed
    // on a platform where that does not quit the app.
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
}
