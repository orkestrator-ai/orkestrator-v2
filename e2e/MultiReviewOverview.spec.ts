import { expect, test } from "@playwright/test";

test("long reviewer failures stay contained and fully accessible", async ({ page }) => {
  await page.goto("/multi-review-overview");

  const note = page.getByTestId("multi-reviewer-note-long-error-reviewer");
  const workflowError = page.getByText("No reviewer produced a valid report", { exact: true });
  await expect(note).toBeVisible();
  await expect(note).toHaveCSS("overflow-x", "hidden");
  await expect(note).toHaveCSS("overflow-y", "auto");

  const geometry = await note.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("Missing reviewer status note");
    const card = element.closest("button");
    if (!(card instanceof HTMLElement)) throw new Error("Missing reviewer card button");
    const text = element.textContent ?? "";

    return {
      cardHeight: card.getBoundingClientRect().height,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      textLength: text.length,
      titleMatchesText: element.title === text,
    };
  });

  expect(geometry.textLength).toBeGreaterThan(4_000);
  expect(geometry.titleMatchesText).toBe(true);
  expect(geometry.clientHeight).toBeLessThanOrEqual(64);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.cardHeight).toBeLessThan(160);

  const finalScrollTop = await note.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(finalScrollTop).toBeGreaterThan(0);

  await workflowError.scrollIntoViewIfNeeded();
  await expect(workflowError).toBeInViewport();
});

test("a running tool-mode tile keeps a single status spinner", async ({ page }) => {
  await page.goto("/multi-review-running-tile");

  const preparingTile = page.getByRole("button", { name: /^Open Reviewer 1 transcript/ });
  const correctingTile = page.getByRole("button", { name: /^Open Reviewer 2 transcript/ });

  await expect(preparingTile).toBeVisible();
  await expect(preparingTile.getByText("Preparing report")).toHaveCount(0);
  await expect(preparingTile.getByTestId("workflow-result-status")).toHaveCount(0);
  await expect(preparingTile.locator(":scope > svg.animate-spin")).toHaveCount(1);
  await expect(preparingTile.locator("svg.animate-spin")).toHaveCount(1);

  await expect(correctingTile.getByText("Correcting report format")).toBeVisible();
  await expect(correctingTile.getByTestId("workflow-result-status")).toHaveAttribute(
    "data-state",
    "correcting",
  );
  await expect(correctingTile.locator(":scope > svg.animate-spin")).toHaveCount(1);
  await expect(correctingTile.locator("svg.animate-spin")).toHaveCount(2);
});
