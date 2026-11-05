import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

async function expectMailDrawnAsTiles(page: Page) {
  const tiles = page.locator("[data-mail-tile]");
  // Two batched in one row, and one stored as a text block with pasted newlines.
  // The tab is a large module, which a cold fixture server compiles on demand.
  await expect(tiles).toHaveCount(3, { timeout: 30_000 });
  await expect(tiles.nth(0)).toContainText("Parser fixed, ready for review");
  await expect(tiles.nth(1)).toHaveAttribute("data-mail-tone", "info");
  await expect(tiles.nth(2)).toContainText("One more thing");
  // The row it cannot read is a notice, and the transcript around the mail stays.
  await expect(page.getByText("could not be read for display here")).toBeVisible();
  await expect(page.getByText("Please wait for the parser worker's report.")).toBeVisible();
  await expect(page.getByText("The report arrived; reading it now.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("orkestrator-peer");
}

test("a Claude tmux tab draws delivered mail as tiles, and again after a reload", async ({
  page,
}, testInfo) => {
  test.slow();
  await page.goto("/tmux-mail-tiles");
  await expectMailDrawnAsTiles(page);
  await page.reload();
  await expectMailDrawnAsTiles(page);

  // Nothing overflows sideways on either viewport.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  if (process.env.ORKESTRATOR_VISUAL_PREVIEW_DIR) {
    mkdirSync(process.env.ORKESTRATOR_VISUAL_PREVIEW_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(
        process.env.ORKESTRATOR_VISUAL_PREVIEW_DIR,
        `tmux-mail-tiles-${testInfo.project.name}.png`,
      ),
    });
  }
});
