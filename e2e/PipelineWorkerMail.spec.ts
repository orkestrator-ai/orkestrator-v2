import { expect, test, type Locator, type Page } from "@playwright/test";

function tiles(page: Page): Locator {
  return page.locator("[data-mail-tile]");
}

test("a worker's stored transcript draws mail as tiles, with no envelope on screen", async ({
  page,
}) => {
  await page.goto("/pipeline-worker-mail");
  const transcript = page.getByTestId("worker-transcript");
  await expect(tiles(page)).toHaveCount(2);

  // A coordinator on another node, steered in between the worker's own updates.
  await expect(tiles(page).nth(0)).toHaveAttribute("data-mail-kind", "coordinator");
  await expect(tiles(page).nth(0)).toContainText("Project coordinator on mini");
  await expect(tiles(page).nth(0)).toContainText("Scope change");
  await expect(tiles(page).nth(0)).toContainText("Please also cover escaped quotes");
  await expect(tiles(page).nth(1)).toHaveAttribute("data-mail-kind", "message");
  await expect(tiles(page).nth(1)).toContainText("Heads up");

  // The malformed envelope is a clean line and the rest of the stage still renders.
  await expect(transcript.getByText("could not be read for display here")).toHaveCount(4);
  await expect(transcript.getByText("Done. All parser tests pass.")).toBeVisible();
  await expect(transcript).not.toContainText("orkestrator-peer-payload-json");
  await expect(transcript).not.toContainText("messageId");
  await expect(transcript).not.toContainText("not json");
  await expect(transcript).not.toContainText("Instructions for the agent");

  // A person naming the tag keeps their own bubble.
  await expect(transcript.getByText("appear in the old transcript?")).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("find reaches a tile by its body and never by the envelope's markup", async ({ page }) => {
  await page.goto("/pipeline-worker-mail");
  const tile = tiles(page).nth(0);
  await expect(tile).toHaveAttribute("data-expanded", "false");
  await tile.getByRole("button").first().focus();
  await page.keyboard.press("ControlOrMeta+f");
  const search = page.getByPlaceholder("Find in chat");

  await search.fill("The failing input");
  await expect(tile).toHaveAttribute("data-expanded", "true");
  await expect(page.getByText("1 of 1")).toBeVisible();

  for (const markup of ["payload-json", "messageId", "You are a build pipeline step"]) {
    await search.fill(markup);
    await expect(page.getByText("No results")).toBeVisible();
  }
});

test("mail and unreadable notices survive reload", async ({ page }, testInfo) => {
  await page.goto("/pipeline-worker-mail");
  await page.reload();
  await expect(tiles(page)).toHaveCount(2);
  await expect(page.getByText("could not be read for display here")).toHaveCount(4);
  await page.screenshot({
    path: `output/visual-previews/mail-repaired-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
