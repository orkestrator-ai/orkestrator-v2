import { expect, test } from "@playwright/test";

test("compose gallery restores keyboard focus after Escape and the close button", async ({
  page,
}) => {
  await page.goto("/native-compose?images");
  const opener = page.getByRole("button", { name: "Preview second.svg" });
  for (const close of ["Escape", "close button"]) {
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Image preview: second.svg" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("img", { name: "second.svg" })).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("dialog", { name: "Image preview: first.svg" })).toBeVisible();
    if (close === "Escape") await page.keyboard.press("Escape");
    else await page.getByRole("button", { name: "Close image preview" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
    // Tab past the second thumbnail's remove button and back into the prompt.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const input = page.getByRole("textbox", { name: "Send a message" });
    await expect(input).toBeFocused();
    await page.keyboard.type("Continue");
    await expect(input).toContainText("Continue");
    await input.fill("");
  }
});

test("queue edit keeps the caret in the composer and the opener names its purpose", async ({
  page,
}) => {
  await page.goto("/native-compose");
  const input = page.getByRole("textbox", { name: "Send a message" });
  await input.focus();
  const strip = page.getByTestId("compose-queue-strip");
  await expect(
    strip.getByRole("button", { name: "View queued prompts (123)", exact: true }),
  ).toBeVisible();
  await strip.getByRole("button", { name: "Edit queued prompt 1 of 123", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toContainText("Also run the focused regression");
  await expect(strip).toContainText("122 queued");
  await expect(strip.getByTestId("compose-queue-item").first()).toContainText("Queued prompt 2");
});

test("arrow keys steer any queued prompt without leaving the keyboard", async ({ page }) => {
  await page.goto("/native-compose");
  const input = page.getByRole("textbox", { name: "Send a message" });
  const strip = page.getByTestId("compose-queue-strip");
  const steer = (position: number, total: number) =>
    strip.getByRole("button", {
      name: new RegExp(`^Steer queued prompt ${position} of ${total}:`),
    });
  await input.focus();
  await page.keyboard.type("Draft line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");

  // From the second line ArrowUp moves the caret, not the focus.
  await page.keyboard.press("ArrowUp");
  await expect(input).toBeFocused();
  // Mark where the caret is so its return can be checked exactly.
  await page.keyboard.type("#");
  await page.keyboard.press("ArrowUp");
  await expect(steer(1, 123)).toBeFocused();
  // The next prompt to run is the strip nearest the input, and in view.
  const [inputBox, nextBox] = await Promise.all([input.boundingBox(), steer(1, 123).boundingBox()]);
  expect(nextBox!.y).toBeLessThan(inputBox!.y);
  await expect(steer(1, 123)).toBeInViewport();

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(steer(3, 123)).toBeFocused();
  await expect(steer(3, 123)).toBeInViewport();
  await page.keyboard.press("ArrowDown");
  await expect(steer(2, 123)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("native-steered")).toHaveText("queued-2");
  // The prompt queued after it takes its place and the focus.
  await expect(steer(2, 122)).toBeFocused();
  await expect(steer(2, 122)).toHaveAccessibleName("Steer queued prompt 2 of 122: Queued prompt 3");

  await page.keyboard.press("Escape");
  await expect(input).toBeFocused();
  // The draft is untouched and the caret came back where it was.
  const draft = (await input.innerText()).replace(/\s+/g, " ");
  expect(draft).toMatch(/^Draft l.*#.* line two$/);
  await page.keyboard.type("!");
  await expect(input).toContainText("#!");

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await expect(input).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press(" ");
  await expect(page.getByTestId("native-steered")).toHaveText("queued-2,queued-1");
  await expect(steer(1, 121)).toBeFocused();
});

test("compose controls stay reachable in a narrow viewport", async ({ page }, testInfo) => {
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
        rect.left >= primaryRect.left &&
        rect.right <= primaryRect.right &&
        rect.top >= primaryRect.top &&
        rect.bottom <= primaryRect.bottom,
      fullyInsideViewport:
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight,
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
  await expect(page.getByRole("menuitemradio", { name: /^Fast/ })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveAccessibleName(/High ⚡/);

  const strip = page.getByTestId("compose-queue-strip");
  const next = strip.getByTestId("compose-queue-item").first();
  await expect(strip).toContainText("123 queued");
  await strip.getByRole("button", { name: /^Steer queued prompt 1 of 123:/ }).click();
  await expect(next).toContainText("Queued prompt 2");
  await expect(strip).toContainText("122 queued");
  await strip.getByRole("button", { name: "Remove queued prompt 1 of 122" }).click();
  await expect(next).toContainText("Queued prompt 3");
  await expect(strip).toContainText("121 queued");
  await strip.getByRole("button", { name: "Edit queued prompt 1 of 121" }).click();
  await expect(page.getByRole("textbox", { name: "Send a message" })).toContainText(
    "Queued prompt 3",
  );
  await expect(next).toContainText("Queued prompt 4");
  await page.getByRole("textbox", { name: "Send a message" }).fill("");
  await strip.getByTitle("View queued prompts").click();
  await expect(page.getByRole("dialog", { name: "Queued Prompts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Queued Prompts" })).toBeHidden();

  await page.getByRole("button", { name: "Address all" }).click();
  await expect(page.getByTestId("native-send-count")).toHaveText("1");
});
