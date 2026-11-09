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

test("project navigation matches the search row and contains the Notes tab", async ({
  page,
}, testInfo) => {
  await page.goto("/project-navigation");
  const row = page.getByTestId("project-navigation-bar");
  const search = page.getByTestId("project-search-bar");
  const notes = row.getByRole("tab", { name: "Notes", exact: true });
  await expect(row).toBeVisible();
  // The tab row scrolls horizontally when the window is too narrow for it.
  await notes.scrollIntoViewIfNeeded();
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
    for (const label of ["Home", "Coordinator", "Scheduling", "Kanban", "Pull requests", "Notes"]) {
      const tab = tabs.getByRole("tab", { name: label, exact: true });
      if (["Coordinator", "Scheduling", "Kanban"].includes(label)) {
        await page.keyboard.press("ArrowRight");
      } else if (label === "Pull requests") {
        await page.keyboard.press("End");
      } else if (label === "Notes") {
        await page.keyboard.press("ArrowLeft");
      }
      await expect(tab).toBeFocused();
      await expect(tab).toHaveCSS("outline-style", "solid");
      await expect(tab).toHaveCSS("outline-width", "1px");
      await expect(tab).toHaveCSS("outline-offset", "-2px");
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

for (const width of [320, 390]) {
  test(`project navigation grid fits two reachable columns at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/project-navigation?presentation=grid");
    const tabs = page.getByRole("tablist", { name: "Project navigation" });
    await expect(tabs).toBeVisible();
    const geometry = await tabs.evaluate((element) => {
      const container = element.getBoundingClientRect();
      return {
        columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
        left: container.left,
        right: container.right,
        boxes: Array.from(element.querySelectorAll('[role="tab"]'), (tab) => {
          const box = tab.getBoundingClientRect();
          return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
        }),
      };
    });
    expect(geometry.columns).toBe(2);
    expect(new Set(geometry.boxes.map((box) => box.x)).size).toBe(2);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width);
    for (const box of geometry.boxes) {
      expect(box.x).toBeGreaterThanOrEqual(geometry.left);
      expect(box.right).toBeLessThanOrEqual(geometry.right);
      expect(box.bottom).toBeLessThanOrEqual(844);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    for (const label of [
      "Coordinator",
      "Kanban",
      "GitHub",
      "Linear",
      "Features",
      "Notes",
      "Pull requests",
    ]) {
      const tab = tabs.getByRole("tab", { name: label, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await tab.focus();
      await expect(tab).toBeFocused();
    }
  });
}

test("Scheduling tab creates project work and reloads its saved schedules", async ({ page }) => {
  await page.goto("/project-navigation");
  const tabs = page.getByRole("tablist", { name: "Project navigation" });
  await tabs.getByRole("tab", { name: "Scheduling", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Scheduling" });
  await expect(panel).toContainText("No schedules for this project yet");
  await panel.getByRole("button", { name: "New schedule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Browser project schedule");
  await dialog.getByLabel("Time", { exact: true }).fill("+30m");
  await dialog.getByLabel("Initial prompt").fill("Check project work");
  await expect(dialog.getByRole("combobox", { name: "Project", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(panel.getByTestId("schedule-row")).toContainText("Browser project schedule");
  await tabs.getByRole("tab", { name: "Kanban", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await page.reload();
  await tabs.getByRole("tab", { name: "Scheduling", exact: true }).click();
  await expect(panel.getByTestId("schedule-row")).toContainText("Browser project schedule");
});
