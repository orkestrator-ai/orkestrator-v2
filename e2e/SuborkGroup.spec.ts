import { expect, test } from "@playwright/test";

test.describe("subork group", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/subork-group");
    await expect(page.getByText("3 suborks", { exact: true })).toBeVisible();
  });

  test("shows the group's counts and one line per subork", async ({ page }) => {
    await expect(page.getByText("1 working · 1 done · 1 failed", { exact: true })).toBeVisible();
    await expect(page.getByText("Council r12: Opus review", { exact: true })).toBeVisible();
    await expect(page.getByText("Read src/components/chat/SuborkGroup.tsx")).toBeVisible();
    await expect(page.getByText(/^I'd ship it as is/)).toBeVisible();
    await expect(page.getByText(/^No enabled model matches/)).toBeVisible();
  });

  test("a row opens its transcript from the keyboard", async ({ page }) => {
    const row = page.getByRole("button", { name: /Council r12: Sol review/ });
    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("opened-transcript")).toHaveText("sol");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /grok 4\.9/ })).toBeFocused();
  });

  test("the header collapses and expands, and Stop ends the call", async ({ page }) => {
    const header = page.getByRole("button", { name: /3 suborks/ });
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Council r12: Opus review", { exact: true })).toHaveCount(0);
    await header.click();
    await expect(page.getByText("Council r12: Opus review", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop these suborks" }).click();
    await expect(page.getByText("1 done · 1 failed · 1 stopped", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop these suborks" })).toHaveCount(0);
  });

  test("nothing overflows a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(fits).toBe(true);
    await expect(page.getByText("1 working · 1 done · 1 failed", { exact: true })).toBeVisible();
  });
});
