import { expect, test } from "@playwright/test";
import path from "node:path";

for (const state of ["ready", "running", "failure", "pipeline"]) {
  test(`Auto-pipeline ${state} and cancellation`, async ({ page }, testInfo) => {
    if (state === "ready") {
      await page.goto("/multi-review-launch");
      await expect(page.getByRole("dialog", { name: "Configure Multi Review" })).toBeVisible();
      await page.screenshot({
        path: path.resolve(
          `output/visual-previews/auto-pipeline-before-${testInfo.project.name}.png`,
        ),
        fullPage: true,
      });
    }
    await page.goto(`/auto-pipeline?${state === "ready" ? "" : state}`);
    const button = page.getByRole("button", { name: "Auto-pipeline", exact: true });
    if (state === "pipeline") {
      await expect(button).toHaveCount(0);
      return;
    }
    await expect(button).toBeVisible();
    if (state === "ready")
      await page.screenshot({
        path: path.resolve(
          `output/visual-previews/auto-pipeline-launch-${testInfo.project.name}.png`,
        ),
        fullPage: true,
      });
    if (state === "running") {
      await expect(button).toBeDisabled();
      await expect(page.getByRole("status")).toContainText("finish");
    } else {
      await button.click();
      if (state === "failure") {
        await expect(page.getByRole("button", { name: "Retry drafting" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Plain Multi Review" })).toBeVisible();
      } else {
        await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
          "Remember the selected workspace",
        );
        await page.getByRole("button", { name: "Move criterion 2 up" }).click();
        await expect(page.getByLabel("Criterion 1", { exact: true })).toHaveValue(
          "Deleted workspaces fall back to the first available workspace",
        );
      }
    }
    await page.screenshot({
      path: path.resolve(
        `output/visual-previews/auto-pipeline-${state}-${testInfo.project.name}.png`,
      ),
      fullPage: true,
    });
    if (state === "ready") {
      await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
      await expect(page.getByRole("dialog", { name: "Configure Multi Review" })).toBeVisible();
    }
  });
}

test("adopted Build inspector keeps its original notes and criteria", async ({
  page,
}, testInfo) => {
  await page.goto("/pipeline-flow?scenario=loops&adopted");
  await page
    .getByRole("tab", { name: /^Build,/ })
    .first()
    .click();
  await page.getByText("Original Build notes and acceptance criteria", { exact: true }).click();
  await expect(page.getByText("Finished interactive feature work.", { exact: true })).toBeVisible();
  await page.screenshot({
    path: path.resolve(`output/visual-previews/auto-pipeline-build-${testInfo.project.name}.png`),
    fullPage: true,
  });
});

test("Notes retains generated Build notes after later pipeline updates", async ({
  page,
}, testInfo) => {
  await page.goto("/pipeline-flow?scenario=notes&adopted");
  await page.getByText("Original interactive Build notes", { exact: true }).click();
  await expect(page.getByText("Finished interactive feature work.", { exact: true })).toBeVisible();
  await page.screenshot({
    path: path.resolve(`output/visual-previews/auto-pipeline-notes-${testInfo.project.name}.png`),
    fullPage: true,
  });
});
