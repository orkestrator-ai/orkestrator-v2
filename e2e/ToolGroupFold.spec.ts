import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    foldProbe?: {
      heights: number[];
      bottomGaps: number[];
      anchorTops: number[];
      ended: boolean;
      retainedOnExit: boolean;
      retainedDuringExit: boolean;
      animations: string[];
    };
  }
}

const scrollerSelector = '[data-virtuoso-scroller="true"]';
const contentSelector = ".tool-group-fold-content";

async function bottomGap(page: Page) {
  return page
    .locator(scrollerSelector)
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

async function observeFold(page: Page, anchorSelector?: string) {
  await page.evaluate(
    ({ selector, anchorSelector }) => {
      const probe: NonNullable<Window["foldProbe"]> = (window.foldProbe = {
        heights: [] as number[],
        bottomGaps: [] as number[],
        anchorTops: [] as number[],
        ended: false,
        retainedOnExit: false,
        retainedDuringExit: true,
        animations: [] as string[],
      });
      document.addEventListener("animationstart", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.matches(selector)) return;
        probe.animations.push(event.animationName);
        if (event.animationName !== "tool-group-fold-close") return;
        probe.retainedOnExit = target.isConnected && target.children.length > 0;
        // ResizeObserver runs after layout and the transcript's growth pin, so
        // these are the positions painted to the reader, not pre-layout rAF values.
        const observer = new ResizeObserver(() => {
          probe.heights.push(target.getBoundingClientRect().height);
          if (!probe.ended) probe.retainedDuringExit &&= target.children.length > 0;
          const scroller = target.closest<HTMLElement>('[data-virtuoso-scroller="true"]')!;
          probe.bottomGaps.push(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
          const anchor = anchorSelector ? scroller.querySelector(anchorSelector) : null;
          if (anchor)
            probe.anchorTops.push(
              anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
            );
          if (probe.ended) observer.disconnect();
        });
        observer.observe(target);
      });
      document.addEventListener("animationend", (event) => {
        if (event.animationName === "tool-group-fold-close") probe.ended = true;
      });
    },
    { selector: contentSelector, anchorSelector },
  );
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`a live two-call group folds with ${reducedMotion} motion and keeps bottom follow`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/streaming-transcript?long=1&fold=1");
    const scroller = page.locator(scrollerSelector);
    const row = page.locator("[data-chat-message-index]").last();
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(2);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    const rowCount = await page.getByTestId("transcript-row-count").textContent();
    const held = await row.elementHandle();
    await observeFold(page);
    await page.getByRole("button", { name: "Grow tool group" }).click();
    const trigger = page.getByRole("button", { name: /^Show 3 tool calls:/ });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(0);
    await expect(page.locator(contentSelector).last()).toBeHidden();
    expect(await held!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.getByTestId("transcript-row-count")).toHaveText(rowCount!);
    if (reducedMotion === "no-preference") {
      await expect.poll(() => page.evaluate(() => window.foldProbe!.ended)).toBe(true);
      const probe = await page.evaluate(() => window.foldProbe!);
      expect(probe.retainedOnExit).toBe(true);
      expect(probe.retainedDuringExit).toBe(true);
      // Virtuoso defers measured padding updates by one animation frame. Bound
      // transient drift to that frame's height change; settled geometry below
      // must return to the bottom within browser rounding tolerance.
      const largestFrame = Math.max(
        ...probe.heights.slice(1).map((height, index) => Math.abs(height - probe.heights[index]!)),
      );
      expect(Math.max(...probe.bottomGaps)).toBeLessThanOrEqual(largestFrame + 2);
      const fullHeight = Math.max(...probe.heights);
      expect(fullHeight).toBeGreaterThan(30);
      expect(probe.heights.some((height) => height > 1 && height < fullHeight - 1)).toBe(true);
      expect(probe.heights.at(-1)).toBeLessThan(2);
    } else {
      expect(await page.evaluate(() => window.foldProbe!.animations)).toEqual([]);
      expect(
        await page
          .locator(contentSelector)
          .last()
          .evaluate((element) => getComputedStyle(element).animationName),
      ).toBe("none");
    }
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    // Exercise a reader-initiated close after Radix has mounted its content.
    await trigger.click();
    const fold = page.getByRole("button", { name: /^Fold 3 tool calls:/ });
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(3);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    await fold.click();
    await expect(row.getByRole("button", { name: "Exec Command success" })).toHaveCount(0);
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
    await expect(scroller).toBeVisible();
  });
}

test("folding below a released reader preserves their history position", async ({ page }) => {
  await page.goto("/streaming-transcript?long=1&fold=1");
  await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(2);
  const scroller = page.locator(scrollerSelector);
  // Let the scroller-ref effect attach input listeners after the first bottom fill.
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
  const anchor = await scroller.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = Array.from(element.querySelectorAll<HTMLElement>("[data-chat-message-index]")).find(
      (row) => row.getBoundingClientRect().bottom > viewport.top,
    )!;
    return {
      selector: `[data-chat-message-index="${row.dataset.chatMessageIndex}"]`,
      top: row.getBoundingClientRect().top - viewport.top,
    };
  });
  // The tail remains inside overscan, so this exercises an actual mounted fold.
  const tail = page.locator("[data-chat-message-index]").last();
  await expect(tail.getByRole("button", { name: "Exec Command success" })).toHaveCount(2);
  await observeFold(page, anchor.selector);
  await page.getByRole("button", { name: "Grow tool group" }).click();
  await expect.poll(() => page.evaluate(() => window.foldProbe!.ended)).toBe(true);
  const probe = await page.evaluate(() => window.foldProbe!);
  expect(probe.retainedOnExit).toBe(true);
  expect(probe.anchorTops.length).toBeGreaterThan(1);
  expect(
    Math.max(...probe.anchorTops.map((top) => Math.abs(top - anchor.top))),
  ).toBeLessThanOrEqual(2);
  await expect(tail.getByRole("button", { name: "Exec Command success" })).toHaveCount(0);
  await expect
    .poll(() =>
      scroller.evaluate(
        (element, anchor) =>
          Math.abs(
            element.querySelector(anchor.selector)!.getBoundingClientRect().top -
              element.getBoundingClientRect().top -
              anchor.top,
          ),
        anchor,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(100);
});
