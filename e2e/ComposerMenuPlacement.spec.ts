import { expect, test } from "@playwright/test";

test("composer menus stay within the mobile visual viewport after a resize and flip", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.goto("/menu-placement");
  await page.setViewportSize({ width: 390, height: 420 });

  const menu = page.getByRole("listbox", { name: "File and folder suggestions" });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("data-side", "top");

  async function expectInsideVisualViewport() {
    const bounds = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const viewport = window.visualViewport!;
      return {
        top: rect.top,
        bottom: rect.bottom,
        viewportTop: viewport.offsetTop,
        viewportBottom: viewport.offsetTop + viewport.height,
      };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.viewportTop);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportBottom);
  }

  await expectInsideVisualViewport();

  await page.getByTestId("menu-anchor").evaluate((anchor) => {
    (anchor.parentElement as HTMLElement).style.top = "20px";
    window.dispatchEvent(new Event("resize"));
  });
  await expect(menu).toHaveAttribute("data-side", "bottom");
  await expectInsideVisualViewport();
});

test("composer menu respects a shorter clipping ancestor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.goto("/menu-placement?clip");

  const menu = page.getByRole("listbox", { name: "File and folder suggestions" });
  await expect(menu).toBeVisible();
  const bounds = await menu.evaluate((element) => {
    const menuRect = element.getBoundingClientRect();
    const clipRect = document.querySelector('[data-testid="menu-clip"]')!.getBoundingClientRect();
    return {
      top: menuRect.top,
      bottom: menuRect.bottom,
      clipTop: clipRect.top,
      clipBottom: clipRect.bottom,
    };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.clipTop);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.clipBottom);
});

test("menu hides when the composer fills a keyboard-sized viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.setViewportSize({ width: 390, height: 400 });
  await page.goto("/menu-placement?cramped");

  const menu = page.locator('[role="listbox"]');
  await expect(menu).toBeHidden();
  await expect(menu).toHaveCSS("max-height", "0px");
});

test("slash menu uses its bounded height in a mobile browser", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.goto("/menu-placement?menu=slash");
  await page.setViewportSize({ width: 390, height: 420 });

  const menu = page.locator('[data-side="top"]');
  await expect(menu).toBeVisible();
  const bounds = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport!;
    return { top: rect.top, viewportTop: viewport.offsetTop };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.viewportTop);
});
