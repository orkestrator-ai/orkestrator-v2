import { expect, test } from "@playwright/test";

test("Cmd+Shift+K opens a searchable list of keyboard shortcuts", async ({ page }, testInfo) => {
  await page.goto("/keyboard-shortcuts");
  await expect(page.getByTestId("terminal").locator("textarea")).toBeAttached();
  await page.keyboard.press("Meta+Shift+K");

  const dialog = page.getByTestId("keyboard-shortcuts-dialog");
  await expect(dialog).toBeVisible();
  const search = page.getByRole("textbox", { name: "Search keyboard shortcuts" });
  await expect(search).toBeFocused();
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible();
  await expect(page.getByTestId("keyboard-shortcut-search-projects")).toBeVisible();

  // The list scrolls inside the dialog rather than past the viewport.
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport && box.y + box.height <= viewport.height).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("keyboard-shortcuts.png") });

  await search.fill("zoom");
  await expect(page.getByTestId("keyboard-shortcut-zoom-in")).toBeVisible();
  await expect(page.getByTestId("keyboard-shortcut-search-projects")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("keyboard-shortcuts-search.png") });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

for (const modifier of ["Meta", "Control"]) {
  for (const surface of ["composer", "terminal"]) {
    for (const dismiss of ["Escape", "toggle"]) {
      test(`${modifier} shortcut returns focus and typing to ${surface} after ${dismiss}`, async ({
        page,
      }) => {
        await page.goto("/keyboard-shortcuts");
        const input =
          surface === "composer"
            ? page.getByRole("textbox", { name: "Composer" })
            : page.getByTestId("terminal").locator("textarea.xterm-helper-textarea");
        await input.focus();
        await page.keyboard.press(`${modifier}+Shift+K`);
        const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        await expect(dialog).toBeVisible();
        await page.keyboard.press(dismiss === "Escape" ? "Escape" : `${modifier}+Shift+K`);
        await expect(dialog).toHaveCount(0);
        await expect(input).toBeFocused();
        await page.keyboard.type("resumed");
        if (surface === "composer") await expect(input).toHaveValue("resumed");
        else await expect(page.getByTestId("terminal-input")).toHaveText("resumed");
      });
    }
  }

  test(`${modifier} shortcut opens over fullscreen settings and one Escape dismisses it`, async ({
    page,
  }) => {
    await page.goto("/fullscreen-settings");
    const settings = page.getByTestId("settings-content");
    await expect(settings).toBeVisible();
    await page.keyboard.press(`${modifier}+Shift+K`);
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("z-index", "80");
    await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCSS("z-index", "80");
    const search = dialog.getByRole("textbox");
    await search.click(); // Proves the settings surface cannot intercept pointer input.
    await search.fill("design");
    await expect(page.getByTestId("keyboard-shortcut-design-help")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeVisible();
  });

  test(`${modifier} shortcut wins over Monaco Delete Line`, async ({ page }) => {
    await page.goto("/monaco-runtime");
    const editor = page.getByTestId("monaco-runtime-editor");
    const input = editor.getByRole("textbox", { name: "Editor content" });
    // Monaco's lazy chunk can take longer than five seconds under parallel
    // load (flake 0792). Only startup gets the longer budget; the shortcut
    // assertions below keep the default deadline.
    await expect(input).toBeAttached({ timeout: 30_000 });
    await input.focus();
    const value = page.getByTestId("monaco-runtime-value");
    const original = await value.textContent();
    await page.keyboard.press(`${modifier}+Shift+K`);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await expect(value).toHaveText(original!);
    await page.keyboard.press("Escape");
    await expect(input).toBeFocused();
    await page.keyboard.type("x");
    await expect(value).toHaveText(`x${original}`);
    await expect(value).toContainText("const answer: number = 42;");
  });
}

test("short viewport keeps the footer and final shortcut reachable", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 400 });
  await page.goto("/keyboard-shortcuts");
  await expect(page.getByTestId("terminal").locator("textarea")).toBeAttached();
  await page.keyboard.press("Meta+Shift+K");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog.getByText("Close", { exact: true })).toBeInViewport({ ratio: 1 });
  const last = dialog.locator("li").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByText("Close", { exact: true })).toBeInViewport({ ratio: 1 });
  const box = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(400);
});

for (const modifier of ["Meta", "Control"]) {
  test(`${modifier} from an opaque app-owned design frame opens shortcuts`, async ({ page }) => {
    await page.goto("/keyboard-shortcuts");
    const input = page
      .frameLocator('iframe[title="Design preview"]')
      .getByRole("textbox", { name: "Design input" });
    await input.fill("kept");
    await page.keyboard.press(`${modifier}+Shift+K`);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Search keyboard shortcuts" })).toBeFocused();
    await page.keyboard.press(`${modifier}+Shift+K`);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await expect(input).toHaveValue("kept");
  });
}

test("uncooperative cross-origin browser/service frames keep their keyboard events isolated", async ({
  page,
}) => {
  await page.route("http://preview.invalid/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<input aria-label="Preview input">',
    }),
  );
  await page.goto("/keyboard-shortcuts");
  await page.locator('iframe[title="Service preview"]').evaluate((frame: HTMLIFrameElement) => {
    frame.src = "http://preview.invalid/";
  });
  const input = page.frameLocator('iframe[title="Service preview"]').getByRole("textbox");
  await input.fill("kept");
  await page.keyboard.press("Control+Shift+K");
  // The browser's origin boundary prevents a parent from intercepting this
  // chord. This limitation is explicit; Electron handles it before dispatch.
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await expect(input).toHaveValue("kept");
  await page.getByRole("textbox", { name: "Composer" }).focus();
  await page.keyboard.press("Control+Shift+K");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});
