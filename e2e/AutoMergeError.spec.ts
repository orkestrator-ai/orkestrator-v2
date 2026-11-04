import { expect, test, type Page } from "@playwright/test";

function failure(page: Page) {
  return page.getByRole("status").filter({ hasText: "Auto-merge:" });
}

test("the desktop toolbar shows a typical failure whole, inside the bar", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "this asserts the desktop toolbar");
  await page.goto("/auto-merge-error");
  const label = failure(page);
  await expect(label).toHaveText(
    "Auto-merge: The pull request or merge effects changed; confirm the merge again",
  );

  const { clipped, labelHeight, barHeight } = await label.evaluate((element) => ({
    clipped:
      element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth,
    labelHeight: element.getBoundingClientRect().height,
    barHeight: element.closest("[data-mobile-toolbar]")!.getBoundingClientRect().height,
  }));
  expect(clipped).toBe(false);
  expect(labelHeight).toBeLessThan(barHeight);
});

test("a failure too long for the bar reads in full in a scrollable tooltip", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "phones have no hover");
  await page.goto("/auto-merge-error?message=long");
  const label = failure(page);
  await expect(label).toBeVisible();

  await label.hover();
  const tooltip = page.locator("p").filter({ hasText: "Auto-merge:" });
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(((await label.textContent()) ?? "").trim());

  // Moving onto the tooltip keeps it open, and its end can be scrolled to.
  await tooltip.hover();
  await page.mouse.wheel(0, 5000);
  await expect
    .poll(() =>
      tooltip.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  await expect(tooltip).toBeVisible();
  expect(await tooltip.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("the tooltip opens from the keyboard", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "this asserts the desktop toolbar");
  await page.goto("/auto-merge-error?message=long");
  await failure(page).focus();
  await expect(page.locator("p").filter({ hasText: "Auto-merge:" })).toBeVisible();
});

test("the phone toolbar shows a long failure whole, with no tooltip to rely on", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "this asserts the phone toolbar");
  await page.goto("/auto-merge-error?message=long&presentation=grid");
  const label = failure(page);
  await expect(label).toBeVisible();
  const { clipped, labelWidth, viewportWidth } = await label.evaluate((element) => ({
    clipped:
      element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth,
    labelWidth: element.getBoundingClientRect().right,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(clipped).toBe(false);
  expect(labelWidth).toBeLessThanOrEqual(viewportWidth);
});
