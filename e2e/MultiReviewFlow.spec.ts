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

async function viewportBox(page: Page): Promise<Box> {
  return page.locator("[data-flow-viewport]").evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
}

function inside(box: Box, frame: Box): boolean {
  return (
    box.x >= frame.x - 1 &&
    box.y >= frame.y - 1 &&
    box.x + box.width <= frame.x + frame.width + 1 &&
    box.y + box.height <= frame.y + frame.height + 1
  );
}

test("fits the 32-reviewer maximum and zooms within bounds", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=32");
  const viewport = page.viewportSize()!;
  test.skip(viewport.width < 960, "The stacked layout has no zoom");
  await expect(page.getByRole("tab", { name: /^Reviewer \d+ ·/ })).toHaveCount(32);
  const level = page.getByTestId("multi-review-zoom-level");
  await expect(level).toHaveText("100%");

  await page.getByRole("button", { name: "Fit the whole pipeline" }).click();
  await expect(level).not.toHaveText("100%");
  const frame = await viewportBox(page);
  const boxes = await nodeBoxes(page);
  expect(boxes).toHaveLength(35);
  for (const box of boxes) expect(inside(box, frame)).toBe(true);
  expect(overlapping(boxes)).toEqual([]);

  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  while (await zoomIn.isEnabled()) await zoomIn.click();
  await expect(level).toHaveText("200%");
  const zoomOut = page.getByRole("button", { name: "Zoom out" });
  while (await zoomOut.isEnabled()) await zoomOut.click();
  await expect(level).toHaveText("20%");
  await level.click();
  await expect(level).toHaveText("100%");
});

test("keeps the node reached from the keyboard in view at the 32-reviewer maximum", async ({
  page,
}) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=32");
  test.skip(page.viewportSize()!.width < 960, "The stacked layout scrolls the page instead");
  const selected = page.locator('[role="tab"][aria-selected="true"]');
  await selected.focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < 30; step += 1) await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveAttribute("aria-label", /^Reviewer 30 ·/);
  await expect(selected).toBeFocused();
  const box = await selected.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
  expect(inside(box, await viewportBox(page))).toBe(true);
});

test("pans the zoomed graph by dragging the canvas and with Ctrl + wheel zoom", async ({
  page,
}) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=32");
  test.skip(page.viewportSize()!.width < 960, "The stacked layout has no zoom");
  const frame = await viewportBox(page);
  const scrollTop = () =>
    page.locator("[data-flow-viewport]").evaluate((element) => element.scrollTop);
  // Drag from empty canvas below the Fix column's label.
  const start = { x: frame.x + frame.width - 60, y: frame.y + frame.height - 80 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y - 300, { steps: 5 });
  await page.mouse.up();
  expect(await scrollTop()).toBeGreaterThan(250);

  const level = page.getByTestId("multi-review-zoom-level");
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 200);
  await page.keyboard.up("Control");
  await expect(level).not.toHaveText("100%");
});

test("shows a failed reviewer's error on its node, with the whole text in a tooltip", async ({
  page,
}) => {
  await page.goto("/multi-review-flow?phase=failed&reviewers=4");
  const node = page.getByRole("tab", { name: /^Reviewer 1 ·/ });
  const excerpt = node.locator("[data-flow-node-error]");
  await expect(excerpt).toContainText("The reviewer session ended before it filed a report");
  // One line, cut to the node's width.
  expect(
    await excerpt.evaluate(
      (element) =>
        element.scrollWidth > element.clientWidth && element.getBoundingClientRect().height < 20,
    ),
  ).toBe(true);

  // From the keyboard: select the next reviewer, then arrow back onto the failed one.
  const next = page.getByRole("tab", { name: /^Reviewer 2 ·/ });
  await next.click();
  await next.focus();
  await page.keyboard.press("ArrowUp");
  await expect(node).toBeFocused();
  const tooltip = page.getByTestId("multi-review-node-error-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("(HTTP 529, overloaded)");
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
});

test("shows the selected step's transcript tail in the inspector", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=consolidating&reviewers=4");
  const selected = page.locator('[role="tab"][aria-selected="true"]');
  await expect(selected).toHaveAttribute("aria-label", /^Consolidation,/);
  const tail = page.getByRole("log", { name: "Latest consolidation activity" });
  await expect(tail).toContainText("Merging four reviewer reports");
});
