import { expect, test, type Locator, type Page } from "@playwright/test";

const mobileShellTitle =
  "A project and environment name that is far too long for a mobile title bar";

async function touchTap(page: Page, trigger: Locator) {
  const box = await trigger.boundingBox();
  if (!box) throw new Error("Expected a rendered touch target");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test("long mobile titles stay between controls and support touch and keyboard dismissal", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.goto("/mobile-shell");

  const drawer = page.getByRole("dialog", { name: "Projects and environments" });
  const drawerCloseButton = drawer.locator("button.absolute.right-2");
  await expect(drawer).toBeVisible();
  await expect(drawerCloseButton).toBeFocused();
  for (const key of ["Tab", "Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(
      await drawer.evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  const menu = page.getByRole("button", { name: "Open projects and environments" });
  await expect(menu).toBeFocused();
  const title = page.getByRole("button", { name: mobileShellTitle });
  const agentInfo = page.getByTestId("mobile-agent-info-slot");
  const tools = page.getByRole("button", { name: "Open tools" });
  const titleBar = page.locator("div[data-backend-drag-region]").first();

  const geometry = await Promise.all([titleBar, menu, title, agentInfo, tools].map(async (locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error("Expected a rendered title-bar control");
    return box;
  }));
  const [titleBarBox, menuBox, titleBox, agentInfoBox, toolsBox] = geometry;
  expect(menuBox.x).toBeGreaterThanOrEqual(titleBarBox.x);
  expect(titleBox.x).toBeGreaterThanOrEqual(menuBox.x + menuBox.width);
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(agentInfoBox.x);
  expect(agentInfoBox.x + agentInfoBox.width).toBeLessThanOrEqual(toolsBox.x);
  expect(toolsBox.x + toolsBox.width).toBeLessThanOrEqual(titleBarBox.x + titleBarBox.width);

  await expect(title).toHaveCSS("-webkit-app-region", "no-drag");
  const titleMetrics = await title.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflow: getComputedStyle(element).overflow,
  }));
  expect(titleMetrics.overflow).toBe("hidden");
  expect(titleMetrics.scrollWidth).toBeGreaterThan(titleMetrics.clientWidth);
  expect(await titleBar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await touchTap(page, title);
  await expect(page.getByRole("tooltip")).toContainText(mobileShellTitle);
  await expect(title).toHaveAttribute("aria-expanded", "true");
  await touchTap(page, title);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(title).toHaveAttribute("aria-expanded", "false");

  await touchTap(page, title);
  await expect(page.getByRole("tooltip")).toBeVisible();
  await touchTap(page, page.getByText("Workspace"));
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await title.focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await title.press("Enter");
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await title.blur();
  await title.focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await title.press("Space");
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await title.blur();
  await title.focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await title.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("a narrow Electron title remains a native drag region", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop runtime coverage only");
  await page.setViewportSize({ width: 700, height: 700 });
  await page.goto("/mobile-shell?desktop");

  const drawer = page.getByRole("dialog", { name: "Projects and environments" });
  await expect(drawer.locator("button.absolute.right-2")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  const title = page.getByRole("button", { name: mobileShellTitle });
  await expect(title).toHaveAttribute("data-backend-drag-region", "");
  await expect(title).toHaveCSS("-webkit-app-region", "drag");
  await expect(page.getByRole("button", { name: "Open projects and environments" }))
    .toHaveCSS("-webkit-app-region", "no-drag");
  await expect(page.getByTestId("mobile-agent-info-slot"))
    .toHaveCSS("-webkit-app-region", "no-drag");
  await expect(page.getByRole("button", { name: "Open tools" }))
    .toHaveCSS("-webkit-app-region", "no-drag");

  await title.dispatchEvent("mousedown", { button: 0 });
  await expect(page.getByTestId("mobile-shell-drag-starts")).toHaveText("1");
});
