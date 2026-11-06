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
