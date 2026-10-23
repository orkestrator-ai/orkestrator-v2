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

test("project navigation matches the search row and contains Kanban notes", async ({
  page,
}, testInfo) => {
  await page.goto("/project-navigation");
  const row = page.getByTestId("project-navigation-bar");
  const search = page.getByTestId("project-search-bar");
  const notes = row.getByRole("button", { name: "Project notes" });
  await expect(row).toBeVisible();
  await expect(notes).toBeVisible();
  const rowBox = (await row.boundingBox())!;
  const searchBox = (await search.boundingBox())!;
  const notesBox = (await notes.boundingBox())!;
  expect(rowBox.height).toBe(testInfo.project.name === "desktop-chromium" ? 32 : 40);
  expect(rowBox.height).toBe(searchBox.height);
  expect(rowBox.y).toBe(searchBox.y);
  expect(notesBox.y).toBeGreaterThanOrEqual(rowBox.y);
  expect(notesBox.y + notesBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
  expect(notesBox.x + notesBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});

for (const presentation of ["bar", "grid"]) {
  test(`project tabs retain keyboard focus rings in ${presentation} presentation`, async ({
    page,
  }) => {
    await page.goto(`/project-navigation?presentation=${presentation}`);
    const tabs = page.getByRole("tablist", { name: "Project navigation" });
    await expect(tabs).toBeVisible();
    // Enter keyboard modality before focusing the first tab without activating
    // Home, which would create a project checkout in the real application.
    await page.keyboard.press("Tab");
    const first = tabs.getByRole("tab", { name: "Home", exact: true });
    await first.focus();
    for (const label of ["Home", "Kanban", "Pull requests", "Features"]) {
      const tab = tabs.getByRole("tab", { name: label, exact: true });
      if (label === "Kanban") {
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
      } else if (label === "Pull requests") {
        await page.keyboard.press("End");
      } else if (label === "Features") {
        await page.keyboard.press("ArrowLeft");
      }
      await expect(tab).toBeFocused();
      await expect(tab).toHaveCSS("outline-style", "none");
      // Wait for the selector's box-shadow transition before measuring it.
      await expect(tab).toHaveCSS("box-shadow", /2px inset/);
      const focus = await tab.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const container = element.parentElement!.getBoundingClientRect();
        return {
          visible: element.matches(":focus-visible"),
          verticalOverflow: Math.max(0, container.top - box.top, box.bottom - container.bottom),
        };
      });
      expect(focus.visible).toBe(true);
      expect(focus.verticalOverflow).toBe(0);
    }
  });
}
