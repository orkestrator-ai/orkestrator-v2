import { expect, test, type Locator } from "@playwright/test";

test("live transcript follow releases on scroll-up and re-engages at bottom", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "desktop coverage is sufficient for Virtuoso wheel and follow timing",
  );
  await page.goto("/virtuoso-follow");

  const scroller = page.locator('[data-virtuoso-scroller="true"]');
  const atBottom = page.getByTestId("virtuoso-at-bottom");
  const count = page.getByTestId("virtuoso-follow-count");
  const followDecision = page.getByTestId("virtuoso-follow-decision");

  await expect(scroller).toBeVisible();
  await expect(atBottom).toHaveText("true");
  await expect.poll(() => distanceFromBottom(scroller)).toBeLessThanOrEqual(50);

  await scroller.hover();
  await page.mouse.wheel(0, -600);
  await expect(atBottom).toHaveText("false");
  await expect.poll(() => distanceFromBottom(scroller)).toBeGreaterThan(50);
  const releasedScrollTop = await scroller.evaluate((element) => element.scrollTop);

  await page.getByRole("button", { name: "Append message" }).click();
  await expect(count).toHaveText("81");
  await expect(followDecision).toHaveText("false");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(releasedScrollTop);
  await expect.poll(() => distanceFromBottom(scroller)).toBeGreaterThan(50);
  await expect(atBottom).toHaveText("false");

  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(atBottom).toHaveText("true");
  await expect.poll(() => distanceFromBottom(scroller)).toBeLessThanOrEqual(50);
  const stickyScrollTop = await scroller.evaluate((element) => element.scrollTop);

  await page.getByRole("button", { name: "Append message" }).click();
  await expect(count).toHaveText("82");
  await expect(followDecision).toHaveText("auto");
  await expect.poll(() => distanceFromBottom(scroller)).toBeLessThanOrEqual(50);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(stickyScrollTop);
  await expect(page.getByText("Message 82")).toBeVisible();
});

async function distanceFromBottom(scroller: Locator) {
  return scroller.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}
