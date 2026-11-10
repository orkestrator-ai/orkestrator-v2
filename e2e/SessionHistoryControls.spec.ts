import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

test("rewind confirmation and branch selection work in a browser", async ({ page }, testInfo) => {
  await page.goto("/session-history-controls");
  await page.getByRole("button", { name: "Rewind Pi session to before this prompt" }).click();
  const dialog = page.getByTestId("message-rewind-dialog");
  await expect(dialog).toBeVisible();
  await mkdir("output/visual-previews", { recursive: true });
  await page.screenshot({
    path: `output/visual-previews/history-rewind-${testInfo.project.name}.png`,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Rewind Pi session to before this prompt" }).click();
  await page.getByRole("button", { name: "Rewind", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("Try another approach");
  await page.getByRole("button", { name: "Branches", exact: true }).click();
  const branch = page.getByRole("button", {
    name: 'Switch to the branch starting "Earlier approach"',
  });
  await expect(branch).toBeVisible();
  await page.screenshot({
    path: `output/visual-previews/history-branches-${testInfo.project.name}.png`,
  });
  await branch.click();
  await expect(page.getByText(/No other branches/)).toBeVisible();
});

test("history controls retain actionable error states", async ({ page }) => {
  await page.goto("/session-history-controls?fail");
  await page.getByRole("button", { name: "Branches", exact: true }).click();
  await expect(page.getByText("Branches unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Rewind Pi session to before this prompt" }).click();
  await page.getByRole("button", { name: "Rewind", exact: true }).click();
  await expect(page.getByTestId("message-rewind-dialog")).toBeVisible();
  await expect(page.locator('textarea[aria-label="Draft"]')).toHaveValue("");
});
