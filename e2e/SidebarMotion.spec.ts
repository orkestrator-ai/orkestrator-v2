import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

/**
 * Opens the fixture, reloading only for module requests a host network change
 * aborted (flake 4291); any other startup failure still fails the case.
 */
async function openFixture(page: Page, testInfo: TestInfo, url = "/sidebar-motion") {
  const main = page.getByTestId("main-content");
  let aborted = 0;
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText === "net::ERR_NETWORK_CHANGED") aborted += 1;
  });
  for (let attempt = 1; ; attempt += 1) {
    aborted = 0;
    await page.goto(url);
    try {
      await expect(main).toBeVisible({ timeout: 20_000 });
      return main;
    } catch (error) {
      if (aborted === 0 || attempt === 3) throw error;
      testInfo.annotations.push({ type: "retry", description: "flake 4291: reloaded" });
    }
  }
}

test("real panels restore width, bound reversal pins and release once", async ({
  page,
}, testInfo) => {
  const main = await openFixture(page, testInfo);
  const sidebar = page.locator("[data-panel]").first();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(344);
  await main.evaluate((element) => {
    (window as unknown as { contentSizes: number[] }).contentSizes = [];
    new ResizeObserver(() =>
      (window as unknown as { contentSizes: number[] }).contentSizes.push(
        element.getBoundingClientRect().width,
      ),
    ).observe(element);
  });
  await page.getByRole("button", { name: "compact", exact: true }).click();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(56);
  await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
  await expect(page.getByTestId("resizes")).toHaveText("1");
  const sizes = await page.evaluate(
    () => (window as unknown as { contentSizes: number[] }).contentSizes,
  );
  expect(new Set(sizes).size).toBeLessThanOrEqual(2);
  const icon = page.getByRole("button", { name: "Example repository", exact: true });
  await icon.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("selected")).toHaveText("fixture");
  await expect(icon).toHaveAttribute("aria-current", "page");
  expect(Math.round((await sidebar.boundingBox())!.width)).toBe(56);
  await page.getByRole("button", { name: "full", exact: true }).click();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(344);
  await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
  await page.getByRole("button", { name: "compact", exact: true }).click();
  await page.waitForTimeout(60);
  await page.getByRole("button", { name: "full", exact: true }).click();
  expect((await main.boundingBox())!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
  const handle = page.locator("[data-separator]");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 25, box.y + 50, { steps: 4 });
  await page.mouse.up();
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(350);
  const draggedWidth = (await sidebar.boundingBox())!.width;
  await page.getByRole("button", { name: "compact", exact: true }).click();
  await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
  await page.getByRole("button", { name: "full", exact: true }).click();
  await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
  expect((await sidebar.boundingBox())!.width).toBeCloseTo(draggedWidth, 0);
  // A pointer can take over a full panel while it is still expanding.
  await page.getByRole("button", { name: "compact", exact: true }).click();
  await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
  await page.getByRole("button", { name: "full", exact: true }).click();
  await page.waitForTimeout(40);
  const movingBox = (await handle.boundingBox())!;
  await page.mouse.move(movingBox.x, movingBox.y + 50);
  await page.mouse.down();
  await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
  await page.mouse.up();
  await page.getByRole("button", { name: "Reduced motion: false" }).click();
  await page.getByRole("button", { name: "compact", exact: true }).click();
  await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(56);
});

/** Every width the main content is laid out at from here on. */
async function recordMainWidths(main: Locator) {
  await main.evaluate((element) => {
    const state = window as unknown as { mainWidths: number[] };
    state.mainWidths = [];
    let first = true;
    new ResizeObserver(() => {
      if (first) first = false;
      else state.mainWidths.push(element.getBoundingClientRect().width);
    }).observe(element);
  });
}

const mainWidths = (page: Page) =>
  page.evaluate(() => (window as unknown as { mainWidths: number[] }).mainWidths);

// The group lays itself out afresh when the handle remounts, from a percentage
// default as in the shell, and a dragged width differs from that default.
async function openWithDraggedWidth(page: Page, testInfo: TestInfo) {
  const main = await openFixture(page, testInfo, "/sidebar-motion?shellDefault");
  const handle = (await page.locator("[data-separator]").boundingBox())!;
  await page.mouse.move(handle.x, handle.y + 50);
  await page.mouse.down();
  await page.mouse.move(handle.x + 30, handle.y + 50, { steps: 4 });
  await page.mouse.up();
  return main;
}

// A busy main thread delays the frame that starts the panel moving.
for (const frameDelay of [0, 300]) {
  for (const from of ["hidden", "compact"] as const) {
    test(`from ${from} to full lays the main content out once, frames ${frameDelay}ms late`, async ({
      page,
    }, testInfo) => {
      const main = await openWithDraggedWidth(page, testInfo);
      const sidebar = page.locator("[data-panel]").first();
      const fullWidth = Math.round((await sidebar.boundingBox())!.width);
      await page.getByRole("button", { name: from, exact: true }).click();
      await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
      await page.waitForTimeout(100);
      await recordMainWidths(main);
      await page.evaluate((delay) => {
        const frame = window.requestAnimationFrame.bind(window);
        document.addEventListener(
          "click",
          () => {
            window.requestAnimationFrame = (callback) =>
              frame(() => setTimeout(() => callback(performance.now()), delay));
            setTimeout(() => {
              window.requestAnimationFrame = frame;
            });
          },
          { capture: true, once: true },
        );
      }, frameDelay);
      await page.getByRole("button", { name: "full", exact: true }).click();
      await expect
        .poll(async () => Math.round((await sidebar.boundingBox())!.width))
        .toBe(fullWidth);
      await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
      await page.waitForTimeout(100);
      expect(await mainWidths(page)).toHaveLength(1);
    });
  }
}

test("hiding lays the main content out once", async ({ page }, testInfo) => {
  const main = await openWithDraggedWidth(page, testInfo);
  await recordMainWidths(main);
  await page.getByRole("button", { name: "hidden", exact: true }).click();
  await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(await mainWidths(page)).toHaveLength(1);
});

for (const zoom of [0.8, 1.25]) {
  test(`root CSS zoom ${zoom} keeps pins in layout pixels`, async ({ page }, testInfo) => {
    const main = await openFixture(page, testInfo);
    const sidebar = page.locator("[data-panel]").first();
    await page.evaluate((scale) => {
      document.documentElement.style.zoom = String(scale);
    }, zoom);
    // Changing root zoom also changes the panel group's available layout width.
    // Keep the resulting user width, rather than assuming its original allocation.
    await page.waitForTimeout(300);
    const fullWidth = Math.round((await sidebar.boundingBox())!.width / zoom);
    expect(fullWidth).toBeGreaterThanOrEqual(280);
    expect(fullWidth).toBeLessThanOrEqual(400);
    await page.getByRole("button", { name: "compact", exact: true }).click();
    const pin = await main.evaluate((element) => Number.parseFloat(element.style.width));
    expect(pin).toBeLessThanOrEqual(page.viewportSize()!.width / zoom);
    await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width / zoom)).toBe(56);
    await page.getByRole("button", { name: "full", exact: true }).click();
    await expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);
    await expect
      .poll(async () => Math.round((await sidebar.boundingBox())!.width / zoom))
      .toBe(fullWidth);
  });
}
