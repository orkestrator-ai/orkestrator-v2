import type { ElectronApplication, Page } from "playwright";

/**
 * Startup dialogs that can open over the workspace in an isolated Electron
 * profile, by their dismiss buttons (the same pair the browser specs close).
 * The Electron specs launch with an empty platform selection, so the profile
 * provisions no managed `gh`, and agent-test host tool checks never fall back
 * to PATH (`apps/backend/src/core/host-tools.ts`): "GitHub CLI Not Found"
 * opens on every start.
 */
const STARTUP_DIALOG_BUTTONS = ["Continue Without Docker", "Continue Without GitHub CLI"];

/**
 * Close those dialogs whenever one appears in any window of `app`, including
 * windows opened later. Each is dismissed for this run only; "Don't remind me
 * again" stays unticked, so nothing is written to the profile.
 */
export function dismissStartupDialogs(app: ElectronApplication): void {
  const watch = (page: Page) => {
    for (const name of STARTUP_DIALOG_BUTTONS) {
      page
        .addLocatorHandler(page.getByRole("button", { name, exact: true }), (button) =>
          button.click(),
        )
        .catch(() => undefined);
    }
  };
  for (const page of app.windows()) watch(page);
  app.on("window", watch);
}
