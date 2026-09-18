import { expect, test } from "@playwright/test";

test("CI status announces running, failed, and successful completion", async ({ page }) => {
  await page.goto("/pr-check-status");

  const status = page.getByRole("status", {
    name: "3 of 4 CI checks passed; 1 still running",
  });
  await expect(status).toBeVisible();
  await expect(status).toHaveText("(3/4)");
  await expect(status).toHaveClass(/text-yellow-600/);
  await expect(status).toHaveAttribute("data-state", "running");
  await expect(page.getByRole("button", { name: /View PR/ })).toHaveText(/View PR\s*\(3\/4\)/);

  await page.getByRole("button", { name: "Complete with failure" }).click();
  await expect(
    page.getByRole("status", {
      name: "3 of 4 CI checks passed; 1 failed; all checks complete",
    }),
  ).toHaveText("(3/4)");
  await expect(page.getByRole("status")).toHaveClass(/text-red-600/);
  await expect(page.getByRole("status")).toHaveAttribute("data-state", "failed");

  await page.getByRole("button", { name: "Complete successfully" }).click();
  await expect(
    page.getByRole("status", { name: "4 of 4 CI checks passed; all checks complete" }),
  ).toHaveText("(4/4)");
  await expect(page.getByRole("status")).toHaveClass(/text-green-600/);
  await expect(page.getByRole("status")).toHaveAttribute("data-state", "passed");
});

test("CI status only colors the parenthetical count", async ({ page }) => {
  await page.goto("/pr-check-status");

  const status = page.getByRole("status");
  const label = page.getByText("View PR", { exact: true });
  const statusColor = await status.evaluate((element) => getComputedStyle(element).color);
  const labelColor = await label.evaluate((element) => getComputedStyle(element).color);
  expect(statusColor).not.toBe(labelColor);
});
