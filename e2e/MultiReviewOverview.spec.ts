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
