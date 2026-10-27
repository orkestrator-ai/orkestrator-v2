import { expect, test, type Locator, type Page } from "@playwright/test";

const mobileShellTitle =
  "A project and environment name that is far too long for a mobile title bar";

type InputEventRecord = { type: string; pointerType: string; trusted: boolean };
type InputRecordingWindow = Window & { mobileShellInputEvents: InputEventRecord[] };

async function recordInput(page: Page) {
  await page.evaluate(() => {
    const events: InputEventRecord[] = [];
    (window as unknown as InputRecordingWindow).mobileShellInputEvents = events;
    for (const type of [
      "pointerdown",
      "pointerup",
      "touchstart",
      "touchend",
      "mousedown",
      "mouseup",
      "click",
    ]) {
      document.addEventListener(
        type,
        (event) => {
          events.push({
            type: event.type,
            pointerType: (event as PointerEvent).pointerType ?? "",
            trusted: event.isTrusted,
          });
        },
        { capture: true },
      );
    }
  });
}

async function recordedInput(page: Page) {
  return page.evaluate(() => (window as unknown as InputRecordingWindow).mobileShellInputEvents);
}

async function touchTap(page: Page, trigger: Locator) {
  const box = await trigger.boundingBox();
  if (!box) throw new Error("Expected a rendered touch target");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test("long mobile titles stay between controls and support touch and keyboard dismissal", async ({
  browserName,
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
    expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  const menu = page.getByRole("button", { name: "Open projects and environments" });
  await expect(menu).toBeFocused();
  const title = page.getByRole("button", { name: mobileShellTitle });
  const agentInfo = page.getByTestId("mobile-agent-info-slot");
  const tools = page.getByRole("button", { name: "Open tools" });
  const actions = page.getByTestId("mobile-title-actions");
  const titleBar = page.locator("div[data-backend-drag-region]").first();

  const geometry = await Promise.all(
    [titleBar, menu, title, tools, agentInfo, actions].map(async (locator) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error("Expected a rendered title-bar control");
      return box;
    }),
  );
  const [titleBarBox, menuBox, titleBox, toolsBox, agentInfoBox, actionsBox] = geometry;
  expect(menuBox.x).toBeGreaterThanOrEqual(titleBarBox.x);
  expect(titleBox.x).toBeGreaterThanOrEqual(menuBox.x + menuBox.width);
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(toolsBox.x);
  expect(toolsBox.x + toolsBox.width).toBeLessThanOrEqual(agentInfoBox.x);
  expect(agentInfoBox.x + agentInfoBox.width).toBeLessThanOrEqual(
    titleBarBox.x + titleBarBox.width,
  );
  expect(actionsBox.x).toBeLessThanOrEqual(toolsBox.x);
  expect(actionsBox.x + actionsBox.width).toBeGreaterThanOrEqual(
    agentInfoBox.x + agentInfoBox.width,
  );

  // `-webkit-app-region` is Chromium's (Electron's) property; other engines drop it.
  if (browserName === "chromium") {
    await expect(title).toHaveCSS("-webkit-app-region", "no-drag");
    await expect(actions).toHaveCSS("-webkit-app-region", "no-drag");
    await expect(agentInfo).toHaveCSS("-webkit-app-region", "no-drag");
    await expect(tools).toHaveCSS("-webkit-app-region", "no-drag");
  }
  const titleMetrics = await title.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflow: getComputedStyle(element).overflow,
  }));
  expect(titleMetrics.overflow).toBe("hidden");
  expect(titleMetrics.scrollWidth).toBeGreaterThan(titleMetrics.clientWidth);
  expect(await titleBar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );

  await touchTap(page, title);
  await expect(page.getByRole("tooltip")).toContainText(mobileShellTitle);
  await expect(title).toHaveAttribute("aria-expanded", "true");
  await touchTap(page, title);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(title).toHaveAttribute("aria-expanded", "false");

  // The bubble covers the top of the workspace. Tapping it closes it, and the
  // tap's click must not fall through to whatever is underneath. Chromium
  // would also close it by blurring the focused title; WebKit never focuses a
  // tapped button, so this step is what proves the bubble's own handler.
  const tooltip = page.getByRole("tooltip");
  await touchTap(page, title);
  await expect(tooltip).toBeVisible();
  await recordInput(page);
  await touchTap(page, tooltip);
  await expect(tooltip).toHaveCount(0);
  await expect(title).toHaveAttribute("aria-expanded", "false");
  const input = await recordedInput(page);
  expect(input.map((event) => event.type)).toEqual([
    "pointerdown",
    "touchstart",
    "pointerup",
    "touchend",
  ]);
  expect(input.every((event) => event.trusted)).toBe(true);
  await expect(page.getByTestId("mobile-shell-workspace-clicks")).toHaveText("0");

  // A tap below the bubble is outside the tooltip.
  await touchTap(page, title);
  await expect(tooltip).toBeVisible();
  const tooltipBox = await tooltip.boundingBox();
  if (!tooltipBox) throw new Error("Expected the title tooltip on screen");
  await page.touchscreen.tap(195, tooltipBox.y + tooltipBox.height + 200);
  await expect(tooltip).toHaveCount(0);

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

test("pen input dismisses the title bubble without touch events or click-through", async ({
  browserName,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  test.skip(browserName !== "chromium", "CDP pen input requires Chromium");
  await page.goto("/mobile-shell");
  await page.keyboard.press("Escape");
  const title = page.getByRole("button", { name: mobileShellTitle });
  const tooltip = page.getByRole("tooltip");
  const client = await page.context().newCDPSession(page);
  const penTap = async (target: Locator) => {
    const box = await target.boundingBox();
    if (!box) throw new Error("Expected a rendered pen target");
    const position = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await client.send("Input.dispatchMouseEvent", {
      ...position,
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "pen",
    });
    await client.send("Input.dispatchMouseEvent", {
      ...position,
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "pen",
    });
  };
  try {
    await penTap(title);
    await expect(tooltip).toBeVisible();
    await expect(title).toHaveAttribute("aria-expanded", "true");
    await penTap(title);
    await expect(tooltip).toHaveCount(0);
    await penTap(title);
    await expect(tooltip).toBeVisible();
    await recordInput(page);
    await penTap(tooltip);
    await expect(tooltip).toHaveCount(0);
    await expect(title).toHaveAttribute("aria-expanded", "false");
    const input = await recordedInput(page);
    expect(input.map((event) => event.type)).toEqual(["pointerdown", "pointerup", "click"]);
    expect(input.every((event) => event.trusted && event.pointerType === "pen")).toBe(true);
    await expect(page.getByTestId("mobile-shell-workspace-clicks")).toHaveText("0");
  } finally {
    await client.detach();
  }
});

test("touch dismissal suppresses compatibility mouse events over an active workspace control", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.goto("/mobile-shell");
  await page.keyboard.press("Escape");
  await touchTap(page, page.getByRole("button", { name: mobileShellTitle }));
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  const box = await tooltip.boundingBox();
  if (!box) throw new Error("Expected the title tooltip on screen");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await recordInput(page);
  await page.touchscreen.tap(point.x, point.y);
  await expect(tooltip).toHaveCount(0);
  const input = await recordedInput(page);
  expect(input.map((event) => event.type)).toEqual([
    "pointerdown",
    "touchstart",
    "pointerup",
    "touchend",
  ]);
  expect(input.every((event) => event.trusted)).toBe(true);
  const clicks = page.getByTestId("mobile-shell-workspace-clicks");
  await expect(clicks).toHaveText("0");
  // The exact same position now hits a live control. This verifies the
  // suppression assertion would catch a compatibility click falling through.
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, point),
  ).toBe("Workspace action");
  await page.touchscreen.tap(point.x, point.y);
  await expect(clicks).toHaveText("1");
});

test("the title uses space released when the optional inbox is hidden", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");

  const measure = async () => {
    await page.keyboard.press("Escape");
    const title = page.getByRole("button", { name: mobileShellTitle });
    const tools = page.getByRole("button", { name: "Open tools" });
    const actions = page.getByTestId("mobile-title-actions");
    const [titleBox, toolsBox, actionsBox] = await Promise.all(
      [title, tools, actions].map(async (locator) => {
        const box = await locator.boundingBox();
        if (!box) throw new Error("Expected a rendered title-bar control");
        return box;
      }),
    );
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(toolsBox.x);
    return { actionsBox, titleBox };
  };

  await page.goto("/mobile-shell");
  const withInbox = await measure();
  await expect(page.getByRole("button", { name: "Agent inbox" })).toBeVisible();

  await page.goto("/mobile-shell?withoutInbox");
  const withoutInbox = await measure();
  await expect(page.getByRole("button", { name: "Agent inbox" })).toHaveCount(0);

  expect(withoutInbox.actionsBox.width).toBeLessThan(withInbox.actionsBox.width);
  expect(withoutInbox.titleBox.width).toBeGreaterThan(withInbox.titleBox.width);
});

test("a narrow Electron title remains a native drag region", async ({
  browserName,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop runtime coverage only");
  test.skip(browserName !== "chromium", "native drag regions are Electron's, so Chromium-only");
  await page.setViewportSize({ width: 700, height: 700 });
  await page.goto("/mobile-shell?desktop");

  const drawer = page.getByRole("dialog", { name: "Projects and environments" });
  await expect(drawer.locator("button.absolute.right-2")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  const title = page.getByRole("button", { name: mobileShellTitle });
  await expect(title).toHaveAttribute("data-backend-drag-region", "");
  await expect(title).toHaveCSS("-webkit-app-region", "drag");
  await expect(page.getByRole("button", { name: "Open projects and environments" })).toHaveCSS(
    "-webkit-app-region",
    "no-drag",
  );
  await expect(page.getByTestId("mobile-agent-info-slot")).toHaveCSS(
    "-webkit-app-region",
    "no-drag",
  );
  await expect(page.getByRole("button", { name: "Open tools" })).toHaveCSS(
    "-webkit-app-region",
    "no-drag",
  );

  await title.dispatchEvent("mousedown", { button: 0 });
  await expect(page.getByTestId("mobile-shell-drag-starts")).toHaveText("1");
});

test("tapping the backdrop closes the projects drawer and returns focus to its trigger", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.goto("/mobile-shell");
  const drawer = page.getByRole("dialog", { name: "Projects and environments" });
  await expect(drawer.locator("button.absolute.right-2")).toBeFocused();

  // Radix closes the drawer on the press outside it; the backdrop has no
  // click handler of its own (see MobileAppShellLayout).
  const backdrop = page.locator("[data-slot='mobile-projects-overlay']");
  const box = await backdrop.boundingBox();
  if (!box) throw new Error("Expected the drawer backdrop on screen");
  await page.touchscreen.tap(box.x + box.width - 12, box.y + box.height / 2);
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open projects and environments" })).toBeFocused();
});
