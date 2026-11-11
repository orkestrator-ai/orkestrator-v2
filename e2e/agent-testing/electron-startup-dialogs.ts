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
 * host (beelink's ufw does). Electron specs launch with the check off
 * (`electronSpecEnvironment`), so this matters only to a spec that turns it on. It hides the rest of the window from role queries
 * whichever step is running, so it is closed through its own Close control, as
 * the browser specs do (`browser-gateway.spec.ts`). Nothing is written to the
 * profile. The Electron specs use local worktree environments, which the
 * notice says are not affected.
 */
const REACHABILITY_DIALOG = "Docker containers can't reach Orkestrator";

/**
 * Close those dialogs whenever one appears in `page`. Each is dismissed for
 * this run only; "Don't remind me again" stays unticked, so nothing is written
 * to the profile. For a page reached over CDP, where there is no
 * `ElectronApplication` to watch for new windows.
 */
export function dismissStartupDialogsOnPage(page: Page): void {
  for (const name of STARTUP_DIALOG_BUTTONS) {
    page
      .addLocatorHandler(page.getByRole("button", { name, exact: true }), async (button) => {
        // The button can leave the role tree between the check that ran this
        // handler and the click: a later modal hides it, or a status refresh
        // re-renders the dialog. An unbounded click then waits for the whole
        // action's timeout and fails it. After this handler resolves,
        // Playwright waits for the button to become hidden; if it remains
        // visible, the triggering action can still time out.
        await button.click({ timeout: 5_000 }).catch(() => undefined);
      })
      .catch(() => undefined);
  }
  const reachability = page.getByRole("dialog", { name: REACHABILITY_DIALOG, exact: true });
  page
    .addLocatorHandler(reachability, (dialog) =>
      dialog.getByRole("button", { name: "Close", exact: true }).last().click(),
    )
    .catch(() => undefined);
}

/**
 * Close those dialogs whenever one appears in any window of `app`, including
 * windows opened later (`dismissStartupDialogsOnPage`).
 */
export function dismissStartupDialogs(app: ElectronApplication): void {
  for (const page of app.windows()) dismissStartupDialogsOnPage(page);
  app.on("window", dismissStartupDialogsOnPage);
}
