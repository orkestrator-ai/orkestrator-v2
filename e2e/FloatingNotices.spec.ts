import { expect, test, type Page } from "@playwright/test";

async function box(page: Page, selector: string) {
  const rect = await page.locator(selector).first().boundingBox();
  if (!rect) throw new Error(`${selector} has no box`);
  return rect;
}

test("beside a wide transcript the cards sit in the empty space, covering no text", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "a desktop-width pane");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/floating-notices?scene=agent");
  const mail = page.getByRole("region", { name: "Agent mail" });
  const prompts = page.getByRole("status", { name: "Waiting for you" });
  await expect(mail).toContainText("1 message in inbox · pull only");
  await expect(prompts).toContainText("Sign in and enter the code");
  // No minimize control: there is nothing under the card to uncover.
  await expect(page.getByRole("button", { name: /^Minimize/ })).toHaveCount(0);

  const column = await box(page, '[data-testid="transcript-column"]');
  for (const card of [mail, prompts]) {
    const rect = (await card.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(column.x + column.width);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1600);
  }
  // Warnings stack above information.
  expect((await prompts.boundingBox())!.y).toBeLessThan((await mail.boundingBox())!.y);
});

test("without room beside the column, pills open the card and give focus back", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "a mid-width pane");
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("/floating-notices?scene=agent");
  const pill = page.getByRole("button", { name: "Agent mail: 1 message in inbox · pull only" });
  await expect(pill).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent mail" })).toHaveCount(0);

  await pill.focus();
  await page.keyboard.press("Enter");
  const card = page.getByRole("region", { name: "Agent mail" });
  await expect(card).toBeFocused();
  await expect(card.getByRole("button", { name: "Deliver now" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(pill).toBeFocused();
});

test("on a phone the notices are pills in the corner", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "a phone-width pane");
  await page.goto("/floating-notices?scene=coordinator");
  const pill = page.getByRole("button", { name: /^Agent unavailable:/ });
  await expect(pill).toBeVisible();
  await expect(page.getByRole("button", { name: /^Work records nearly full:/ })).toBeVisible();
  await pill.click();
  const card = page.getByRole("status", { name: "Agent unavailable" });
  await expect(card).toContainText("Codex is unavailable for Coordinator.");
  const rect = (await card.boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(390);
});

test("over a pane's content a card can be minimized and reopened", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "a desktop-width pane");
  await page.goto("/floating-notices?scene=markdown");
  const card = page.getByRole("region", { name: "Raw mode only" });
  await expect(card).toContainText("Rendered mode is unavailable for this file");
  // Below the file header, so the Rendered and Raw switch stays reachable.
  const header = await box(page, "text=docs/notes.md");
  expect((await card.boundingBox())!.y).toBeGreaterThan(header.y + header.height);

  await page.getByRole("button", { name: "Minimize Raw mode only" }).click();
  await expect(card).toHaveCount(0);
  const pill = page.getByRole("button", { name: /^Raw mode only:/ });
  await expect(pill).toBeFocused();
  await pill.click();
  await expect(card).toBeVisible();
});

test("short horizontal panes keep every tall notice and its actions reachable", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "wide horizontal split");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/floating-notices?scene=short");
  const pane = page.getByTestId("constrained-pane");
  const stack = pane.locator("[data-floating-notice-stack]");
  const bounds = (await pane.boundingBox())!;
  const stackBounds = (await stack.boundingBox())!;
  expect(stackBounds.y + stackBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  expect(await stack.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  // Each card scrolls independently; the stack can also reach later cards.
  for (const label of ["First long notice", "Second long notice"]) {
    const action = page.getByRole("button", { name: `Resolve ${label}` });
    await action.scrollIntoViewIfNeeded();
    await action.click();
  }
  await expect(page.getByRole("status", { name: "Completed notice actions" })).toHaveText("2");
  const prompt = page.getByRole("status", { name: "Waiting for you", exact: true });
  await prompt.scrollIntoViewIfNeeded();
  const lastCode = prompt.getByRole("button", { name: "1A2B-3C4D" }).last();
  await lastCode.scrollIntoViewIfNeeded();
  await expect(lastCode).toBeVisible();
  await page.screenshot({ path: "output/visual-previews/notices-fixed-short-stack.png" });
});

test("128px panes contain long-label pills and their opened cards", async ({ page }) => {
  await page.goto("/floating-notices?scene=narrow");
  const pane = page.getByTestId("constrained-pane");
  const bounds = (await pane.boundingBox())!;
  for (const pill of await pane.getByRole("button").all()) {
    const rect = (await pill.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  }
  const pill = page.getByRole("button", { name: /^First long notice:/ });
  await pill.focus();
  await page.keyboard.press("Enter");
  const card = page.getByRole("region", { name: "First long notice" });
  await expect(card).toBeFocused();
  const rect = (await card.boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
  expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  await page.keyboard.press("Escape");
  await expect(pill).toBeFocused();
  await page.screenshot({ path: "output/visual-previews/notices-fixed-128px.png" });
});

test("coordinator splits keep notices in their conversation pane", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "two desktop columns");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/floating-notices?scene=coordinator-split");
  for (const id of ["first", "second"]) {
    const pane = page.locator(`[data-coordinator-pane="${id}-pane"]`);
    const pill = pane.getByRole("button", { name: `Could not start: ${id} could not start.` });
    await expect(pill).toBeVisible();
    await expect(pane.getByRole("alert", { name: "Could not start", exact: true })).toHaveCount(0);
    await pill.click();
    const card = pane.getByRole("alert", { name: "Could not start", exact: true });
    await expect(card).toContainText(`${id} failed to start`);
    const bounds = (await pane.boundingBox())!;
    const rect = (await card.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    await pane.getByRole("button", { name: "Minimize Could not start" }).click();
    await expect(pill).toBeFocused();
  }
  await page.reload();
  await expect(page.getByRole("button", { name: /^Could not start:/ })).toHaveCount(2);
  await page.screenshot({ path: "output/visual-previews/notices-fixed-coordinator-split.png" });
});

test("hidden mobile coordinator conversations keep their notices hidden", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile switcher");
  await page.goto("/floating-notices?scene=coordinator-split");
  const first = page.getByRole("button", { name: "Could not start: first could not start." });
  const second = page.getByRole("button", { name: "Could not start: second could not start." });
  await expect(first).toBeVisible();
  await expect(second).toHaveCount(0);
  const hidden = page.locator('[data-coordinator-pane="second-pane"]');
  for (const announcement of await hidden.locator("[data-floating-notice-announcement]").all()) {
    await expect(announcement).toBeHidden();
  }
  await page.getByRole("tab", { name: "2. second", exact: true }).click();
  await expect(second).toBeVisible();
  await expect(first).toHaveCount(0);
  await second.click();
  await expect(page.getByRole("alert", { name: "Could not start", exact: true })).toContainText(
    "second failed to start",
  );
  await page.getByRole("tab", { name: "1. first", exact: true }).click();
  await expect(page.getByText("second failed to start", { exact: true })).toBeHidden();
  await expect(first).toBeVisible();
  await page.reload();
  await expect(first).toBeVisible();
  await expect(second).toHaveCount(0);
  await page.screenshot({ path: "output/visual-previews/notices-fixed-coordinator-mobile.png" });
});

test("new and updated prompt and error summaries stay live while their pills are closed", async ({
  page,
}) => {
  await page.goto("/floating-notices?scene=live");
  await page.getByRole("button", { name: "Update notices" }).click();
  const status = page.getByRole("status", { name: "Notice announcement", exact: true });
  const alert = page.getByRole("alert", { name: "Notice announcement", exact: true });
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveText("Waiting for you: Sign in and enter the code");
  await expect(alert).toHaveAttribute("aria-live", "assertive");
  await expect(alert).toHaveText("Action failed: Attempt 1 failed");
  await expect(page.getByRole("button", { name: /^Waiting for you:/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByRole("button", { name: /^Action failed:/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByRole("status", { name: "Waiting for you", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Update notices" }).click();
  await expect(status).toHaveText("Waiting for you: Sign in to continue");
  await expect(alert).toHaveText("Action failed: Attempt 2 failed");
  const tree = await page.locator("main").ariaSnapshot();
  expect(tree).toContain('status "Notice announcement"');
  expect(tree).toContain('alert "Notice announcement"');
});
