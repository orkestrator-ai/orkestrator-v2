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

test("archived conversations stay reachable and restore before resuming", async ({ page }) => {
  await page.goto("/native-resume-session");
  const dialog = page.getByRole("dialog", { name: "Resume Session" });
  const archived = dialog.getByRole("button", { name: /A finished conversation/ });

  await expect(dialog.getByText("Original implementation")).toBeVisible();
  await expect(archived).toHaveCount(0);

  await dialog.getByRole("switch", { name: "Show archived (1)" }).click();
  await expect(archived).toContainText("Archived");
  // Newer than every live row, and still below them.
  const rows = dialog.getByRole("button", { name: /implementation|finished/ });
  expect((await rows.allTextContents()).at(-1)).toContain("A finished conversation");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await archived.click();
  await expect(page.getByTestId("archive-calls")).toHaveText("restore:kept");
  await expect(page.getByTestId("selected-session")).toHaveText("kept");
});
