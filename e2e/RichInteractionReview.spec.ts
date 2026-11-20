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

test("releasing the captured pointer outside the talk button stops speech", async ({ page }) => {
  await page.addInitScript(() => {
    class SpeechFixture {
      onend?: () => void;
      start() {}
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: SpeechFixture,
    });
  });
  await page.goto("/rich-interaction-speech");
  const talk = page.getByRole("button", { name: "Hold to talk" });
  const box = await talk.boundingBox();
  if (!box) throw new Error("Missing talk button");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByRole("img", { name: "Microphone is recording" })).toBeVisible();
  await page.mouse.move(box.x + box.width + 10, box.y + box.height + 10);
  await page.mouse.up();
  await expect(page.getByRole("img", { name: "Microphone is recording" })).toHaveCount(0);
  await expect(talk).toHaveAttribute("aria-pressed", "false");
});
