import { expect, test } from "@playwright/test";
import path from "node:path";
import { parseAutoPipelineTicket } from "../packages/protocol/src/auto-pipeline";

type DraftProbe = { drafts: number; cancels: number; confirms: number; release: () => void };
type ProbeWindow = Window & { autoPipelineProbe?: DraftProbe };

test("a new draft after Cancel stays cancellable and ignores its late response", async ({
  page,
}, testInfo) => {
  await page.goto("/auto-pipeline");
  await page.evaluate(() => {
    const original = window.orkestrator!.invoke;
    const probe: DraftProbe = { drafts: 0, cancels: 0, confirms: 0, release: () => undefined };
    (window as ProbeWindow).autoPipelineProbe = probe;
    window.orkestrator!.invoke = async (command, args) => {
      if (command === "draft_auto_pipeline" && ++probe.drafts === 2)
        await new Promise<void>((resolve) => {
          probe.release = resolve;
        });
      if (command === "cancel_auto_pipeline_draft") probe.cancels++;
      if (command === "confirm_auto_pipeline") probe.confirms++;
      return original(command, args);
    };
  });
  const launch = page.getByRole("button", { name: "Auto-pipeline", exact: true });
  const dialog = page.getByRole("dialog", { name: "Review Auto-pipeline draft" });
  await launch.click();
  await expect(dialog.getByLabel("Title", { exact: true })).toBeVisible();
  await page.screenshot({
    path: path.resolve(
      `output/visual-previews/auto-pipeline-before-redraft-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await launch.click();
  await expect(dialog.getByRole("status")).toHaveText("Drafting ticket and Build notes…");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeEnabled();
  await page.screenshot({
    path: path.resolve(
      `output/visual-previews/auto-pipeline-redraft-fixed-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).autoPipelineProbe!.cancels))
    .toBe(1);
  await page.evaluate(() => (window as ProbeWindow).autoPipelineProbe!.release());
  // A third completed draft is an observable barrier after the cancelled request.
  await launch.click();
  await expect(dialog.getByLabel("Title", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).autoPipelineProbe!.drafts))
    .toBe(3);
  expect(await page.evaluate(() => (window as ProbeWindow).autoPipelineProbe!.confirms)).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

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
  const body = page.getByRole("region", { name: "Auto-pipeline draft" });
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
  await page.screenshot({
    path: path.resolve(
      `output/visual-previews/auto-pipeline-criterion-validation-v2-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  await criterion.fill("First\nSecond");
  await expect(criterion).toHaveValue("First Second");
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
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

test("a refused confirmation shows its reason beside Confirm wherever the draft is scrolled", async ({
  page,
}, testInfo) => {
  await page.goto("/auto-pipeline?long&refused");
  await page.getByRole("button", { name: "Auto-pipeline", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review Auto-pipeline draft" });
  await page.getByRole("tab", { name: "Acceptance criteria (8)" }).click();
  await expect(page.getByRole("textbox", { name: "Criterion 8", exact: true })).toBeVisible();
  await page.screenshot({
    path: path.resolve(
      `output/visual-previews/auto-pipeline-criteria-after-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  const body = dialog.getByRole("region", { name: "Auto-pipeline draft" });
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const confirm = dialog.getByRole("button", { name: "Confirm Auto-pipeline" });
  await expect(confirm).toBeInViewport();
  await confirm.click();
  await expect(dialog.getByRole("status")).toBeInViewport();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("Close this environment's terminals");
  await expect(alert).toBeInViewport();
  await expect(confirm).toBeEnabled();
  await page.screenshot({
    path: path.resolve(
      `output/visual-previews/auto-pipeline-refused-after-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
});
