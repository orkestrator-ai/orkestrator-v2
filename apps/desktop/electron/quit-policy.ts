type QuitApp = Pick<Electron.App, "on" | "quit">;

/**
 * Quits when the last window closes, but never before startup has produced one.
 *
 * First-run startup is a sequence of windows with gaps between them. The agent
 * platform picker closes the moment the user chooses, and the toolchain
 * progress window is created asynchronously afterwards, so for a moment the
 * process owns no window at all. Everywhere except macOS `window-all-closed`
 * quits, which turned that gap into "the button did nothing and the app
 * disappeared": the process exited mid-startup, before the selection had even
 * been written to disk.
 *
 * The gate covers the whole startup sequence rather than one window, so a later
 * step that briefly owns no window cannot reintroduce the gap. Setup windows
 * handle an unsolicited close explicitly; known programmatic handoffs are the
 * only pre-main windowless periods left for this global policy to ignore.
 */
export function registerWindowAllClosedQuit(options: {
  app: QuitApp;
  platform: NodeJS.Platform;
  /**
   * Quit even on macOS. An `agent-test` profile is supervised by a launcher
   * that waits for the process to exit, so a windowless app that lingers in the
   * dock would hang the run.
   */
  alwaysQuit: boolean;
}): { markMainWindowCreated(): void } {
  let hasCreatedMainWindow = false;
  options.app.on("window-all-closed", () => {
    if (!hasCreatedMainWindow) return;
    if (options.platform !== "darwin" || options.alwaysQuit) options.app.quit();
  });
  return {
    markMainWindowCreated(): void {
      hasCreatedMainWindow = true;
    },
  };
}
