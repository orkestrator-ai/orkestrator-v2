import path from "node:path";
import { expect, test } from "@playwright/test";

test.skip(({ hasTouch }) => hasTouch, "Compact is a desktop sidebar view");

for (const zoom of [80, 100, 125]) {
  test(`the pointer crosses the gap beside a scrolled icon at ${zoom}% zoom`, async ({ page }) => {
    if (zoom === 125) await page.setViewportSize({ width: 820, height: 400 });
    await page.goto("/sidebar-drag?compact-popover&scroll");
    const rail = page.getByTestId("compact-repository-list");
    await expect(rail.getByRole("button")).toHaveCount(11);
    await page.evaluate((value) => {
      document.documentElement.style.zoom = `${value}%`;
    }, zoom);
    // At a taller desktop viewport, constrain the rail so it still has to scroll.
    await rail.evaluate((element) => (element.style.maxHeight = "350px"));
    const icon = rail.getByRole("button", { name: /^extra-9(?:,|$)/ });
    await icon.scrollIntoViewIfNeeded();
    expect(await rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await icon.hover();

    const panel = page.getByTestId("compact-repository-popover");
    await expect(panel.getByRole("button", { name: /^extra-9-env-1/ })).toBeVisible();
    await panel.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const anchor = (await icon.boundingBox())!;
    const box = (await panel.boundingBox())!;
    const y = anchor.y + anchor.height / 2;
    expect(box.y).toBeLessThanOrEqual(y);
    expect(box.y + box.height).toBeGreaterThan(y);
    expect(box.x - anchor.x - anchor.width).toBeCloseTo(8 * (zoom / 100), 0);
    expect(box.y + box.height).toBeLessThan(page.viewportSize()!.height);

    // Park the pointer in the strip past the close delay before finishing the move.
    await page.clock.install();
    await page.mouse.move((anchor.x + anchor.width + box.x) / 2, y, { steps: 8 });
    await page.clock.runFor(250);
    await expect(icon).toHaveAttribute("aria-expanded", "true");
    await page.mouse.move(box.x + 15, y, { steps: 4 });
    await page.clock.runFor(250);
    await expect(panel).toHaveAttribute("data-state", "open");
    await page.screenshot({
      path: path.resolve("output/visual-previews", `compact-popover-fixed-${zoom}.png`),
      animations: "disabled",
    });
  });
}

test("row overlays hold focus and handle their own keys", async ({ page }) => {
  await page.goto("/sidebar-drag?compact-popover");
  const icon = page
    .getByTestId("compact-repository-list")
    .getByRole("button", { name: /^p(?:,|$)/, includeHidden: true });
  await icon.press("ArrowRight");
  const panel = page.getByTestId("compact-repository-popover");
  const row = panel.getByRole("button", { name: /^p-env-1/ });
  await expect(row).toBeFocused();
  await row.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(icon).toHaveAttribute("aria-expanded", "true");

  await row.press("Control+Backspace");
  const dialog = page.getByRole("alertdialog", { name: "Delete environment" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await page.mouse.move(700, 250);
  await page.clock.install();
  await page.clock.runFor(250);
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: /^Delete/ })).toBeFocused();
  await expect(icon).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({
    path: path.resolve("output/visual-previews", "compact-popover-delete-dialog.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(icon).toHaveAttribute("aria-expanded", "true");
});

test("closing restores focus and makes the exiting rows inert", async ({ page }) => {
  await page.clock.install();
  await page.goto("/sidebar-drag?compact-popover");
  const icon = page
    .getByTestId("compact-repository-list")
    .getByRole("button", { name: /^p(?:,|$)/ });
  await icon.press("ArrowRight");
  const panel = page.getByTestId("compact-repository-popover");
  const row = panel.locator('[data-environment-selection-id="p-env-1"]');
  await expect(row).toBeFocused();
  await page.addStyleTag({
    content: '.hover-popover[data-state="closed"] { animation-play-state: paused }',
  });
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1000);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-state", "closed");
  await expect(icon).toBeFocused();
  await expect(panel.getByRole("button")).toHaveCount(0);
  expect(
    await row.evaluate((element: HTMLElement) => {
      element.focus();
      return element === document.activeElement;
    }),
  ).toBe(false);
});

test("opening an attention line dismisses the panel and opens the named request", async ({
  page,
}) => {
  await page.goto("/sidebar-drag?compact-popover&attention-target");
  const icon = page
    .getByTestId("compact-repository-list")
    .getByRole("button", { name: /^p(?:,|$)/ });
  await icon.hover();
  const panel = page.getByTestId("compact-repository-popover");
  await panel.getByRole("button", { name: /^Question: Choose a deployment window/ }).click();
  await expect(icon).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Finish layout hydration" }).click();
  await expect(page.locator('[data-interaction-id="question-target"]')).toBeFocused();
});
