import { describe, expect, mock, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { createApplicationMenuTemplate } from "../../../apps/desktop/electron/application-menu";

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return Array.isArray(item.submenu) ? item.submenu : [];
}

describe("desktop application menu", () => {
  test("owns Command+W and forwards it as an application tab action", () => {
    const newWindow = mock(() => {});
    const closeTab = mock(() => {});
    const zoom = mock((_direction: "in" | "out" | "reset") => {});
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      newWindow,
      closeTab,
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
});
