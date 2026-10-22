import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectHitTarget(locator: Locator) {
  await expect(locator).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
    )
    .toBe(true);
}

async function openFailedSetup(page: Page) {
  await page.goto("/setup-recovery");
  const recovery = page
    .getByText("Retry setup, or skip it to continue with the current workspace.", { exact: true })
    .locator("..");
  // The competing setup overlay must really be laid out inside the native tab.
  const nativeOverlay = page
    .locator("[data-pane-leaf]")
    .getByText("Codex will connect automatically once setup finishes", { exact: true });
  await expect(nativeOverlay).toBeInViewport({ ratio: 1 });
  await expect(recovery.getByText("Environment setup failed.", { exact: true })).toBeVisible();
  // Check paint order as well as clickability; transparent tab content can
  // intercept events even while the recovery text is visible underneath it.
  await expectHitTarget(recovery.locator("p").nth(1));
  await expectHitTarget(recovery.getByRole("button", { name: "Retry setup", exact: true }));
  await expectHitTarget(recovery.getByRole("button", { name: "Skip setup", exact: true }));
  return recovery;
}

test("failed setup retry receives clicks above a laid-out native tab", async ({ page }) => {
  const recovery = await openFailedSetup(page);
  await recovery.getByRole("button", { name: "Retry setup", exact: true }).click();
  await expect(page.getByTestId("recovery-requests")).toHaveText(
    JSON.stringify([
      { command: "run_environment_setup", environmentId: "setup-recovery-environment" },
    ]),
  );
  await expect(page.getByTestId("setup-phase")).toHaveText("running");
  await expect(recovery).toHaveCount(0);
  await expect(
    page.getByText("Waiting for setup scripts to complete...", { exact: true }),
  ).toBeVisible();
});

test("failed setup skip confirmation receives clicks above a laid-out native tab", async ({
  page,
}) => {
  const recovery = await openFailedSetup(page);
  await recovery.getByRole("button", { name: "Skip setup", exact: true }).click();
  await expectHitTarget(recovery.getByRole("button", { name: "Cancel", exact: true }));
  await expectHitTarget(recovery.getByRole("button", { name: "Skip anyway", exact: true }));
  await expect(page.getByTestId("recovery-requests")).toHaveText("[]");
  await recovery.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(recovery.getByRole("button", { name: "Retry setup", exact: true })).toBeVisible();
  await expect(page.getByTestId("setup-phase")).toHaveText("failed");
  await recovery.getByRole("button", { name: "Skip setup", exact: true }).click();
  await recovery.getByRole("button", { name: "Skip anyway", exact: true }).click();
  await expect(page.getByTestId("recovery-requests")).toHaveText(
    JSON.stringify([
      { command: "override_environment_setup", environmentId: "setup-recovery-environment" },
    ]),
  );
  await expect(page.getByTestId("setup-phase")).toHaveText("ready");
  await expect(recovery).toHaveCount(0);
  await expect(page.getByText("Environment setup failed.", { exact: true })).toHaveCount(0);
});
