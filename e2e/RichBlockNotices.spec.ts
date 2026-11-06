import { expect, test } from "@playwright/test";
import path from "node:path";

test("diagram failures show the right tone, source and retry controls", async ({
  page,
}, testInfo) => {
  await page.goto("/rich-block-notices");
  const unavailable = page.locator('[data-rich-block-key="fixture-unavailable"]');
  const broken = page.locator('[data-rich-block-key="fixture-broken"]');
  await expect(unavailable.getByRole("note")).toHaveAttribute("data-rich-notice-tone", "warning");
  await expect(unavailable).toContainText("flowchart LR");
  await expect(unavailable).toContainText("A[Agent] --> B[Bridge]");
  await unavailable.getByRole("button", { name: "Retry rendering" }).click();
  await expect(unavailable.getByRole("note")).toHaveAttribute("data-rich-notice-tone", "warning");
  await expect(broken.getByRole("note")).toHaveAttribute("data-rich-notice-tone", "error");
  await expect(broken).toContainText("broken[Agent --> (B");
  await expect(broken.getByRole("button", { name: "Retry rendering" })).toHaveCount(0);
  await page.screenshot({
    path: path.resolve("output/visual-previews", `rich-notices-${testInfo.project.name}.png`),
    fullPage: true,
  });
  await page.reload();
  await expect(unavailable.getByRole("note")).toHaveAttribute("data-rich-notice-tone", "warning");
  await expect(broken.getByRole("note")).toHaveAttribute("data-rich-notice-tone", "error");
});
