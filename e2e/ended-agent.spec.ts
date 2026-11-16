import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

test("a historical launch stays ended through unrelated work and remount", async ({
  page,
}, testInfo) => {
  await page.goto("/ended-agent");
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  const previews = path.resolve(import.meta.dirname, "../output/visual-previews");
  await mkdir(previews, { recursive: true });
  await page.screenshot({
    path: path.join(previews, `8303-own-turn-${testInfo.project.name}.png`),
  });
  await page.getByRole("button", { name: "Settle turn" }).click();
  await expect(page.getByText("Ended", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start unrelated turn" }).click();
  await expect(page.getByText("Ended", { exact: true })).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Switch environment" }).click();
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await expect(page.getByText("Ended", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Ended", { exact: true })).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: path.join(previews, `8303-later-turn-${testInfo.project.name}.png`),
  });
});
