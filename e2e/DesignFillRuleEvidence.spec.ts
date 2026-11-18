import { expect, test } from "@playwright/test";

test("the fill-rule evidence count settles without scrolling", async ({ page }) => {
  const url = new URL("../design/00005-fill-rule-controls.html", import.meta.url);
  await page.goto(url.href, { waitUntil: "domcontentloaded" });

  // Browsers may choose to preload some offscreen lazy images. Require every
  // image the counter depends on to load without relying on that heuristic.
  await expect(page.locator('.frame img[loading="eager"]')).toHaveCount(8);
  const badge = page.locator("[data-evidence-badge]");
  await expect(badge).toHaveText("Evidence 8 / 8 images");
  await expect(badge).toHaveAttribute("data-complete", "true");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
