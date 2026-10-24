import { expect, test } from "@playwright/test";

test("Claude background limit persists across reload and clears when reset to default", async ({
  page,
}) => {
  await page.goto("/global-settings");
  const limit = page.getByRole("combobox", { name: "Background task time limit" });
  await expect(limit).toHaveText("2 hours (default)");

  await limit.click();
  await page.getByRole("option", { name: "1 day", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("global-settings-last-write") ?? "{}")
            .claudeBackgroundCommandLimitHours,
      ),
    )
    .toBe(24);
  await page.reload();
  await expect(limit).toHaveText("1 day");

  await limit.click();
  await page.getByRole("option", { name: "2 hours (default)", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const payload = JSON.parse(localStorage.getItem("global-settings-last-write")!);
        const config = JSON.parse(localStorage.getItem("global-settings-config")!);
        return {
          payloadHasLimit: Object.hasOwn(payload, "claudeBackgroundCommandLimitHours"),
          storedHasLimit: Object.hasOwn(config.global, "claudeBackgroundCommandLimitHours"),
        };
      }),
    )
    .toEqual({ payloadHasLimit: false, storedHasLimit: false });
  await page.reload();
  await expect(limit).toHaveText("2 hours (default)");
});

test("the Claude page shows its sign-in card without a session", async ({ page }) => {
  await page.goto("/global-settings");
  const card = page.getByRole("region", { name: "Claude Code sign-in" });
  await expect(card.getByText("Login expired")).toBeVisible();
  await expect(card.getByText("Host login · max")).toBeVisible();
  await expect(card.getByRole("button", { name: "Sign in to Claude" })).toBeVisible();
});
