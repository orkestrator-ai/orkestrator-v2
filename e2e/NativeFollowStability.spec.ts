import { expect, test } from "@playwright/test";
import type { ScrollDiagnostics } from "../apps/web/src/lib/transcript-scroll/transcript-scroll-controller";

declare global {
  interface Window {
    __followProbe?: { pillShows: number; spacerHeights: number[]; stop: () => void };
  }
}

const scrollerSelector = '[data-transcript-scroller="true"]';
const pillName = /scroll to bottom of conversation/i;

/**
 * The native dock reserves its own height below the transcript, so its
 * "Scroll down" button is layout: a button flashed while following pushed the
 * transcript up and snapped it back down.
 */
test("a follower never sees the scroll-down button while a response streams", async ({ page }) => {
  await page.goto("/rich-transcript-perf");
  await page.waitForFunction(() => window.__richPerf?.ready === true);
  const scroller = page.locator(scrollerSelector);
  await expect(scroller).toBeVisible();
  await page.evaluate(() => window.__richPerf!.scrollToBottom());
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: pillName })).toHaveCount(0);

  await page.evaluate(() => {
    let pillShows = 0;
    let visible = false;
    const spacerHeights: number[] = [];
    const observer = new MutationObserver(() => {
      const shown = document.querySelector('[aria-label="Scroll to bottom of conversation"]');
      if (shown && !visible) pillShows += 1;
      visible = shown !== null;
    });
    observer.observe(document.body, { subtree: true, childList: true });
    let running = true;
    const sample = () => {
      if (!running) return;
      const spacer = document.querySelector('[data-testid="transcript-bottom-spacer"]');
      const height = spacer?.getBoundingClientRect().height ?? -1;
      if (spacerHeights.at(-1) !== height) spacerHeights.push(height);
      requestAnimationFrame(sample);
    };
    sample();
    window.__followProbe = {
      get pillShows() {
        return pillShows;
      },
      spacerHeights,
      stop() {
        running = false;
        observer.disconnect();
      },
    };
    window.__richPerf!.startStream(16, 24);
  });
  await page.waitForTimeout(3_000);
  const result = await page.evaluate(() => {
    window.__richPerf!.stopStream();
    const probe = window.__followProbe!;
    probe.stop();
    return { pillShows: probe.pillShows, spacerHeights: probe.spacerHeights };
  });
  expect(result.pillShows).toBe(0);
  expect(result.spacerHeights).toHaveLength(1);

  // A reader who scrolls away still gets the button.
  await scroller.hover();
  await page.mouse.wheel(0, -800);
  await expect(page.getByRole("button", { name: pillName })).toBeVisible();
});

test("bare viewport movement in an idle transcript keeps return-to-latest visible", async ({
  page,
}) => {
  await page.goto("/rich-transcript-perf");
  await page.waitForFunction(() => window.__richPerf?.ready === true);
  const scroller = page.locator(scrollerSelector);
  await page.evaluate(() => window.__richPerf!.scrollToBottom());
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(1);
  // Geometry can arrive before the bounded latest journey retires its latch.
  await expect
    .poll(() =>
      scroller.evaluate((el) => {
        const stats = (
          el as HTMLElement & {
            orkTranscriptScrollDiagnostics: () => ScrollDiagnostics;
          }
        ).orkTranscriptScrollDiagnostics();
        return (
          stats.operationsStarted -
          stats.converged -
          stats.clamped -
          stats.expired -
          stats.unresolved -
          stats.cancelled -
          stats.superseded
        );
      }),
    )
    .toBe(0);
  await scroller.evaluate((el) => {
    el.scrollTop -= 800;
  });
  await expect(page.getByRole("button", { name: pillName })).toBeVisible();
  await page.evaluate(async () => {
    for (let frame = 0; frame < 5; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  expect(
    await scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
  ).toBeGreaterThan(100);
  await expect(page.getByRole("button", { name: pillName })).toBeVisible();
});
