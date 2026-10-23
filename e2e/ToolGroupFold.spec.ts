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
