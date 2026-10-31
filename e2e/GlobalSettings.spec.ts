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

test("disabled Cursor retains its browser sign-in controls", async ({ page }) => {
  await page.goto("/global-settings?cursor-disabled");
  await expect(page.getByRole("button", { name: "Sign in with Cursor" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Cursor Agent sign-in" })).toHaveCount(0);
});

test("Session titles discloses where a first message goes and persists its choice", async ({
  page,
}) => {
  await page.goto("/global-settings?section=platforms");
  const policy = page.getByRole("combobox", { name: "Session titles" });
  await expect(policy).toHaveText("Any signed-in login");
  await expect(page.getByText("goes to OpenAI or Anthropic", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  const stored = () =>
    page.evaluate(() => {
      const config = JSON.parse(localStorage.getItem("global-settings-config") ?? "{}");
      return config.global?.sessionTitleGeneration ?? null;
    });
  await policy.click();
  await page.getByRole("option", { name: "The session's own login only" }).click();
  await expect.poll(stored).toBe("own-platform");
  await page.reload();
  await expect(policy).toHaveText("The session's own login only");

  await policy.click();
  await page.getByRole("option", { name: "Any signed-in login" }).click();
  await expect.poll(stored).toBeNull();
});
