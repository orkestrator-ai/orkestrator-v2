import { expect, test } from "@playwright/test";

test("a workflow card keeps its name and lists its agents inside it", async ({ page }) => {
  await page.goto("/workflow-agents");
  const card = page.getByRole("button", { name: /^Workflow Build investor Discover/ });
  await expect(card).toBeVisible();
  // One card: the workflow's agents are not cards of their own.
  await expect(page.locator("[data-background-task-id]")).toHaveCount(1);
  await expect(
    page.getByText("3 running · 1 queued · 1/5 done — Build: introductions"),
  ).toBeVisible();

  await card.focus();
  await page.keyboard.press("Enter");
  const agents = page.getByRole("region", { name: "5 workflow agents" });
  await expect(agents).toBeVisible();
  await expect(agents.getByRole("listitem")).toHaveCount(5);
  await expect(
    agents.getByText("Editing src/components/discover/info-request-section.tsx"),
  ).toBeVisible();
  await expect(agents.getByText("Using Read")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
