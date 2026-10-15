import { expect, test } from "@playwright/test";

test("long reviewer failures stay contained and fully accessible", async ({ page }) => {
  await page.goto("/multi-review-overview");

  const node = page.getByRole("tab", { name: /^Reviewer 1 ·/ });
  await node.click();
  await expect(node).toHaveAttribute("aria-selected", "true");

  const note = page.getByTestId("multi-reviewer-note-long-error-reviewer");
  const workflowError = page.getByText("No reviewer produced a valid report", { exact: true });
  await expect(note).toBeVisible();
  await expect(note).toHaveCSS("overflow-x", "hidden");
  await expect(note).toHaveCSS("overflow-y", "auto");

  const geometry = await note.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("Missing reviewer status note");
    const selected = document.querySelector('[role="tab"][aria-selected="true"]');
    if (!(selected instanceof HTMLElement)) throw new Error("Missing selected reviewer node");
    const text = element.textContent ?? "";

    return {
      nodeHeight: selected.getBoundingClientRect().height,
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
  // The node itself only says "failed"; the error lives in the inspector.
  expect(geometry.nodeHeight).toBeLessThan(160);

  const finalScrollTop = await note.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(finalScrollTop).toBeGreaterThan(0);

  await workflowError.scrollIntoViewIfNeeded();
  await expect(workflowError).toBeInViewport();
});

test("a running tool-mode node keeps a single status spinner", async ({ page }) => {
  await page.goto("/multi-review-running-tile");

  const preparingNode = page.getByRole("tab", { name: /^Reviewer 1 ·/ });
  const correctingNode = page.getByRole("tab", { name: /^Reviewer 2 ·/ });

  await expect(preparingNode).toBeVisible();
  await expect(page.getByText("Preparing report")).toHaveCount(0);
  await expect(preparingNode.locator("svg.animate-spin")).toHaveCount(1);
  await expect(page.getByTestId("workflow-result-status")).toHaveCount(0);

  await expect(correctingNode.getByText("correcting report")).toBeVisible();
  await expect(correctingNode.locator("svg.animate-spin")).toHaveCount(1);
  await correctingNode.click();
  const status = page.getByTestId("multi-review-inspector").getByTestId("workflow-result-status");
  await expect(status).toHaveAttribute("data-state", "correcting");
  await expect(status).toContainText("Correcting report format");
});
