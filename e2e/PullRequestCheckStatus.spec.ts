import { expect, test } from "@playwright/test";

test("CI status announces running, failed, and successful completion", async ({ page }) => {
  await page.goto("/pr-check-status");

  const status = page.getByRole("status", {
    name: "3 of 4 CI checks passed; 1 still running",
  });
  await expect(status).toBeVisible();
  await expect(status).toHaveText("3/4 checks; 1 still running");
  await expect(status).toHaveClass(/border-orange-500/);
  await expect(status).toHaveClass(/bg-transparent/);

  await page.getByRole("button", { name: "Complete with failure" }).click();
  await expect(
    page.getByRole("status", { name: "3 of 4 CI checks passed; all checks complete" }),
  ).toHaveText("3/4 checks; all checks complete");
  await expect(page.getByRole("status")).toHaveClass(/border-red-600/);

  await page.getByRole("button", { name: "Complete successfully" }).click();
  await expect(
    page.getByRole("status", { name: "4 of 4 CI checks passed; all checks complete" }),
  ).toHaveText("4/4 checks; all checks complete");
  await expect(page.getByRole("status")).toHaveClass(/border-green-600/);
  await expect(page.getByRole("status")).toHaveClass(/text-green-600/);
  await expect(page.getByRole("status")).not.toHaveClass(/text-red-600/);
});

test("CI status uses compact styling in grid presentation", async ({ page }) => {
  await page.goto("/pr-check-status?grid");

  const status = page.getByRole("status");
  await expect(status).toHaveClass(/px-2\.5/);
  await expect(status).toHaveClass(/text-xs/);
});
