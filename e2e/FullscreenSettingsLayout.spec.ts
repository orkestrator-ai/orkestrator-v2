import { expect, test, type Locator } from "@playwright/test";

async function expectInsideScrollport(item: Locator, nav: Locator) {
  await expect(item).toBeInViewport({ ratio: 1 });
  const itemBox = await item.boundingBox();
  const navBox = await nav.boundingBox();
  expect(itemBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(itemBox!.y).toBeGreaterThanOrEqual(navBox!.y);
  expect(itemBox!.y + itemBox!.height).toBeLessThanOrEqual(navBox!.y + navBox!.height);
}

test.describe("desktop settings sections", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "desktop sidebar coverage");
    await page.setViewportSize({ width: 1024, height: 320 });
  });

  test("wheel scrolling reaches the last section while the title stays pinned", async ({
    page,
  }) => {
    await page.goto("/fullscreen-settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    const last = nav.getByRole("button", { name: "Section 16", exact: true });
    const title = page.getByText("Fixture settings", { exact: true });
    await expect(nav).toBeVisible();
    await expect(last).not.toBeInViewport();
    expect(await nav.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    const titleBefore = await title.boundingBox();
    const content = page.locator('[data-slot="settings-content-scrollport"]');
    expect(await content.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    // Establish that this is the real scrollport before checking isolation.
    await content.hover();
    await page.mouse.wheel(0, 150);
    await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    const contentScrollBefore = await content.evaluate((node) => node.scrollTop);

    // Use a real input event before clicking: Playwright's click would otherwise
    // scroll the target into view automatically and mask an unreachable row.
    await nav.hover();
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => nav.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expectInsideScrollport(last, nav);
    expect(await title.boundingBox()).toEqual(titleBefore);
    expect(await content.evaluate((node) => node.scrollTop)).toBe(contentScrollBefore);
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(0);

    await last.click();
    await expect(last).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("settings-content")).toHaveText("Content for section-16");
  });

  test("a deep-linked last section is visible on mount, reload and a repeated request", async ({
    page,
  }) => {
    await page.goto("/fullscreen-settings?section=section-16");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    const last = nav.getByRole("button", { name: "Section 16", exact: true });
    for (const pass of ["initial", "reload"]) {
      if (pass === "reload") await page.reload();
      await expect(last).toHaveAttribute("aria-current", "page");
      await expectInsideScrollport(last, nav);
      expect(await nav.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      await expect(page.getByTestId("settings-content")).toHaveText("Content for section-16");
    }

    await nav.hover();
    await page.mouse.wheel(0, -1000);
    const first = nav.getByRole("button", { name: "Section 1", exact: true });
    await expectInsideScrollport(first, nav);
    await first.click();
    await expect(first).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "Jump to last section" }).click();
    await expect(last).toHaveAttribute("aria-current", "page");
    await expectInsideScrollport(last, nav);
    await expect(page.getByTestId("settings-content")).toHaveText("Content for section-16");
  });

  test("a normal desktop window shows every section without navigation overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/fullscreen-settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expectInsideScrollport(nav.getByRole("button", { name: "Section 16", exact: true }), nav);
    expect(await nav.evaluate((node) => node.scrollHeight === node.clientHeight)).toBe(true);
    await expect(page.getByRole("combobox", { name: "Settings section" })).toBeHidden();
  });
});

test("Tab and Shift+Tab cycle inside settings without reaching the page underneath", async ({
  page,
}) => {
  await page.goto("/fullscreen-settings");
  const dialog = page.getByRole("dialog", { name: "Fixture settings" });
  await expect(dialog).toBeFocused();
  const focusedLabel = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      const dialog = document.querySelector("[role='dialog'][aria-label='Fixture settings']");
      if (!active || !dialog?.contains(active)) return `outside:${active?.textContent ?? ""}`;
      return active.getAttribute("aria-label") ?? active.textContent?.trim() ?? "";
    });

  // More presses than the layer has controls, so each direction wraps at least once.
  for (const key of ["Tab", "Shift+Tab"]) {
    const visited: string[] = [];
    for (let press = 0; press < 30; press += 1) {
      await page.keyboard.press(key);
      visited.push(await focusedLabel());
    }
    expect(visited.filter((label) => label.startsWith("outside:"))).toEqual([]);
    expect(new Set(visited).size).toBeLessThan(visited.length);
  }
  await expect(page.getByRole("button", { name: "Page underneath" })).not.toBeFocused();
});

test("narrow settings use the selector to reach the last section with the keyboard", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "narrow selector coverage");
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto("/fullscreen-settings");
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeHidden();
  const selector = page.getByRole("combobox", { name: "Settings section" });
  await expect(selector).toHaveText("Section 1");
  await selector.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  const last = page.getByRole("option", { name: "Section 16", exact: true });
  await expect(last).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Enter");
  await expect(selector).toHaveText("Section 16");
  await expect(selector).toBeFocused();
  await expect(page.getByTestId("settings-content")).toHaveText("Content for section-16");
  await expect(page.getByRole("listbox")).toBeHidden();
});

test("with machines attached the header lists them and the title moves right", async ({
  page,
}, testInfo) => {
  const mobile = testInfo.project.name === "mobile-chromium";
  await page.goto("/fullscreen-settings?machines");
  const strip = page.getByRole("group", { name: "Machine" }).locator("visible=true");
  const chip = (name: string) => strip.getByRole("button", { name: new RegExp(`^${name}`) });
  await expect(strip.getByRole("button")).toHaveText([
    "Studio(command node)",
    "Desk",
    "Build box",
    "Laptop",
  ]);
  await expect(chip("Studio")).toHaveAttribute("aria-pressed", "true");
  await expect(chip("Laptop")).toBeDisabled();
  if (!mobile) {
    const title = page.getByRole("heading", { name: "Section 1" });
    const stripBox = await strip.boundingBox();
    const titleBox = await title.boundingBox();
    expect(titleBox!.x).toBeGreaterThan(stripBox!.x + stripBox!.width);
  }

  await chip("Desk").click();
  await expect(chip("Desk")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-content")).toHaveText("Content for section-1 on Desk");
  await page.screenshot({ path: testInfo.outputPath("settings-machines.png") });

  // A section only the command node has keeps it, and the choice returns afterwards.
  if (mobile) {
    await page.getByRole("combobox", { name: "Settings section" }).click();
    await page.getByRole("option", { name: "Section 2", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Section 2", exact: true }).click();
  }
  await expect(chip("Studio")).toHaveAttribute("aria-pressed", "true");
  await expect(chip("Desk")).toBeDisabled();
  await expect(page.getByTestId("settings-content")).toHaveText("Content for section-2 on Studio");
  if (mobile) {
    await page.getByRole("combobox", { name: "Settings section" }).click();
    await page.getByRole("option", { name: "Section 3", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Section 3", exact: true }).click();
  }
  await expect(chip("Desk")).toHaveAttribute("aria-pressed", "true");
});
