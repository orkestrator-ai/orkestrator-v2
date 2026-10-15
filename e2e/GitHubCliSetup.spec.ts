import { expect, test } from "@playwright/test";

test("GitHub setup retries status and polling failures and rehydrates after reload", async ({
  page,
}) => {
  await page.goto("/github-cli-setup");
  await expect(page.getByRole("alert")).toHaveText("Status temporarily unavailable");
  await page.getByRole("button", { name: "Restore status service" }).click();
  const retry = page.getByRole("button", { name: "Check again" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in to GitHub", exact: true }).click();
  await expect(page.getByText("A1B2-C3D4")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Poll temporarily unavailable");
  await page.getByRole("button", { name: "Complete sign-in" }).click();
  await expect(page.getByText("The GitHub CLI is installed and signed in.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("The GitHub CLI is installed and signed in.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("GitHub setup recovers completion while unmounted", async ({ page }) => {
  await page.goto("/github-cli-setup");
  await expect(page.getByRole("alert")).toHaveText("Status temporarily unavailable");
  await page.getByRole("button", { name: "Restore status service" }).click();
  await page.getByRole("button", { name: "Check again" }).click();
  await page.getByRole("button", { name: "Sign in to GitHub", exact: true }).click();
  await expect(page.getByText("A1B2-C3D4")).toBeVisible();
  await page.getByRole("button", { name: "Hide setup" }).click();
  await page.getByRole("button", { name: "Complete sign-in" }).click();
  await page.getByRole("button", { name: "Show setup" }).click();
  await expect(page.getByText("The GitHub CLI is installed and signed in.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("The GitHub CLI is installed and signed in.")).toBeVisible();
});
