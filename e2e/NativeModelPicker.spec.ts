import { expect, test } from "@playwright/test";

test("short mobile viewports keep every picker view reachable", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.setViewportSize({ width: 390, height: 360 });
  await page.goto("/native-model-picker");
  await page.getByTitle("Choose model, reasoning, and speed").click();

  const picker = page.locator("[data-native-model-picker]");
  const mobileLayout = await picker.evaluate((element) => {
    const content = element as HTMLElement;
    const rect = content.getBoundingClientRect();
    return {
      height: rect.height,
      clientHeight: content.clientHeight,
      scrollHeight: content.scrollHeight,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    };
  });
  expect(mobileLayout.scrollHeight).toBeGreaterThan(mobileLayout.clientHeight);
  expect(mobileLayout.top).toBeGreaterThanOrEqual(0);
  expect(mobileLayout.bottom).toBeLessThanOrEqual(360);
  expect(mobileLayout.left).toBeGreaterThanOrEqual(0);
  expect(mobileLayout.right).toBeLessThanOrEqual(390);

  const reasoningTrigger = page.locator("[data-native-mobile-reasoning-trigger]");
  await reasoningTrigger.scrollIntoViewIfNeeded();
  await expect(reasoningTrigger).toBeInViewport();
  await reasoningTrigger.click();

  const lastReasoning = page.getByRole("menuitemradio", { name: /Fixture effort 12/ });
  await lastReasoning.scrollIntoViewIfNeeded();
  await expect(lastReasoning).toBeInViewport();
  await lastReasoning.click();
  await expect(page.getByTitle("Choose model, reasoning, and speed"))
    .toHaveAccessibleName(/Fixture effort 12/);
});

test("desktop picker scrolls model and reasoning columns independently", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop layout only");
  await page.setViewportSize({ width: 1024, height: 480 });
  await page.goto("/native-model-picker");
  await page.getByTitle("Choose model, reasoning, and speed").click();

  const picker = page.locator("[data-native-model-picker]");
  const modelList = page.locator("[data-native-model-list]");
  const reasoningList = page.locator("[data-native-reasoning-list]");
  const speedList = page.locator("[data-native-speed-list]");
  const layout = await picker.evaluate((element) => {
    const content = element as HTMLElement;
    const rect = content.getBoundingClientRect();
    return {
      height: rect.height,
      clientHeight: content.clientHeight,
      scrollHeight: content.scrollHeight,
      top: rect.top,
      bottom: rect.bottom,
    };
  });
  expect(layout.height).toBe(376);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight);
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(480);

  expect(await modelList.evaluate((element) => element.scrollHeight))
    .toBeGreaterThan(await modelList.evaluate((element) => element.clientHeight));
  expect(await reasoningList.evaluate((element) => element.scrollHeight))
    .toBeGreaterThan(await reasoningList.evaluate((element) => element.clientHeight));
  expect(await speedList.evaluate((element) => element.scrollHeight))
    .toBeLessThanOrEqual(await speedList.evaluate((element) => element.clientHeight));

  const lastReasoning = page.getByRole("menuitemradio", { name: /Fixture effort 12/ });
  await reasoningList.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const lastItemLayout = await lastReasoning.evaluate((element) => {
    const itemRect = element.getBoundingClientRect();
    const listRect = element.closest("[data-native-reasoning-list]")!.getBoundingClientRect();
    return {
      itemTop: itemRect.top,
      itemBottom: itemRect.bottom,
      listTop: listRect.top,
      listBottom: listRect.bottom,
    };
  });
  expect(lastItemLayout.itemTop).toBeGreaterThanOrEqual(lastItemLayout.listTop);
  expect(lastItemLayout.itemBottom).toBeLessThanOrEqual(lastItemLayout.listBottom);
  await lastReasoning.click();
  await expect(page.getByTitle("Choose model, reasoning, and speed"))
    .toHaveAccessibleName(/Fixture effort 12/);
});
