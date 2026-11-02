import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "chromium" && process.env.PR_PANE_CPU_THROTTLE) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
});

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
  let previous = -1;
  let stable = 0;
  await expect
    .poll(async () => {
      const current = await scroller.evaluate((el) => el.scrollTop);
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      return stable;
    })
    .toBeGreaterThanOrEqual(3);

  const selection = await page.evaluate(() => window.prPaneSelection!());
  await page.screenshot({
    path: `output/visual-previews/pr-transcript-before-${testInfo.project.name}.png`,
  });
  await link.press("Enter");
  await expect(page.getByRole("button", { name: "Close PR pane" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "feat: add usage history tab" })).toBeVisible();
  expect(await page.evaluate(() => window.prPaneSelection!())).toEqual(selection);
  await page.screenshot({ path: `output/visual-previews/pr-reflow-${testInfo.project.name}.png` });
  await expect(link).toBeInViewport();
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeGreaterThan(100);
  await page.screenshot({
    path: `output/visual-previews/pr-transcript-after-${testInfo.project.name}.png`,
  });
  await page.getByRole("button", { name: "Close PR pane" }).click();
  await expect(link).toBeInViewport();
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeGreaterThan(100);
  expect(await page.evaluate(() => window.prPaneSelection!())).toEqual(selection);
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
