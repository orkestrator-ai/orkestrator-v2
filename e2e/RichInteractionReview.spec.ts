import { expect, test } from "@playwright/test";
import path from "node:path";
import { mkdir } from "node:fs/promises";

test("a whole-run stop requires confirmation and unavailable evidence keeps acceptance disabled", async ({
  page,
}, info) => {
  await page.goto("/rich-interaction-review");
  const workflow = page.getByRole("region", { name: "Workflow controls" });
  const review = page.getByRole("region", { name: "Result review" });
  const stop = workflow.getByRole("button", { name: "Stop workflow run", exact: true });
  await expect(review.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  const directory = path.resolve("output/visual-previews");
  await mkdir(directory, { recursive: true });
  await expect(stop).toBeDisabled();
  await expect(review.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
  await page.screenshot({
    path: path.join(directory, `rich-interaction-review-after-${info.project.name}.png`),
    fullPage: true,
  });
  await page.reload();
  await expect(stop).toBeDisabled();
  const confirm = workflow.getByRole("checkbox", { name: /including all active stages/ });
  await confirm.focus();
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Space");
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(workflow.getByTestId("workflow-intent")).toContainText('"confirmWholeRun":true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
