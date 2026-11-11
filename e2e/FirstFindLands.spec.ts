import { expect, test, type Page } from "@playwright/test";

/**
 * The first find on a freshly opened long transcript lands on its match while
 * the rows above it are still unmeasured. Find refines its row navigation onto
 * the match's box; the rows above then measured far smaller than the list's
 * estimate, the list moved the row out of its rendered window, and a box alone
 * could not be brought back, so the navigation ran out with nothing on screen.
 * The box now carries its row, which the controller returns to by index.
 */

test.skip(({ hasTouch }) => hasTouch, "one desktop layout reproduces the estimate error");

async function openTranscript(page: Page) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/transcript-list-renders");
  await page.waitForFunction(() => window.transcriptListFixture?.ready() === true);
  await expect(page.locator('[data-chat-message-key="row-99"]').first()).toBeVisible();
  // Start-up has finished: the tab has stopped committing on its own.
  await expect(async () => {
    await page.evaluate(() => window.transcriptListFixture!.resetCommits());
    await page.waitForTimeout(400);
    const commits = await page.evaluate(() => window.transcriptListFixture!.commits());
    expect(commits.every((tab) => tab.update === 0 && tab.nested === 0)).toBe(true);
  }).toPass({ timeout: 15_000 });
}

test("the first find lands on its match", async ({ page }) => {
  await openTranscript(page);
  await page.keyboard.press("ControlOrMeta+f");
  const input = page.getByRole("textbox", { name: "Find in chat" });
  await input.fill("Fixture row 91");
  const current = page.locator("[data-chat-message-index].outline-amber-400\\/35");
  await expect(current).toHaveAttribute("data-chat-message-key", "row-91");
  await expect(current).toBeInViewport();
  // It stays there once the rows it passed have measured.
  await page.waitForTimeout(1_000);
  await expect(current).toBeInViewport();
});
