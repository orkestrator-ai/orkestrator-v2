import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/terminal-corner-toolbar");
  await expect(page.getByTestId("terminal-ready")).toHaveText("true");
});

test("desktop history releases hidden hit targets and survives the terminal/button handoff", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "requires a hover-capable pointer");
  const history = page.getByRole("button", { name: "Open earlier terminal output" });
  const host = page.getByTestId("terminal-host");
  await expect(history).toHaveCSS("opacity", "0");
  await expect(history).toHaveCSS("pointer-events", "none");
  // Opacity alone would leave the button (or its toolbar) above xterm here.
  expect(
    await history.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return document.querySelector('[data-testid="terminal-host"]')!.contains(target);
    }),
  ).toBe(true);

  const rect = (await host.boundingBox())!;
  await page.mouse.move(rect.x + 20, rect.y + 100);
  await page.mouse.down();
  await page.mouse.move(rect.x + 180, rect.y + 100, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId("terminal-selection")).not.toHaveText("");
  await expect(history).toHaveCSS("pointer-events", "none");

  // Drag the real xterm scrollbar below the reveal zone while history is hidden.
  const viewportRow = page.getByTestId("terminal-viewport-row");
  const previousRow = Number(await viewportRow.textContent());
  await page.mouse.move(rect.x + rect.width - 8, rect.y + 190);
  const slider = host.locator(".scrollbar.vertical .slider");
  await slider.hover();
  const thumb = (await slider.boundingBox())!;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y - 80, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => Number(await viewportRow.textContent())).toBeLessThan(previousRow);
  await expect(history).toHaveCSS("pointer-events", "none");

  // Approach through xterm's corner, then cross to the sibling button.
  await page.mouse.move(rect.x + rect.width - 50, rect.y + 40);
  await expect(history).toHaveCSS("opacity", "1");
  await expect(history).toHaveCSS("pointer-events", "auto");
  await history.hover();
  await expect(history).toHaveCSS("opacity", "1");
  // Return to xterm inside the reveal zone before leaving it.
  await page.mouse.move(rect.x + rect.width - 50, rect.y + 40);
  await expect(history).toHaveCSS("opacity", "1");
  await history.click();
  await expect(page.getByRole("region", { name: "Earlier terminal output" })).toBeVisible();
  await expect(page.getByText("Retained earlier output")).toBeVisible();
  await page.getByRole("button", { name: "Return to live terminal" }).click();
  await page.mouse.move(rect.x + 100, rect.y + 160);
  await expect(history).toHaveCSS("opacity", "0");
  await expect(history).toHaveCSS("pointer-events", "none");
  await page.getByRole("button", { name: "Mark setup complete" }).focus();
  await page.keyboard.press("Tab");
  await expect(history).toBeFocused();
  await expect(history).toHaveCSS("opacity", "1");
  await expect(history).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Earlier terminal output" })).toBeVisible();
});

test("touch history is visible and opens on tap at phone and tablet widths", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "requires a touch-only pointer");
  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expect(page.getByTestId("terminal-ready")).toHaveText("true");
    expect(
      await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches),
    ).toBe(true);
    const history = page.getByRole("button", { name: "Open earlier terminal output" });
    await expect(history).toHaveCSS("opacity", "1");
    await expect(history).toHaveCSS("pointer-events", "auto");
    // Both controls share the toolbar while a setup session is still running.
    await history.tap();
    await expect(page.getByText("Retained earlier output")).toBeVisible();
    await expect(page.getByTestId("setup-complete")).toHaveText("false");
    await page.getByRole("button", { name: "Return to live terminal" }).tap();
    await page.getByRole("button", { name: "Mark setup complete" }).tap();
    await expect(page.getByTestId("setup-complete")).toHaveText("true");
    await expect(history).toHaveCSS("opacity", "1");
    await history.tap();
    await expect(page.getByText("Retained earlier output")).toBeVisible();
    await page.getByRole("button", { name: "Return to live terminal" }).tap();
  }
});

test("narrow pane banner dismissals and recovery win hit-testing over both toolbar controls", async ({
  page,
}) => {
  const history = page.getByRole("button", { name: "Open earlier terminal output" });
  const setup = page.getByRole("button", { name: "Mark setup complete" });
  await setup.hover();
  await expect(history).toHaveCSS("opacity", "1");

  const assertBannerHitTarget = async (name: string) => {
    const button = page.getByRole("button", { name, exact: true });
    const bannerControl = (await button.boundingBox())!;
    const toolbar = (await setup.locator("..").boundingBox())!;
    expect(bannerControl.x).toBeLessThan(toolbar.x + toolbar.width);
    expect(bannerControl.x + bannerControl.width).toBeGreaterThan(toolbar.x);
    expect(bannerControl.y).toBeLessThan(toolbar.y + toolbar.height);
    expect(bannerControl.y + bannerControl.height).toBeGreaterThan(toolbar.y);
    expect(
      await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
    ).toBe(true);
    await button.click();
    await expect(page.getByRole("region", { name: "Earlier terminal output" })).toHaveCount(0);
    await expect(page.getByTestId("setup-complete")).toHaveText("false");
    await expect(page.getByTestId("terminal-pane").getByRole("status")).toHaveCount(0);
  };

  await page.getByRole("button", { name: "Show warning", exact: true }).click();
  await assertBannerHitTarget("Dismiss terminal warning");
  await page.getByRole("button", { name: "Show disconnected", exact: true }).click();
  await assertBannerHitTarget("Dismiss disconnected notice");
  await page.getByRole("button", { name: "Show disconnected", exact: true }).click();
  await assertBannerHitTarget("Reconnect");
  await expect(page.getByTestId("reconnections")).toHaveText("1");
});
