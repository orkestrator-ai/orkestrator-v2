import { expect, test, type Page } from "@playwright/test";
import { startAnchorProbe, stopAnchorProbe } from "./transcript-anchor-probe";

const scrollerSelector = '[data-transcript-scroller="true"]';
const contentSelector = ".tool-group-fold-content";

async function bottomGap(page: Page) {
  return page
    .locator(scrollerSelector)
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

/** Records every animation and every height the group's body takes, after layout. */
async function observeGroupBody(page: Page) {
  await page.evaluate((selector) => {
    const probe = { animations: [] as string[], heights: [] as number[] };
    (window as unknown as { groupProbe: typeof probe }).groupProbe = probe;
    document.addEventListener("animationstart", (event) => {
      if (event.target instanceof HTMLElement && event.target.matches(selector)) {
        probe.animations.push(event.animationName);
      }
    });
    const body = Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!;
    new ResizeObserver(() => probe.heights.push(body.getBoundingClientRect().height)).observe(body);
  }, contentSelector);
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`a live group crossing the fold threshold stays open with ${reducedMotion} motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/streaming-transcript?long=1&fold=1");
    const row = page.locator("[data-chat-message-index]").last();
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(2);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    const rowCount = await page.getByTestId("transcript-row-count").textContent();
    const firstCall = await row
      .getByRole("button", { name: "Exec Command success" })
      .first()
      .elementHandle();
    await observeGroupBody(page);

    await page.getByRole("button", { name: "Grow tool group" }).click();
    // The reader was looking at these rows: they stay, with the fold control
    // added above them. Nothing collapses on its own and nothing remounts.
    const fold = page.getByRole("button", { name: /^Fold 3 tool calls:/ });
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(3);
    expect(await firstCall!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.getByTestId("transcript-row-count")).toHaveText(rowCount!);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);

    // Folding is the reader's, immediate, and never animates layout height.
    await fold.click();
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(0);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    const show = page.getByRole("button", { name: /^Show 3 tool calls:/ });
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await show.click();
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(3);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    const probe = await page.evaluate(
      () => (window as unknown as { groupProbe: { animations: string[] } }).groupProbe,
    );
    expect(probe.animations.includes("tool-group-fold-close")).toBe(false);
    const animationName = await page
      .locator(contentSelector)
      .last()
      .evaluate((element) => getComputedStyle(element).animationName);
    expect(animationName).toBe(reducedMotion === "reduce" ? "none" : "tool-group-fold-open");
    if (reducedMotion === "no-preference") {
      // Opening fades settled rows in: opacity only, never a height keyframe.
      const keyframes = await page.evaluate(() =>
        Array.from(document.styleSheets).flatMap((sheet) =>
          Array.from(sheet.cssRules)
            .filter(
              (rule): rule is CSSKeyframesRule =>
                rule instanceof CSSKeyframesRule && rule.name.startsWith("tool-group-fold"),
            )
            .map((rule) => rule.cssText),
        ),
      );
      expect(keyframes.length).toBeGreaterThan(0);
      for (const text of keyframes) expect(text).not.toContain("height");
    }
  });
}

test("a live group growing below a released reader leaves their place where it is", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1&fold=1");
  await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
  const scroller = page.locator(scrollerSelector);
  // Let the scroller attach its input listeners after the first bottom fill.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const next = () => (++frames === 8 ? resolve() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
  );
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  const scrollEnded = scroller.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.addEventListener("scrollend", () => resolve(), { once: true });
      }),
  );
  await page.mouse.wheel(0, -250);
  await scrollEnded;
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(100);
  // The reader has stopped and is reading: the wheel's animation (which can
  // restart around writes and so end more than once) is over.
  await page.waitForTimeout(400);
  const anchorIndex = await scroller.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll<HTMLElement>("[data-chat-message-index]")).find(
      (row) => row.getBoundingClientRect().bottom > viewport.top,
    )!.dataset.chatMessageIndex;
  });
  // The tail remains inside overscan, so this exercises an actual mounted group.
  const tail = page.locator("[data-chat-message-index]").last();
  await expect(tail.getByRole("button", { name: "Exec Command success" })).toHaveCount(2);
  await startAnchorProbe(scroller, `css:[data-chat-message-index="${anchorIndex}"]`);
  await page.getByRole("button", { name: "Grow tool group" }).click();
  await expect(tail.getByRole("button", { name: "Exec Command success" })).toHaveCount(3);
  await page.waitForTimeout(400);
  const probe = await stopAnchorProbe(scroller);
  expect(probe.missing).toBe(0);
  expect(probe.maxError).toBeLessThanOrEqual(2);
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(100);
});

test("a 1,500-call group opens in a bounded viewport that owns its own scrolling", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=1500");
  const scroller = page.locator(scrollerSelector);
  const show = page.getByRole("button", { name: /^Show 1500 tool calls:/ });
  await expect(show).toBeVisible();
  await show.click();
  const viewport = page.locator("[data-transcript-inner-viewport]");
  await expect(viewport).toBeVisible();
  // Mounted work is proportional to the visible window, not to the group.
  await expect.poll(() => viewport.locator("[data-transcript-part-id]").count()).toBeGreaterThan(0);
  const mounted = await viewport.locator("[data-transcript-part-id]").count();
  expect(mounted).toBeLessThan(60);
  // The open group's row stays within the body ceiling plus its head line.
  const row = page.locator("[data-chat-message-index]").last();
  const ceiling = await page.evaluate(() =>
    Math.min(
      28 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      0.55 * innerHeight,
    ),
  );
  const rowHeight = (await row.boundingBox())!.height;
  expect(rowHeight).toBeLessThanOrEqual(ceiling + 120);
  // A wheel over the group scrolls the group, not the transcript.
  const outerBefore = await scroller.evaluate((element) => element.scrollTop);
  const innerScroller = viewport.locator("[data-virtuoso-scroller]");
  const innerBefore = await innerScroller.evaluate((element) => element.scrollTop);
  await innerScroller.hover();
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() => innerScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(innerBefore + 100);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(outerBefore, 0);
  // Still bounded after scrolling deep into it.
  expect(await viewport.locator("[data-transcript-part-id]").count()).toBeLessThan(60);
});

test("a selection inside a long group's viewport survives nearby inner scrolling", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=1500");
  await page.getByRole("button", { name: /^Show 1500 tool calls:/ }).click();
  const viewport = page.locator("[data-transcript-inner-viewport]");
  const innerScroller = viewport.locator("[data-virtuoso-scroller]");
  await expect
    .poll(() => viewport.locator("[data-tool-group-entry-index]").count())
    .toBeGreaterThan(2);
  const entry = viewport.locator('[data-tool-group-entry-index="1"]');
  const held = await entry.elementHandle();
  await entry.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  // Let selectionchange deliver, then move the reader past the inner
  // overscan (120 px) but inside the protection bound (8 rows beyond the
  // visible range): it stays mounted only because it is protected.
  await page.waitForTimeout(50);
  const entryHeight = (await entry.boundingBox())!.height;
  await innerScroller.evaluate((element, by) => {
    element.scrollTop += by;
  }, entryHeight * 7.5);
  await page.waitForTimeout(200);
  expect(await held!.evaluate((element) => element.isConnected)).toBe(true);
  expect(
    await page.evaluate(() => document.getSelection()?.toString().length ?? 0),
  ).toBeGreaterThan(0);
  // Far past it, protection releases and the window stays bounded.
  await innerScroller.evaluate((element) => {
    element.scrollTop += 20_000;
  });
  await expect.poll(() => held!.evaluate((element) => element.isConnected)).toBe(false);
  expect(await viewport.locator("[data-tool-group-entry-index]").count()).toBeLessThan(60);
});

test("focus inside a long group's viewport survives nearby inner scrolling", async ({ page }) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=1500");
  await page.getByRole("button", { name: /^Show 1500 tool calls:/ }).click();
  const viewport = page.locator("[data-transcript-inner-viewport]");
  const innerScroller = viewport.locator("[data-virtuoso-scroller]");
  await expect
    .poll(() => viewport.locator("[data-tool-group-entry-index]").count())
    .toBeGreaterThan(2);
  const entry = viewport.locator('[data-tool-group-entry-index="1"]');
  const control = entry.locator("button, [tabindex]").first();
  await control.focus();
  const held = await control.elementHandle();
  const entryHeight = (await entry.boundingBox())!.height;
  // Past the inner overscan but inside the protection bound: the focused
  // control is neither unmounted nor blurred.
  await innerScroller.evaluate((element, by) => {
    element.scrollTop += by;
  }, entryHeight * 7.5);
  await page.waitForTimeout(200);
  expect(await held!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await held!.evaluate((element) => document.activeElement === element)).toBe(true);
  // Far past it, protection releases and the window stays bounded.
  await innerScroller.evaluate((element) => {
    element.scrollTop += 20_000;
  });
  await expect.poll(() => held!.evaluate((element) => element.isConnected)).toBe(false);
  expect(await viewport.locator("[data-tool-group-entry-index]").count()).toBeLessThan(60);
});

test("a waiting group that fits its cap follows appended calls as it starts overflowing", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=12&liveGroup=1");
  await page.getByRole("button", { name: /^Show 12 tool calls:/ }).click();
  const viewport = page.locator("[data-transcript-inner-viewport]");
  const inner = viewport.locator("[data-virtuoso-scroller]");
  const gap = () =>
    inner.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  await expect(viewport.locator('[data-transcript-part-id="tool-5011"]')).toBeVisible();
  await expect
    .poll(() => inner.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBe(0);
  await page.getByRole("button", { name: "Append group calls" }).click();
  await expect
    .poll(() => inner.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await expect(viewport.locator('[data-transcript-part-id="tool-5019"]')).toBeVisible();
  await page.getByRole("button", { name: "Append group calls" }).click();
  await expect(viewport.locator('[data-transcript-part-id="tool-5027"]')).toBeVisible();
  await expect.poll(gap).toBeLessThanOrEqual(2);
  // Once the reader leaves the inner end, later calls respect their place.
  await inner.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(gap).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Append group calls" }).click();
  await expect(page.getByRole("button", { name: /^Fold 36 tool calls:/ })).toBeVisible();
  await expect.poll(() => inner.evaluate((element) => element.scrollTop)).toBe(0);
});

test("history prepended inside an open virtualized group preserves the visible call and its offset", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=80");
  await page.getByRole("button", { name: /^Show 80 tool calls:/ }).click();
  const viewport = page.locator("[data-transcript-inner-viewport]");
  const inner = viewport.locator("[data-virtuoso-scroller]");
  await expect(viewport.locator('[data-transcript-part-id="tool-5000"]')).toBeVisible();
  await inner.evaluate((element) => {
    element.scrollTop = 900;
  });
  const visibleCall = () =>
    inner.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const part = Array.from(
        element.querySelectorAll<HTMLElement>("[data-transcript-part-id]"),
      ).find((part) => part.getBoundingClientRect().bottom > top);
      return part
        ? { id: part.dataset.transcriptPartId!, offset: part.getBoundingClientRect().top - top }
        : null;
    });
  await expect
    .poll(async () => {
      const call = await visibleCall();
      return call !== null && call.id !== "tool-5000";
    })
    .toBe(true);
  const before = await visibleCall();
  await page.getByRole("button", { name: "Prepend group calls" }).click();
  await expect(page.getByRole("button", { name: /^Fold 90 tool calls:/ })).toBeVisible();
  await expect.poll(visibleCall).toEqual(before);
  expect(await viewport.locator("[data-tool-group-entry-index]").count()).toBeLessThan(60);
});
