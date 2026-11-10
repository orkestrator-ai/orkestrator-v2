import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { parseAutoPipelineTicket } from "../packages/protocol/src/auto-pipeline";

type ProbeWindow = Window & { confirmedTicket?: unknown };
const shot = (page: Page, name: string, project: string) =>
  page.screenshot({
    path: path.resolve(`output/visual-previews/auto-pipeline-${name}-${project}.png`),
    fullPage: true,
  });
const draftRegion = (page: Page) => page.getByRole("region", { name: "Auto-pipeline draft" });
const steps = (page: Page) => page.getByRole("navigation", { name: "Auto-pipeline steps" });

test("drafting runs in a tab that can be left and returned to without losing it", async ({
  page,
}, testInfo) => {
  await page.goto("/auto-pipeline?draftMs=2500");
  await page.getByRole("button", { name: "Auto-pipeline", exact: true }).click();
  // The Multi Review dialog closes; the draft is a tab, not a modal over the app.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const region = draftRegion(page);
  await expect(region.getByText(/Drafting ticket and Build notes/)).toBeVisible();
  await expect(region.getByTestId("auto-pipeline-spinner")).toBeVisible();
  await expect(steps(page).getByRole("button", { name: /Draft/ })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await shot(page, "tab-drafting", testInfo.project.name);
  // Leave while it drafts, then come back: the draft finished in the background.
  await page.getByRole("tab", { name: "Codex 1" }).click();
  await expect(region).toHaveCount(0);
  await page.waitForTimeout(3000);
  await page.getByRole("tab", { name: "Auto-pipeline 2" }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Remember the selected workspace",
  );
  await shot(page, "tab-details", testInfo.project.name);
});

test("details, acceptance criteria and confirm are steps of the same tab", async ({
  page,
}, testInfo) => {
  await page.goto("/auto-pipeline");
  await page.getByRole("button", { name: "Auto-pipeline", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Edited title");
  await page.getByRole("button", { name: /^Description, rendered/ }).press("Enter");
  const editor = page.getByRole("textbox", { name: "Description", exact: true });
  const edited = "Summary: **Edited description**.\n\nProblem: missing.\n\nContext: fixture.";
  await editor.fill(edited);
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(draftRegion(page).locator("strong")).toHaveText("Edited description");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const criterion = page.getByRole("textbox", { name: "Criterion 1", exact: true });
  await criterion.fill("First");
  await criterion.press("End");
  await criterion.press("Enter");
  await expect(criterion).toHaveValue("First ");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("Second\r\nthird\nfourth"));
  await criterion.press("ControlOrMeta+V");
  await expect(criterion).toHaveValue("First Second third fourth");
  await shot(page, "tab-criteria", testInfo.project.name);
  // Edits survive leaving the tab: they are saved with the draft.
  await page.getByRole("tab", { name: "Codex 1" }).click();
  await page.getByRole("tab", { name: "Auto-pipeline 2" }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Edited title");
  await steps(page)
    .getByRole("button", { name: /Acceptance criteria/ })
    .click();
  await expect(criterion).toHaveValue("First Second third fourth");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Files to commit")).toBeVisible();
  await expect(page.getByText(/closes this environment's terminal shells/)).toBeVisible();
  await shot(page, "tab-confirm", testInfo.project.name);
  await page.evaluate(() => {
    const original = window.orkestrator!.invoke;
    window.orkestrator!.invoke = async (command, args) => {
      if (command === "confirm_auto_pipeline")
        (window as ProbeWindow).confirmedTicket = args?.ticket;
      return original(command, args);
    };
  });
  await page.getByRole("button", { name: "Confirm Auto-pipeline" }).click();
  await expect(page.getByText(/Promoting environment/)).toBeVisible();
  await expect(page.getByText(/Auto-pipeline started/)).toBeVisible();
  const ticket = parseAutoPipelineTicket(
    await page.evaluate(() => (window as ProbeWindow).confirmedTicket),
  );
  expect(ticket.title).toBe("Edited title");
  expect(ticket.acceptanceCriteria[0]).toBe("First Second third fourth");
  await shot(page, "tab-promoted", testInfo.project.name);
});

test("a blank criterion blocks confirmation and says why", async ({ page }, testInfo) => {
  await page.goto("/auto-pipeline");
  await page.getByRole("button", { name: "Auto-pipeline", exact: true }).click();
  await steps(page)
    .getByRole("button", { name: /Acceptance criteria/ })
    .click();
  const criterion = page.getByRole("textbox", { name: "Criterion 1", exact: true });
  await criterion.fill("");
  await expect(criterion).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter an acceptance criterion.")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm Auto-pipeline" })).toBeDisabled();
  await expect(page.getByRole("list", { name: "Before confirming" })).toContainText(
    "empty acceptance criterion",
  );
  await shot(page, "tab-blocked", testInfo.project.name);
});

for (const state of ["ready", "running", "failure", "pipeline"]) {
  test(`Auto-pipeline ${state}`, async ({ page }, testInfo) => {
    if (state === "ready") {
      await page.goto("/multi-review-launch");
      await expect(page.getByRole("dialog", { name: "Configure Multi Review" })).toBeVisible();
      await shot(page, "before", testInfo.project.name);
    }
    await page.goto(`/auto-pipeline?${state === "ready" ? "" : state}`);
    const button = page.getByRole("button", { name: "Auto-pipeline", exact: true });
    if (state === "pipeline") {
      await expect(button).toHaveCount(0);
      return;
    }
    await expect(button).toBeVisible();
    if (state === "ready") await shot(page, "launch", testInfo.project.name);
    if (state === "running") {
      await expect(button).toBeDisabled();
      await expect(page.getByRole("status")).toContainText("finish");
    } else {
      await button.click();
      if (state === "failure") {
        await expect(page.getByRole("alert")).toContainText("drafting session failed");
        await expect(page.getByRole("button", { name: "Retry drafting" })).toBeVisible();
      } else {
        await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
          "Remember the selected workspace",
        );
      }
    }
    await shot(page, state, testInfo.project.name);
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

test("a refused confirmation keeps the draft and shows its reason beside Confirm", async ({
  page,
}, testInfo) => {
  await page.goto("/auto-pipeline?long&refused");
  await page.getByRole("button", { name: "Auto-pipeline", exact: true }).click();
  await steps(page)
    .getByRole("button", { name: /Acceptance criteria/ })
    .click();
  await expect(page.getByRole("textbox", { name: "Criterion 8", exact: true })).toBeVisible();
  await shot(page, "tab-criteria-long", testInfo.project.name);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const body = draftRegion(page);
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const confirm = page.getByRole("button", { name: "Confirm Auto-pipeline" });
  await expect(confirm).toBeInViewport();
  await confirm.click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("did not close");
  await expect(alert).toBeInViewport();
  await expect(confirm).toBeEnabled();
  await shot(page, "tab-refused", testInfo.project.name);
});

test("an unsaved edit warns and stays in the tab while saves fail", async ({ page }, testInfo) => {
  await page.goto("/auto-pipeline?saveOffline");
  await page.getByRole("button", { name: "Auto-pipeline", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Edited while offline");
  const warning = page.getByRole("alert");
  await expect(warning).toContainText("not saved yet");
  await expect(page.getByRole("button", { name: "Retry saving" })).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Edited while offline");
  await shot(page, "tab-unsaved", testInfo.project.name);
});

test("a ticket whose confirmation began is read-only and can be confirmed again", async ({
  page,
}, testInfo) => {
  await page.goto("/auto-pipeline?refused&locked");
  await page.getByRole("button", { name: "Auto-pipeline", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Submitted title");
  await steps(page)
    .getByRole("button", { name: /Confirm/ })
    .click();
  await page.getByRole("button", { name: "Confirm Auto-pipeline" }).click();
  await expect(page.getByRole("alert")).toContainText("did not close");
  await expect(page.getByText(/can no longer change/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm Auto-pipeline" })).toBeEnabled();
  await steps(page)
    .getByRole("button", { name: /Details/ })
    .click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Submitted title");
  await expect(page.getByLabel("Title", { exact: true })).toBeDisabled();
  await shot(page, "tab-locked", testInfo.project.name);
});

test("a drafting request the backend never recorded says why", async ({ page }, testInfo) => {
  await page.goto("/auto-pipeline?draftRefused");
  await page.getByRole("button", { name: "Auto-pipeline", exact: true }).click();
  await page.getByRole("button", { name: "Draft ticket" }).click();
  await expect(page.getByRole("alert")).toContainText("Drafting did not start");
  await expect(page.getByRole("button", { name: "Draft ticket" })).toBeVisible();
  await shot(page, "tab-draft-refused", testInfo.project.name);
});
