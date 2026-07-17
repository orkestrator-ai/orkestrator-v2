import { expect, test } from "@playwright/test";

test("Codex Fast and secondary actions stay reachable in a narrow viewport", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout only");
  await page.goto("/codex-compose");

  const primary = page.locator('[data-native-compose-controls="primary"]');
  const secondary = page.locator('[data-native-compose-controls="secondary"]');
  const reasoning = page.getByTitle("Choose reasoning effort");
  const fast = page.getByRole("button", { name: "Fast" });

  await expect(primary).toBeVisible();
  await expect(secondary).toBeVisible();
  await expect(fast).toBeVisible();
  await expect(fast).toHaveAttribute("aria-pressed", "false");

  const geometry = await fast.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const primaryRect = element.parentElement!.getBoundingClientRect();
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
  await expect
    .poll(() => reasoning.evaluate((element) => element.nextElementSibling?.textContent?.trim()))
    .toBe("Fast");

  await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "+123 queued" }).click();
  await expect(page.getByRole("dialog", { name: "Queued Prompts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Queued Prompts" })).toBeHidden();

  await page.getByRole("button", { name: "Address all" }).click();
  await expect(page.getByTestId("codex-send-count")).toHaveText("1");
});
