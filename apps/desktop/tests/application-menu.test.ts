import { describe, expect, mock, test } from "bun:test";
import type { KeyboardEvent as MenuKeyboardEvent, MenuItemConstructorOptions } from "electron";
import {
  createApplicationMenuTemplate,
  type ApplicationMenuActions,
  type ApplicationMenuWindow,
} from "../electron/application-menu";

function menuActions(overrides: Partial<ApplicationMenuActions> = {}): ApplicationMenuActions {
  return {
    platform: "darwin",
    productName: "Orkestrator AI",
    windows: [],
    newWindow: () => {},
    closeTab: () => {},
    selectWindow: () => {},
    zoom: () => {},
    showKeyboardShortcuts: () => {},
    openSettings: () => {},
    ...overrides,
  };
}

/** An item's label, or its role or type when it has none. */
function itemNames(items: MenuItemConstructorOptions[]): string[] {
  return items.map((item) => item.label ?? item.role ?? item.type ?? "");
}

/** Every item in the template, submenus included. */
function allItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...allItems(submenu(item))]);
}

function menuItem(
  template: MenuItemConstructorOptions[],
  menu: string,
  label: string,
): MenuItemConstructorOptions | undefined {
  const top = template.find((item) => item.label === menu);
  return top && submenu(top).find((item) => item.label === label);
}

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return Array.isArray(item.submenu) ? item.submenu : [];
}

function windowItem(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions | undefined {
  const windowMenu = template.find((item) => item.label === "Window");
  return windowMenu && submenu(windowMenu).find((item) => item.label === label);
}

function windowRadioItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const windowMenu = template.find((item) => item.label === "Window");
  return windowMenu ? submenu(windowMenu).filter((item) => item.type === "radio") : [];
}

function windowRadioLabels(template: MenuItemConstructorOptions[]): string[] {
  return windowRadioItems(template).map((item) => item.label ?? "");
}

describe("desktop application menu on macOS", () => {
  test("includes the update menu action only for supported installs and invokes it", () => {
    const actions = menuActions();
    const withoutUpdater = createApplicationMenuTemplate(actions);
    expect(submenu(withoutUpdater[0]!).some((item) => item.label === "Check for Updates…")).toBe(
      false,
    );
    const checkForUpdates = mock(() => {});
    const withUpdater = createApplicationMenuTemplate({ ...actions, checkForUpdates });
    const item = submenu(withUpdater[0]!).find((item) => item.label === "Check for Updates…");
    expect(item).toBeDefined();
    (item?.click as (() => void) | undefined)?.();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test("owns Command+W and forwards it as an application tab action", () => {
    const newWindow = mock(() => {});
    const closeTab = mock(() => {});
    const zoom = mock((_direction: "in" | "out" | "reset") => {});
    const template = createApplicationMenuTemplate(
      menuActions({
        newWindow,
        closeTab,
        zoom,
      }),
    );

    const fileMenu = template.find((item) => item.label === "File");
    const newWindowItem = fileMenu && submenu(fileMenu).find((item) => item.label === "New Window");
    const closeItem = fileMenu && submenu(fileMenu).find((item) => item.label === "Close Tab");
    expect(newWindowItem?.accelerator).toBe("CmdOrCtrl+N");
    expect(closeItem?.accelerator).toBe("Command+W");

    (newWindowItem?.click as (() => void) | undefined)?.();
    (closeItem?.click as (() => void) | undefined)?.();
    expect(newWindow).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledTimes(1);
  });

  test("places a Window menu after View", () => {
    const template = createApplicationMenuTemplate(menuActions());

    const labels = template.map((item) => item.label);
    expect(labels).toEqual(["Orkestrator AI", "File", "Edit", "View", "Window"]);
  });

  test("keeps the macOS app menu roles and Window › Zoom", () => {
    const template = createApplicationMenuTemplate(menuActions());
    expect(itemNames(submenu(template[0]!))).toEqual([
      "about",
      "separator",
      "Settings…",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit",
    ]);
    expect(itemNames(submenu(template.find((item) => item.label === "Window")!))).toEqual([
      "minimize",
      "zoom",
      "separator",
      "No Open Windows",
    ]);
  });

  test("lists open windows and switches to the clicked one", () => {
    const selectWindow = mock((_id: number) => {});
    const windows: ApplicationMenuWindow[] = [
      { id: 11, title: "Orkestrator AI — Local", focused: true },
      { id: 22, title: "Orkestrator AI — Staging", focused: false },
    ];
    const template = createApplicationMenuTemplate(
      menuActions({
        windows,
        selectWindow,
      }),
    );

    const localItem = windowItem(template, "Orkestrator AI — Local");
    const stagingItem = windowItem(template, "Orkestrator AI — Staging");
    expect(localItem?.type).toBe("radio");
    expect(localItem?.checked).toBe(true);
    expect(stagingItem?.checked).toBe(false);

    (stagingItem?.click as (() => void) | undefined)?.();
    expect(selectWindow).toHaveBeenCalledWith(22);
  });

  test("disambiguates windows that share a title", () => {
    const selectWindow = mock((_id: number) => {});
    const template = createApplicationMenuTemplate(
      menuActions({
        windows: [
          { id: 1, title: "Orkestrator AI — Local", focused: true },
          { id: 2, title: "Orkestrator AI — Local", focused: false },
        ],
        selectWindow,
      }),
    );

    const first = windowItem(template, "Orkestrator AI — Local (1)");
    const second = windowItem(template, "Orkestrator AI — Local (2)");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    (second?.click as (() => void) | undefined)?.();
    expect(selectWindow).toHaveBeenCalledWith(2);
  });

  test("shows a disabled placeholder when no windows are open", () => {
    const template = createApplicationMenuTemplate(menuActions());

    const placeholder = windowItem(template, "No Open Windows");
    expect(placeholder?.enabled).toBe(false);
  });

  test("numbers duplicates without touching a unique title", () => {
    const template = createApplicationMenuTemplate(
      menuActions({
        windows: [
          { id: 1, title: "Orkestrator AI — Local", focused: true },
          { id: 2, title: "Orkestrator AI — Local", focused: false },
          { id: 3, title: "Orkestrator AI — Staging", focused: false },
        ],
      }),
    );

    expect(windowRadioLabels(template)).toEqual([
      "Orkestrator AI — Local (1)",
      "Orkestrator AI — Local (2)",
      "Orkestrator AI — Staging",
    ]);
  });

  test("keeps every label distinct when a title already looks like a suffix", () => {
    const template = createApplicationMenuTemplate(
      menuActions({
        windows: [
          { id: 1, title: "A", focused: true },
          { id: 2, title: "A (1)", focused: false },
          { id: 3, title: "A", focused: false },
        ],
      }),
    );

    const labels = windowRadioLabels(template);
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(labels.length);
    // Every radio remains individually addressable by its distinct label.
    for (const label of labels) {
      expect(windowItem(template, label)).toBeDefined();
    }
  });

  test("leaves no radio checked when no window is focused", () => {
    const template = createApplicationMenuTemplate(
      menuActions({
        windows: [
          { id: 1, title: "Orkestrator AI — Local", focused: false },
          { id: 2, title: "Orkestrator AI — Staging", focused: false },
        ],
      }),
    );

    expect(windowRadioItems(template).every((item) => item.checked === false)).toBe(true);
  });

  test("the app menu offers Settings… with ⌘, after the update check, shown but owned by the routers", () => {
    const openSettings = mock(() => {});
    const template = createApplicationMenuTemplate(
      menuActions({ openSettings, checkForUpdates: () => {} }),
    );
    expect(itemNames(submenu(template[0]!)).slice(0, 4)).toEqual([
      "about",
      "Check for Updates…",
      "separator",
      "Settings…",
    ]);
    const item = menuItem(template, "Orkestrator AI", "Settings…")!;
    expect(item.accelerator).toBe("CmdOrCtrl+,");
    // The app shortcut routers own the key; the menu only labels it, so a
    // press is never delivered twice.
    expect(item.registerAccelerator).toBe(false);
    (item.click as () => void)();
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(allItems(template).filter((entry) => entry.label === "Settings…")).toHaveLength(1);
  });

  test("View offers Keyboard Shortcuts… with its chord, shown but owned by native input", () => {
    const zoom = mock((_direction: "in" | "out" | "reset") => {});
    const showKeyboardShortcuts = mock((_request: "open" | "toggle") => {});
    const template = createApplicationMenuTemplate(
      menuActions({
        zoom,
        showKeyboardShortcuts,
      }),
    );

    const viewMenu = template.find((item) => item.label === "View");
    const items = viewMenu ? submenu(viewMenu) : [];
    expect(items.map((item) => item.label ?? item.type)).toEqual([
      "Zoom In",
      "Zoom Out",
      "separator",
      "Actual Size",
      "separator",
      "Keyboard Shortcuts…",
    ]);
    const item = items.at(-1)!;
    expect(item.accelerator).toBe("CmdOrCtrl+Shift+K");
    // Display-only on Windows and Linux: main's before-input-event hook owns the key.
    expect(item.registerAccelerator).toBe(false);

    const click = item.click as (
      menuItem: unknown,
      window: unknown,
      event: MenuKeyboardEvent,
    ) => void;
    // A pointer or keyboard-navigated click opens; it never closes the dialog.
    click(undefined, undefined, {});
    click(undefined, undefined, { triggeredByAccelerator: false });
    click(undefined, undefined, { triggeredByAccelerator: true, shiftKey: false, metaKey: false });
    // macOS's key equivalent fires only for a press no page claimed; it toggles.
    click(undefined, undefined, { triggeredByAccelerator: true, shiftKey: true, metaKey: true });
    expect(showKeyboardShortcuts.mock.calls).toEqual([["open"], ["open"], ["open"], ["toggle"]]);
    expect(zoom).not.toHaveBeenCalled();
  });
});

describe.each(["linux", "win32"] as const)("desktop application menu on %s", (platform) => {
  test("uses the platform layout: Quit ends File and About lives under Help", () => {
    const template = createApplicationMenuTemplate(menuActions({ platform }));
    expect(template.map((item) => item.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
    expect(itemNames(submenu(template[0]!))).toEqual([
      "New Window",
      "separator",
      "Close Tab",
      "separator",
      "Settings…",
      "separator",
      "quit",
    ]);
    const help = template.find((item) => item.label === "Help")!;
    expect(itemNames(submenu(help))).toEqual(["about"]);
    expect(itemNames(submenu(template.find((item) => item.label === "Window")!))).toEqual([
      "minimize",
      "separator",
      "No Open Windows",
    ]);
  });

  test("offers Check for Updates… under Help when the install can update itself", () => {
    const checkForUpdates = mock(() => {});
    const template = createApplicationMenuTemplate(menuActions({ platform, checkForUpdates }));
    const help = template.find((item) => item.label === "Help")!;
    expect(itemNames(submenu(help))).toEqual(["Check for Updates…", "separator", "about"]);
    (menuItem(template, "Help", "Check for Updates…")?.click as (() => void) | undefined)?.();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test("leaves out the macOS-only roles, which have no action here", () => {
    const roles = allItems(createApplicationMenuTemplate(menuActions({ platform }))).map(
      (item) => item.role,
    );
    for (const role of ["hide", "hideOthers", "unhide", "zoom", "services", "front"] as const) {
      expect(roles).not.toContain(role);
    }
  });

  test("registers no Command or Super accelerator, which Electron maps to the Super/Windows key", () => {
    const closeTab = mock(() => {});
    const template = createApplicationMenuTemplate(menuActions({ platform, closeTab }));
    for (const item of allItems(template)) {
      const modifiers = String(item.accelerator ?? "")
        .toLowerCase()
        .split("+")
        .slice(0, -1);
      for (const modifier of ["command", "cmd", "super", "meta"]) {
        expect(modifiers).not.toContain(modifier);
      }
    }
    // Close Tab stays available from the menu, without a key.
    const close = menuItem(template, "File", "Close Tab");
    expect(close?.accelerator).toBeUndefined();
    (close?.click as (() => void) | undefined)?.();
    expect(closeTab).toHaveBeenCalledTimes(1);
  });

  test("keeps the Ctrl accelerators the shortcuts dialog lists for this platform", () => {
    const zoom = mock((_direction: "in" | "out" | "reset") => {});
    const showKeyboardShortcuts = mock((_request: "open" | "toggle") => {});
    const template = createApplicationMenuTemplate(
      menuActions({ platform, zoom, showKeyboardShortcuts }),
    );
    // CmdOrCtrl is Control here: Ctrl+N, Ctrl+=, Ctrl+-, Ctrl+0 and Ctrl+Shift+K.
    expect(menuItem(template, "File", "New Window")?.accelerator).toBe("CmdOrCtrl+N");
    expect(menuItem(template, "View", "Zoom In")?.accelerator).toBe("CmdOrCtrl+=");
    expect(menuItem(template, "View", "Zoom Out")?.accelerator).toBe("CmdOrCtrl+-");
    expect(menuItem(template, "View", "Actual Size")?.accelerator).toBe("CmdOrCtrl+0");

    const settings = menuItem(template, "File", "Settings…")!;
    expect(settings.accelerator).toBe("CmdOrCtrl+,");
    expect(settings.registerAccelerator).toBe(false);

    const shortcuts = menuItem(template, "View", "Keyboard Shortcuts…")!;
    expect(shortcuts.accelerator).toBe("CmdOrCtrl+Shift+K");
    // Shown as Ctrl+Shift+K but never registered: main's before-input-event
    // hook is the only owner of the key, so one press cannot toggle twice.
    expect(shortcuts.registerAccelerator).toBe(false);
    const click = shortcuts.click as (
      menuItem: unknown,
      window: unknown,
      event: MenuKeyboardEvent,
    ) => void;
    // Enter-based menu navigation reports triggeredByAccelerator even for
    // unregistered items. It opens and never closes the dialog.
    click(undefined, undefined, {});
    click(undefined, undefined, { triggeredByAccelerator: false });
    click(undefined, undefined, { triggeredByAccelerator: true, ctrlKey: false, shiftKey: false });
    expect(showKeyboardShortcuts.mock.calls).toEqual([["open"], ["open"], ["open"]]);
  });
});

describe.each(["darwin", "linux", "win32"] as const)("shortcut menu input on %s", (platform) => {
  test("toggles only for Shift and the platform accelerator modifier", () => {
    const showKeyboardShortcuts = mock((_request: "open" | "toggle") => {});
    const template = createApplicationMenuTemplate(
      menuActions({ platform, showKeyboardShortcuts }),
    );
    const click = menuItem(template, "View", "Keyboard Shortcuts…")!.click!;
    const chord = {
      triggeredByAccelerator: true,
      shiftKey: true,
      metaKey: platform === "darwin",
      ctrlKey: platform !== "darwin",
    };
    for (const event of [
      chord,
      { ...chord, shiftKey: false },
      { ...chord, altKey: true },
      { ...chord, metaKey: true, ctrlKey: true },
      { ...chord, metaKey: !chord.metaKey, ctrlKey: !chord.ctrlKey },
      { ...chord, triggeredByAccelerator: false },
    ]) {
      click({} as Electron.MenuItem, undefined, event);
    }
    expect(showKeyboardShortcuts.mock.calls).toEqual([
      ["toggle"],
      ["open"],
      ["open"],
      ["open"],
      ["open"],
      ["open"],
    ]);
  });
});
