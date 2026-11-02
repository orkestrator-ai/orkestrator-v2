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
 * The backend's boot-time container reachability check opens this modal a few
 * seconds after startup on a host whose firewall drops Docker's traffic to the
 * host (beelink's ufw does). It hides the rest of the window from role queries
 * whichever step is running, so it is closed through its own Close control, as
 * the browser specs do (`browser-gateway.spec.ts`). Nothing is written to the
 * profile. The Electron specs use local worktree environments, which the
 * notice says are not affected.
 */
const REACHABILITY_DIALOG = "Docker containers can't reach Orkestrator";

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
    const reachability = page.getByRole("dialog", { name: REACHABILITY_DIALOG, exact: true });
    page
      .addLocatorHandler(reachability, (dialog) =>
        dialog.getByRole("button", { name: "Close", exact: true }).last().click(),
      )
      .catch(() => undefined);
  };
  for (const page of app.windows()) watch(page);
  app.on("window", watch);
}
