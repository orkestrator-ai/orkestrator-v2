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

test("opens from the keyboard with New design and Import modes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/design-launch");

  const entry = page.getByRole("button", { name: "New design workspace" });
  await entry.focus();
  await expect(entry).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Design workspace" });
  await expect(dialog).toBeVisible();
  for (const mode of ["New design", "Import"])
    await expect(dialog.getByRole("tab", { name: mode })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Open" })).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Design readiness" })).toHaveCount(0);

  // The draft brief survives switching modes.
  await dialog.getByRole("textbox", { name: "Design brief" }).fill("A calmer checkout");
  await dialog.getByRole("tab", { name: "Import" }).click();
  await expect(dialog.getByLabel("Import .orkdes")).toBeVisible();
  await dialog.getByRole("tab", { name: "New design" }).click();
  await expect(dialog.getByRole("textbox", { name: "Design brief" })).toHaveValue(
    "A calmer checkout",
  );
});

test("pasted image removal stays visible without hover at desktop and touch viewports", async ({
  page,
}, testInfo) => {
  await page.goto("/design-launch");
  await page.getByRole("button", { name: "New design workspace" }).click();
  const prompt = page.getByRole("textbox", { name: "Design brief" });
  await prompt.focus();
  await prompt.evaluate((element) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHhoAAAAASUVORK5CYII=";
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  const remove = page.getByRole("button", { name: /^Remove clipboard-.*\.png$/ });
  await expect(remove).toBeVisible();
  await expect(remove).toHaveCSS("opacity", "1");
  if (testInfo.project.name === "mobile-chromium") {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await remove.tap();
  } else {
    await remove.focus();
    await expect(remove).toBeFocused();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0);
});
