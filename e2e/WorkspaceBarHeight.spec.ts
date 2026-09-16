import { expect, test } from "@playwright/test";

test("project search row matches the pane tab strip height", async ({ page }, testInfo) => {
  await page.goto("/workspace-bar-height");

  const searchRow = page.getByTestId("project-search-bar");
  const tabStrip = page.getByTestId("workspace-tab-strip");
  const trigger = page.getByTestId("project-search-trigger");

  await expect(searchRow).toBeVisible();
  await expect(tabStrip).toBeVisible();
  await expect(trigger).toBeVisible();

  const geometry = await page.evaluate(() => {
    const search = document.querySelector("[data-testid='project-search-bar']");
    const strip = document.querySelector("[data-testid='workspace-tab-strip']");
    const trigger = document.querySelector("[data-testid='project-search-trigger']");
    if (!(search instanceof HTMLElement) || !(strip instanceof HTMLElement)) {
      throw new Error("Expected rendered workspace chrome rows");
    }
    if (!(trigger instanceof HTMLElement)) {
      throw new Error("Expected rendered project search trigger");
    }

    const searchBox = search.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    const triggerBox = trigger.getBoundingClientRect();
    return {
      searchHeight: searchBox.height,
      stripHeight: stripBox.height,
      searchTop: searchBox.top,
      stripTop: stripBox.top,
      triggerHeight: triggerBox.height,
      triggerOverflow: Math.max(
        0,
        searchBox.top - triggerBox.top,
        triggerBox.bottom - searchBox.bottom,
      ),
    };
  });

  const expectedHeight = testInfo.project.name === "desktop-chromium" ? 32 : 40;
  expect(geometry.searchHeight).toBe(expectedHeight);
  expect(geometry.stripHeight).toBe(expectedHeight);
  expect(geometry.searchHeight).toBe(geometry.stripHeight);
  expect(geometry.triggerOverflow).toBe(0);
  expect(geometry.triggerHeight).toBeLessThan(geometry.searchHeight);

  if (testInfo.project.name === "desktop-chromium") {
    expect(geometry.searchTop).toBe(geometry.stripTop);
  }
});
