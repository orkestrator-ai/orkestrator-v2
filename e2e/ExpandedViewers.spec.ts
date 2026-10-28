import { expect, test } from "@playwright/test";

const viewers = [
  { viewer: "source", trigger: "Expand source", title: "Expanded source", cap: 1024 },
  { viewer: "file", trigger: "Preview file: fixture.txt (Text)", title: "fixture.txt", cap: 1024 },
  { viewer: "gallery", trigger: "Open gallery", title: "Image preview: Width fixture", cap: 1536 },
  { viewer: "mermaid", trigger: "Expand diagram", title: "Mermaid diagram", cap: 1280 },
  { viewer: "table", trigger: "Expand table", title: "Table", cap: 1440 },
];

for (const { viewer, trigger, title, cap } of viewers) {
  test(`${viewer} viewer preserves its expanded width inside the viewport`, async ({ page }) => {
    const viewport = page.viewportSize()!;
    // The normal desktop catches a fallback to the default 32rem cap. A wider
    // desktop also checks each viewer's explicit cap instead of just its gutter.
    const widths = viewport.width >= 640 ? [viewport.width, 1920] : [viewport.width];
    for (const width of widths) {
      await page.setViewportSize({ ...viewport, width });
      await page.goto(`/expanded-viewers?viewer=${viewer}`);
      await page.getByRole("button", { name: trigger, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog).toBeVisible();
      const expectedWidth = Math.min(cap, width - 32);
      // Opening zoom changes the bounding box while the element is visible.
      await expect
        .poll(async () => (await dialog.boundingBox())?.width)
        .toBeCloseTo(expectedWidth, 1);
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeCloseTo((width - expectedWidth) / 2, 1);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  });
}
