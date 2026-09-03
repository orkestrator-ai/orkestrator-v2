import { expect, test } from "@playwright/test";
import {
  BOOTSTRAP_HTML,
  PLATFORM_SELECTION_HTML,
} from "../apps/desktop/electron/toolchain-bootstrap-window";

const pages = [
  { name: "toolchain progress", html: BOOTSTRAP_HTML, finalSelector: "#detail" },
  { name: "platform selection", html: PLATFORM_SELECTION_HTML, finalSelector: "#continue" },
] as const;

for (const setupPage of pages) {
  test(`${setupPage.name} centers on an oversized tiled surface`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "one Chromium layout run is enough");
    await page.setViewportSize({ width: 1_200, height: 900 });
    await page.setContent(setupPage.html);

    const main = page.locator("main");
    const box = await main.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x + box!.width / 2 - 600)).toBeLessThan(1);
    expect(Math.abs(box!.y + box!.height / 2 - 450)).toBeLessThan(1);
  });

  test(`${setupPage.name} stays reachable on a height-constrained surface`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "one Chromium layout run is enough");
    await page.setViewportSize({ width: 700, height: 180 });
    await page.setContent(setupPage.html);

    const main = page.locator("main");
    const initialBox = await main.boundingBox();
    expect(initialBox).not.toBeNull();
    expect(initialBox!.y).toBeGreaterThanOrEqual(0);
    expect(
      await page.evaluate(() => document.scrollingElement!.scrollHeight > window.innerHeight),
    ).toBe(true);

    const finalElement = page.locator(setupPage.finalSelector);
    await finalElement.scrollIntoViewIfNeeded();
    await expect(finalElement).toBeInViewport();
  });
}
