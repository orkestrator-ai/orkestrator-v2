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

test("approval waits for a successfully rendered preview", async ({ page }) => {
  await page.goto("/agents-md-approval?preview=pending");
  const approve = page.getByRole("button", { name: "Approve and open PR" });
  await expect(approve).toBeDisabled();
  await expect(page.getByRole("button", { name: "Decline" })).toBeEnabled();
  await expect(page.getByTestId("decision")).toHaveText("");
  await expect(page.getByText("Reading AGENTS.md on the base branch…")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("agents-md-preview-ready")));
  await expect(page.getByTestId("agents-md-diff")).toBeVisible();
  await expect(approve).toBeEnabled();
});

test("a failed preview can be retried without approving it", async ({ page }) => {
  await page.goto("/agents-md-approval?preview=error");
  await expect(page.getByText(/The project node is offline/)).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve and open PR" });
  await expect(approve).toBeDisabled();
  await page.getByRole("button", { name: "Retry preview" }).click();
  await expect(page.getByTestId("agents-md-diff")).toBeVisible();
  await expect(approve).toBeEnabled();
  await expect(page.getByTestId("decision")).toHaveText("");
});

test("a merge failure blocks approval and still allows decline", async ({ page }) => {
  await page.goto("/agents-md-approval?preview=invalid");
  await expect(page.getByText(/more than one ## Orkestrator/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and open PR" })).toBeDisabled();
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("decision")).toContainText('"decision":"reject"');
});
