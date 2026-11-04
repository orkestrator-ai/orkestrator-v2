import { expect, test } from "@playwright/test";
import path from "node:path";

test("real panels restore width, bound reversal pins and release once", async ({
  page,
}, testInfo) => {
  await page.goto("/sidebar-motion");
  const sidebar = page.locator("[data-panel]").first();
  const main = page.getByTestId("main-content");
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(344);
  await page.screenshot({
    path: path.resolve("output/visual-previews/sidebar-before-" + testInfo.project.name + ".png"),
  });
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
  await page.screenshot({
    path: path.resolve("output/visual-previews/sidebar-after-" + testInfo.project.name + ".png"),
  });
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
