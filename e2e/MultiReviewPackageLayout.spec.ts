import { expect, test } from "@playwright/test";

for (const containerWidth of [390, 1407, 1408, 1600]) {
  test(`package validation and transcript fit a ${containerWidth}px container`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: containerWidth, height: 1400 });
    await page.goto("/multi-review-flow?phase=preparing&longTranscript&packageControls");
    await page.getByRole("button", { name: "Publish validation" }).click();
    const split = page.getByTestId("multi-review-step-split");
    const tail = page.getByRole("log", { name: "Latest review package generation activity" });
    await expect(tail).toContainText("Package transcript entry 40.");

    // Account for the overview's scrollbar gutter so these are exact container
    // widths on platforms with either classic or overlay scrollbars.
    const measuredWidth = await split.evaluate((element) => {
      let container = element.parentElement;
      while (container && getComputedStyle(container).containerType === "normal") {
        container = container.parentElement;
      }
      if (!container) throw new Error("Missing query container");
      return container.clientWidth;
    });
    await page.setViewportSize({
      width: containerWidth + containerWidth - measuredWidth,
      height: 1400,
    });

    const geometry = await split.evaluate((element) => {
      const details = element.firstElementChild!;
      const transcript = element.lastElementChild!;
      const log = transcript.querySelector("[role='log']")!;
      const table = details.querySelector("table")!;
      const tableScroll = table.parentElement!;
      let container = element.parentElement!;
      while (getComputedStyle(container).containerType === "normal")
        container = container.parentElement!;
      const box = (node: Element) => {
        const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
        return { x, y, width, height, right, bottom };
      };
      return {
        containerWidth: container.clientWidth,
        split: box(element),
        details: box(details),
        transcript: box(transcript),
        log: box(log),
        columnOverflow: [details, transcript].map((node) => node.scrollWidth - node.clientWidth),
        tableScroll: box(tableScroll),
        tableOverflow: tableScroll.scrollWidth - tableScroll.clientWidth,
        tableOverflowStyle: getComputedStyle(tableScroll).overflowX,
        logOverflow: log.scrollHeight - log.clientHeight,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(geometry.containerWidth).toBe(containerWidth);
    if (containerWidth >= 1408) {
      expect(Math.abs(geometry.details.y - geometry.transcript.y)).toBeLessThanOrEqual(1);
      expect(geometry.transcript.x - geometry.details.right).toBeGreaterThanOrEqual(15);
      expect(Math.abs(geometry.details.width - geometry.transcript.width)).toBeLessThanOrEqual(1);
    } else {
      expect(geometry.transcript.y - geometry.details.bottom).toBeGreaterThanOrEqual(15);
      expect(Math.abs(geometry.details.x - geometry.transcript.x)).toBeLessThanOrEqual(1);
      expect(geometry.transcript.width).toBeCloseTo(geometry.split.width, 0);
    }
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
    expect(Math.max(...geometry.columnOverflow)).toBeLessThanOrEqual(1);
    expect(geometry.tableScroll.right).toBeLessThanOrEqual(geometry.details.right + 1);
    expect(geometry.tableOverflowStyle).toBe("auto");
    if (containerWidth === 390) expect(geometry.tableOverflow).toBeGreaterThan(0);
    expect(geometry.log.height).toBeGreaterThanOrEqual(448);
    expect(geometry.log.height).toBeLessThan(1400);
    expect(geometry.logOverflow).toBeGreaterThan(300);
    expect(geometry.log.right).toBeLessThanOrEqual(geometry.transcript.right + 1);
    if (containerWidth >= 1408) {
      const footer = page.getByRole("button", { name: "Cancel" }).locator("xpath=..");
      const footerBox = (await footer.boundingBox())!;
      expect(footerBox.y - geometry.log.bottom).toBeGreaterThanOrEqual(0);
      expect(footerBox.y - geometry.log.bottom).toBeLessThanOrEqual(24);
    }
  });
}

for (const width of [390, 1600]) {
  test(`validation preserves a package reader's position at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1200 });
    await page.goto("/multi-review-flow?phase=preparing&longTranscript&packageControls");
    const tail = page.getByRole("log", { name: "Latest review package generation activity" });
    await expect(page.getByLabel("Review validation", { exact: true })).toHaveCount(0);
    await expect(tail).toContainText("Package transcript entry 40.");
    const scrollTop = () => tail.evaluate((element) => element.scrollTop);
    const bottomGap = () =>
      tail.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    await expect.poll(bottomGap).toBeLessThanOrEqual(1);
    const mountedTail = await tail.elementHandle();
    await tail.scrollIntoViewIfNeeded();
    await tail.hover();
    const beforeWheel = await scrollTop();
    await page.mouse.wheel(0, -300);
    await expect.poll(scrollTop).toBeLessThan(beforeWheel - 100);
    // Read at a fixed early offset so reflow to the narrower split column
    // cannot clamp the reading position against the bottom.
    await tail.evaluate((element) => {
      element.scrollTop = 200;
      element.dispatchEvent(new Event("scroll"));
    });
    const readingTop = await scrollTop();
    await page.getByRole("button", { name: "Publish validation" }).click();
    await expect(page.getByRole("table", { name: "Validation commands" })).toBeVisible();
    expect(await tail.evaluate((element, original) => element === original, mountedTail)).toBe(
      true,
    );
    await expect.poll(scrollTop).toBe(readingTop);
    expect(await bottomGap()).toBeGreaterThan(100);

    // A fresh snapshot must retain the user's choice to stop following.
    await page.getByRole("button", { name: "Append package transcript" }).click();
    await expect(tail).toContainText("Package transcript entry 41.");
    await expect.poll(scrollTop).toBe(readingTop);
    expect(await bottomGap()).toBeGreaterThan(100);
  });
}
