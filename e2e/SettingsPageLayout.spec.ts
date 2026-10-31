import { expect, test } from "@playwright/test";

for (const width of [390, 1680]) {
  test(`settings pages align left, cap widths and wrap controls at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "explicit viewport coverage");
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/fullscreen-settings?page-layout");
    const scrollport = page.locator('[data-slot="settings-content-scrollport"]');
    const available = await scrollport.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        left: node.getBoundingClientRect().left + parseFloat(style.paddingLeft),
        width: node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      };
    });
    for (const [variant, cap] of [
      ["default", 768],
      ["wide", 1024],
    ] as const) {
      const pageLayout = page.getByTestId(`page-${variant}`);
      const box = (await pageLayout.boundingBox())!;
      expect(box.x).toBeCloseTo(available.left, 0);
      expect(box.width).toBeCloseTo(Math.min(cap, available.width), 0);
      const heading = pageLayout.getByRole("heading", { level: 2 });
      const titleBox = (await heading.boundingBox())!;
      const actionBox = (await pageLayout
        .getByRole("button", { name: "First action" })
        .boundingBox())!;
      const labelBox = (await pageLayout.locator("label").boundingBox())!;
      const controlBox = (await pageLayout.getByRole("textbox").boundingBox())!;
      if (width === 390) {
        expect(actionBox.y).toBeGreaterThan(titleBox.y + titleBox.height);
        expect(controlBox.y).toBeGreaterThan(labelBox.y + labelBox.height);
      } else {
        expect(actionBox.y).toBeLessThan(titleBox.y + titleBox.height);
        expect(actionBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
        expect(controlBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
      }
      expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(box.x + box.width);
      expect(await pageLayout.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await expect(page.getByRole("heading", { name: "Section 1", exact: true })).toHaveCount(1);
    if (width === 390)
      await expect(page.getByRole("combobox", { name: "Settings section" })).toBeVisible();
  });
}

test("related Debug controls and notes use section spacing", async ({ page }) => {
  await page.goto("/global-settings?section=debug");
  const heading = page.getByRole("heading", { name: "Save Logs for Debugging" });
  const group = heading.locator("../..");
  await expect(group.getByLabel("Log retention days")).toBeVisible();
  await expect(group.getByText("Stored logs", { exact: true })).toBeVisible();
  await expect(group.getByText(/requires an app restart/)).toBeVisible();
  const gaps = await group.evaluate((node) =>
    Array.from(node.children)
      .slice(1)
      .map(
        (child, index) =>
          child.getBoundingClientRect().top - node.children[index].getBoundingClientRect().bottom,
      ),
  );
  expect(gaps.length).toBe(4);
  for (const gap of gaps) expect(gap).toBeCloseTo(12, 0);
});

test("the Platforms note stays with the platform card", async ({ page }) => {
  await page.goto("/global-settings?section=platforms");
  const note = page.getByText(
    "Disabling a platform hides new launch choices; existing sessions and files are kept.",
  );
  const group = note.locator("..");
  await expect(group.getByRole("switch")).toHaveCount(6);
  const gap = await note.evaluate(
    (node) =>
      node.getBoundingClientRect().top -
      node.previousElementSibling!.getBoundingClientRect().bottom,
  );
  expect(gap).toBeCloseTo(12, 0);
});
