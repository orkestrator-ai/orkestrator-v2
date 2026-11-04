import path from "node:path";
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

test("the transcript identifies partial pages and reaches the final answer", async ({ page }) => {
  await page.goto("/subork-group?paging=1");
  await page.getByRole("button", { name: /Council r12: Opus review/ }).click();
  await expect(page.getByRole("status")).toContainText("Partial transcript: messages 1–1 of 2");
  await expect(page.getByText("First transcript page", { exact: true })).toBeVisible();
  const preview = path.resolve("output/visual-previews");
  const layout = test.info().project.name;
  await page.screenshot({ path: path.join(preview, `subork-pagination-verified-${layout}.png`) });
  // Reconstruct the prior dialog's missing paging strip for a visual comparison.
  await page
    .getByRole("dialog")
    .getByRole("status", { includeHidden: true })
    .evaluate((node) => {
      (node as HTMLElement).style.display = "none";
    });
  await page.screenshot({
    path: path.join(preview, `subork-pagination-before-reconstruction-verified-${layout}.png`),
  });
  await page
    .getByRole("dialog")
    .getByRole("status", { includeHidden: true })
    .evaluate((node) => {
      (node as HTMLElement).style.display = "";
    });
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Final consultation answer", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await page.getByRole("button", { name: "Back to start" }).click();
  await expect(page.getByText("First transcript page", { exact: true })).toBeVisible();
});

test("maximum targets fit at desktop and 320px and retain Stop and all rows", async ({ page }) => {
  await page.goto("/subork-group?maximum=1");
  const preview = path.resolve("output/visual-previews");
  // Reconstruct the former unbounded header, then restore the actual UI.
  const stack = page.locator("[data-subork-group] button[aria-expanded] > span").first();
  const original = await stack.innerHTML();
  await stack.evaluate((node) => {
    const mark = node.firstElementChild!;
    node.replaceChildren(
      ...Array.from({ length: 32 }, (_, i) => {
        const clone = mark.cloneNode(true) as HTMLElement;
        if (i) clone.classList.add("-ml-2");
        return clone;
      }),
    );
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.screenshot({
    path: path.join(preview, "subork-maximum-before-reconstruction-320.png"),
  });
  await stack.evaluate((node, html) => {
    node.innerHTML = html;
  }, original);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByText("+29", { exact: true })).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(32);
    await expect(page.getByText("4 working · 28 failed", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop these suborks" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: path.join(preview, `subork-maximum-after-${width}.png`) });
  }
  await page.reload();
  await expect(page.getByRole("listitem")).toHaveCount(32);
  await page.getByRole("button", { name: /Target 31/ }).click();
  await expect(page.getByTestId("opened-transcript")).toHaveText("target-31");
});

test("Stop failure gives feedback and keeps retry available", async ({ page }) => {
  await page.goto("/subork-group?stop-fails=1");
  await page.getByRole("button", { name: "Stop these suborks" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not stop");
  await expect(page.getByRole("button", { name: "Stop these suborks" })).toBeEnabled();
  await page.screenshot({
    path: path.resolve("output/visual-previews/subork-stop-error-after.png"),
  });
});
