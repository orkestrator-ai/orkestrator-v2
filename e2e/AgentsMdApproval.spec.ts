import { expect, test } from "@playwright/test";

test("AGENTS.md approval shows the section diff, takes edits and approves them", async ({
  page,
}) => {
  await page.goto("/agents-md-approval");
  const dialog = page.getByTestId("agents-md-request");
  await expect(dialog.getByRole("heading", { name: "Save decisions to AGENTS.md?" })).toBeVisible();
  await expect(dialog).toContainText("Agreed while planning the release");
  const diff = page.getByTestId("agents-md-diff");
  await expect(diff.locator('[data-diff="remove"]')).toHaveText([
    "- - Never touch ports 34121/34122.",
  ]);
  await expect(diff.locator('[data-diff="add"]')).toHaveText([
    "+ - Never bind ports 34121 or 34122.",
    "+ - Commit flaky-test records in the same change.",
  ]);
  // Unchanged entries stay as context.
  await expect(
    diff.locator('[data-diff="same"]', { hasText: "Use bun, never npm." }),
  ).toBeVisible();

  // An entry that would escape the section is refused before approval.
  const first = dialog.getByRole("textbox", { name: "Entry 1 text" });
  await first.fill("## Injected heading");
  await expect(dialog.getByRole("alert")).toContainText("cannot start with a heading");
  await expect(dialog.getByRole("button", { name: "Approve and open PR" })).toBeDisabled();

  await first.fill("Commit flaky-test records with the fix.");
  await expect(diff.locator('[data-diff="add"]')).toContainText([
    "+ - Commit flaky-test records with the fix.",
  ]);
  await expect(page.getByTestId("decision")).toHaveText("");
  await dialog.getByRole("button", { name: "Approve and open PR" }).click();
  await expect(page.getByTestId("decision")).toContainText('"decision":"approve"');
  await expect(page.getByTestId("decision")).toContainText(
    '"text":"Commit flaky-test records with the fix."',
  );
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("AGENTS.md approval can be declined without approving anything", async ({ page }) => {
  await page.goto("/agents-md-approval");
  const dialog = page.getByTestId("agents-md-request");
  await expect(page.getByTestId("agents-md-diff")).toBeVisible();
  await dialog.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("decision")).toHaveText(
    JSON.stringify({ requestId: "agents-md-fixture", decision: "reject" }),
  );
});
