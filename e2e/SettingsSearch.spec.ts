import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/** Screenshots for the change's review; git-ignored. */
const PREVIEWS = path.resolve(import.meta.dirname, "../output/visual-previews");

async function shot(page: Page, name: string, project: string) {
  if (process.env.SETTINGS_SEARCH_SCREENSHOTS !== "1") return;
  await page.screenshot({ path: path.join(PREVIEWS, `${name}-review-fixes-${project}.png`) });
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
  await expect(field.locator("[data-setting-explanation]")).toContainText("Applies immediately");
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
  await expect(dialog.getByTestId("reset-preview").locator("dd").first()).toHaveText("Off");
  await shot(page, "settings-reset-conflict", testInfo.project.name);
  await dialog.getByRole("button", { name: "Reset to default" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("settings-search:resets")!).expect[0].value,
      ),
    )
    .toBe(false);
  await expect(explanation).toContainText("Default; nothing stored on");
});

test("search opens nested provider controls and the sound switch", async ({ page }, testInfo) => {
  await page.goto("/settings-search");
  const search = visibleSearch(page);
  await search.fill("1M context beta");
  await search.press("Enter");
  await expect(
    page
      .getByRole("radiogroup", { name: "Claude 1M context beta" })
      .getByRole("radio", { name: "Provider default — Off" }),
  ).toBeFocused();
  await shot(page, "settings-claude-context", testInfo.project.name);

  await search.fill("default claude model");
  await search.press("Enter");
  await expect(page.locator("#agent-model-claude")).toBeFocused();

  await search.fill("agent stopped sound");
  await search.press("Enter");
  await expect(page.getByRole("switch", { name: "Agent stopped sound" })).toBeFocused();
  await shot(page, "settings-sounds", testInfo.project.name);
});

test("Modified filters an active query", async ({ page }, testInfo) => {
  await page.goto("/settings-search");
  const search = visibleSearch(page);
  await search.fill("debug");
  const results = page.getByRole("region", { name: "Settings search results" });
  await expect(results.getByRole("button", { name: /^Renderer debug logging/ })).toBeVisible();
  await page
    .getByRole("button", { name: "Show modified settings" })
    .locator("visible=true")
    .click();
  const modified = page.getByRole("region", { name: "Modified settings" });
  await expect(modified.getByRole("button", { name: /^Save logs to disk/ })).toBeVisible();
  await expect(modified.getByRole("button", { name: /^Renderer debug logging/ })).toHaveCount(0);
  await expect(search).toHaveValue("debug");
  await shot(page, "settings-modified-query", testInfo.project.name);
});

test("a persisted sound switch appears with its source in Modified after reload", async ({
  page,
}) => {
  await page.goto("/settings-search?section=sounds");
  const sound = page.getByRole("switch", { name: "Pull request merged sound" });
  await expect(sound).toHaveAttribute("aria-checked", "true");
  await sound.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("settings-search:sounds") ?? "{}").prMerged,
      ),
    )
    .toBe(false);
  await page.reload();
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await page
    .getByRole("button", { name: "Show modified settings" })
    .locator("visible=true")
    .click();
  const modified = page.getByRole("region", { name: "Modified settings" });
  const row = modified.getByRole("listitem").filter({ hasText: "Pull request merged sound" });
  await expect(row).toContainText("Off · Set on");
  await expect(modified.getByRole("button", { name: /^Agent stopped sound/ })).toHaveCount(0);
});
