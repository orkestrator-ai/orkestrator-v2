import { expect, test, type Page } from "@playwright/test";

const PHASES = [
  "preparing",
  "reviewing",
  "consolidating",
  "ready",
  "fixing",
  "interactive",
  "paused-prepare",
  "paused-consolidate",
  "paused-fix",
  "completed",
  "cancelled",
  "failed",
] as const;

type Box = { x: number; y: number; width: number; height: number };

async function nodeBoxes(page: Page): Promise<Box[]> {
  return page.getByRole("tab").evaluateAll((nodes) =>
    nodes.map((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

function overlapping(boxes: Box[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  boxes.forEach((a, i) =>
    boxes.slice(i + 1).forEach((b, offset) => {
      if (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      )
        pairs.push([i, i + 1 + offset]);
    }),
  );
  return pairs;
}

test("renders every phase as a pipeline without overlapping nodes", async ({ page }) => {
  for (const phase of PHASES) {
    await page.goto(`/multi-review-flow?phase=${phase}&reviewers=4`);
    const pipeline = page.getByRole("tablist", { name: "Multi Review pipeline" });
    await expect(pipeline.getByRole("tab")).toHaveCount(7);
    // Exactly one node is inspected, and the inspector names it.
    const selected = pipeline.locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(page.getByTestId("multi-review-inspector")).toHaveAttribute(
      "aria-labelledby",
      (await selected.getAttribute("id"))!,
    );
    expect(overlapping(await nodeBoxes(page)), phase).toEqual([]);
  }
});

for (const count of [1, 2, 4, 8]) {
  test(`fits a panel of ${count} reviewer${count === 1 ? "" : "s"}`, async ({ page }) => {
    await page.goto(`/multi-review-flow?phase=reviewing&reviewers=${count}`);
    await expect(page.getByRole("tab", { name: /^Reviewer \d+ ·/ })).toHaveCount(count);
    const boxes = await nodeBoxes(page);
    expect(overlapping(boxes)).toEqual([]);
    const viewport = page.viewportSize()!;
    for (const box of boxes) expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  });
}

test("shows elapsed time and tokens side by side on running nodes", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4");
  const runtime = page.getByLabel("Reviewer 2 runtime and token usage");
  await expect(runtime).toHaveText(/^\d+m \d+s · 81k tokens$/);
  const before = await runtime.textContent();
  await expect.poll(() => runtime.textContent(), { timeout: 4_000 }).not.toBe(before);
  // The long model name is truncated inside the node rather than widening it.
  const queued = page.getByRole("tab", { name: /^Reviewer 4 ·/ });
  const detail = queued.getByText(/^deepseek-v4\.1-flash/);
  expect(await detail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});

test("uses the graph at desktop width and stacks on narrow screens", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=consolidating&reviewers=4");
  const viewport = page.viewportSize()!;
  const layout = await page.locator("[data-flow-layout]").getAttribute("data-flow-layout");
  expect(layout).toBe(viewport.width < 960 ? "stacked" : "graph");
  if (layout === "stacked") {
    const boxes = await nodeBoxes(page);
    // One column, in pipeline order.
    for (let index = 1; index < boxes.length; index += 1) {
      expect(boxes[index]!.y).toBeGreaterThan(boxes[index - 1]!.y);
      expect(Math.abs(boxes[index]!.x - boxes[0]!.x)).toBeLessThanOrEqual(1);
    }
  } else {
    await expect(page.locator('path[data-edge-state="active"]')).toHaveCount(4);
  }
});

test("walks the pipeline from the keyboard", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4");
  const selected = page.locator('[role="tab"][aria-selected="true"]');
  await expect(selected).toHaveAttribute("aria-label", /^Reviewer 2 ·/);
  await selected.focus();
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveAttribute("aria-label", /^Reviewer 3 ·/);
  await expect(selected).toBeFocused();
  await page.keyboard.press("End");
  await expect(selected).toHaveAttribute("aria-label", /^Fix,/);
  await expect(
    page.getByTestId("multi-review-inspector").getByRole("heading", { level: 2 }).first(),
  ).toHaveText("Fix");
});
