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

function pipeline(page: Page) {
  return page.getByRole("tablist", { name: "Multi Review pipeline" });
}

async function nodeBoxes(page: Page): Promise<Box[]> {
  return pipeline(page)
    .getByRole("tab")
    .evaluateAll((nodes) =>
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

/** Each node's face rows by name, and whether its title is cut short. */
async function faces(page: Page) {
  return pipeline(page)
    .getByRole("tab")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const title = node.querySelector<HTMLElement>("[data-flow-node-title]")!;
        const rows = [...node.querySelectorAll<HTMLElement>("[data-flow-node-row]")];
        return {
          name: node.getAttribute("aria-label")!.split(",")[0]!,
          state: node.getAttribute("data-flow-state"),
          rows: rows.map((row) => row.getAttribute("data-flow-node-row")),
          rowsInOrder: rows.every(
            (row, index) =>
              index === 0 ||
              row.getBoundingClientRect().top >=
                rows[index - 1]!.getBoundingClientRect().bottom - 0.5,
          ),
          titleTruncated: title.scrollWidth > title.clientWidth,
        };
      }),
    );
}

test("puts a running node's elapsed time and tokens on its own third row", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4");
  const runtime = page.getByLabel("Reviewer 2 runtime and token usage");
  await expect(runtime).toHaveText(/^\d+m \d+s · 81k tokens$/);
  const before = await runtime.textContent();
  await expect.poll(() => runtime.textContent(), { timeout: 4_000 }).not.toBe(before);
  const reviewer = page.getByRole("tab", { name: /^Reviewer 2 ·/ });
  await expect(reviewer.locator('[data-flow-node-row="runtime"]')).toContainText("reviewing");
  await expect(reviewer.locator('[data-flow-node-row="title"]')).toHaveText(/^Reviewer 2 · \w+$/);
  for (const face of await faces(page)) {
    // Running nodes have three rows; queued ones two; none loses its title.
    if (face.state === "running")
      expect(face.rows, face.name).toEqual(["title", "detail", "runtime"]);
    if (face.state === "not-started") expect(face.rows, face.name).toEqual(["title", "detail"]);
    expect(face.rowsInOrder, face.name).toBe(true);
    expect(face.titleTruncated, face.name).toBe(false);
  }
  expect(overlapping(await nodeBoxes(page))).toEqual([]);
  if (page.viewportSize()!.width >= 960) {
    // Edges still meet each node, tall or short, at its vertical centre.
    const misses = await pipeline(page).evaluate((canvas) => {
      const origin = canvas.getBoundingClientRect();
      const rects = [...canvas.querySelectorAll('[role="tab"]')].map((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left - origin.left,
          right: box.right - origin.left,
          centre: box.top - origin.top + box.height / 2,
        };
      });
      const near = (a: number, b: number) => Math.abs(a - b) <= 1;
      return [...canvas.querySelectorAll<SVGPathElement>("path[data-flow-edge]")].flatMap(
        (path) => {
          const numbers = (path.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)!.map(Number);
          const [x2, y2] = numbers.slice(-2);
          const startMet = rects.some(
            (rect) => near(rect.right, numbers[0]!) && near(rect.centre, numbers[1]!),
          );
          const endMet = rects.some((rect) => near(rect.left, x2!) && near(rect.centre, y2!));
          return startMet && endMet ? [] : [path.dataset.flowEdge];
        },
      );
    });
    expect(misses).toEqual([]);
  }
  // The long model name is truncated inside the node rather than widening it.
  const queued = page.getByRole("tab", { name: /^Reviewer 4 ·/ });
  const detail = queued.getByText(/^deepseek-v4\.1-flash/);
  expect(await detail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // Its whole text is in the tooltip.
  expect(await detail.getAttribute("title")).toBe(await detail.textContent());
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
  const selected = pipeline(page).getByRole("tab", { selected: true });
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

test("scrolls the 32-reviewer maximum and zooms within bounds", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=32");
  await expect(page.getByRole("tab", { name: /^Reviewer \d+ ·/ })).toHaveCount(32);
  const controls = page.getByRole("group", { name: "Zoom" });
  await expect(controls.getByRole("button")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Fit the whole pipeline" })).toHaveCount(0);
  const level = page.getByTestId("multi-review-zoom-level");
  await expect(level).toHaveText("100%");
  const boxes = await nodeBoxes(page);
  expect(boxes).toHaveLength(36);
  expect(overlapping(boxes)).toEqual([]);
  await page.getByRole("tab", { name: /^Reviewer 32 ·/ }).click();
  const selectedBox = (await page.getByRole("tab", { name: /^Reviewer 32 ·/ }).boundingBox())!;
  expect(inside(selectedBox, await visibleFrame(page))).toBe(true);

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
  const selected = pipeline(page).getByRole("tab", { selected: true });
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

test("a two-finger pinch zooms the stacked column on touch", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Desktop WebKit has no Touch constructor to build the pinch");
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

// Synthetic, so it pins the handler rather than proving a real trackpad or
// iOS Safari (0029 task 5).
test("a Safari gesture pinch zooms the graph and is kept from the page", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=8");
  const level = page.getByTestId("multi-review-zoom-level");
  await expect(level).toHaveText("100%");
  const gesture = (scale: number) =>
    page.locator("[data-flow-viewport]").evaluate((element, scale) => {
      const { left, top } = element.getBoundingClientRect();
      const send = (type: string, eventScale: number) =>
        element.dispatchEvent(
          Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
            scale: eventScale,
            clientX: left + 40,
            clientY: top + 40,
          }),
        );
      // Both must be cancelled, or Safari zooms the whole page instead.
      const taken = [!send("gesturestart", 1), !send("gesturechange", scale)];
      send("gestureend", scale);
      return taken;
    }, scale);
  expect(await gesture(2)).toEqual([true, true]);
  await expect(level).toHaveText("200%");
  // A gesture's scale is relative to the zoom it started at.
  expect(await gesture(0.5)).toEqual([true, true]);
  await expect(level).toHaveText("100%");
});

test("the stacked zoom controls are full-size touch targets", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4");
  test.skip(!isStacked(page), "The wide graph's controls are sized for a fine pointer");
  const controls = page.getByRole("group", { name: "Zoom" });
  await expect(controls.getByRole("button")).toHaveCount(4);
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

test("fullscreen covers its tab and keeps zoom and scrolling usable", async ({ page }) => {
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
  const level = page.getByTestId("multi-review-zoom-level");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(level).toHaveText("125%");
  await level.click();
  await expect(level).toHaveText("100%");
  if (isStacked(page)) {
    await overlay.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => overlay.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Exit fullscreen" })).toBeInViewport();
  } else {
    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    while (await zoomIn.isEnabled()) await zoomIn.click();
    await expect(level).toHaveText("200%");
    const viewport = page.locator("[data-flow-viewport]");
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
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

test("the wide graph keeps its zoom and pan while another pane is shown", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=8&paneControls");
  const level = page.getByTestId("multi-review-zoom-level");
  const graph = page.locator("[data-flow-viewport]");
  const pan = () => graph.evaluate((element) => [element.scrollLeft, element.scrollTop]);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(level).toHaveText("150%");
  await expect.poll(() => graph.evaluate((element) => element.scrollHeight)).toBeGreaterThan(1000);
  await graph.evaluate((element) => {
    element.scrollLeft = 120;
    element.scrollTop = 40;
  });
  await expect.poll(pan).toEqual([120, 40]);
  await page.getByRole("button", { name: "Activate other pane" }).click();
  await expect(graph).toBeHidden();
  await page.getByRole("button", { name: "Activate review pane" }).click();
  await expect(level).toHaveText("150%");
  await expect.poll(pan).toEqual([120, 40]);
});

test("centres a stage selected behind another pane when shown at the same width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=8&paneControls");
  const graph = page.locator("[data-flow-viewport]");
  const selected = page.locator('[data-flow-node="consolidation"]');
  const insideGraph = () =>
    selected.evaluate((element) => {
      const node = element.getBoundingClientRect();
      const viewport = element.closest("[data-flow-viewport]")!.getBoundingClientRect();
      return (
        node.left >= viewport.left &&
        node.right <= viewport.right &&
        node.top >= viewport.top &&
        node.bottom <= viewport.bottom
      );
    });
  await expect(graph).toBeVisible();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByTestId("multi-review-zoom-level")).toHaveText("150%");
  await graph.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect.poll(insideGraph).toBe(false);
  const width = await graph.evaluate((element) => element.clientWidth);
  await page.getByRole("button", { name: "Activate other pane" }).click();
  await expect(graph).toBeHidden();
  await page.getByRole("button", { name: "Advance to consolidation" }).click();
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Activate review pane" }).click();
  await expect.poll(() => graph.evaluate((element) => element.clientWidth)).toBe(width);
  await expect.poll(insideGraph).toBe(true);
});

for (const widths of [
  [1200, 390],
  [390, 1200],
]) {
  test(`adopts a hidden resize from ${widths[0]} to ${widths[1]} across the graph breakpoint`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: widths[0]!, height: 1000 });
    await page.goto("/multi-review-flow?phase=reviewing&reviewers=8&paneControls");
    const layout = () => page.locator("[data-flow-layout]").getAttribute("data-flow-layout");
    const before = widths[0]! < 960 ? "stacked" : "graph";
    const after = widths[1]! < 960 ? "stacked" : "graph";
    await expect.poll(layout).toBe(before);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(page.getByTestId("multi-review-zoom-level")).toHaveText("125%");
    const graph = page.locator("[data-flow-viewport]");
    await graph.evaluate((element) => {
      element.scrollLeft = 40;
    });
    await expect.poll(() => graph.evaluate((element) => element.scrollLeft)).toBe(40);
    await page.getByRole("button", { name: "Activate other pane" }).click();
    await page.setViewportSize({ width: widths[1]!, height: 1000 });
    await expect.poll(layout).toBe(before);
    await page.getByRole("button", { name: "Activate review pane" }).click();
    await expect.poll(layout).toBe(after);
    await expect(page.getByTestId("multi-review-zoom-level")).toHaveText("100%");
    await expect.poll(() => graph.evaluate((element) => element.clientWidth)).toBeGreaterThan(0);
    const shownWidth = await graph.evaluate((element) => element.clientWidth);
    expect(shownWidth).toBeLessThanOrEqual(widths[1]!);
    expect(shownWidth).toBeGreaterThan(widths[1]! - 100);
    await expect.poll(() => graph.evaluate((element) => element.scrollLeft)).toBe(0);
    // Return to the original layout at a fresh width: its old zoom/pan must reset too.
    await page.getByRole("button", { name: "Activate other pane" }).click();
    await page.setViewportSize({ width: widths[0]! + 50, height: 1000 });
    await page.getByRole("button", { name: "Activate review pane" }).click();
    await expect.poll(layout).toBe(before);
    await expect(page.getByTestId("multi-review-zoom-level")).toHaveText("100%");
    const viewport = page.locator("[data-flow-viewport]");
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(0);
  });
}

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
  const selected = pipeline(page).getByRole("tab", { selected: true });
  await expect(selected).toHaveAttribute("aria-label", /^Consolidation,/);
  const tail = page.getByRole("log", { name: "Latest consolidation activity" });
  await expect(tail).toContainText("Merging four reviewer reports");
});

test("the transcript tail fills the inspector down to the footer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/multi-review-flow?phase=consolidating&reviewers=4");
  const tail = page.getByRole("log", { name: "Latest consolidation activity" });
  await expect(tail).toContainText("Merging four reviewer reports");
  const footer = page.getByRole("button", { name: "Cancel" }).locator("xpath=..");
  const tailBox = (await tail.boundingBox())!;
  const footerBox = (await footer.boundingBox())!;
  // Only the inspector's bottom padding sits between them.
  const gap = footerBox.y - (tailBox.y + tailBox.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(24);
  await page.screenshot({ path: "output/playwright/multi-review-tail-fill.png" });
});

test("a completed overflowing transcript follows pane resizing until the reader scrolls up", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1800 });
  await page.goto("/multi-review-flow?phase=consolidating&longTranscript");
  await page.getByRole("tab", { name: /^Reviewer 1 ·/ }).click();
  const tail = page.getByTestId("multi-review-transcript-tail");
  await expect(tail).toContainText("Transcript entry 40.");
  await expect(tail).not.toContainText("Working…");
  const bottomGap = () =>
    tail.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  const height = () => tail.evaluate((element) => element.clientHeight);
  const scrollTop = () => tail.evaluate((element) => element.scrollTop);
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  expect(await tail.evaluate((element) => element.scrollHeight)).toBeGreaterThan(await height());
  const initialHeight = await height();
  await page.setViewportSize({ width: 1280, height: 1500 });
  await expect.poll(height).toBeLessThan(initialHeight);
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);

  // Real wheel input scrolls only the log, leaving the overview in place.
  await tail.scrollIntoViewIfNeeded();
  const overview = page.getByTestId("multi-review-overview-scroll");
  const overviewTop = await overview.evaluate((element) => element.scrollTop);
  const beforeWheel = await scrollTop();
  await tail.hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(scrollTop).toBeLessThan(beforeWheel - 100);
  const readingTop = await scrollTop();
  const readingHeight = await height();
  await page.setViewportSize({ width: 1280, height: 1200 });
  await expect.poll(height).toBeLessThan(readingHeight);
  await expect.poll(scrollTop).toBe(readingTop);
  expect(await bottomGap()).toBeGreaterThan(100);
  expect(await overview.evaluate((element) => element.scrollTop)).toBe(overviewTop);

  await page.mouse.wheel(0, 100_000);
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  expect(await overview.evaluate((element) => element.scrollTop)).toBe(overviewTop);
  const followingHeight = await height();
  await page.setViewportSize({ width: 1280, height: 1050 });
  await expect.poll(height).toBeLessThan(followingHeight);
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
});

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
  { width: 1024, height: 600 },
]) {
  test(`inspector grid contains the tail and report at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/multi-review-flow?phase=ready&longTranscript");
    await page.getByRole("tab", { name: /^Reviewer 1 ·/ }).click();
    const inspector = page.getByTestId("multi-review-inspector");
    const tail = page.getByTestId("multi-review-transcript-tail");
    await expect(tail).toContainText("Transcript entry 40.");
    const overview = page.getByTestId("multi-review-overview-scroll");
    // Return to the inspector's start so the badge has not stuck over its body.
    await overview.evaluate((element) => {
      const panel = element.querySelector('[data-testid="multi-review-inspector"]')!;
      element.scrollTop +=
        panel.getBoundingClientRect().top - element.getBoundingClientRect().top - 16;
    });
    const badge = page.getByTestId("multi-review-findings-badge");
    const header = inspector.getByRole("heading", { level: 2 }).first().locator("xpath=..");
    const body = inspector.locator(":scope > div").nth(1);
    const badgeBox = (await badge.boundingBox())!;
    const headerBox = (await header.boundingBox())!;
    expect(overlapping([badgeBox, headerBox])).toEqual([]);
    expect(badgeBox.y).toBeLessThan(headerBox.y + headerBox.height);
    expect(badgeBox.y + badgeBox.height).toBeLessThanOrEqual((await body.boundingBox())!.y + 1);
    const tailBox = (await tail.boundingBox())!;
    expect(tailBox.height).toBeGreaterThanOrEqual(448);
    expect(inside(tailBox, (await inspector.boundingBox())!)).toBe(true);
    expect(tailBox.x).toBeGreaterThanOrEqual(0);
    expect(tailBox.x + tailBox.width).toBeLessThanOrEqual(viewport.width);
    // The consolidated report belongs to Consolidation's Report view.
    await pipeline(page)
      .getByRole("tab", { name: /^Consolidation,/ })
      .click();
    await inspector
      .getByRole("tablist", { name: "Inspector views" })
      .getByRole("tab", { name: "Report", exact: true })
      .click();
    await expect(inspector.getByRole("log")).toHaveCount(0);
    const article = inspector.getByRole("article", { name: "Consolidated Multi Review" });
    const report = article.getByRole("heading", { name: "Consolidated Multi Review", exact: true });
    await expect(report).toBeVisible();
    const reportBox = (await article.boundingBox())!;
    expect(inside(reportBox, (await inspector.boundingBox())!)).toBe(true);
    expect(reportBox.x).toBeGreaterThanOrEqual(0);
    expect(reportBox.x + reportBox.width).toBeLessThanOrEqual(viewport.width);
    expect(await overview.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await report.scrollIntoViewIfNeeded();
    await expect(report).toBeInViewport();
    await expect(badge).toBeInViewport();
    await page.screenshot({
      path: `output/playwright/multi-review-report-${viewport.width}x${viewport.height}.png`,
    });
  });
}

test("inspector report content and selected views belong to each pipeline node", async ({
  page,
}) => {
  await page.goto("/multi-review-flow?phase=ready");
  const inspector = page.getByTestId("multi-review-inspector");
  const views = inspector.getByRole("tablist", { name: "Inspector views" });
  const transcript = views.getByRole("tab", { name: "Transcript", exact: true });
  const report = views.getByRole("tab", { name: "Report", exact: true });

  await pipeline(page)
    .getByRole("tab", { name: /^Reviewer 1 ·/ })
    .click();
  await expect(transcript).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByRole("article")).toHaveCount(0);
  await report.click();
  const reviewerReport = inspector.getByRole("article", { name: "Reviewer report" });
  await expect(reviewerReport).toBeVisible();
  await reviewerReport.getByRole("button", { name: "Issues · 3", exact: true }).click();
  await expect(reviewerReport).toContainText("Restart resets runtime for shared fix session");
  await expect(reviewerReport).not.toContainText("Consolidation drops coverage gaps");

  await pipeline(page)
    .getByRole("tab", { name: /^Consolidation,/ })
    .click();
  await expect(transcript).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByRole("log")).toContainText("Merging four reviewer reports");
  await report.click();
  const consolidated = inspector.getByRole("article", { name: "Consolidated Multi Review" });
  await expect(consolidated).toBeVisible();
  await consolidated.getByRole("button", { name: /^Issues ·/ }).click();
  await expect(consolidated).toContainText(
    "Consolidation drops coverage gaps from stopped reviewers",
  );

  await pipeline(page)
    .getByRole("tab", { name: /^Reviewer 1 ·/ })
    .click();
  await expect(report).toHaveAttribute("aria-selected", "true");
  await expect(reviewerReport).toBeVisible();
  await transcript.click();
  await pipeline(page)
    .getByRole("tab", { name: /^Reviewer 2 ·/ })
    .click();
  await expect(transcript).toHaveAttribute("aria-selected", "true");
  await pipeline(page)
    .getByRole("tab", { name: /^Consolidation,/ })
    .click();
  await expect(report).toHaveAttribute("aria-selected", "true");
  await expect(consolidated).toBeVisible();
  await pipeline(page)
    .getByRole("tab", { name: /^Reviewer 1 ·/ })
    .click();
  await expect(transcript).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByRole("log")).toBeVisible();
});

test("an overflowing transcript keeps its reading position and follow mode behind Report", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/multi-review-flow?phase=ready&longTranscript&transcriptControls");
  await pipeline(page)
    .getByRole("tab", { name: /^Reviewer 1 ·/ })
    .click();
  const inspector = page.getByTestId("multi-review-inspector");
  const views = inspector.getByRole("tablist", { name: "Inspector views" });
  const tail = inspector.getByTestId("multi-review-transcript-tail");
  const bottomGap = () =>
    tail.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  const scrollTop = () => tail.evaluate((element) => element.scrollTop);
  const append = page.getByRole("button", { name: "Append transcript entry" });
  await expect(tail).toContainText("Transcript entry 32.");
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  expect(await scrollTop()).toBeGreaterThan(300);
  const mountedTail = await tail.elementHandle();

  // Following survives a hide/show, including an authoritative update while hidden.
  await views.getByRole("tab", { name: "Report", exact: true }).click();
  await expect(tail).toBeHidden();
  await append.click();
  await expect(tail).toContainText("Transcript entry 33.");
  await views.getByRole("tab", { name: "Transcript", exact: true }).click();
  expect(await tail.evaluate((element, original) => element === original, mountedTail)).toBe(true);
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);

  await tail.scrollIntoViewIfNeeded();
  await tail.hover();
  const beforeWheel = await scrollTop();
  await page.mouse.wheel(0, -300);
  await expect.poll(scrollTop).toBeLessThan(beforeWheel - 100);
  const readingTop = await scrollTop();
  await views.getByRole("tab", { name: "Report", exact: true }).click();
  await views.getByRole("tab", { name: "Transcript", exact: true }).click();
  await expect.poll(scrollTop).toBe(readingTop);

  // New output behind Report must not turn following back on for a reader.
  await views.getByRole("tab", { name: "Report", exact: true }).click();
  await append.click();
  await expect(tail).toContainText("Transcript entry 34.");
  await views.getByRole("tab", { name: "Transcript", exact: true }).click();
  await expect.poll(scrollTop).toBe(readingTop);
  expect(await bottomGap()).toBeGreaterThan(100);

  // Returning to the bottom explicitly resumes following new hidden output.
  await tail.scrollIntoViewIfNeeded();
  await tail.hover();
  await page.mouse.wheel(0, 100_000);
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  await views.getByRole("tab", { name: "Report", exact: true }).click();
  await append.click();
  await expect(tail).toContainText("Transcript entry 35.");
  await views.getByRole("tab", { name: "Transcript", exact: true }).click();
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
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
  await page.getByTestId("multi-review-findings-badge").click();
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

test("findings stay reachable, fit the viewport and scroll internally", async ({ page }) => {
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4&manyFindings&paneControls");
  const badge = page.getByTestId("multi-review-findings-badge");
  const panel = page.getByTestId("multi-review-findings");
  await badge.scrollIntoViewIfNeeded();
  await expect(badge).toBeInViewport();
  const inspector = page.getByTestId("multi-review-inspector");
  const header = inspector.getByRole("heading", { level: 2 }).first();
  const badgeBox = (await badge.boundingBox())!;
  expect(overlapping([badgeBox, (await header.boundingBox())!])).toEqual([]);
  await badge.click();
  await expect(panel).toBeInViewport();
  const { width, height } = page.viewportSize()!;
  expect(inside((await panel.boundingBox())!, { x: 0, y: 0, width, height })).toBe(true);
  const list = panel.getByRole("list");
  await expect(panel.getByRole("listitem")).toHaveCount(41);
  await list.hover();
  const pageScroll = await badge.evaluate((element) => {
    let parent = element.parentElement;
    while (parent && parent.scrollHeight <= parent.clientHeight) parent = parent.parentElement;
    return parent?.scrollTop ?? 0;
  });
  await page.mouse.wheel(0, 10_000);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(panel.getByText("Additional finding 35", { exact: true })).toBeInViewport();
  expect(
    await badge.evaluate((element) => {
      let parent = element.parentElement;
      while (parent && parent.scrollHeight <= parent.clientHeight) parent = parent.parentElement;
      return parent?.scrollTop ?? 0;
    }),
  ).toBe(pageScroll);
  await panel.click({ position: { x: 10, y: 10 } });
  await expect(panel).toBeVisible();
  await badge.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(badge).toBeFocused();
  await badge.click();
  await header.click();
  await expect(panel).toHaveCount(0);
  await badge.click();
  const outside = page.getByRole("textbox", { name: "Other pane input" });
  expect(
    await outside.evaluate((element) => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await expect(panel).toBeVisible();
  const overview = page.getByTestId("multi-review-overview-scroll");
  const overviewTop = () => overview.evaluate((element) => element.scrollTop);
  await overview.evaluate((element) => {
    element.scrollTop = 120;
  });
  await expect.poll(overviewTop).toBeGreaterThan(0);
  const readingTop = await overviewTop();
  await page.getByRole("button", { name: "Activate other pane" }).click();
  await page.getByRole("button", { name: "Activate review pane" }).click();
  await expect(panel).toHaveCount(0);
  // Another pane taking over leaves the reader where they were.
  await expect.poll(overviewTop).toBe(readingTop);
  // Sticky positioning keeps the badge in view at the very end of the scroll.
  // Only the stacked column is tall enough to carry it up to its sticky offset.
  await overview.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(badge).toBeInViewport();
  if (isStacked(page)) {
    await expect
      .poll(async () => (await badge.boundingBox())!.y - (await overview.boundingBox())!.y)
      .toBeCloseTo(12, 0);
  }
});

for (const scale of [0.75, 1, 1.5]) {
  test(`divider follows a captured mouse at ${scale * 100}% application CSS zoom`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1800, height: 1400 });
    await page.goto("/multi-review-flow?phase=reviewing&reviewers=4");
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom);
    }, scale);
    const divider = page.getByRole("separator", { name: "Resize graph" });
    await expect(divider).toBeVisible();
    const before = Number(await divider.getAttribute("aria-valuenow"));
    const box = (await divider.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(divider).toBeFocused();
    // One jump beyond the original hit area exercises native pointer capture.
    await page.mouse.move(x, y + 90);
    await expect(divider).toHaveAttribute("aria-valuenow", String(before + Math.round(90 / scale)));
    const moved = (await divider.boundingBox())!;
    expect(Math.abs(moved.y - box.y - 90)).toBeLessThanOrEqual(1);
    await page.mouse.up();
    await page.reload();
    await expect(page.getByRole("separator", { name: "Resize graph" })).toHaveAttribute(
      "aria-valuenow",
      String(before + Math.round(90 / scale)),
    );
    await page.getByRole("separator", { name: "Resize graph" }).press("Enter");
    await page.reload();
    await expect(page.getByRole("separator", { name: "Resize graph" })).toHaveAttribute(
      "aria-valuenow",
      String(before),
    );
  });
}

test("a divider click keeps automatic sizing and supports keyboard resizing without tabbing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4");
  const divider = page.getByRole("separator", { name: "Resize graph" });
  const before = Number(await divider.getAttribute("aria-valuenow"));
  await divider.click();
  await expect(divider).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(divider).toHaveAttribute("aria-valuenow", String(before - 16));
  await page.keyboard.press("Enter");
  await divider.click();
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=8");
  await expect(page.getByRole("separator", { name: "Resize graph" })).not.toHaveAttribute(
    "aria-valuenow",
    String(before),
  );
});

test("touch resize captures the finger beyond the handle and prevents page panning", async ({
  page,
  context,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "chromium", "Requires Chromium CDP touch input");
  test.skip(testInfo.project.name !== "mobile-chromium", "Requires native touch input");
  // A tablet-sized touch client uses the wide graph and its divider.
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.goto("/multi-review-flow?phase=reviewing&reviewers=4");
  const divider = page.getByRole("separator", { name: "Resize graph" });
  const before = Number(await divider.getAttribute("aria-valuenow"));
  const box = (await divider.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const scrollY = await page.evaluate(() => window.scrollY);
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + 80, id: 1 }],
    });
    await expect(divider).toHaveAttribute("aria-valuenow", String(before + 80));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await page.reload();
    await expect(page.getByRole("separator", { name: "Resize graph" })).toHaveAttribute(
      "aria-valuenow",
      String(before + 80),
    );
  } finally {
    await cdp.detach();
  }
});
