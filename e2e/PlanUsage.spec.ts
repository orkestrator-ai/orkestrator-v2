import { expect, test } from "@playwright/test";

test("stale platform and account quotas retain their timestamp and explanation after reload", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-01T13:00:00.000Z") });
  await page.goto("/global-settings?plan-usage=1");
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    const pane = page.getByRole("region", { name: "Plan usage", exact: true });
    const rows = [
      pane,
      page.getByRole("listitem", { name: "Host login", exact: true }),
      page.getByRole("listitem", { name: "Second account", exact: true }),
    ];
    for (const row of rows) {
      await expect(row.getByText("42% used", { exact: true })).toBeVisible();
      await expect(
        row.getByText("Last known usage, as of 1h ago. HTTP 429. Retrying in 5 minutes.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(row.getByText(/^Updated /)).toHaveCount(0);
    }
    const refresh = pane.getByRole("button", { name: "Refresh plan usage" });
    await refresh.focus();
    await expect(refresh).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(refresh).toBeEnabled();
    await expect(pane.getByText("42% used", { exact: true })).toBeVisible();
  }
});

test("an inactive saved twin can be removed while the grouped host login remains active", async ({
  page,
}, testInfo) => {
  await page.goto("/global-settings?plan-usage=1&grouped-account=1");
  const row = page.getByRole("listitem", { name: "Second account", exact: true });
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
  await expect(row.getByText("Also the host login", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Use", exact: true })).toHaveCount(0);
  await expect(row.getByText("42% used", { exact: true })).toBeVisible();
  await page.screenshot({
    path: `output/visual-previews/account-twin-after-${testInfo.project.name}.png`,
    fullPage: true,
  });
  const remove = row.getByRole("button", { name: "Remove", exact: true });
  await remove.focus();
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row.getByRole("button", { name: "Confirm remove", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  const host = page.getByRole("listitem", { name: "Host login", exact: true });
  await expect(host.getByText("Active", { exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(host.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
  await page.screenshot({
    path: `output/visual-previews/account-twin-removed-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
