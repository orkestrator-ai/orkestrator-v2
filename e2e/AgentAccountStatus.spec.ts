import { expect, test } from "@playwright/test";

test("a mounted account panel follows the bridge onto the active account", async ({ page }) => {
  await page.goto("/agent-account-status");
  const panel = page.getByTestId("agent-info-account");
  await expect(panel).toContainText("Moves to Work login");
  await page.getByRole("button", { name: "Toggle account panel" }).click();
  await page.getByRole("button", { name: "Start next turn" }).click();
  await page.getByRole("button", { name: "Toggle account panel" }).click();
  await expect(panel).not.toContainText("Moves to");
  await expect(panel.getByRole("combobox")).toContainText("Work login");
  await expect(panel.getByRole("button", { name: "Manage accounts" })).toBeVisible();
});
