import { expect, test } from "@playwright/test";
import path from "node:path";
import { parseAutoPipelineTicket } from "../packages/protocol/src/auto-pipeline";

test("criterion Enter and multiline paste submit a valid single-line ticket", async ({
  page,
}, testInfo) => {
  await page.goto("/auto-pipeline");
  await page.getByRole("button", { name: "Auto-pipeline", exact: true }).click();
  await page.getByRole("tab", { name: "Acceptance criteria (2)" }).click();
  const criterion = page.getByRole("textbox", { name: "Criterion 1", exact: true });
  await criterion.fill("First");
  await criterion.press("End");
  await criterion.press("Enter");
  await expect(criterion).toHaveValue("First ");
  // Chromium's clipboard paste inserts newlines through the native textarea input path.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("Second\r\nthird\nfourth"));
  await criterion.press("ControlOrMeta+V");
  await expect(criterion).toHaveValue("First Second third fourth");
  const confirm = page.getByRole("button", { name: "Confirm Auto-pipeline" });
  await expect(confirm).toBeEnabled();
  await criterion.fill("");
  await expect(criterion).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter an acceptance criterion.")).toBeVisible();
  await expect(confirm).toBeDisabled();
  await page.getByRole("dialog", { name: "Review Auto-pipeline draft" }).evaluate((dialog) => {
    dialog.scrollTop = 0;
  });
  await page.screenshot({
    path: path.resolve(
      `output/visual-previews/auto-pipeline-criterion-validation-v2-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  await criterion.fill("First\nSecond");
  await expect(criterion).toHaveValue("First Second");
  await page.getByRole("dialog", { name: "Review Auto-pipeline draft" }).evaluate((dialog) => {
    dialog.scrollTop = 0;
  });
  await page.screenshot({
    path: path.resolve(
      `output/visual-previews/auto-pipeline-criterion-normalized-v2-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  await page.evaluate(() => {
    const original = window.orkestrator!.invoke;
    window.orkestrator!.invoke = async (command, args) => {
      if (command === "confirm_auto_pipeline") {
        (window as Window & { confirmedTicket?: unknown }).confirmedTicket = args?.ticket;
      }
      return original(command, args);
    };
  });
  await confirm.click();
  const ticket = parseAutoPipelineTicket(
    await page.evaluate(() => (window as Window & { confirmedTicket?: unknown }).confirmedTicket),
  );
  expect(ticket.acceptanceCriteria[0]).toBe("First Second");
  await expect(page.getByRole("dialog", { name: "Review Auto-pipeline draft" })).toHaveCount(0);
});

test("Escape from description editing retains the draft and returns to rendered preview", async ({
  page,
}, testInfo) => {
  await page.goto("/auto-pipeline");
  await page.getByRole("button", { name: "Auto-pipeline", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review Auto-pipeline draft" });
  await page.getByLabel("Title", { exact: true }).fill("Edited title");
  await page.getByRole("tab", { name: "Acceptance criteria (2)" }).click();
  await page.getByRole("textbox", { name: "Criterion 1", exact: true }).fill("Edited criterion");
  await page.getByRole("tab", { name: "Description", exact: true }).click();
  await page.getByRole("button", { name: /^Description, rendered/ }).press("Enter");
  const editor = page.getByRole("textbox", { name: "Description", exact: true });
  const edited = "Summary: **Edited description**.\n\nProblem: missing.\n\nContext: fixture.";
  await editor.fill(edited);
  await editor.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(dialog.locator("strong")).toHaveText("Edited description");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Edited title");
  await page.screenshot({
    path: path.resolve(
      `output/visual-previews/auto-pipeline-escape-retained-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Description, rendered/ }).press("Space");
  await expect(editor).toHaveValue(edited);
  await editor.press("Escape");
  await page.getByRole("tab", { name: "Acceptance criteria (2)" }).click();
  await expect(page.getByRole("textbox", { name: "Criterion 1", exact: true })).toHaveValue(
    "Edited criterion",
  );
  // Once editing has ended, Escape still dismisses the draft normally.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

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
        await page.getByRole("tab", { name: "Acceptance criteria (2)" }).click();
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
