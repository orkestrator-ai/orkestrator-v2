import { describe, expect, mock, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import {
  createApplicationMenuTemplate,
  type ApplicationMenuWindow,
} from "../../../apps/desktop/electron/application-menu";

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

describe("desktop application menu", () => {
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
    });

    const placeholder = windowItem(template, "No Open Windows");
    expect(placeholder?.enabled).toBe(false);
  });
});
