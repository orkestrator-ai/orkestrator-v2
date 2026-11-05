import { test, expect } from "@playwright/test";
import path from "node:path";

test("scheduler warning survives resource updates, inactive view and reload", async ({
  page,
}, testInfo) => {
  await page.goto("/scheduler-status");
  await expect(page.getByTestId("schedule-row")).toBeVisible();
  await expect(page.getByTestId("scheduler-paused")).toHaveCount(0);
  const previews = path.resolve("output/visual-previews");
  await page.screenshot({
    path: path.join(previews, `scheduler-before-${testInfo.project.name}.png`),
  });
  await page.getByRole("button", { name: "Lose writer lease" }).click();
  await expect(page.getByTestId("scheduler-paused")).toContainText("lost");
  await page.screenshot({
    path: path.join(previews, `scheduler-after-${testInfo.project.name}.png`),
  });
  await page.getByRole("button", { name: "Switch away" }).click();
  await page.getByRole("button", { name: "Lose writer lease" }).click();
  await page.getByRole("button", { name: "Return to schedules" }).click();
  await expect(page.getByTestId("scheduler-paused")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("scheduler-paused")).toBeVisible();
});
