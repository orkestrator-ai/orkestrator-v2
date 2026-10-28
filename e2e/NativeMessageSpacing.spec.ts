import { expect, test } from "@playwright/test";

test("user paragraphs have an internal gap and no outer block margins", async ({ page }) => {
  await page.goto("/native-message-spacing");
  const paragraphs = page.getByTestId("two-paragraphs").locator(".prose p");
  await expect(paragraphs).toHaveText(["First paragraph.", "Second paragraph."]);
  await expect(paragraphs.first()).toHaveCSS("margin-top", "0px");
  await expect(paragraphs.last()).toHaveCSS("margin-bottom", "0px");

  const first = (await paragraphs.first().boundingBox())!;
  const second = (await paragraphs.last().boundingBox())!;
  expect(second.y - (first.y + first.height)).toBeGreaterThanOrEqual(8);
});

test("a single user paragraph keeps the bubble compact", async ({ page }) => {
  await page.goto("/native-message-spacing");
  const bubble = page.getByTestId("single-paragraph").locator(".rounded-xl");
  const paragraph = bubble.locator(".prose p");
  await expect(paragraph).toHaveText("Single paragraph.");
  await expect(paragraph).toHaveCSS("margin-top", "0px");
  await expect(paragraph).toHaveCSS("margin-bottom", "0px");

  const dimensions = await bubble.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      chrome:
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom) +
        parseFloat(style.borderTopWidth) +
        parseFloat(style.borderBottomWidth),
    };
  });
  const textHeight = (await paragraph.boundingBox())!.height;
  expect(dimensions.height).toBeCloseTo(textHeight + dimensions.chrome, 1);
});
