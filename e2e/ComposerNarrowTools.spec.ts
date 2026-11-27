import { expect, test } from "@playwright/test";

// The deliverables and demonstration buttons are hidden in a narrow chat
// column (a phone, or the design tab's agent panel), so attachments (+) lead.
for (const [width, narrow] of [
  [360, true],
  [480, true],
  [900, false],
] as const) {
  test(`a ${width}px chat column ${narrow ? "hides" : "shows"} the session tools`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: Math.max(width + 40, 480), height: 360 });
    await page.goto(`/composer-narrow-tools?width=${width}&design-context`);
    await expect(page.getByText("Design context", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    const tools = page.getByTestId("session-interaction-tools");
    const add = page.getByRole("button", { name: "Add attachment" });
    await expect(add).toBeVisible();
    await expect(tools).toHaveCount(1);
    if (narrow) {
      await expect(tools).toBeHidden();
      await expect(page.getByRole("button", { name: "Session deliverables" })).toBeHidden();
      await expect(page.getByRole("button", { name: "Record a demonstration" })).toBeHidden();
      // + is the first control of the toolbar row.
      const primary = page.locator('[data-native-compose-controls="primary"]');
      const firstVisible = await primary.evaluate((row) =>
        Array.from(row.querySelectorAll("button"))
          .find((button) => button.getBoundingClientRect().width > 0)
          ?.getAttribute("aria-label"),
      );
      expect(firstVisible).toBe("Add attachment");
    } else {
      await expect(page.getByRole("button", { name: "Session deliverables" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Record a demonstration" })).toBeVisible();
    }
    if (testInfo.project.name === "desktop-chromium")
      await page.getByTestId("chat-column").screenshot({
        path: `output/visual-previews/design-opening-after-${width}px.png`,
      });
  });
}
