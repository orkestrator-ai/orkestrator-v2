import { expect, test } from "@playwright/test";
import path from "node:path";

test("floating actions fit their icon, reopen with keyboard, and navigate", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/coordinator-actions");
  const icon = page.getByRole("button", { name: "Actions, 1 waiting" });
  await expect(icon).toHaveAttribute("aria-expanded", "false");
  const width = await icon.evaluate((element) => ({
    icon: element.getBoundingClientRect().width,
    wrapper: element.parentElement!.getBoundingClientRect().width,
  }));
  expect(Math.abs(width.icon - width.wrapper)).toBeLessThan(1);
  await page.screenshot({
    path: path.resolve("output/visual-previews/actions-repaired-narrow.png"),
  });
  await icon.focus();
  await expect(icon).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(icon).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Transcript control" }).focus();
  await icon.focus();
  await expect(icon).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Which option?" }).click();
  await expect(page.getByTestId("anchor")).toHaveText("assistant");
  await page.screenshot({ path: path.resolve("output/visual-previews/actions-repaired-open.png") });
});

test("wide actions dock below mail with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/coordinator-actions");
  await expect(page.getByRole("button", { name: "Which option?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Actions, 1 waiting" })).toHaveCount(0);
  const actions = await page.getByRole("region", { name: "Actions", exact: true }).boundingBox();
  const mail = await page.getByText("One message waiting").boundingBox();
  expect(actions!.y).toBeGreaterThan(mail!.y + mail!.height);
  await page.screenshot({ path: path.resolve("output/visual-previews/actions-repaired-wide.png") });
});
