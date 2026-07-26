import { expect, test, type Locator, type Page } from "@playwright/test";

const fullObjectId = "63d12576e9198f24bc2271a6a8c3702dfb391eae";
const longBranch = "feature/a-realistically-very-long-mobile-branch-name";

function diffHeader(page: Page) {
  return page.locator("[data-testid='diff-viewer-pane'] > div > div").first();
}

async function headerGeometry(header: Locator) {
  return header.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("Missing diff header");

    const content = element.children[0];
    const actions = element.children[1];
    if (!(content instanceof HTMLElement) || !(actions instanceof HTMLElement)) {
      throw new Error("Missing diff header regions");
    }

    const headerBox = element.getBoundingClientRect();
    const contentBox = content.getBoundingClientRect();
    const actionsBox = actions.getBoundingClientRect();
    const descendantOverflow = Array.from(element.querySelectorAll("*")).map((child) => {
      const box = child.getBoundingClientRect();
      return Math.max(box.right - headerBox.right, headerBox.left - box.left);
    });

    return {
      headerWidth: headerBox.width,
      headerClientWidth: element.clientWidth,
      headerScrollWidth: element.scrollWidth,
      siblingOverlap: Math.max(0, contentBox.right - actionsBox.left),
      worstOverflow: Math.max(0, ...descendantOverflow),
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
  await page.goto(`/diff-viewer?branch=${encodeURIComponent(longBranch)}`);

  const pane = page.getByTestId("diff-viewer-pane");
  await expect(pane.locator(".monaco-diff-editor")).toBeVisible();

  // Side-by-side is unusable at this width, so the toggle is gone and the
  // remaining control has room.
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Inline" })).toHaveCount(0);
  await expect(page.getByTitle("View file")).toBeVisible();

  const header = diffHeader(page);
  const branchReference = header.locator(`[title="vs ${longBranch}"]`);
  await expect(branchReference).toBeVisible();
  await expect(branchReference).toHaveText(`vs ${longBranch}`);

  const {
    headerWidth,
    headerClientWidth,
    headerScrollWidth,
    siblingOverlap,
    worstOverflow,
  } = await headerGeometry(header);
  expect(headerWidth).toBeLessThanOrEqual(390);
  expect(headerScrollWidth).toBeLessThanOrEqual(headerClientWidth + 1);
  expect(siblingOverlap).toBeLessThanOrEqual(1);
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
      guardClientWidth: guard.clientWidth,
      guardScrollWidth: guard.scrollWidth,
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
  expect(layout.guardScrollWidth).toBeLessThanOrEqual(layout.guardClientWidth + 1);
  expect(layout.originalVisible).toBe(false);
  expect(layout.minimapVisible).toBe(false);
  // Word wrap is on, so no code sits off-screen behind a horizontal scroll.
  expect(layout.renderedLineCount).toBeGreaterThan(0);
  expect(layout.textPastRightEdge).toBeLessThanOrEqual(1);

  const accessibility = await header.ariaSnapshot();
  expect(accessibility).toContain("Modified");

  await page.getByTitle("View file").click();
  await expect(page.getByTestId("view-file-count")).toHaveText("1");
});

for (const statusCase of [
  { query: "new", accessibleName: "New file" },
  { query: "deleted", accessibleName: "Deleted" },
] as const) {
  test(`the ${statusCase.query} file state renders accessibly on a phone`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile-chromium",
      "this asserts the phone layout",
    );
    await page.goto(`/diff-viewer?status=${statusCase.query}`);

    const pane = page.getByTestId("diff-viewer-pane");
    await expect(pane.locator(".monaco-diff-editor")).toBeVisible();
    await expect(page.getByRole("button", { name: "Side by side" })).toHaveCount(0);

    const accessibility = await diffHeader(page).ariaSnapshot();
    expect(accessibility).toContain(statusCase.accessibleName);
  });
}

test("the mounted diff switches exactly at the mobile breakpoint", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "this resizes the desktop viewport across the breakpoint",
  );
  await page.goto("/diff-viewer");

  const pane = page.getByTestId("diff-viewer-pane");
  await expect(pane.locator(".monaco-diff-editor")).toBeVisible();
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.setViewportSize({ width: 767, height: 844 });
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Inline" })).toHaveCount(0);
  await expect(pane.locator(".monaco-diff-editor")).not.toHaveClass(/side-by-side/);

  await page.setViewportSize({ width: 768, height: 844 });
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Inline" })).toBeVisible();
  await expect(pane.locator(".monaco-diff-editor")).toHaveClass(/side-by-side/);
});

test("the desktop diff keeps its mode controls and full-ref tooltip", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "this asserts the desktop layout",
  );
  await page.goto("/diff-viewer");

  const pane = page.getByTestId("diff-viewer-pane");
  await expect(pane.locator(".monaco-diff-editor")).toBeVisible();
  const sideBySide = page.getByRole("button", { name: "Side by side" });
  const inline = page.getByRole("button", { name: "Inline" });
  await expect(sideBySide).toHaveAttribute("aria-pressed", "true");
  await expect(pane.locator(".monaco-diff-editor")).toHaveClass(/side-by-side/);

  await inline.click();
  await expect(inline).toHaveAttribute("aria-pressed", "true");
  await expect(pane.locator(".monaco-diff-editor")).not.toHaveClass(/side-by-side/);

  await sideBySide.click();
  await expect(sideBySide).toHaveAttribute("aria-pressed", "true");
  await expect(pane.locator(".monaco-diff-editor")).toHaveClass(/side-by-side/);

  // A 40-character object name is abbreviated, but its complete value remains
  // available through the native tooltip.
  const baseReference = diffHeader(page).locator(`[title="vs ${fullObjectId}"]`);
  await expect(baseReference).toHaveText("vs 63d1257");
});
