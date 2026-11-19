import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const previewDir = path.resolve(import.meta.dirname, "../output/visual-previews");

test("the dock links back to the current plan after scrolling through history", async ({
  page,
}, testInfo) => {
  await page.goto("/cursor-plan-card");
  const implement = page.getByRole("button", { name: "Implement this plan" });
  const review = page.getByRole("button", { name: "Review plan" });
  const scroller = page.locator('[data-transcript-scroller="true"]');
  await expect(implement).toBeInViewport({ ratio: 0.99 });
  await expect(review).toHaveCount(0);
  const capture = process.env.ORKESTRATOR_CAPTURE_PLAN_PREVIEWS === "1";
  if (capture) {
    await mkdir(previewDir, { recursive: true });
    await page.screenshot({
      path: path.join(previewDir, `plan-review-visible-${testInfo.project.name}.png`),
    });
  }

  await scroller.hover({ position: { x: 30, y: 50 } });
  await page.mouse.wheel(0, -1600);
  await expect(implement).not.toBeInViewport();
  await expect(review).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve plan" })).toHaveCount(0);
  if (capture) {
    await page.screenshot({
      path: path.join(previewDir, `plan-review-away-${testInfo.project.name}.png`),
    });
  }

  await review.focus();
  await page.keyboard.press("Enter");
  await expect(implement).toBeInViewport({ ratio: 0.99 });
  await expect(review).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Implementation plan: Observe the queue" }),
  ).toBeVisible();
});

for (const [detail, message] of [
  ["loading", "Loading plan…"],
  ["error", "Could not load plan details."],
]) {
  test(`cannot implement while plan details are ${detail}`, async ({ page }, testInfo) => {
    await page.goto(`/cursor-plan-card?detail=${detail}`);
    await expect(page.getByText(message)).toBeVisible();
    await expect(page.getByRole("button", { name: "Implement this plan" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Switch to Build" })).toBeEnabled();
    if (process.env.ORKESTRATOR_CAPTURE_PLAN_PREVIEWS === "1") {
      await mkdir(previewDir, { recursive: true });
      await page.screenshot({
        path: path.join(previewDir, `plan-review-${detail}-${testInfo.project.name}.png`),
      });
    }
  });
}
