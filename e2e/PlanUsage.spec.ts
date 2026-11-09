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
      const age = row.getByTestId("usage-reading-age");
      await expect(age).toContainText(/Updated .+ \(1h ago\)/);
      await expect(age.getByText("Stale", { exact: true })).toBeVisible();
      await expect(
        row.getByText("HTTP 429. Retrying in 5 minutes.", { exact: true }),
      ).toBeVisible();
      await expect(row.getByTestId("usage-reading-bars")).toHaveAttribute("data-stale", "true");
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

test("each account says when its reading was taken, and on which machine", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-01T13:00:00.000Z") });
  await page.goto("/global-settings?plan-usage=1&shared-reading=1");
  const host = page.getByRole("listitem", { name: "Host login", exact: true });
  const second = page.getByRole("listitem", { name: "Second account", exact: true });
  const third = page.getByRole("listitem", { name: "Third account", exact: true });

  const hostAge = host.getByTestId("usage-reading-age");
  await expect(hostAge).toContainText(/^Updated .+ \(3m ago\)$/);
  await expect(hostAge).toHaveAttribute("data-stale", "false");
  const secondAge = second.getByTestId("usage-reading-age");
  await expect(secondAge).toContainText(/^Updated .+ \(1m ago\) on beelink$/);
  await expect(second.getByText("100% used", { exact: true })).toBeVisible();
  await expect(third.getByText("Usage has not been read yet.", { exact: true })).toBeVisible();
  await page.screenshot({
    path: `output/visual-previews/account-usage-readings-${testInfo.project.name}.png`,
    fullPage: true,
  });

  // Half an hour later, every reading is past the display bound.
  await page.clock.fastForward("31:00");
  await expect(hostAge.getByText("Stale", { exact: true })).toBeVisible();
  await expect(host.getByTestId("usage-reading-bars")).toHaveAttribute("data-stale", "true");
  await page.screenshot({
    path: `output/visual-previews/account-usage-readings-stale-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("the account-switch log opens in a dialog, newest first, and closes on Escape", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-01T13:00:00.000Z") });
  await page.goto("/global-settings?plan-usage=1&switch-log=1");
  await expect(page.getByText("Switched without asking", { exact: true })).toBeVisible();
  // Nothing of the log is inline.
  await expect(page.getByRole("listitem", { name: /^Switch on / })).toHaveCount(0);
  await page.screenshot({
    path: `output/visual-previews/switch-log-button-${testInfo.project.name}.png`,
    fullPage: true,
  });

  const open = page.getByRole("button", { name: "View switch log, 13 entries" });
  await open.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Codex account switches" });
  await expect(dialog).toBeVisible();
  const rows = dialog.getByRole("listitem");
  await expect(rows).toHaveCount(13);
  await expect(rows.first()).toHaveAttribute("aria-label", "Switch on omarchy-hp");
  await expect(rows.last()).toHaveAttribute("aria-label", "Switch on rkmbp");
  await expect(rows.last()).toContainText("618BTrading → arkaydeusdev");
  await expect(rows.last()).toContainText(
    "Asked by orkestrator-v2 coordinator: “User asked to move off the limited account”",
  );
  await page.screenshot({
    path: `output/visual-previews/switch-log-dialog-${testInfo.project.name}.png`,
  });

  // The list scrolls inside the dialog.
  const list = dialog.getByTestId("coordinator-switch-log");
  const scrollable = await list.evaluate((node) => node.scrollHeight > node.clientHeight);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport ? box.height <= viewport.height : false).toBe(true);
  if (scrollable) {
    await list.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(rows.last()).toBeInViewport();
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
});
