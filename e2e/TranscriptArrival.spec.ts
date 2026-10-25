import { expect, test, type Page } from "@playwright/test";
import { scrollDiagnostics, startAnchorProbe, stopAnchorProbe } from "./transcript-anchor-probe";

const scrollerSelector = '[data-transcript-scroller="true"]';
const arrivingRow = '[data-chat-message-key^="streamed-turn-"]';

declare global {
  interface Window {
    __arrivalProbe?: {
      samples: Array<{ height: number; distance: number; animating: boolean }>;
      added: Array<{ row: boolean; inGroup: boolean }>;
      stop: () => void;
    };
  }
}

async function waitForFrames(page: Page, count = 4) {
  await page.evaluate(
    (frameCount) =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const next = () => (++frames === frameCount ? resolve() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
    count,
  );
}

async function distanceFromBottom(page: Page) {
  return page
    .locator(scrollerSelector)
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

/**
 * Samples, once per painted frame, the arriving row's height and the
 * scroller's distance from its end, and records every element the entrance
 * attribute is added to.
 */
async function startArrivalProbe(page: Page) {
  await page.evaluate(
    ({ scrollerSelector, selector }) => {
      const samples: Array<{ height: number; distance: number; animating: boolean }> = [];
      const added: Array<{ row: boolean; inGroup: boolean }> = [];
      let running = true;
      let frame = 0;
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        if (!running) return;
        // Re-resolved each frame: a remount replaces the scroller.
        const el = document.querySelector<HTMLElement>(scrollerSelector);
        const row = el?.querySelector<HTMLElement>(selector);
        if (el && row) {
          samples.push({
            height: row.getBoundingClientRect().height,
            distance: el.scrollHeight - el.clientHeight - el.scrollTop,
            animating: row.hasAttribute("data-transcript-arrival"),
          });
        }
        frame = requestAnimationFrame(() => channel.port2.postMessage(0));
      };
      frame = requestAnimationFrame(() => channel.port2.postMessage(0));
      // One entry per element: development's re-run effects set it twice.
      const seen = new WeakSet<Element>();
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target as HTMLElement;
          if (record.oldValue !== null || seen.has(target)) continue;
          seen.add(target);
          added.push({
            row: target.hasAttribute("data-chat-message-index"),
            inGroup: target.closest(".tool-group-fold-content") !== null,
          });
        }
      });
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["data-transcript-arrival"],
      });
      window.__arrivalProbe = {
        samples,
        added,
        stop() {
          running = false;
          cancelAnimationFrame(frame);
          observer.disconnect();
        },
      };
    },
    { scrollerSelector, selector: arrivingRow },
  );
}

async function stopArrivalProbe(page: Page) {
  return page.evaluate(() => {
    const probe = window.__arrivalProbe!;
    probe.stop();
    return { samples: probe.samples, added: probe.added };
  });
}

async function releaseFollow(page: Page) {
  await page.locator(scrollerSelector).evaluate((element) => {
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.scrollTop = Math.max(0, element.scrollTop - 600);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(100);
}

async function openFollowing(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator(scrollerSelector)).toBeVisible();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
  await waitForFrames(page, 8);
}

test("a row arriving for a follower grows in while the transcript stays at its end", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFollowing(page, "/streaming-transcript?arrivals");
  await startArrivalProbe(page);
  await page.getByRole("button", { name: "Append turn" }).click();
  await expect(page.locator(arrivingRow)).toBeVisible();
  await expect(page.locator("[data-transcript-arrival]")).toHaveCount(0);
  await waitForFrames(page, 4);
  const { samples, added } = await stopArrivalProbe(page);

  expect(added).toEqual([{ row: true, inGroup: false }]);
  const finalHeight = samples.at(-1)!.height;
  expect(finalHeight).toBeGreaterThan(20);
  // Drawn short first, never at full size before the entrance.
  expect(samples[0]!.height).toBeLessThan(finalHeight * 0.75);
  expect(samples.filter((sample) => sample.animating).length).toBeGreaterThan(4);
  for (let index = 1; index < samples.length; index++) {
    expect(samples[index]!.height).toBeGreaterThanOrEqual(samples[index - 1]!.height - 0.5);
  }
  // The follower is pinned to the end on every painted frame.
  for (const sample of samples) expect(sample.distance).toBeLessThanOrEqual(1);
});

test("a row arrives at full size under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFollowing(page, "/streaming-transcript?arrivals");
  await startArrivalProbe(page);
  await page.getByRole("button", { name: "Append turn" }).click();
  await expect(page.locator(arrivingRow)).toBeVisible();
  await waitForFrames(page, 6);
  const { samples, added } = await stopArrivalProbe(page);

  expect(added).toEqual([]);
  expect(samples[0]!.height).toBe(samples.at(-1)!.height);
  for (const sample of samples) expect(sample.distance).toBeLessThanOrEqual(1);
});

test("a tool call joining a short group grows in inside it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFollowing(page, "/streaming-transcript?fold&shortGroup&arrivals");
  await startArrivalProbe(page);
  const lastRow = page.locator('[data-chat-message-key="live-fold"]');
  await expect(lastRow.locator("[data-transcript-part-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "Grow tool group" }).click();
  await expect(lastRow.locator("[data-transcript-part-id]")).toHaveCount(2);
  await expect(page.locator("[data-transcript-arrival]")).toHaveCount(0);
  const { added } = await stopArrivalProbe(page);

  // The call joined the existing row: only it animates, not the row.
  expect(added).toEqual([{ row: false, inGroup: true }]);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
});

test("rows that mount without arriving render at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFollowing(page, "/streaming-transcript?long=1&arrivals");
  await startArrivalProbe(page);
  // Navigating through history mounts rows; a remount restores every row.
  await releaseFollow(page);
  await page.getByRole("button", { name: "Scroll to tool history" }).click();
  await expect(page.locator('[data-chat-message-index="40"]')).toBeVisible();
  await page.getByRole("button", { name: "Save and remount" }).click();
  await expect(page.getByTestId("list-generation")).toHaveText("1");
  await expect(page.locator("[data-chat-message-index]").first()).toBeVisible();
  await waitForFrames(page, 8);
  const { added } = await stopArrivalProbe(page);
  expect(added).toEqual([]);
});

test("a detached reader's row holds every painted frame while rows grow in below", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFollowing(page, "/streaming-transcript?long=1&arrivals");
  const scroller = page.locator(scrollerSelector);
  await releaseFollow(page);
  await page.getByRole("button", { name: "Scroll to tool history" }).click();
  await expect(page.locator('[data-chat-message-index="40"]')).toBeVisible();
  await expect
    .poll(async () => (await scrollDiagnostics(scroller)).lastOutcome)
    .toMatch(/converged|clamped/);
  await startAnchorProbe(scroller, 'css:[data-chat-message-index="40"]');
  for (let index = 0; index < 3; index++) {
    await page.getByRole("button", { name: "Append turn" }).click();
    await expect(page.getByTestId("transcript-row-count")).toHaveText(String(84 + index));
  }
  await waitForFrames(page, 24);
  const probe = await stopAnchorProbe(scroller);
  expect(probe.missing).toBe(0);
  expect(probe.maxError).toBeLessThanOrEqual(2);
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(100);
});
