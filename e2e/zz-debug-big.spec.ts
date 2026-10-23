import { test } from "@playwright/test";
test("debug big group", async ({ page }) => {
  await page.goto("/streaming-transcript?long=1&bigGroup=1500");
  await page.getByRole("button", { name: /^Show 1500 tool calls:/ }).click();
  await page.waitForTimeout(800);
  console.log(
    "INNERTOP",
    await page
      .locator("[data-transcript-inner-viewport] [data-virtuoso-scroller]")
      .evaluate((e) => e.scrollTop),
  );
});
