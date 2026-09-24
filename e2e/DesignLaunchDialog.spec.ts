import { expect, test } from "@playwright/test";

test("keeps sm gutters and caps the launch dialog at 42rem", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto("/design-launch");

  await page.getByRole("button", { name: "New design workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Design workspace" });
  await expect(dialog).toBeVisible();

  const narrowBox = await dialog.boundingBox();
  expect(narrowBox).not.toBeNull();
  expect(narrowBox!.x).toBe(16);
  expect(narrowBox!.width).toBe(608);

  await page.setViewportSize({ width: 1024, height: 900 });
  const wideBox = await dialog.boundingBox();
  expect(wideBox).not.toBeNull();
  expect(wideBox!.width).toBe(672);
  expect(wideBox!.x).toBe(176);
});
