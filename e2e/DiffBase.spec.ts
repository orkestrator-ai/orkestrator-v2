import { expect, test } from "@playwright/test";

test("Changes keeps its selected style through comparison, reload and reset", async ({ page }) => {
  await page.goto("/diff-base");
  const changes = page.getByRole("tab", { name: "Changes", exact: true });
  await expect(changes).toHaveAttribute("data-state", "active");
  const selectedColor = await changes.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(selectedColor).not.toBe("rgba(0, 0, 0, 0)");
  await changes.click({ button: "right" });
  await expect(page.locator('[role="tab"]').filter({ hasText: "Changes" })).toHaveAttribute(
    "data-state",
    "active",
  );
  await page.getByRole("menuitem", { name: "Compare against…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox").first()).toContainText("origin/main");
  await dialog.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: /Earlier base/ }).click();
  await dialog.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("diff-base-notice")).toContainText("Earlier base");
  await expect(changes).toHaveCSS("background-color", selectedColor);
  await page.reload();
  await expect(page.getByTestId("diff-base-notice")).toContainText("Earlier base");
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(dialog.getByRole("combobox").nth(1)).toContainText("Earlier base");
  await dialog.getByRole("button", { name: "Use automatic base" }).click();
  await expect(page.getByTestId("diff-base-notice")).toHaveCount(0);
  await changes.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Compare against…" }).click();
  await dialog.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByTestId("diff-base-notice")).toContainText("Merge main");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByTestId("diff-base-notice")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("diff-base-notice")).toHaveCount(0);
  await expect(changes).toHaveAttribute("data-state", "active");
});
