import { expect, test } from "@playwright/test";

for (const width of [300, 390, 1200]) {
  test(`all docks preserve canvas and panel at ${width}px and short heights`, async ({ page }) => {
    await page.setViewportSize({ width, height: 300 });
    await page.goto("/design-agent-dock");
    const panel = page.getByRole("region", { name: "Agent panel" });
    const canvas = page.getByTestId("canvas").locator("..");
    if (width === 390 && test.info().project.name === "desktop-chromium") {
      await panel.evaluate((el) => {
        el.style.minWidth = "320px";
      });
      await page.screenshot({ path: "output/visual-previews/design-panel-before-390.png" });
      await panel.evaluate((el) => {
        el.style.minWidth = "min(320px, 50%)";
      });
      await page.screenshot({ path: "output/visual-previews/design-panel-after-left-390.png" });
    }
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      await page.getByRole("button", { name: "Move agent panel" }).press(key);
      const horizontal = key === "ArrowLeft" || key === "ArrowRight";
      const extent = horizontal ? width : 300;
      const size = async (locator: typeof panel) => {
        const box = await locator.boundingBox();
        return horizontal ? box!.width : box!.height;
      };
      expect(await size(panel)).toBeGreaterThanOrEqual(
        Math.min(horizontal ? 320 : 160, extent * 0.5),
      );
      expect(await size(canvas)).toBeGreaterThan(extent * 0.19 - 1);
      expect((await size(panel)) + (await size(canvas))).toBeLessThanOrEqual(extent);
      const separator = page.getByRole("separator", { name: "Resize agent panel" });
      await separator.press("End");
      expect(await size(panel)).toBeCloseTo(extent * 0.8, 0);
      await separator.press("Home");
      expect(await size(panel)).toBeLessThanOrEqual(extent * 0.5);
      const before = await size(panel);
      const handle = await separator.boundingBox();
      const x = handle!.x + handle!.width / 2;
      const y = handle!.y + handle!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      const sign = key === "ArrowLeft" || key === "ArrowUp" ? 1 : -1;
      await page.mouse.move(x + (horizontal ? sign * 10 : 0), y + (horizontal ? 0 : sign * 10));
      await page.mouse.up();
      expect(await size(panel)).toBeCloseTo(before + 10, 0);
    }
    if (test.info().project.name === "desktop-chromium")
      await page.screenshot({ path: `output/visual-previews/design-panel-after-${width}.png` });
  });
}
