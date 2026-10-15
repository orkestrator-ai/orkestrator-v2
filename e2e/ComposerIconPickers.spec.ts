import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectMenuAboveTrigger(page: Page, trigger: Locator) {
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("data-side", "top");
  const menuBox = (await menu.boundingBox())!;
  const triggerBox = (await trigger.boundingBox())!;
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y);
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  return menu;
}

test("mode and approval pickers show an icon, and open above with icons and names", async ({
  page,
}, testInfo) => {
  await page.goto("/composer-icon-pickers");

  const mode = page.getByTestId("fixture-mode-picker");
  await expect(mode).toHaveAccessibleName("Mode: Build");
  await expect(mode).toHaveText("");
  await expect(mode.locator("svg")).toHaveClass(/text-yellow-500/);

  await mode.click();
  const modeMenu = await expectMenuAboveTrigger(page, mode);
  for (const name of ["Build", "Plan"]) {
    const item = modeMenu.getByRole("menuitemradio", { name });
    await expect(item).toBeVisible();
    await expect(item.locator("svg").last()).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("mode-menu.png") });
  await modeMenu.getByRole("menuitemradio", { name: "Plan" }).click();
  await expect(mode).toHaveAccessibleName("Mode: Plan");
  await expect(mode.locator("svg")).toHaveClass(/text-green-500/);

  const approvals = page.getByTestId("fixture-approval-picker");
  await expect(approvals).toHaveAccessibleName("Approvals: Bypass");
  await approvals.click();
  const approvalMenu = await expectMenuAboveTrigger(page, approvals);
  for (const name of ["Ask", "Accept edits", "Auto", "Bypass"]) {
    await expect(approvalMenu.getByRole("menuitemradio", { name })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("approval-menu.png") });
  await approvalMenu.getByRole("menuitemradio", { name: "Ask" }).click();
  await expect(approvals).toHaveAccessibleName("Approvals: Ask");
});
