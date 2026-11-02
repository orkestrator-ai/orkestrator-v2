import { expect, test } from "@playwright/test";

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
      return rect.top > bounds.top + 40 && rect.bottom < bounds.bottom - 40;
    })?.textContent;
  });
  expect(linkName).toBeTruthy();
  const link = page.getByRole("link", { name: linkName!, exact: true });
  await expect(link).toBeVisible();
  await link.focus();
  await page.waitForTimeout(300); // Let virtualized row measurements settle after focusing.
  const before = await scroller.evaluate((el) => el.scrollTop);
  const selection = await page.evaluate(() => window.prPaneSelection!());
  await page.screenshot({
    path: `output/visual-previews/pr-transcript-before-${testInfo.project.name}.png`,
  });
  await link.press("Enter");
  await expect(page.getByRole("button", { name: "Close PR pane" })).toBeVisible();
  expect(await page.evaluate(() => window.prPaneSelection!())).toEqual(selection);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(before);
  await page.screenshot({
    path: `output/visual-previews/pr-transcript-after-${testInfo.project.name}.png`,
  });
  await page.getByRole("button", { name: "Close PR pane" }).click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(before);
  expect(await page.evaluate(() => window.prPaneSelection!())).toEqual(selection);
  await link.focus();
  await expect(link).toBeFocused();
});
