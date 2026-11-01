import { expect, test } from "@playwright/test";
import { confirmReleaseBranch, openBranchField } from "./agent-launch-branch";

// Chrome's native datalist popup is checked in AgentLaunchDialogNativePopup.spec.ts,
// which needs an unlocked desktop (todo 1171). Here, choosing a suggestion is
// what the popup does to the page: it sets the input's value and fires `input`.
test("offers branch suggestions and confirms a chosen one with the keyboard", async ({ page }) => {
  const { dialog, branch } = await openBranchField(page);
  await branch.fill("release/2.0");
  await expect(branch).toHaveValue("release/2.0");
  await expect(branch).toHaveAttribute("aria-invalid", "false");
  await confirmReleaseBranch(page, dialog);
});

test("allows a manually entered branch and resets it on reopen", async ({ page }) => {
  await page.goto("/agent-launch");
  const branch = page.getByLabel("Target branch");
  await branch.fill("main; unsafe");
  await expect(branch).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Create pull request" })).toBeDisabled();
  await branch.fill("manual/base");
  await page.getByRole("button", { name: "Create pull request" }).click();
  await expect(page.getByTestId("pr-launch-selection")).toHaveText("manual/base");
  await page.getByRole("button", { name: "Reopen PR dialog" }).click();
  await expect(branch).toHaveValue("main");
});
