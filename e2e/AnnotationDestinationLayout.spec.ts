import { expect, test, type Locator } from "@playwright/test";

async function expectContained(element: Locator, parent: Locator) {
  const parentBox = await parent.boundingBox();
  expect(parentBox).not.toBeNull();
  const geometry = await element.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(parentBox!.x - 1);
  expect(geometry.right).toBeLessThanOrEqual(parentBox!.x + parentBox!.width + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

for (const width of [240, 280, 360]) {
  test(`destination titles and composer actions stay inside a ${width}px sidebar`, async ({
    page,
  }) => {
    await page.goto("/annotation-destination-layout");
    const sidebar = page.getByRole("complementary", { name: "Page annotations" });
    await sidebar.evaluate((node, pixels) => {
      node.style.width = `${pixels}px`;
    }, width);
    const composer = sidebar.getByRole("region", { name: "Ask an agent" });
    const picker = composer.getByRole("group", { name: "Agent session" });
    const group = picker.getByRole("radiogroup", { name: "Agent session" });
    const options = group.getByRole("radio");
    await expect(options).toHaveCount(5);

    const discuss = composer.getByRole("button", { name: /^Discuss with / });
    const implement = composer.getByRole("button", { name: /^Request changes from / });
    await options.first().click();
    const singleLineHeights = await Promise.all(
      [discuss, implement].map((button) => button.evaluate((node) => node.clientHeight)),
    );

    for (const option of (await options.all()).slice(1)) {
      const title = option.locator(":scope > span").first();
      const fullTitle = await title.textContent();
      await option.click();
      await expect(option).toHaveAttribute("aria-checked", "true");
      await expect(discuss).toHaveAccessibleName(`Discuss with ${fullTitle} (advisory)`);
      await expect(implement).toHaveAccessibleName(`Request changes from ${fullTitle}`);

      for (const element of [composer, picker, group, option])
        await expectContained(element, sidebar);

      const clamp = await title.evaluate((node) => ({
        height: node.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(node).lineHeight),
        fullHeight: node.scrollHeight,
      }));
      expect(clamp.height).toBeCloseTo(clamp.lineHeight * 2, 0);
      expect(clamp.fullHeight).toBeGreaterThan(clamp.height);

      for (const [index, button] of [discuss, implement].entries()) {
        await expectContained(button, composer);
        const label = await button.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = node.getBoundingClientRect();
          const lines = Array.from(range.getClientRects());
          return {
            height: node.clientHeight,
            wraps: new Set(lines.map((line) => line.top)).size > 1,
            textInside: lines.every(
              (line) =>
                line.left >= rect.left &&
                line.right <= rect.right &&
                line.top >= rect.top &&
                line.bottom <= rect.bottom,
            ),
          };
        });
        expect(label.wraps).toBe(true);
        expect(label.textInside).toBe(true);
        expect(label.height).toBeGreaterThan(singleLineHeights[index]!);
      }
    }
  });
}
