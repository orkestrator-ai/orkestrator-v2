import { expect, test, type Locator, type Page } from "@playwright/test";

const fullObjectId = "63d12576e9198f24bc2271a6a8c3702dfb391eae";
const longBranch = "feature/a-realistically-very-long-mobile-branch-name";
const afterLabel = "Current workspace file";

// The first change in the fixture body: one removal answered by one addition.
const removedHeading = "-# Frontend State Audit";
const addedHeading = "+# Frontend State Audit — What Should Move";

function diffHeader(page: Page) {
  return page.getByTestId("diff-viewer-pane").getByTestId("diff-viewer-header");
}

function diffHunks(page: Page) {
  return page.getByTestId("diff-viewer-pane").getByTestId("change-hunks");
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

/**
 * How the backend rows are laid out: side by side (the removal and its
 * replacement share a row, removal on the left) or unified (the replacement
 * sits below the removal in the same column).
 */
async function rowLayout(page: Page): Promise<"split" | "unified" | "other"> {
  const hunks = diffHunks(page);
  const [removed, added] = await Promise.all([
    hunks.getByText(removedHeading, { exact: true }).boundingBox(),
    hunks.getByText(addedHeading, { exact: true }).boundingBox(),
  ]);
  if (!removed || !added) return "other";
  if (Math.abs(removed.y - added.y) <= 1 && removed.x + removed.width <= added.x + 1) {
    return "split";
  }
  if (added.y >= removed.y + removed.height - 1 && Math.abs(removed.x - added.x) <= 1) {
    return "unified";
  }
  return "other";
}

test("the diff header fits a phone and the hunks use the full width", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "this asserts the phone layout");
  await page.goto(`/diff-viewer?branch=${encodeURIComponent(longBranch)}`);

  const hunks = diffHunks(page);
  await expect(hunks).toBeVisible();
  await expect(hunks.getByText(addedHeading, { exact: true })).toBeVisible();

  // Side-by-side is unusable at this width, so the toggle is gone and the
  // remaining controls have room.
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Inline" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View file" })).toBeVisible();

  // The long baseline ref is truncated in place; the full `ref@oid` stays in the tooltip.
  const header = diffHeader(page);
  const baseReference = header.getByTestId("diff-viewer-endpoints");
  await expect(baseReference).toBeVisible();
  await expect(baseReference).toHaveAttribute(
    "title",
    `${longBranch}@${fullObjectId} → ${afterLabel}`,
  );
  await expect(baseReference).toHaveText(`vs ${longBranch}@63d1257 · ${afterLabel}`);
  expect(await baseReference.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
    true,
  );

  const { headerWidth, headerClientWidth, headerScrollWidth, siblingOverlap, worstOverflow } =
    await headerGeometry(header);
  expect(headerWidth).toBeLessThanOrEqual(390);
  expect(headerScrollWidth).toBeLessThanOrEqual(headerClientWidth + 1);
  expect(siblingOverlap).toBeLessThanOrEqual(1);
  expect(worstOverflow).toBeLessThanOrEqual(1);

  // A phone gets one column of rows, regardless of the remembered desktop mode.
  await expect.poll(() => rowLayout(page)).toBe("unified");

  const layout = await hunks.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const lines = Array.from(element.querySelectorAll("pre > div"));
    return {
      width: box.width,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      twoColumnRows: element.querySelectorAll(".grid-cols-2").length,
      renderedLineCount: lines.length,
      textPastRightEdge: Math.max(
        0,
        ...lines.map((line) => {
          const range = document.createRange();
          range.selectNodeContents(line);
          return range.getBoundingClientRect().right - box.right;
        }),
      ),
    };
  });
  expect(layout.width).toBeGreaterThan(380);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.twoColumnRows).toBe(0);
  // Lines wrap, so no code sits off-screen behind a horizontal scroll.
  expect(layout.renderedLineCount).toBeGreaterThan(0);
  expect(layout.textPastRightEdge).toBeLessThanOrEqual(1);

  const accessibility = await header.ariaSnapshot();
  expect(accessibility).toContain("Modified");

  await page.getByRole("button", { name: "View file" }).click();
  await expect(page.getByTestId("view-file-count")).toHaveText("1");
});

for (const statusCase of [
  { query: "new", accessibleName: "New file", line: "+# Frontend State Audit — What Should Move" },
  { query: "deleted", accessibleName: "Deleted", line: "-# Frontend State Audit" },
] as const) {
  test(`the ${statusCase.query} file state renders accessibly on a phone`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "this asserts the phone layout");
    await page.goto(`/diff-viewer?status=${statusCase.query}`);

    const hunks = diffHunks(page);
    await expect(hunks.getByText(statusCase.line, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Side by side" })).toHaveCount(0);

    const accessibility = await diffHeader(page).ariaSnapshot();
    expect(accessibility).toContain(statusCase.accessibleName);
  });
}

test("the mounted diff switches exactly at the mobile breakpoint", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "this resizes the desktop viewport across the breakpoint",
  );
  await page.goto("/diff-viewer");

  await expect(diffHunks(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => rowLayout(page)).toBe("split");

  await page.setViewportSize({ width: 767, height: 844 });
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Inline" })).toHaveCount(0);
  await expect.poll(() => rowLayout(page)).toBe("unified");

  await page.setViewportSize({ width: 768, height: 844 });
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Inline" })).toBeVisible();
  await expect.poll(() => rowLayout(page)).toBe("split");
});

test("the desktop diff keeps its mode controls and full-ref tooltip", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "this asserts the desktop layout");
  await page.goto("/diff-viewer");

  await expect(diffHunks(page)).toBeVisible();
  const sideBySide = page.getByRole("button", { name: "Side by side" });
  const inline = page.getByRole("button", { name: "Inline" });
  await expect(sideBySide).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => rowLayout(page)).toBe("split");

  await inline.click();
  await expect(inline).toHaveAttribute("aria-pressed", "true");
  await expect(sideBySide).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => rowLayout(page)).toBe("unified");

  await sideBySide.click();
  await expect(sideBySide).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => rowLayout(page)).toBe("split");

  // A 40-character object name is abbreviated, but its complete value remains
  // available through the native tooltip.
  const baseReference = diffHeader(page).getByTestId("diff-viewer-endpoints");
  await expect(baseReference).toHaveAttribute("title", `main@${fullObjectId} → ${afterLabel}`);
  await expect(baseReference).toHaveText(`vs main@63d1257 · ${afterLabel}`);
});
