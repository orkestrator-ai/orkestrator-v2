import { expect, test } from "@playwright/test";

test("resume picker shows fork lineage and resumes the selected branch", async ({ page }) => {
  await page.goto("/native-resume-session");
  const dialog = page.getByRole("dialog", { name: "Resume Session" });
  await expect(dialog.getByText("Alternative implementation", { exact: true })).toBeVisible();
  const row = dialog.getByRole("button", { name: /Compare implementations/ });
  await expect(row).toContainText("Alternative implementation");
  await row.click();
  await expect(page.getByTestId("selected-session")).toHaveText("fork");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
