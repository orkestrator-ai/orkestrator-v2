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

// One test per phase, so each page load has its own time budget: twelve in
// one test overran it under a loaded parallel run.
for (const phase of PHASES) {
  test(`renders the ${phase} phase as a pipeline without overlapping nodes`, async ({ page }) => {
    await page.goto(`/multi-review-flow?phase=${phase}&reviewers=4`);
    const pipeline = page.getByRole("tablist", { name: "Multi Review pipeline" });
    await expect(pipeline.getByRole("tab")).toHaveCount(8);
    // Exactly one node is inspected, and the inspector names it.
    const selected = pipeline.locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(page.getByTestId("multi-review-inspector")).toHaveAttribute(
      "aria-labelledby",
      (await selected.getAttribute("id"))!,
    );
    expect(overlapping(await nodeBoxes(page)), phase).toEqual([]);
  });
}

for (const count of [1, 2, 4, 8]) {
  test(`fits a panel of ${count} reviewer${count === 1 ? "" : "s"}`, async ({ page }) => {
    await page.goto(`/multi-review-flow?phase=reviewing&reviewers=${count}`);
    await expect(page.getByRole("tab", { name: /^Reviewer \d+ ·/ })).toHaveCount(count);
    const boxes = await nodeBoxes(page);
    expect(overlapping(boxes)).toEqual([]);
    const viewport = page.viewportSize()!;
    // The PR column, last, runs past the right edge rather than narrowing the rest.
    for (const box of boxes.slice(0, -1)) {
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
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

test("settles across the graph breakpoint with an 8px scrollbar gutter", async ({ page }) => {
  await page.setViewportSize({ width: 952, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=32");
  await page.addStyleTag({
    content: `
    [data-flow-viewport]::-webkit-scrollbar { width: 8px; height: 8px; }
    [data-flow-viewport] { scrollbar-gutter: stable; scrollbar-color: auto; scrollbar-width: auto; }
  `,
  });
  await expect(page.locator("[data-flow-layout]")).toHaveAttribute("data-flow-layout", "stacked");
  const outerGutter = await page
    .locator("[data-flow-layout]")
    .evaluate((element) => window.innerWidth - element.clientWidth);
  for (const width of [968, 964, 960, 959, 961, 965, 967, 958]) {
    await page.setViewportSize({ width: width + outerGutter, height: 900 });
    await expect
      .poll(() => page.locator("[data-flow-layout]").evaluate((element) => element.clientWidth))
      .toBe(width);
    await expect(page.locator("[data-flow-layout]")).toHaveAttribute(
      "data-flow-layout",
      width < 960 ? "stacked" : "graph",
    );
    if (width >= 960) {
      expect(
        await page
          .locator("[data-flow-viewport]")
          .evaluate((element) => element.getBoundingClientRect().width - element.clientWidth),
      ).toBe(8);
    }
    // Observe several paint/ResizeObserver cycles. The tablist must remain
    // mounted and the layout must stop toggling once the resize has settled.
    expect(
      await page.locator("[data-flow-layout]").evaluate(async (element) => {
        const tablist = element.querySelector('[role="tablist"]');
        let changes = 0;
        const observer = new MutationObserver(() => {
          changes += 1;
        });
        observer.observe(element, {
          attributes: true,
          attributeFilter: ["data-flow-layout"],
          childList: true,
        });
        for (let frame = 0; frame < 12; frame += 1) await new Promise(requestAnimationFrame);
        observer.disconnect();
        return changes === 0 && tablist === element.querySelector('[role="tablist"]');
      }),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
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
  await expect(selected).toHaveAttribute("aria-label", /^Pull request,/);
  await expect(
    page.getByTestId("multi-review-inspector").getByRole("heading", { level: 2 }).first(),
  ).toHaveText("Pull request");
  await page.keyboard.press("ArrowLeft");
  await expect(selected).toHaveAttribute("aria-label", /^Fix,/);
});

test("centres each new stage as far as the graph scrolls", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4");
  const viewportLocator = page.locator("[data-flow-viewport]");
  test.skip(
    await viewportLocator.evaluate((element) => element.scrollWidth <= element.clientWidth),
    "The whole pipeline fits, so nothing scrolls",
  );
  const scrollLeft = () => viewportLocator.evaluate((element) => element.scrollLeft);
  // The browser's own limit, which can differ from scrollWidth - clientWidth
  // by the reserved scrollbar gutter.
  const maxScroll = await viewportLocator.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    const max = element.scrollLeft;
    element.scrollLeft = 0;
    return max;
  });
  // The review starts at the left edge, the PR column out of view.
  expect(await scrollLeft()).toBe(0);
  await page.getByRole("tab", { name: /^Pull request,/ }).click();
  // At the far right the canvas stops at its edge rather than centring the node.
  await expect.poll(scrollLeft).toBe(maxScroll);
  await page.getByRole("tab", { name: /^Review package,/ }).click();
  await expect.poll(scrollLeft).toBe(0);
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

const isStacked = (page: Page) => page.viewportSize()!.width < 960;

/** Where nodes must be visible: the graph's viewport, or the page for the column. */
async function visibleFrame(page: Page): Promise<Box> {
  if (!isStacked(page)) return viewportBox(page);
  const { width, height } = page.viewportSize()!;
  return { x: 0, y: 0, width, height };
}

test("fits the 32-reviewer maximum and zooms within bounds", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=32");
  await expect(page.getByRole("tab", { name: /^Reviewer \d+ ·/ })).toHaveCount(32);
  const level = page.getByTestId("multi-review-zoom-level");
  await expect(level).toHaveText("100%");

  await page.getByRole("button", { name: "Fit the whole pipeline" }).click();
  await expect(level).not.toHaveText("100%");
  // Every node at once: inside the graph's viewport, or for the stacked
  // column, on the screen once Fit has brought the column's top into view.
  await expect
    .poll(async () => {
      const frame = await visibleFrame(page);
      return (await nodeBoxes(page)).every((box) => inside(box, frame));
    })
    .toBe(true);
  // Layout overflow must agree with the scaled canvas, including at Fit.
  const overflow = await page.locator("[data-flow-viewport]").evaluate((element) => ({
    x: element.scrollWidth - element.clientWidth,
    y: element.scrollHeight - element.clientHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(1);
  expect(overflow.y).toBeLessThanOrEqual(1);
  const boxes = await nodeBoxes(page);
  expect(boxes).toHaveLength(36);
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
  if (!isStacked(page)) {
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
  }
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
  expect(inside(box, await visibleFrame(page))).toBe(true);
});

test("pans the zoomed graph by dragging the canvas and with Ctrl + wheel zoom", async ({
  page,
}) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=32");
  const viewportLocator = page.locator("[data-flow-viewport]");
  const level = page.getByTestId("multi-review-zoom-level");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  if (isStacked(page)) {
    // The column fills the screen at 100%, so zoom in until it overflows sideways.
    for (let click = 0; click < 2; click += 1) {
      await page.getByRole("button", { name: "Zoom in" }).click();
    }
    await expect(level).toHaveText("200%");
    // Drag from the column's "Prepare" label, which is canvas, not a node.
    const label = await page.getByText("Prepare", { exact: true }).boundingBox();
    const start = { x: label!.x + label!.width / 2, y: label!.y + label!.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 200, start.y, { steps: 5 });
    await page.mouse.up();
    expect(await viewportLocator.evaluate((element) => element.scrollLeft)).toBeGreaterThan(150);
    // Sideways only: the page keeps vertical scrolling.
    expect(await viewportLocator.evaluate((element) => element.scrollTop)).toBe(0);
  } else {
    const frame = await viewportBox(page);
    // Drag from empty canvas below the PR column's label.
    const start = { x: frame.x + frame.width - 60, y: frame.y + frame.height - 80 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y - 300, { steps: 5 });
    await page.mouse.up();
    expect(await viewportLocator.evaluate((element) => element.scrollTop)).toBeGreaterThan(250);
  }

  const before = await level.textContent();
  const frame = await viewportBox(page);
  await page.mouse.move(frame.x + frame.width / 2, frame.y + Math.min(frame.height, 400) / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 200);
  await page.keyboard.up("Control");
  await expect(level).not.toHaveText(before!);
});

test("a two-finger pinch zooms the stacked column on touch", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=8");
  test.skip(!isStacked(page), "The touch project uses the stacked layout");
  const level = page.getByTestId("multi-review-zoom-level");
  await expect(level).toHaveText("100%");
  const pinch = (from: [number, number], to: [number, number]) =>
    page.locator("[data-flow-viewport]").evaluate(
      (element, [start, end]) => {
        const touches = (spread: [number, number]) =>
          spread.map(
            (x, index) =>
              new Touch({ identifier: index + 1, target: element, clientX: x, clientY: 300 }),
          );
        const send = (type: string, list: Touch[]) =>
          element.dispatchEvent(
            new TouchEvent(type, { touches: list, bubbles: true, cancelable: true }),
          );
        send("touchstart", touches(start));
        const moved = !send("touchmove", touches(end));
        send("touchend", []);
        return moved;
      },
      [from, to] as const,
    );
  // Fingers spread to twice the distance: twice the zoom, and the page itself
  // is not zoomed (the move was taken).
  expect(await pinch([150, 250], [100, 300])).toBe(true);
  await expect(level).toHaveText("200%");
  expect(await pinch([100, 300], [150, 250])).toBe(true);
  await expect(level).toHaveText("100%");
});

test("the stacked zoom controls are full-size touch targets", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4");
  test.skip(!isStacked(page), "The wide graph's controls are sized for a fine pointer");
  const controls = page.getByRole("group", { name: "Zoom" });
  await expect(controls.getByRole("button")).toHaveCount(5);
  for (const button of await controls.getByRole("button").all()) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  // Inside the screen, and still in reach after the page scrolls past the top.
  const { width } = page.viewportSize()!;
  const groupBox = (await controls.boundingBox())!;
  expect(groupBox.x + groupBox.width).toBeLessThanOrEqual(width);
});

test("fullscreen covers its tab and keeps Fit and scrolling usable", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=8&paneControls");
  // The overlay covers the tab root, including its header and inspector.
  const root = page.getByTestId("review-pane");
  const rootBox = (await root.boundingBox())!;
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  const overlay = page.locator("[data-flow-fullscreen]");
  await expect(overlay).toBeVisible();
  await expect
    .poll(async () => {
      const box = (await overlay.boundingBox())!;
      return Math.max(
        ...(["x", "y", "width", "height"] as const).map((key) => Math.abs(box[key] - rootBox[key])),
      );
    })
    .toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Fit the whole pipeline" }).click();
  const frame = (await overlay.boundingBox())!;
  for (const box of await nodeBoxes(page)) {
    expect(box.y).toBeGreaterThanOrEqual(frame.y);
    expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
  }
  if (isStacked(page)) {
    await page.getByTestId("multi-review-zoom-level").click();
    await overlay.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => overlay.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Exit fullscreen" })).toBeInViewport();
    await page.getByRole("button", { name: "Fit the whole pipeline" }).click();
    await expect.poll(() => overlay.evaluate((element) => element.scrollTop)).toBe(0);
  }
  await page.getByRole("button", { name: "Exit fullscreen" }).press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fullscreen", exact: true })).toBeFocused();
});

test("fullscreen leaves Escape to another pane, an inactive tab and an open context menu", async ({
  page,
}) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4&paneControls");
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  const overlay = page.locator("[data-flow-fullscreen]");
  const outside = page.getByRole("textbox", { name: "Other pane input" });
  const escapeUnconsumed = () =>
    outside.evaluate((element) => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      return !event.defaultPrevented;
    });
  await outside.focus();
  expect(await escapeUnconsumed()).toBe(true);
  await expect(overlay).toBeVisible();
  await page.getByRole("button", { name: "Activate other pane" }).click();
  expect(await escapeUnconsumed()).toBe(true);
  await expect(overlay).toHaveCount(1);
  await page.getByRole("button", { name: "Activate review pane" }).click();
  await expect(overlay).toBeVisible();
  await page.getByRole("tab", { name: /^Reviewer 1 ·/ }).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(overlay).toBeVisible();
  await page.getByRole("button", { name: "Exit fullscreen" }).press("Escape");
  await expect(overlay).toHaveCount(0);
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

test("shows each queued reviewer's place in the admission queue", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=8");
  await expect(page.getByRole("tab", { name: /^Reviewer 4 ·/ })).toContainText("starting");
  await expect(page.getByRole("tab", { name: /^Reviewer 5 ·/ })).toContainText("queued · #1 of 4");
  await expect(page.getByRole("tab", { name: /^Reviewer 8 ·/ })).toContainText("queued · #4 of 4");
  expect(overlapping(await nodeBoxes(page))).toEqual([]);
});

test("marks findings a running reviewer reported as provisional", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4");
  const count = page.getByTestId("multi-review-findings-count");
  await expect(count).toContainText("provisional");
  const row = page.getByRole("listitem").filter({ hasText: "Zoom level label reads 99%" });
  await expect(row.getByTestId("multi-review-finding-standing")).toHaveText("provisional");
  // A finding a completed report already has stays confirmed.
  const confirmed = page
    .getByRole("listitem")
    .filter({ hasText: "Paused prepare step never clears validation stop flag" });
  await expect(confirmed.getByTestId("multi-review-finding-standing")).toHaveCount(0);
});

for (const phase of ["ready", "interactive", "reviewing", "consolidating"]) {
  test(`a retained clean-review PR notice reflects the current ${phase} snapshot after reload`, async ({
    page,
  }) => {
    await page.goto("/multi-review-flow?phase=ready&cleanReviewPr&cleanReport");
    await expect(page.getByTestId("multi-review-auto-pr-notice")).toContainText(
      "The review found nothing to fix",
    );
    await page.goto(`/multi-review-flow?phase=${phase}&cleanReviewPr`);
    await expect(page.getByRole("tablist", { name: "Multi Review pipeline" })).toBeVisible();
    await expect(page.getByTestId("multi-review-auto-pr-notice")).toHaveCount(0);
    const assertCurrentReview = async () => {
      const pr = page.getByRole("tab", { name: /^Pull request,/ });
      await expect(pr).toHaveAttribute("data-flow-state", "not-started");
      await expect(pr).toHaveAttribute("aria-selected", "false");
      const edge = page.locator('[data-flow-edge="into-pr"]');
      await expect(edge).toHaveAttribute("data-edge-state", "pending");
      if (await page.locator('[data-flow-layout="graph"]').count()) {
        const right = await page
          .locator('[data-flow-node="fix"]')
          .evaluate(
            (node: HTMLElement) => parseFloat(node.style.left) + parseFloat(node.style.width),
          );
        expect(await edge.getAttribute("d")).toMatch(new RegExp(`^M${right} `));
      }
      await pr.click();
      await expect(page.getByTestId("multi-review-inspector")).not.toContainText(
        "The review found nothing to fix",
      );
      await expect(page.getByTestId("multi-review-inspector")).toContainText("earlier review");
    };
    await assertCurrentReview();
    await page.reload();
    await expect(page.getByRole("tablist", { name: "Multi Review pipeline" })).toBeVisible();
    await expect(page.getByTestId("multi-review-auto-pr-notice")).toHaveCount(0);
    await assertCurrentReview();
  });
}
