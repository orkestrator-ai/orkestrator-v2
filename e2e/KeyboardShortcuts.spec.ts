import { expect, test } from "@playwright/test";

test("Cmd+Shift+/ opens a searchable list of keyboard shortcuts", async ({ page }, testInfo) => {
  await page.goto("/keyboard-shortcuts");
  await expect(page.getByTestId("terminal").locator("textarea")).toBeAttached();
  await page.keyboard.press("Meta+Shift+Slash");

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
        await page.keyboard.press(`${modifier}+Shift+Slash`);
        const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        await expect(dialog).toBeVisible();
        await page.keyboard.press(dismiss === "Escape" ? "Escape" : `${modifier}+Shift+Slash`);
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
    await page.keyboard.press(`${modifier}+Shift+Slash`);
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

  test(`${modifier} shortcuts chord opens over Monaco and leaves Shift+K to the editor`, async ({
    page,
  }) => {
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
    await page.keyboard.press(`${modifier}+Shift+Slash`);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await expect(value).toHaveText(original!);
    await page.keyboard.press("Escape");
    await expect(input).toBeFocused();
    await page.keyboard.type("x");
    await expect(value).toHaveText(`x${original}`);
    await expect(value).toContainText("const answer: number = 42;");

    await page.keyboard.press(`${modifier}+Shift+K`);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await expect(input).toBeFocused();
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    // Monaco binds Delete Line to Cmd+Shift+K on macOS and Ctrl+Shift+K elsewhere.
    if (modifier === (mac ? "Meta" : "Control")) await expect(value).toHaveText("");
  });
}

test("short viewport keeps the footer and final shortcut reachable", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 400 });
  await page.goto("/keyboard-shortcuts");
  await expect(page.getByTestId("terminal").locator("textarea")).toBeAttached();
  await page.keyboard.press("Meta+Shift+Slash");
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
      .getByRole("textbox", { name: "Design input", exact: true });
    await input.fill("kept");
    await page.keyboard.press(`${modifier}+Shift+Slash`);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Search keyboard shortcuts" })).toBeFocused();
    await page.keyboard.press(`${modifier}+Shift+Slash`);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await expect(input).toHaveValue("kept");
  });
}

test("pointer and Tab entry into a design frame land where the user went, not on the remembered field", async ({
  page,
}) => {
  await page.goto("/keyboard-shortcuts");
  const frame = page.frameLocator('iframe[title="Design preview"]');
  const first = frame.getByRole("textbox", { name: "Design input", exact: true });
  const second = frame.getByRole("textbox", { name: "Second design input" });
  await expect(second).toBeAttached();
  // Focus stops either side of the frame, so Tab and Shift+Tab enter it
  // directly (xterm keeps Tab for itself).
  await page.locator('iframe[title="Design preview"]').evaluate((element) => {
    const before = document.createElement("button");
    before.textContent = "Before design";
    const after = document.createElement("button");
    after.textContent = "After design";
    element.before(before);
    element.after(after);
  });
  const composer = page.getByRole("textbox", { name: "Composer" });
  // The state the frame's focus restoration answers: a field had focus, then
  // the frame was left with none focused while the page outside took focus.
  const rememberThenLeave = async (field: typeof first) => {
    await field.click();
    await field.evaluate((element: HTMLElement) => element.blur());
    await composer.focus();
  };

  // A click on another field puts focus and typing there.
  await rememberThenLeave(first);
  await second.click();
  await page.keyboard.type("clicked");
  await expect(second).toBeFocused();
  await expect(second).toHaveValue("clicked");
  await expect(first).toHaveValue("");

  // Tab from before the frame lands on its first field, not the remembered second.
  await rememberThenLeave(second);
  await page.getByRole("button", { name: "Before design" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.type("tabbed");
  await expect(first).toBeFocused();
  await expect(first).toHaveValue("tabbed");
  await expect(second).toHaveValue("clicked");

  // Shift+Tab from after the frame lands on its last field, not the remembered first.
  await rememberThenLeave(first);
  await page.getByRole("button", { name: "After design" }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("back");
  await expect(second).toBeFocused();
  // Keyboard focus selects a field's text, so typing replaces "clicked".
  await expect(second).toHaveValue("back");
  await expect(first).toHaveValue("tabbed");
});

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
  await page.keyboard.press("Control+Shift+Slash");
  // The browser's origin boundary prevents a parent from intercepting this
  // chord. This limitation is explicit; Electron handles it before dispatch.
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await expect(input).toHaveValue("kept");
  await page.getByRole("textbox", { name: "Composer" }).focus();
  await page.keyboard.press("Control+Shift+Slash");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});

test("outside pointer dismissal notifies desktop restoration once and returns typing", async ({
  page,
}) => {
  await page.goto("/keyboard-shortcuts");
  await page.evaluate(() => {
    const state = { closed: 0 };
    Object.assign(window, {
      shortcutDismissal: state,
      orkestrator: {
        ...window.orkestrator,
        listen: () => () => {},
        keyboardShortcuts: {
          closed: async () => {
            state.closed++;
          },
        },
      },
    });
  });
  const composer = page.getByRole("textbox", { name: "Composer" });
  await composer.focus();
  await page.keyboard.press("Meta+Shift+Slash");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 2, y: 2 } });
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { shortcutDismissal: { closed: number } }).shortcutDismissal.closed,
      ),
    )
    .toBe(1);
  await expect(composer).toBeFocused();
  await page.keyboard.type("resumed");
  await expect(composer).toHaveValue("resumed");
});

test.describe("⌘K search works wherever focus is", () => {
  const requests = (page: import("@playwright/test").Page) => page.getByTestId("search-requests");
  const shellInput = (page: import("@playwright/test").Page) =>
    page.getByTestId("terminal-input").evaluate((output) => output.textContent);

  test("from the composer, and ⌘K in a terminal while Ctrl+K reaches the shell", async ({
    page,
  }) => {
    await page.goto("/keyboard-shortcuts");
    await page.getByRole("textbox", { name: "Composer" }).focus();
    await page.keyboard.press("Meta+K");
    await expect(requests(page)).toHaveText("1");
    await page.keyboard.press("Control+K");
    // Ctrl+K in a macOS text field is kill-line; elsewhere it is search.
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await expect(requests(page)).toHaveText(mac ? "1" : "2");

    const terminal = page.getByTestId("terminal").locator("textarea.xterm-helper-textarea");
    await terminal.focus();
    await page.keyboard.press("Control+K");
    // xterm sent ^K (kill-line) to the shell, and the app left it alone.
    await expect.poll(() => shellInput(page)).toBe("\u000b");
    await expect(requests(page)).toHaveText(mac ? "1" : "2");
    await page.keyboard.press("Meta+K");
    await expect(requests(page)).toHaveText(mac ? "2" : "3");
    expect(await shellInput(page)).toBe("\u000b");
  });

  for (const modifier of ["Meta", "Control"]) {
    test(`${modifier}+K from an app-owned design frame reaches the window`, async ({ page }) => {
      await page.goto("/keyboard-shortcuts");
      const input = page
        .frameLocator('iframe[title="Design preview"]')
        .getByRole("textbox", { name: "Design input", exact: true });
      await input.fill("kept");
      await page.keyboard.press(`${modifier}+K`);
      const mac = await page.evaluate(() =>
        /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent),
      );
      await expect(requests(page)).toHaveText(modifier === "Control" && mac ? "0" : "1");
      await expect(input).toHaveValue("kept");
    });
  }
});

for (const modifier of ["Meta", "Control"]) {
  for (const surface of ["settings", "shortcuts"]) {
    test(`${modifier}+K opens usable project search above ${surface}`, async ({ page }) => {
      await page.goto(
        surface === "settings" ? "/fullscreen-settings?search-ui" : "/keyboard-shortcuts?search-ui",
      );
      if (surface === "shortcuts") {
        await expect(page.getByTestId("terminal").locator("textarea")).toBeAttached();
        await page.keyboard.press("Meta+Shift+Slash");
      }
      const underlying =
        surface === "settings"
          ? page.getByRole("textbox", { name: "Settings value" })
          : page.getByRole("textbox", { name: "Search keyboard shortcuts" });
      await underlying.fill("kept");
      // Ctrl+K remains native text editing on macOS. Override the platform
      // for the Windows/Linux branch so both chords exercise the raised UI.
      if (modifier === "Control")
        await page.evaluate(() =>
          Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true }),
        );
      await page.keyboard.press(`${modifier}+K`);
      const search = page.getByTestId("project-search-dialog");
      await expect(search).toBeVisible();
      const input = search.getByRole("combobox");
      await expect(input).toBeFocused();
      await input.click();
      await page.keyboard.type("sample query");
      await expect(input).toHaveValue("sample query");
      await search.getByRole("button", { name: /^Filter results:/ }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitemradio", { name: "Projects", exact: true }).click();
      await expect(menu).toHaveCount(0);
      await input.click();
      await page.keyboard.press("Escape");
      await expect(search).toHaveCount(0);
      await expect(underlying).toBeVisible();
      await expect(underlying).toHaveValue("kept");
      await page.reload();
      await expect(page.getByTestId("project-search-dialog")).toHaveCount(0);
    });
  }
}

for (const modifier of ["Meta", "Control"]) {
  for (const unassigned of [false, true]) {
    test(`${modifier}+I focuses the ${unassigned ? "fresh" : "assigned"} agent composer and leaves the terminal chord usable`, async ({
      page,
    }) => {
      await page.goto(`/pane-breakpoint${unassigned ? "?unassigned" : ""}`);
      // Both panes must be visible to exercise their actual shortcut ownership.
      await page.setViewportSize({ width: 1024, height: 900 });
      const agent = page
        .locator("[data-pane-leaf]")
        .filter({ has: page.locator('[contenteditable="true"]') });
      const composer = agent.getByRole("textbox");
      await expect(composer).toBeEditable();
      const paneControl = agent.locator("button[aria-label^='Close ']").first().locator("..");
      await paneControl.focus();
      await expect(paneControl).toBeFocused();
      await expect(agent).toHaveClass(/ring-primary/);
      await page.keyboard.press(`${modifier}+i`);
      await expect(composer).toBeFocused();
      await page.keyboard.type("draft");
      await page.keyboard.press("ArrowLeft");
      const caret = () =>
        composer.evaluate((input) => {
          const selection = window.getSelection();
          return {
            inside: !!selection?.anchorNode && input.contains(selection.anchorNode),
            offset: selection?.anchorOffset,
          };
        });
      const before = await caret();
      expect(before.inside).toBe(true);
      expect(before.offset).toBe(4);
      // The native contenteditable italic command must be suppressed, and the
      // imperative focus call must preserve the existing caret.
      await page.keyboard.press(`${modifier}+i`);
      expect(await caret()).toEqual(before);
      await page.keyboard.type("X");
      await expect(composer).toHaveText("drafXt");
      await expect(composer.locator("i, em")).toHaveCount(0);
      expect(await composer.evaluate(() => document.queryCommandState("italic"))).toBe(false);

      const terminalPane = page.locator("[data-pane-leaf]").filter({ has: page.locator(".xterm") });
      const terminal = terminalPane.locator("textarea.xterm-helper-textarea");
      await terminalPane.locator(".xterm-screen").click();
      await terminal.focus();
      await page.keyboard.press(`${modifier}+i`);
      const composeBar = terminalPane.getByPlaceholder(
        "Type a message (newlines become spaces)...",
      );
      await expect(composeBar).toBeVisible();
      await expect(composeBar).toBeFocused();
      await page.keyboard.type("terminal draft");
      await expect(composeBar).toHaveValue("terminal draft");
      await expect(composer).toHaveText("drafXt");
      // Activate the chat pane through its input, then leave focus on the
      // chrome so the shortcut has to move it back into the composer.
      await composer.click();
      await paneControl.focus();
      await expect(paneControl).toBeFocused();
      await expect(agent).toHaveClass(/ring-primary/);
      await page.keyboard.press(`${modifier}+i`);
      await expect(composer).toBeFocused();
      await expect(composeBar).toHaveValue("terminal draft");
    });
  }
}

test.describe("every app shortcut works with a leaf shown in the window's tree", () => {
  for (const modifier of ["Meta", "Control"]) {
    test(`${modifier} shortcuts from the leaf's composer reach this window's handlers`, async ({
      page,
    }) => {
      await page.goto("/keyboard-shortcuts?in-tree");
      const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
      const composer = page.getByRole("textbox", { name: "Leaf composer" });
      await composer.fill("draft");

      // ⌘K, ⌘, and ⌘⇧D are the window's, typed in the leaf's workspace in its tree.
      // Ctrl+K in a macOS text field is kill-line, so it stays with the field.
      await page.keyboard.press(`${modifier}+K`);
      await expect(page.getByTestId("search-requests")).toHaveText(
        modifier === "Control" && mac ? "0" : "1",
      );
      await page.keyboard.press(`${modifier}+Comma`);
      await expect(page.getByTestId("settings-requests")).toHaveText("1");
      await page.keyboard.press(`${modifier}+Shift+D`);
      await expect(page.getByTestId("grouping-requests")).toHaveText("1");

      // ⌘T opens a tab in the leaf's workspace only, not in the hidden one.
      // Ctrl+T in a macOS text field is transpose, so it stays with the field.
      await composer.focus();
      await page.keyboard.press(`${modifier}+T`);
      const tabTaken = !(modifier === "Control" && mac);
      await expect(page.getByTestId("leaf-new-tabs")).toHaveText(tabTaken ? "1" : "0");
      await expect(page.getByTestId("command-new-tabs")).toHaveText("0");

      // ⌘⇧/ opens this document's one shortcuts dialog over the leaf.
      await composer.focus();
      await page.keyboard.press(`${modifier}+Shift+Slash`);
      const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(composer).toBeFocused();
      // The draft is the leaf's own; Ctrl+T on macOS transposed its last letters.
      await expect(composer).toHaveValue(tabTaken ? "draft" : "dratf");

      // Back on this window's own node, ⌘T is its workspace's.
      await page.getByRole("button", { name: "Show this machine" }).click();
      await page.getByRole("textbox", { name: "Command composer" }).focus();
      await page.keyboard.press(`${modifier}+T`);
      await expect(page.getByTestId("command-new-tabs")).toHaveText(tabTaken ? "1" : "0");
      await expect(page.getByTestId("leaf-new-tabs")).toHaveText(tabTaken ? "1" : "0");
    });
  }
});
