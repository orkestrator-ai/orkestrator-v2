import { expect, test, type Page } from "@playwright/test";

/**
 * Returns the widest overflow of any header child past the header's own box.
 * A positive number means something is being clipped or overlapped.
 */
async function headerOverflow(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector("[data-testid='diff-viewer-pane'] > div > div");
    if (!(header instanceof HTMLElement)) throw new Error("Missing diff header");

    const headerBox = header.getBoundingClientRect();
    const overflows = Array.from(header.querySelectorAll("*")).map((child) => {
      const box = child.getBoundingClientRect();
      return Math.max(box.right - headerBox.right, headerBox.left - box.left);
    });

    return {
      headerWidth: headerBox.width,
      worstOverflow: Math.max(0, ...overflows),
    };
  });
}

test("the diff header fits a phone and the editor uses the full width", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "this asserts the phone layout",
  );
  await page.goto("/diff-viewer");

  const pane = page.getByTestId("diff-viewer-pane");
  await expect(pane.locator(".monaco-diff-editor")).toBeVisible();

  // Side-by-side is unusable at this width, so the toggle is gone and the
  // remaining control has room.
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Inline" })).toHaveCount(0);
  await expect(page.getByTitle("View file")).toBeVisible();

  const { headerWidth, worstOverflow } = await headerOverflow(page);
  expect(headerWidth).toBeLessThanOrEqual(390);
  expect(worstOverflow).toBeLessThanOrEqual(1);

  const layout = await page.evaluate(() => {
    const editor = document.querySelector(".monaco-diff-editor");
    const original = document.querySelector(".monaco-diff-editor .editor.original");
    const minimap = document.querySelector(".monaco-diff-editor .minimap");
    const modified = document.querySelector(".monaco-diff-editor .editor.modified");
    const guard = modified?.querySelector(".overflow-guard");
    if (!(editor instanceof HTMLElement) || !(guard instanceof HTMLElement)) {
      throw new Error("Missing diff editor");
    }

    const guardBox = guard.getBoundingClientRect();
    const renderedText = Array.from(modified!.querySelectorAll(".view-line > span > span"));

    return {
      editorWidth: editor.getBoundingClientRect().width,
      originalVisible: original ? original.getBoundingClientRect().width > 0 : false,
      minimapVisible: minimap ? minimap.getBoundingClientRect().width > 0 : false,
      renderedLineCount: renderedText.length,
      textPastRightEdge: Math.max(
        0,
        ...renderedText.map((span) => span.getBoundingClientRect().right - guardBox.right),
      ),
    };
  });

  expect(layout.editorWidth).toBeGreaterThan(380);
  expect(layout.originalVisible).toBe(false);
  expect(layout.minimapVisible).toBe(false);
  // Word wrap is on, so no code sits off-screen behind a horizontal scroll.
  expect(layout.renderedLineCount).toBeGreaterThan(0);
  expect(layout.textPastRightEdge).toBeLessThanOrEqual(1);
});

test("the desktop diff keeps the side-by-side view and its mode toggle", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "this asserts the desktop layout",
  );
  await page.goto("/diff-viewer");

  const pane = page.getByTestId("diff-viewer-pane");
  await expect(pane.locator(".monaco-diff-editor")).toBeVisible();
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const originalWidth = await page
    .locator(".monaco-diff-editor .editor.original")
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(originalWidth).toBeGreaterThan(0);

  // A 40-character object name is abbreviated on every viewport.
  await expect(page.getByText("vs 63d1257")).toBeVisible();
});
