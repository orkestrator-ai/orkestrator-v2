import path from "node:path";
import { expect, test } from "@playwright/test";

const preview = (name: string) =>
  path.resolve(`output/visual-previews/${name}-${test.info().project.name}.png`);

test("a saved Cursor recording opens from its transcript row without reading it", async ({
  page,
}) => {
  await page.goto("/cursor-screen-recording");
  const region = page.getByRole("region", { name: "Recordings" });
  const saved = region.getByRole("button", { name: "Preview file: checkout-flow.mp4 (Video)" });
  await expect(saved).toBeVisible();
  // Only the two saves are offered; the start and the discard are cards alone.
  await expect(region.getByRole("button", { name: /^Preview file:/ })).toHaveCount(2);
  await expect(region).toContainText("Discard screen recording");
  await region.screenshot({ path: preview("cursor-recording-transcript") });

  // Expanded, the cards say what became of each recording.
  await region.getByText("Discard screen recording").click();
  await expect(region).toContainText("Recording discarded. No video was kept.");
  await region.getByText("Save screen recording").first().click();
  await expect(region).toContainText(
    "Recording saved (12.3 s) to /workspace/recordings/checkout-flow.mp4",
  );
  await region.screenshot({ path: preview("cursor-recording-expanded") });

  await saved.click();
  const dialog = page.getByRole("dialog");
  // A video is read only on an explicit activation, under the media bounds.
  await expect(dialog.getByRole("button", { name: "Load video" })).toBeVisible();
  await page.screenshot({ path: preview("cursor-recording-open") });
});

test("a container recording outside /workspace says why it cannot be opened", async ({ page }) => {
  await page.goto("/cursor-screen-recording?container");
  const region = page.getByRole("region", { name: "Recordings" });
  await region.getByRole("button", { name: "Preview file: settings.mp4 (Video)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("outside previewable workspace storage");
  await expect(dialog.getByRole("button", { name: "Load video" })).toHaveCount(0);
  await page.screenshot({ path: preview("cursor-recording-outside-workspace") });

  await page.keyboard.press("Escape");
  await region.getByRole("button", { name: "Preview file: checkout-flow.mp4 (Video)" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Load video" })).toBeVisible();
});
