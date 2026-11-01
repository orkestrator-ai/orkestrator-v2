import { expect, test } from "@playwright/test";

test("Graph Run retains its view behind another pane and centres a background selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/graph-run-flow");
  const graph = page.locator("[data-flow-viewport]");
  const level = page.getByTestId("graph-run-zoom-level");
  await expect(graph).toBeVisible();
  const mountedGraph = await graph.elementHandle();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(level).toHaveText("125%");
  await graph.evaluate((element) => {
    element.scrollLeft = 80;
  });
  await expect.poll(() => graph.evaluate((element) => element.scrollLeft)).toBe(80);
  await page.getByRole("button", { name: "Activate other pane" }).click();
  await expect(graph).toBeHidden();
  await page.getByRole("button", { name: "Activate graph pane" }).click();
  await expect(level).toHaveText("125%");
  await expect.poll(() => graph.evaluate((element) => element.scrollLeft)).toBe(80);
  expect(await graph.evaluate((element, original) => element === original, mountedGraph)).toBe(
    true,
  );

  const target = page
    .getByRole("tablist", { name: "Graph run", includeHidden: true })
    .getByRole("tab", { name: /^consolidate,/, includeHidden: true });
  const inView = () =>
    target.evaluate((element) => {
      const node = element.getBoundingClientRect();
      const viewport = element.closest("[data-flow-viewport]")!.getBoundingClientRect();
      return (
        node.left >= viewport.left &&
        node.right <= viewport.right &&
        node.top >= viewport.top &&
        node.bottom <= viewport.bottom
      );
    });
  await expect.poll(inView).toBe(false);
  const width = await graph.evaluate((element) => element.clientWidth);
  await page.getByRole("button", { name: "Activate other pane" }).click();
  await page.getByRole("button", { name: "Advance graph run" }).click();
  await expect(target).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Activate graph pane" }).click();
  await expect.poll(() => graph.evaluate((element) => element.clientWidth)).toBe(width);
  await expect(level).toHaveText("125%");
  await expect.poll(inView).toBe(true);
});

// WebKit resets a hidden scroller that holds a container query container (0860, 1080).
test("Graph Run keeps its overview scroll position behind another pane", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Short enough that the wide layout overflows too.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 560 });
  await page.goto("/graph-run-flow");
  const overview = page.getByTestId("graph-run-overview-scroll");
  await expect(page.locator("[data-flow-viewport]")).toBeVisible();
  const range = await overview.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(range).toBeGreaterThan(100);
  const offset = Math.floor(range / 2);
  await overview.evaluate((element, top) => {
    element.scrollTop = top;
  }, offset);
  await expect.poll(() => overview.evaluate((element) => element.scrollTop)).toBe(offset);
  await page.getByRole("button", { name: "Activate other pane" }).click();
  await expect(overview).toBeHidden();
  await page.getByRole("button", { name: "Activate graph pane" }).click();
  await expect(overview).toBeVisible();
  await expect.poll(() => overview.evaluate((element) => element.scrollTop)).toBe(offset);
});
