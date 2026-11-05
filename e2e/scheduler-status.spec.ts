import { test, expect } from "@playwright/test";
import path from "node:path";
import { mkdir } from "node:fs/promises";

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

test("zero-offset schedule labels are stable across ICU versions and reload", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    Intl.DateTimeFormat.prototype.formatToParts = function (date?: Date | number) {
      return original
        .call(this, date)
        .map((part) => (part.type === "timeZoneName" ? { ...part, value: "GMT+0" } : part));
    };
  });
  await page.goto("/scheduler-status");
  const row = page.getByTestId("schedule-row");
  await expect(row.getByTestId("schedule-next")).toHaveText("2099-01-01 00:00 GMT");
  await page.getByRole("button", { name: "Switch away" }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Return to schedules" }).click();
  await expect(row.getByTestId("schedule-next")).toHaveText("2099-01-01 00:00 GMT");
  await page.reload();
  await expect(row.getByTestId("schedule-next")).toHaveText("2099-01-01 00:00 GMT");
  const previews = path.resolve("output/visual-previews");
  await mkdir(previews, { recursive: true });
  await row.screenshot({
    path: path.join(previews, `schedule-zone-after-${testInfo.project.name}.png`),
  });
});
