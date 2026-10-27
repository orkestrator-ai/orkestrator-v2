import { describe, expect, mock, test } from "bun:test";
import type { KeyboardEvent as MenuKeyboardEvent, MenuItemConstructorOptions } from "electron";
import {
  createApplicationMenuTemplate,
  type ApplicationMenuWindow,
} from "../electron/application-menu";

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

describe("desktop application menu", () => {
  test("includes the update menu action only for supported installs and invokes it", () => {
    const actions = {
      productName: "Orkestrator AI",
      windows: [],
      newWindow: () => {},
      closeTab: () => {},
      selectWindow: () => {},
      zoom: () => {},
      showKeyboardShortcuts: () => {},
    };
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
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      windows: [],
      newWindow,
      closeTab,
      selectWindow: () => {},
      zoom,
      showKeyboardShortcuts: () => {},
    });

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
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      windows: [],
      newWindow: () => {},
      closeTab: () => {},
      selectWindow: () => {},
      zoom: () => {},
      showKeyboardShortcuts: () => {},
    });

    const labels = template.map((item) => item.label);
    expect(labels).toEqual(["Orkestrator AI", "File", "Edit", "View", "Window"]);
  });

  test("lists open windows and switches to the clicked one", () => {
    const selectWindow = mock((_id: number) => {});
    const windows: ApplicationMenuWindow[] = [
      { id: 11, title: "Orkestrator AI — Local", focused: true },
      { id: 22, title: "Orkestrator AI — Staging", focused: false },
    ];
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      windows,
      newWindow: () => {},
      closeTab: () => {},
      selectWindow,
      zoom: () => {},
      showKeyboardShortcuts: () => {},
    });

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
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      windows: [
        { id: 1, title: "Orkestrator AI — Local", focused: true },
        { id: 2, title: "Orkestrator AI — Local", focused: false },
      ],
      newWindow: () => {},
      closeTab: () => {},
      selectWindow,
      zoom: () => {},
      showKeyboardShortcuts: () => {},
    });

    const first = windowItem(template, "Orkestrator AI — Local (1)");
    const second = windowItem(template, "Orkestrator AI — Local (2)");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    (second?.click as (() => void) | undefined)?.();
    expect(selectWindow).toHaveBeenCalledWith(2);
  });

  test("shows a disabled placeholder when no windows are open", () => {
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      windows: [],
      newWindow: () => {},
      closeTab: () => {},
      selectWindow: () => {},
      zoom: () => {},
      showKeyboardShortcuts: () => {},
    });

    const placeholder = windowItem(template, "No Open Windows");
    expect(placeholder?.enabled).toBe(false);
  });

  test("numbers duplicates without touching a unique title", () => {
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      windows: [
        { id: 1, title: "Orkestrator AI — Local", focused: true },
        { id: 2, title: "Orkestrator AI — Local", focused: false },
        { id: 3, title: "Orkestrator AI — Staging", focused: false },
      ],
      newWindow: () => {},
      closeTab: () => {},
      selectWindow: () => {},
      zoom: () => {},
      showKeyboardShortcuts: () => {},
    });

    expect(windowRadioLabels(template)).toEqual([
      "Orkestrator AI — Local (1)",
      "Orkestrator AI — Local (2)",
      "Orkestrator AI — Staging",
    ]);
  });

  test("keeps every label distinct when a title already looks like a suffix", () => {
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      windows: [
        { id: 1, title: "A", focused: true },
        { id: 2, title: "A (1)", focused: false },
        { id: 3, title: "A", focused: false },
      ],
      newWindow: () => {},
      closeTab: () => {},
      selectWindow: () => {},
      zoom: () => {},
      showKeyboardShortcuts: () => {},
    });

    const labels = windowRadioLabels(template);
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(labels.length);
    // Every radio remains individually addressable by its distinct label.
    for (const label of labels) {
      expect(windowItem(template, label)).toBeDefined();
    }
  });

  test("leaves no radio checked when no window is focused", () => {
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      windows: [
        { id: 1, title: "Orkestrator AI — Local", focused: false },
        { id: 2, title: "Orkestrator AI — Staging", focused: false },
      ],
      newWindow: () => {},
      closeTab: () => {},
      selectWindow: () => {},
      zoom: () => {},
      showKeyboardShortcuts: () => {},
    });

    expect(windowRadioItems(template).every((item) => item.checked === false)).toBe(true);
  });

  test("View offers Keyboard Shortcuts… with its chord, shown but owned by the renderer", () => {
    const zoom = mock((_direction: "in" | "out" | "reset") => {});
    const showKeyboardShortcuts = mock((_request: "open" | "toggle") => {});
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      windows: [],
      newWindow: () => {},
      closeTab: () => {},
      selectWindow: () => {},
      zoom,
      showKeyboardShortcuts,
    });

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
    // Display-only on Windows and Linux: the renderer's own handler sees the key.
    expect(item.registerAccelerator).toBe(false);

    const click = item.click as (
      menuItem: unknown,
      window: unknown,
      event: MenuKeyboardEvent,
    ) => void;
    // A pointer or keyboard-navigated click opens; it never closes the dialog.
    click(undefined, undefined, {});
    click(undefined, undefined, { triggeredByAccelerator: false });
    // macOS's key equivalent fires only for a press no page claimed; it toggles.
    click(undefined, undefined, { triggeredByAccelerator: true });
    expect(showKeyboardShortcuts.mock.calls).toEqual([["open"], ["open"], ["toggle"]]);
    expect(zoom).not.toHaveBeenCalled();
  });
});
