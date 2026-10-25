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
