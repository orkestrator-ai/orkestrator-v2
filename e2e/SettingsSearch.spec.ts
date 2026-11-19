import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/** Screenshots for the change's review; git-ignored. */
const PREVIEWS = path.resolve(import.meta.dirname, "../output/visual-previews");

async function shot(page: Page, name: string, project: string) {
  if (process.env.SETTINGS_SEARCH_SCREENSHOTS !== "1") return;
  await page.screenshot({ path: path.join(PREVIEWS, `${name}-${project}.png`) });
}

function visibleSearch(page: Page) {
  return page.getByRole("searchbox", { name: "Search settings" }).locator("visible=true");
}

test("search finds settings by name and alias, and opens the field focused and unchanged", async ({
  page,
}, testInfo) => {
  await page.goto("/settings-search");
  const search = visibleSearch(page);
  await expect(search).toHaveCount(1);
  await shot(page, "settings-search-empty", testInfo.project.name);

  await search.fill("notifications");
  const results = page.getByRole("region", { name: "Settings search results" });
  await expect(results.getByText(/settings? found/)).toBeVisible();
  await expect(
    results.getByRole("button", { name: /^Desktop notifications for agent questions/ }),
  ).toBeVisible();
  await shot(page, "settings-search-results", testInfo.project.name);

  await search.fill("scrollback");
  await search.press("ArrowDown");
  await expect(results.getByRole("button", { name: /^Scrollback buffer/ })).toBeFocused();
  await page.keyboard.press("Enter");
  const field = page.locator('[data-setting-anchor="terminal.scrollback"]');
  await expect(field).toHaveAttribute("data-setting-highlighted", "true");
  await expect(field.getByRole("slider")).toBeFocused();
  // Opening the field changed nothing: the slider and the explanation agree on the stored value.
  await expect(field.getByRole("slider")).toHaveAttribute("aria-valuenow", "1000");
  await expect(field.locator("[data-setting-explanation]")).toContainText("Effective: 1,000 lines");
  await expect(field.locator("[data-setting-explanation]")).toContainText(
    "Applies to terminals opened afterwards",
  );
  await shot(page, "settings-search-field-highlight", testInfo.project.name);

  // Escape inside the search clears it rather than closing Settings.
  await visibleSearch(page).fill("proxy");
  await visibleSearch(page).press("Escape");
  await expect(visibleSearch(page)).toHaveValue("");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("Modified lists explicit overrides apart from values that only differ from the default", async ({
  page,
}, testInfo) => {
  await page.goto("/settings-search");
  await page
    .getByRole("button", { name: "Show modified settings" })
    .locator("visible=true")
    .click();
  const modified = page.getByRole("region", { name: "Modified settings" });
  const steer = modified.getByRole("listitem").filter({ hasText: "Auto-steer" });
  await expect(steer).toContainText("Override · same as default");
  const logs = modified.getByRole("listitem").filter({ hasText: "Save logs to disk" });
  await expect(logs).toContainText("Set on");
  await expect(logs).not.toContainText("same as default");
  await shot(page, "settings-modified", testInfo.project.name);
});

test("a reset previews its effect and asks again when the value moved", async ({
  page,
}, testInfo) => {
  await page.goto("/settings-search?section=debug&reset-conflict");
  const explanation = page.locator('[data-setting-explanation="debug.save-logs"]');
  await expect(explanation).toContainText("Effective: On");
  await expect(explanation).toContainText("Override");
  await shot(page, "settings-field-explanation", testInfo.project.name);

  await explanation.getByRole("button", { name: "Reset Save logs to disk to default" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByTestId("reset-preview")).toContainText("Off (default)");
  await shot(page, "settings-reset-preview", testInfo.project.name);

  await dialog.getByRole("button", { name: "Reset to default" }).click();
  await expect(dialog.getByText(/changed since you opened this preview/)).toBeVisible();
  await shot(page, "settings-reset-conflict", testInfo.project.name);
  await dialog.getByRole("button", { name: "Reset to default" }).click();
  await expect(dialog).toBeHidden();
  await expect(explanation).toContainText("Default; nothing stored on");
});
