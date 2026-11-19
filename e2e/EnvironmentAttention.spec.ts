import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/environment-attention");
});

test("each waiting or unread row says what it needs, and only those rows", async ({ page }) => {
  const lines = page.getByTestId("environment-attention-line");
  // Working and idle-seen rows have no line.
  await expect(lines).toHaveCount(6);
  await expect(lines.nth(0)).toHaveText(
    /^Needs approval: Claude wants to run bun install · \d+ min$/,
  );
  await expect(lines.nth(1)).toHaveText(
    /^Question: Which API should this use: REST or GraphQL\? · \d+ min · 2 waiting$/,
  );
  // A form that may hold sensitive input keeps its label alone.
  await expect(lines.nth(2)).toHaveText(/^Needs input · \d+ min$/);
  await expect(lines.nth(3)).toHaveText("Finished · result unread");
  await expect(lines.nth(4)).toHaveText("Failed · error unread");
  await expect(lines.nth(5)).toHaveText("Setup needs your approval");
});

test("clicking a line opens the tab holding the request, not just the row", async ({ page }) => {
  await page.getByRole("button", { name: /^Question: Which API/ }).click();
  await expect(page.getByTestId("attention-opened")).toHaveText("api-client: api-client-agent");
  await page.getByRole("button", { name: "Finished · result unread" }).click();
  await expect(page.getByTestId("attention-opened")).toHaveText("billing-export: environment");
});
