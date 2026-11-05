import { expect, test } from "@playwright/test";
import { scrollDiagnostics } from "./transcript-anchor-probe";

test("prompt rail glides to a distant virtualized row and reader wheel cancels ownership", async ({
  page,
}, testInfo) => {
  await page.goto("/streaming-transcript?long&promptRail");
  const rail = page.getByRole("navigation", { name: "Your prompts in this conversation" });
  if (testInfo.project.name === "mobile-chromium") {
    await expect(rail).toBeHidden();
    await page.screenshot({ path: "output/visual-previews/prompt-rail-narrow.png" });
    return;
  }
  await expect(rail).toBeVisible();
  const scroller = page.locator('[data-transcript-scroller="true"]');
  const first = page.locator('[data-chat-message-key="history-8"]');
  // The distant destination must start outside Virtuoso's mounted window.
  await expect(first).toHaveCount(0);
  await page.screenshot({ path: "output/visual-previews/prompt-rail-before.png" });
  // Change a mounted row above the destination as the final leg begins.
  // Virtuoso's real ResizeObserver must measure it while the glide tracks.
  await page.evaluate(() => {
    const watch = () => {
      const row = document.querySelector<HTMLElement>('[data-chat-message-key="history-8"]');
      const previous = row?.parentElement?.previousElementSibling as HTMLElement | null;
      if (!row || !previous) return requestAnimationFrame(watch);
      previous.style.minHeight = "260px";
      document.documentElement.dataset.promptGlideMeasured = "true";
    };
    requestAnimationFrame(watch);
  });
  await rail.getByRole("button").nth(4).click();
  await expect(page.locator("html")).toHaveAttribute("data-prompt-glide-measured", "true");
  await expect.poll(async () => (await scrollDiagnostics(scroller)).lastOutcome).toBe("converged");
  await expect
    .poll(() =>
      first.evaluate((row) => {
        const viewport = row.closest('[data-transcript-scroller="true"]')!;
        return Math.abs(
          row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16,
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  // Real row measurement in the final leg must not leave a delayed seek retry.
  await page.waitForTimeout(300);
  await expect
    .poll(() =>
      first.evaluate((row) => {
        const viewport = row.closest('[data-transcript-scroller="true"]')!;
        return Math.abs(
          row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16,
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: "output/visual-previews/prompt-rail-desktop.png" });

  await rail.getByRole("button").nth(25).click();
  // Pointer stays over the rail after clicking; the sibling scroller never sees this wheel.
  await page.mouse.wheel(0, 90);
  await expect.poll(async () => (await scrollDiagnostics(scroller)).lastOutcome).toBe("cancelled");
  const stopped = await scroller.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, 90);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(stopped + 60);
  const after = await scroller.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(700);
  expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - after)).toBeLessThanOrEqual(1);
});
