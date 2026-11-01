import { expect, type Locator, type Page } from "@playwright/test";

/** Opens the PR launch fixture and checks the branch field's suggestion list. */
export async function openBranchField(page: Page) {
  await page.goto("/agent-launch");
  const dialog = page.getByRole("dialog", { name: "Configure pull request" });
  const branch = page.getByLabel("Target branch");
  await expect(dialog).toBeVisible();
  await expect(branch).toHaveValue("main");
  await expect(branch).toHaveAttribute("list", "create-pr-model-target-branches");
  expect(
    await page
      .locator("datalist option")
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
  ).toEqual(["main", "release/2.0", "develop"]);
  return { dialog, branch };
}

/** Confirms the dialog from the keyboard and checks it returned `release/2.0`. */
export async function confirmReleaseBranch(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  const confirm = page.getByRole("button", { name: "Create pull request" });
  await expect(confirm).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("pr-launch-selection")).toHaveText("release/2.0");
}
