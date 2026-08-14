import { expect, test } from "@playwright/test";

test("compose controls stay reachable in a narrow viewport", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.goto("/native-compose");

  const primary = page.locator('[data-native-compose-controls="primary"]');
  const secondary = page.locator('[data-native-compose-controls="secondary"]');
  // Model, reasoning and speed are one control now, so the picker trigger is
  // what has to survive the narrow layout — there is no separate reasoning or
  // Fast button left to crowd it.
  const picker = primary.getByTitle("Choose model, reasoning, and speed");

  await expect(primary).toBeVisible();
  await expect(secondary).toBeVisible();
  await expect(picker).toBeVisible();

  const geometry = await picker.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const primaryRect = element
      .closest('[data-native-compose-controls="primary"]')!
      .getBoundingClientRect();
    return {
      fullyInsidePrimary:
        rect.left >= primaryRect.left
        && rect.right <= primaryRect.right
        && rect.top >= primaryRect.top
        && rect.bottom <= primaryRect.bottom,
      fullyInsideViewport:
        rect.left >= 0
        && rect.right <= window.innerWidth
        && rect.top >= 0
        && rect.bottom <= window.innerHeight,
    };
  });
  expect(geometry).toEqual({
    fullyInsidePrimary: true,
    fullyInsideViewport: true,
  });
  await expect(picker).toHaveAccessibleName(/\(High\)$/);

  await picker.click();
  await page.locator("[data-native-mobile-speed-trigger]").click();
  await page.getByRole("menuitemradio", { name: /^Fast/ }).click();
  await expect(picker).toHaveAccessibleName(/High ⚡/);

  await page.getByRole("button", { name: "+123 queued" }).click();
  await expect(page.getByRole("dialog", { name: "Queued Prompts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Queued Prompts" })).toBeHidden();

  await page.getByRole("button", { name: "Address all" }).click();
  await expect(page.getByTestId("native-send-count")).toHaveText("1");
});
