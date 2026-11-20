import { expect, test } from "@playwright/test";

test("project search sits in the sidebar header row, level with the action bar", async ({
  page,
}, testInfo) => {
  await page.goto("/workspace-bar-height");

  const header = page.getByTestId("workspace-sidebar-header");
  const search = page.getByTestId("project-search-bar");
  const trigger = page.getByTestId("project-search-trigger");
  await expect(header).toBeVisible();
  await expect(trigger).toBeVisible();
  // No search row of its own: the search is inside the header.
  expect(
    await header.evaluate((element) =>
      element.contains(document.querySelector("[data-testid='project-search-bar']")),
    ),
  ).toBe(true);
  await expect(search).toBeVisible();

  const geometry = await page.evaluate(() => {
    const box = (id: string) => {
      const element = document.querySelector(`[data-testid='${id}']`);
      if (!(element instanceof HTMLElement)) throw new Error(`Expected ${id}`);
      return element.getBoundingClientRect();
    };
    const header = box("workspace-sidebar-header");
    const actions = box("workspace-action-bar");
    const trigger = box("project-search-trigger");
    return {
      headerHeight: header.height,
      headerTop: header.top,
      actionsHeight: actions.height,
      actionsTop: actions.top,
      triggerHeight: trigger.height,
      triggerOverflow: Math.max(0, header.top - trigger.top, trigger.bottom - header.bottom),
      triggerWidth: trigger.width,
    };
  });

  expect(geometry.headerHeight).toBe(48);
  expect(geometry.triggerOverflow).toBe(0);
  expect(geometry.triggerHeight).toBeLessThan(geometry.headerHeight);
  // It takes the width the header's buttons leave.
  expect(geometry.triggerWidth).toBeGreaterThan(200);
  if (testInfo.project.name === "desktop-chromium") {
    expect(geometry.headerTop).toBe(geometry.actionsTop);
    expect(geometry.headerHeight).toBe(geometry.actionsHeight);
  }
});

test("the narrow project drawer fits search, all header actions and its close button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/sidebar-drag?header&drawer");
  const drawer = page.getByRole("dialog", { name: "Projects and environments" });
  const header = drawer.locator("[data-sidebar-header]");
  const close = drawer
    .getByRole("complementary")
    .getByRole("button", { name: "Close projects and environments" });
  const controls = [
    header.getByRole("button", { name: "Search projects and environments" }),
    header.getByRole("button", { name: /^Sort environments/ }),
    header.getByRole("button", { name: /^Refresh projects/ }),
    header.getByRole("button", { name: "Add project" }),
    close,
  ];
  for (const control of controls) await expect(control).toBeVisible();
  const row = (await header.boundingBox())!;
  let left = row.x;
  for (const control of controls) {
    const box = (await control.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(27);
    expect(box.x).toBeGreaterThanOrEqual(left);
    expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width);
    expect(box.y).toBeGreaterThanOrEqual(row.y);
    expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height);
    left = box.x + box.width;
  }

  const search = page.getByRole("dialog", { name: "Search projects and environments" });
  await controls[0]!.click();
  await expect(search.getByRole("combobox")).toBeFocused();
  // Wait for the nested modal to take over outside input before dismissing it.
  await expect(page.locator("#mobile-projects-drawer")).toHaveCSS("pointer-events", "none");
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(controls[0]!).toBeFocused();
  await close.click();
  await expect(drawer).toBeHidden();
});

test("bulk selection keeps project search within the same header", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === "mobile-chromium";
  await page.goto(mobile ? "/sidebar-drag?header&drawer" : "/sidebar-drag?header");
  const header = page.locator("[data-sidebar-header]");
  const search = header.getByRole("button", { name: "Search projects and environments" });
  await expect(search).toBeVisible();
  const row = (await header.boundingBox())!;
  await page.locator('[data-environment-selection-id="p-env-1"]').click({ modifiers: ["Shift"] });
  const count = header.getByText(/\d+ selected/);
  await expect(count).toBeVisible();
  const searchBox = (await search.boundingBox())!;
  const countBox = (await count.boundingBox())!;
  expect((await header.boundingBox())!.height).toBe(row.height);
  expect(searchBox.width).toBeGreaterThanOrEqual(28);
  const gap = countBox.x - (searchBox.x + searchBox.width);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(8);

  const palette = page.getByRole("dialog", { name: "Search projects and environments" });
  await search.click();
  await expect(palette.getByRole("combobox")).toBeFocused();
  if (mobile)
    await expect(page.locator("#mobile-projects-drawer")).toHaveCSS("pointer-events", "none");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(count).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Meta+k");
  await expect(palette).toBeHidden();
  await expect(count).toBeVisible();
});

test("project navigation sits below the sidebar header and contains the Notes tab", async ({
  page,
}, testInfo) => {
  await page.goto("/project-navigation");
  const row = page.getByTestId("project-navigation-bar");
  const sidebarHeader = page.getByTestId("project-navigation-sidebar-header");
  const notes = row.getByRole("tab", { name: "Notes", exact: true });
  await expect(row).toBeVisible();
  // The tab row scrolls horizontally when the window is too narrow for it.
  await notes.scrollIntoViewIfNeeded();
  await expect(notes).toBeVisible();
  const rowBox = (await row.boundingBox())!;
  const headerBox = (await sidebarHeader.boundingBox())!;
  const notesBox = (await notes.boundingBox())!;
  expect(rowBox.height).toBe(testInfo.project.name === "desktop-chromium" ? 32 : 40);
  // The search is in the sidebar header's row, so the navigation row starts
  // where that row ends.
  expect(rowBox.y).toBe(headerBox.y + headerBox.height);
  expect(notesBox.y).toBeGreaterThanOrEqual(rowBox.y);
  expect(notesBox.y + notesBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
  expect(notesBox.x + notesBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});

for (const width of [1280, 900]) {
  test(`project tabs show no scrollbar of their own at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto("/project-navigation");
    const row = page.getByTestId("project-navigation-bar");
    const tabs = row.getByRole("tablist", { name: "Project navigation" });
    await expect(tabs).toBeVisible();
    // The tab list once capped itself at 48rem and scrolled within it, so nine
    // tabs a few pixels wider than the cap drew a scrollbar beneath the row.
    // The surrounding tab scroller hides its scrollbar.
    const geometry = await tabs.evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      rowScrollbarWidth: getComputedStyle(element.parentElement!).scrollbarWidth,
    }));
    expect(geometry.overflowX).toBe("visible");
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expect(geometry.rowScrollbarWidth).toBe("none");
    const last = tabs.getByRole("tab", { name: "Pull requests", exact: true });
    await last.scrollIntoViewIfNeeded();
    const rowBox = (await row.boundingBox())!;
    const lastBox = (await last.boundingBox())!;
    expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  });
}

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
      await expect(tab).toHaveCSS("border-radius", "8px");
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
