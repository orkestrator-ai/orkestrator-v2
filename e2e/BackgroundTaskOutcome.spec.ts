import { expect, test, type Page } from "@playwright/test";

async function openOutcome(page: Page, label: "Task" | "Agent") {
  const row = page.getByRole("button", { name: new RegExp(`${label} Review validation`) });
  if (!(await page.getByText("Two checks failed", { exact: true }).isVisible())) {
    await row.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByText("Two checks failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Error", { exact: true })).toBeVisible();
  await expect(page.getByText("Tool uses", { exact: true })).toBeVisible();
  await expect(page.getByText("Tokens", { exact: true })).toBeVisible();
  await expect(page.getByText("/tmp/tasks/shared.output", { exact: true })).toBeVisible();
}

for (const tool of ["Agent", "Task", "Bash"] as const) {
  for (const container of [false, true]) {
    test(`${tool} outcomes survive launch loading and remount in ${container ? "container" : "local"} environments`, async ({
      page,
    }) => {
      await page.goto(`/background-task-outcome?tool=${tool}${container ? "&container=1" : ""}`);
      await openOutcome(page, "Task");
      await page.getByRole("button", { name: "Load launch", exact: true }).click();
      await openOutcome(page, tool === "Bash" ? "Task" : "Agent");
      const reveal = page.getByRole("button", { name: "Reveal output file", exact: true });
      if (container) await expect(reveal).toHaveCount(0);
      else await expect(reveal).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Copy output file path", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Switch environment", exact: true }).click();
      await expect(page.getByText("Other environment", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Return to task", exact: true }).click();
      await openOutcome(page, tool === "Bash" ? "Task" : "Agent");
      await page.reload();
      await openOutcome(page, tool === "Bash" ? "Task" : "Agent");
      if (container) await expect(reveal).toHaveCount(0);
      else await expect(reveal).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }
}
