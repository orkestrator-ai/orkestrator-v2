import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { EventEmitter } from "node:events";
import { dismissStartupDialogs } from "./agent-testing/electron-startup-dialogs";

test("startup dialog handlers dismiss delayed notices in existing and new windows", async ({
  context,
  page,
}) => {
  // Only the window catalogue is substituted. Locator handlers and actionability
  // checks run in Chromium, just as they do on Electron's Playwright Pages.
  const windows = new EventEmitter();
  Object.assign(windows, { windows: () => [page] });
  dismissStartupDialogs(windows as unknown as ElectronApplication);

  const exercise = async (window: Page) => {
    await window.setContent(`
      <button id="workspace" onclick="this.textContent='Workspace ready'">Workspace</button>
      <div id="notices"></div>
    `);
    for (const button of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
      await window.locator("#notices").evaluate((element, label) => {
        element.innerHTML = `<div role="dialog"><button onclick="this.parentElement.remove()">${label}</button></div>`;
      }, button);
      await window.getByRole("button", { name: /Workspace/ }).click();
      await expect(window.getByRole("dialog")).toHaveCount(0);
    }
    // The notice can arrive late and recur. Its heading Close button and footer
    // Close button have the same accessible name; use the footer, never persist
    // the "Don't remind me again" preference.
    for (let repeat = 0; repeat < 2; repeat++) {
      await window.locator("#notices").evaluate((element) => {
        element.innerHTML = `<div role="dialog" aria-label="Docker containers can't reach Orkestrator">
          <button aria-label="Close">x</button>
          <label><input type="checkbox" onchange="document.body.dataset.persisted='true'">Don't remind me again</label>
          <button onclick="this.parentElement.remove()">Close</button>
        </div>`;
      });
      await window.getByRole("button", { name: "Workspace ready" }).click();
      await expect(window.getByRole("dialog")).toHaveCount(0);
      await expect(window.locator("body")).not.toHaveAttribute("data-persisted");
    }
  };

  await exercise(page);
  const laterWindow = await context.newPage();
  windows.emit("window", laterWindow);
  await exercise(laterWindow);
});
