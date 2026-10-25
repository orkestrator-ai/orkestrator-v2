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
async function startArrivalProbe(page: Page, selector = arrivingRow) {
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
    { scrollerSelector, selector },
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

test("a live authentication failure grows its notice and recovery card in one track", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFollowing(page, "/streaming-transcript?arrivals");
  const selector = '[data-chat-message-key^="native-terminal:error:"]';
  await startArrivalProbe(page, selector);
  await page.getByRole("button", { name: "Append authentication error" }).click();
  const row = page.locator(selector);
  await expect(row.getByRole("region", { name: "Sign in to Claude", exact: true })).toBeVisible();
  await expect(row).not.toHaveAttribute("data-transcript-arrival");
  await waitForFrames(page);
  const { samples, added } = await stopArrivalProbe(page);
  const height = samples.at(-1)!.height;
  expect(height).toBeGreaterThan(120);
  expect(added).toEqual([{ row: true, inGroup: false }]);
  // Includes the recovery card: an implicit second grid track would make the
  // first frame almost full height and leave only the small notice growing.
  expect(samples[0]!.height).toBeLessThan(height * 0.5);
  expect(samples.filter((sample) => sample.animating).length).toBeGreaterThan(4);
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i]!.height).toBeGreaterThanOrEqual(samples[i - 1]!.height - 0.5);
  }
  for (const sample of samples) expect(sample.distance).toBeLessThanOrEqual(1);
});

test("content updates and another append preserve an active entrance and following", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFollowing(page, "/streaming-transcript?arrivals");
  await startArrivalProbe(page);
  const preserved = await page.evaluate(async (selector) => {
    const click = (name: string) =>
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === name)!
        .click();
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    click("Append turn");
    await frame();
    const row = document.querySelector<HTMLElement>(selector)!;
    const animation = row.getAnimations()[0]!;
    await animation.ready;
    const startTime = animation.startTime;
    // Keep both mutations inside the real 300ms entrance, across commits.
    click("Update turn");
    await frame();
    const afterUpdate =
      row.getAnimations()[0] === animation && row.hasAttribute("data-transcript-arrival");
    click("Append turn");
    await frame();
    const afterAppend =
      row.getAnimations()[0] === animation && row.hasAttribute("data-transcript-arrival");
    return {
      afterUpdate,
      afterAppend,
      sameStart: animation.startTime === startTime,
      text: row.textContent,
    };
  }, arrivingRow);
  expect(preserved.afterUpdate).toBe(true);
  expect(preserved.afterAppend).toBe(true);
  expect(preserved.sameStart).toBe(true);
  expect(preserved.text).toContain("More streamed content");
  await expect(page.locator(arrivingRow)).toHaveCount(2);
  await expect(page.locator("[data-transcript-arrival]")).toHaveCount(0);
  await waitForFrames(page);
  const { samples, added } = await stopArrivalProbe(page);
  expect(added).toEqual([
    { row: true, inGroup: false },
    { row: true, inGroup: false },
  ]);
  expect(samples.filter((sample) => sample.animating).length).toBeGreaterThan(4);
  for (const sample of samples) expect(sample.distance).toBeLessThanOrEqual(1);
});

test("an entry entrance settles together with the automatic three-call fold", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFollowing(page, "/streaming-transcript?long=1&fold&arrivals");
  await startArrivalProbe(page, '[data-chat-message-key="live-fold"]');
  await page.getByRole("button", { name: "Grow tool group" }).click();
  const show = page.getByRole("button", { name: /^Show 3 tool calls:/ });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-transcript-arrival]")).toHaveCount(0);
  await expect(page.locator(".tool-group-fold-content").last()).toBeHidden();
  const { samples, added } = await stopArrivalProbe(page);
  expect(added).toEqual([{ row: false, inGroup: true }]);
  expect(samples.length).toBeGreaterThan(4);
  for (const sample of samples) expect(sample.distance).toBeLessThanOrEqual(1);
  await show.click();
  await expect(
    page.locator('[data-chat-message-key="live-fold"] [data-transcript-part-id]'),
  ).toHaveCount(3);
  await expect(page.locator("[data-transcript-arrival]")).toHaveCount(0);
});

for (const scenario of ["crossing", "overflowing", "oversized", "detached"] as const) {
  test(`a short tool body handles an arriving call when ${scenario}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Deterministic content heights exercise both sides of the production cap
    // on mobile and desktop, without depending on text wrapping or fonts.
    const initialCount = scenario === "crossing" ? 4 : 5;
    await openFollowing(
      page,
      `/streaming-transcript?long=1&bigGroup=${initialCount}&liveGroup&arrivals`,
    );
    await page.addStyleTag({
      content: `.tool-group-fold-content button { height: ${scenario === "overflowing" || scenario === "detached" ? 110 : 78}px; }`,
    });
    await page
      .getByRole("button", { name: new RegExp(`^Show ${initialCount} tool calls:`) })
      .click();
    const body = page.locator(
      '[data-chat-message-key="big-tool-group"] .tool-group-fold-content > div',
    );
    await expect(body).toBeVisible();
    await page.evaluate(() =>
      Promise.all(
        Array.from(document.querySelectorAll(".tool-group-fold-content")).flatMap((element) =>
          element.getAnimations().map((animation) => animation.finished),
        ),
      ),
    );
    await waitForFrames(page);
    const before = await body.evaluate((element) => ({
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    if (scenario === "overflowing" || scenario === "detached") {
      expect(before.scrollHeight).toBeGreaterThan(before.height);
    } else {
      expect(before.scrollHeight).toBeLessThanOrEqual(before.height + 1);
    }
    if (scenario === "detached") {
      await body.hover();
      await page.mouse.wheel(0, -1000);
      await waitForFrames(page);
      await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
    }
    if (scenario === "oversized") {
      await page.addStyleTag({
        content:
          '.tool-group-fold-content [data-transcript-part-id="tool-5005"] button { height: 600px; }',
      });
    }
    await startArrivalProbe(page);
    await page
      .getByRole("button", { name: "Append group call", exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(body.locator(":scope > div")).toHaveCount(initialCount + 1);
    if (scenario === "crossing") {
      const entry = body.locator(":scope > div").last();
      await expect(entry).toHaveAttribute("data-transcript-arrival");
      // The call's initial layout fits; streamed content makes it taller
      // during its entrance, taking the short body across its height ceiling.
      await entry.locator("button").evaluate((button) => {
        button.style.height = "160px";
      });
    }
    await expect(page.locator("[data-transcript-arrival]")).toHaveCount(0);
    await waitForFrames(page);
    const { added } = await stopArrivalProbe(page);
    const after = await body.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const last = element.lastElementChild!.getBoundingClientRect();
      return {
        gap: element.scrollHeight - element.clientHeight - element.scrollTop,
        top: element.scrollTop,
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
        lastHeight: last.height,
        lastTop: last.top - viewport.top,
        lastBottom: last.bottom - viewport.bottom,
      };
    });
    expect(after.scrollHeight).toBeGreaterThan(after.height);
    if (scenario === "detached") {
      expect(after.top).toBe(0);
      expect(after.gap).toBeGreaterThan(100);
    } else {
      expect(after.gap).toBeLessThanOrEqual(2);
      expect(after.lastBottom).toBeLessThanOrEqual(1);
      if (scenario === "oversized") expect(after.lastHeight).toBeGreaterThan(after.height);
      else expect(after.lastTop).toBeGreaterThanOrEqual(-1);
    }
    expect(added).toEqual(scenario === "crossing" ? [{ row: false, inGroup: true }] : []);
    if (scenario === "crossing") {
      // A subsequent append still follows: growth must not leave stale
      // detached state behind after the entrance clears.
      await page
        .getByRole("button", { name: "Append group call", exact: true })
        .evaluate((button) => (button as HTMLButtonElement).click());
      await expect(body.locator(":scope > div")).toHaveCount(initialCount + 2);
      await expect
        .poll(() =>
          body.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(2);
    }
    if (scenario === "detached") {
      // Resume following at the new end, then move up within the range that
      // was added. That must release following again before the next append.
      await body.hover();
      await page.mouse.wheel(0, 1000);
      await expect
        .poll(() =>
          body.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(2);
      await page.mouse.wheel(0, -50);
      await expect
        .poll(() =>
          body.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeGreaterThan(20);
      const held = await body.evaluate((element) => element.scrollTop);
      await page
        .getByRole("button", { name: "Append group call", exact: true })
        .evaluate((button) => (button as HTMLButtonElement).click());
      await expect(body.locator(":scope > div")).toHaveCount(initialCount + 2);
      await waitForFrames(page);
      expect(await body.evaluate((element) => element.scrollTop)).toBe(held);
    }
  });
}
