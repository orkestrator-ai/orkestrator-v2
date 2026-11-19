import { expect, test } from "@playwright/test";

test("Machine stays visible at the right while the desktop tabs scroll", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "Desktop project row");
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 740 });
    await page.goto("/project-navigation?machines");
    const bar = page.getByTestId("project-navigation-bar");
    const machine = bar.getByRole("combobox", { name: "Machine" });
    const lastTab = bar.getByRole("tab", { name: "Pull requests", exact: true });
    await expect(machine).toBeInViewport({ ratio: 1 });
    const initial = (await machine.boundingBox())!;
    const row = (await bar.boundingBox())!;
    expect(initial.x + initial.width).toBeLessThanOrEqual(row.x + row.width);
    expect(row.x + row.width - (initial.x + initial.width)).toBeLessThanOrEqual(16);
    await bar.screenshot({ path: `output/visual-previews/project-machine-fixed-${width}.png` });

    if (width === 900) await expect(lastTab).not.toBeInViewport({ ratio: 1 });
    await lastTab.scrollIntoViewIfNeeded();
    await expect(lastTab).toBeInViewport({ ratio: 1 });
    expect(await machine.boundingBox()).toEqual(initial);
  }
});

test("touch opens the Machine list inside Tools and returns focus on dismissal", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile-chromium", "Touch project tools");
  await page.goto("/project-navigation?presentation=tools&machines");
  const toolsButton = page.getByRole("button", { name: "Open tools", exact: true });
  await toolsButton.tap();
  const tools = page.getByRole("dialog", { name: "Tools" });
  const machine = tools.getByRole("combobox", { name: "Machine" });
  await expect(machine).toBeVisible();
  await tools.screenshot({ path: "output/visual-previews/project-machine-tools-390.png" });

  await machine.tap();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  // Radix temporarily hides the underlying Tools from the accessibility tree.
  const toolsState = page.locator("#mobile-tools-popover");
  await expect(toolsState).toHaveClass(/\bvisible\b/);
  await expect(list.getByRole("option", { name: /Offline machine/ })).toBeDisabled();
  await list.screenshot({ path: "output/visual-previews/project-machine-list-390.png" });

  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(tools).toBeVisible();
  await expect(machine).toBeFocused();

  const toolsBox = (await tools.boundingBox())!;
  await machine.tap();
  await expect(list).toBeVisible();
  // Tap the Tools panel's padding outside the list, leaving Tools open.
  await page.touchscreen.tap(toolsBox.x + 5, toolsBox.y + 16);
  await expect(list).toBeHidden();
  await expect(tools).toBeVisible();
  await expect(machine).toBeFocused();

  await machine.tap();
  await list.getByRole("option", { name: "Build machine", exact: true }).tap();
  await expect(list).toBeHidden();
  await expect(tools).toBeHidden();
  await expect(toolsButton).toBeVisible();
});

for (const view of ["empty", "worktree"]) {
  test(`Machine is absent from Tools on the ${view} view`, async ({ page }, info) => {
    test.skip(info.project.name !== "mobile-chromium", "Mobile project tools");
    await page.goto(`/project-navigation?presentation=tools&machines&view=${view}`);
    await page.getByRole("button", { name: "Open tools", exact: true }).tap();
    const tools = page.getByRole("dialog", { name: "Tools" });
    await expect(tools).toBeVisible();
    if (view === "worktree") {
      await expect(tools.getByRole("group", { name: "Project navigation" })).toBeVisible();
    }
    await expect(tools.getByRole("combobox", { name: "Machine" })).toHaveCount(0);
    await tools.screenshot({ path: `output/visual-previews/project-machine-${view}-390.png` });
  });
}
