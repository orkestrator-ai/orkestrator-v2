import { expect, test } from "@playwright/test";

test("Log Detail offers only areas controlled by live policy", async ({ page }) => {
  await page.goto("/global-settings?section=debug");
  await page.getByRole("button", { name: "Levels by area" }).click();
  for (const area of [
    "terminal",
    "backend.activity",
    "desktop.startup",
    "updater",
    "bridge",
    "bridge.diagnostics",
  ]) {
    await expect(
      page.getByRole("combobox", { name: `Log level for ${area}`, exact: true }),
    ).toHaveCount(1);
  }
  // Renderer-only areas take their level from orkestrator:debug at startup. The bare
  // `terminal` area is offered above because its backend sites follow live policy.
  await expect(
    page.getByRole("combobox", { name: /^Log level for (web\.|terminal\.)/ }),
  ).toHaveCount(0);
});

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
  await page.reload({ waitUntil: "domcontentloaded" });
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
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("global-settings-last-unset") ?? "[]"),
    ),
  ).toContain("claudeBackgroundCommandLimitHours");
  await page.reload({ waitUntil: "domcontentloaded" });
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
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(policy).toHaveText("The session's own login only");

  await policy.click();
  await page.getByRole("option", { name: "Any signed-in login" }).click();
  await expect.poll(stored).toBeNull();
});

test("raised detail without backend expiry metadata does not promise automatic reversion", async ({
  page,
}, testInfo) => {
  await page.goto("/global-settings?section=debug");
  await page.getByRole("combobox", { name: "Default log level", exact: true }).click();
  await page.getByRole("option", { name: "Debug", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("global-settings-config") ?? "{}").global?.logDetail
            ?.level,
      ),
    )
    .toBe("debug");
  await page.reload();
  const notice = page.getByTestId("log-detail-expiry");
  await expect(notice).toContainText("not confirmed by this backend");
  await expect(page.getByRole("switch", { name: "Keep raised log detail on" })).toHaveCount(0);
  await notice.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `output/visual-previews/e16-expiry-compatibility-${testInfo.project.name}.png`,
  });
  await page.reload();
  await expect(notice).toContainText("not confirmed by this backend");
});

test("keep-raised normalization settles autosave and external changes resync without writes", async ({
  page,
}) => {
  await page.goto("/global-settings?section=debug&expiry-backend");
  const preset = page.getByRole("combobox", { name: "Log detail preset" });
  const keep = page.getByRole("switch", { name: "Keep raised log detail on" });
  const writes = () =>
    page.evaluate(() => Number(localStorage.getItem("global-settings-patch-count") ?? 0));
  await preset.click();
  await page.getByRole("option", { name: "Everything", exact: true }).click();
  await expect(keep).toBeVisible();
  await keep.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("global-settings-config")!).global.logDetailKeepRaised,
      ),
    )
    .toBe(true);
  const beforeExternal = await writes();
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("fixture-keep-raised", { detail: false })),
  );
  await expect(keep).not.toBeChecked();
  await page.waitForTimeout(1200);
  expect(await writes()).toBe(beforeExternal);
  await keep.click();
  await expect.poll(writes).toBe(beforeExternal + 1);
  await preset.click();
  await page.getByRole("option", { name: "Normal", exact: true }).click();
  await expect.poll(writes).toBe(beforeExternal + 2);
  await page.waitForTimeout(1600);
  expect(await writes()).toBe(beforeExternal + 2);
  await page.reload();
  await expect(preset).toHaveText("Normal");
  await preset.click();
  await page.getByRole("option", { name: "Everything", exact: true }).click();
  await expect(keep).not.toBeChecked();
});

test("first raise waits for expiry confirmation before saving", async ({ page }, testInfo) => {
  await page.clock.install();
  await page.goto("/global-settings?section=debug");
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.getByRole("combobox", { name: "Log detail preset" }).click();
  await page.getByRole("option", { name: "Everything", exact: true }).click();
  const notice = page.getByTestId("log-detail-expiry");
  await expect(notice).toContainText("Save raised detail to confirm");
  await expect(notice).not.toContainText("stays on");
  await notice.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `output/visual-previews/e16-pending-expiry-after-${testInfo.project.name}.png`,
  });
});
