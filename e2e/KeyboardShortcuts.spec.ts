import { expect, test } from "@playwright/test";

test("Cmd+Shift+K opens a searchable list of keyboard shortcuts", async ({ page }, testInfo) => {
  await page.goto("/keyboard-shortcuts");
  await page.keyboard.press("Meta+Shift+K");

  const dialog = page.getByTestId("keyboard-shortcuts-dialog");
  await expect(dialog).toBeVisible();
  const search = page.getByRole("textbox", { name: "Search keyboard shortcuts" });
  await expect(search).toBeFocused();
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible();
  await expect(page.getByTestId("keyboard-shortcut-search-projects")).toBeVisible();

  // The list scrolls inside the dialog rather than past the viewport.
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport && box.y + box.height <= viewport.height).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("keyboard-shortcuts.png") });

  await search.fill("zoom");
  await expect(page.getByTestId("keyboard-shortcut-zoom-in")).toBeVisible();
  await expect(page.getByTestId("keyboard-shortcut-search-projects")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("keyboard-shortcuts-search.png") });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
