import { expect, test } from "@playwright/test";
import path from "node:path";

for (const [button, decision] of [
  ["Approve and send", "approve"],
  ["Decline", "reject"],
] as const) {
  test(`project home message: ${decision} requires an explicit decision`, async ({
    page,
  }, testInfo) => {
    await page.goto("/project-home-message-approval");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("conflict with your own changes");
    await expect(page.getByTestId("project-home-reason")).toContainText(
      "an isolated worktree cannot update it",
    );
    await expect(page.getByTestId("project-home-message-body")).toHaveText(
      "Update the project checkout to the approved release commit.",
    );
    await expect(page.getByTestId("decision")).toHaveText("null");
    // Escape and backdrop clicks must never approve the held message.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("decision")).toHaveText("null");
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (decision === "approve") {
      await page.screenshot({
        path: path.resolve(
          "output/visual-previews",
          `project-home-approval-${testInfo.project.name}.png`,
        ),
      });
    }
    await page.getByRole("button", { name: button }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("decision")).toHaveText(
      JSON.stringify({ requestId: "project-home-fixture", decision }),
    );
    await expect(dialog).toHaveCount(0);
  });
}

test("project home message with images says they stay out of the checkout", async ({
  page,
}, testInfo) => {
  await page.goto("/project-home-message-approval?images=1");
  const images = page.getByTestId("project-home-message-attachments");
  await expect(images).toContainText("kept outside your checkout");
  await expect(images).toContainText("removed with the project home");
  await expect(images).toContainText("clipboard-1.png, clipboard-2.png");
  await expect(images).not.toContainText(".orkestrator");
  await page.screenshot({
    path: path.resolve(
      "output/visual-previews",
      `project-home-approval-images-after-${testInfo.project.name}.png`,
    ),
  });
});
