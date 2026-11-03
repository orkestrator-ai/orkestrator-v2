import { expect, test, type Locator } from "@playwright/test";

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "chromium" && process.env.PR_PANE_CPU_THROTTLE) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
});

/** The reader's place: the first row showing at the top of the scroller and its offset. */
function readingPlace(scroller: Locator) {
  return scroller.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const row = Array.from(el.querySelectorAll<HTMLElement>("[data-chat-message-key]")).find(
      (candidate) => candidate.getBoundingClientRect().bottom > top + 1,
    );
    return row
      ? { key: row.dataset.chatMessageKey, offset: row.getBoundingClientRect().top - top }
      : null;
  });
}

/**
 * Waits until the transcript stops moving. Virtuoso replaces estimated row
 * heights with measured ones after the scroll that rendered them, which moves
 * the rows without changing `scrollTop`, so the rows' positions are compared too.
 */
async function waitForSettledLayout(scroller: Locator) {
  let previous = "";
  let stable = 0;
  await expect
    .poll(
      async () => {
        const current = JSON.stringify([
          await scroller.evaluate((el) => [el.scrollTop, el.scrollHeight, el.clientWidth]),
          await readingPlace(scroller),
        ]);
        stable = current === previous ? stable + 1 : 0;
        previous = current;
        return stable;
      },
      { intervals: [100] },
    )
    .toBeGreaterThanOrEqual(3);
}

async function expectSamePlace(scroller: Locator, before: { key?: string; offset: number }) {
  await waitForSettledLayout(scroller);
  const after = await readingPlace(scroller);
  expect(after?.key).toBe(before.key);
  expect(Math.abs(after!.offset - before.offset)).toBeLessThanOrEqual(2);
}

test("PR pane open and close preserves a scrolled conversation and its active tab", async ({
  page,
}, testInfo) => {
  await page.goto("/streaming-transcript?long&prPane");
  const scroller = page.locator("[data-virtuoso-scroller]");
  await expect(scroller).toBeVisible();
  await scroller.hover();
  await page.mouse.wheel(0, -650);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeGreaterThan(100);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // Choose the link only once the rows have their measured heights; a link
  // chosen while they settle can already be off screen before the pane opens.
  await waitForSettledLayout(scroller);
  const linkName = await scroller.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    return Array.from(el.querySelectorAll("a")).find((a) => {
      const rect = a.getBoundingClientRect();
      return rect.top > bounds.top + bounds.height / 2 && rect.bottom < bounds.bottom - 40;
    })?.textContent;
  });
  expect(linkName).toBeTruthy();
  const link = page.getByRole("link", { name: linkName!, exact: true });
  await expect(link).toBeVisible();
  await link.focus();
  await waitForSettledLayout(scroller);
  await expect(link).toBeInViewport();
  const place = await readingPlace(scroller);
  expect(place).not.toBeNull();

  const selection = await page.evaluate(() => window.prPaneSelection!());
  await page.screenshot({
    path: `output/visual-previews/pr-transcript-before-${testInfo.project.name}.png`,
  });
  await link.press("Enter");
  await expect(page.getByRole("button", { name: "Close PR pane" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "feat: add usage history tab" })).toBeVisible();
  expect(await page.evaluate(() => window.prPaneSelection!())).toEqual(selection);
  // The narrower column re-wraps every row; the reader's place is held.
  await expectSamePlace(scroller, place!);
  await expect(link).toBeInViewport();
  await expect(link).toBeFocused();
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeGreaterThan(100);
  await page.screenshot({
    path: `output/visual-previews/pr-transcript-after-${testInfo.project.name}.png`,
  });
  await page.getByRole("button", { name: "Close PR pane" }).click();
  await expectSamePlace(scroller, place!);
  await expect(link).toBeInViewport();
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeGreaterThan(100);
  expect(await page.evaluate(() => window.prPaneSelection!())).toEqual(selection);
  await page.screenshot({
    path: `output/visual-previews/pr-transcript-closed-${testInfo.project.name}.png`,
  });
  await link.focus();
  await expect(link).toBeFocused();
});

test("delayed failure retains a user-activated browser escape after a blocked popup", async ({
  page,
}) => {
  await page.goto("/streaming-transcript?long&prPane&delayedFailure");
  const scroller = page.locator("[data-virtuoso-scroller]");
  await expect(scroller).toBeVisible();
  const name = await scroller.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    return Array.from(el.querySelectorAll("a")).find((a) => {
      const rect = a.getBoundingClientRect();
      return rect.top > bounds.top + bounds.height / 2 && rect.bottom < bounds.bottom - 40;
    })?.textContent;
  });
  const link = page.getByRole("link", { name: name!, exact: true });
  // Block only automatic attempts, reproducing a browser's expired activation.
  await page.evaluate(() => {
    const nativeOpen = window.open.bind(window);
    window.open = ((...args: Parameters<typeof window.open>) =>
      navigator.userActivation.isActive ? nativeOpen(...args) : null) as typeof window.open;
  });
  await link.focus();
  await link.press("Enter");
  await expect(page.getByRole("button", { name: "Close PR pane" })).toBeVisible();
  const fallback = page.getByRole("button", { name: "Open on GitHub", exact: true });
  await expect(fallback).toBeVisible({ timeout: 15000 });
  const popup = page.waitForEvent("popup");
  await fallback.click();
  await (await popup).close();
});
