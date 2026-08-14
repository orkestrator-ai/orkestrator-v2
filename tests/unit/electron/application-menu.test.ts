import { describe, expect, mock, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { createApplicationMenuTemplate } from "../../../apps/desktop/electron/application-menu";

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return Array.isArray(item.submenu) ? item.submenu : [];
}

describe("desktop application menu", () => {
  test("owns Command+W and forwards it as an application tab action", () => {
    const closeTab = mock(() => {});
    const zoom = mock((_direction: "in" | "out" | "reset") => {});
    const template = createApplicationMenuTemplate({
      productName: "Orkestrator AI",
      closeTab,
      zoom,
    });

    const fileMenu = template.find((item) => item.label === "File");
    const closeItem = fileMenu && submenu(fileMenu).find((item) => item.label === "Close Tab");
    expect(closeItem?.accelerator).toBe("Command+W");

    (closeItem?.click as (() => void) | undefined)?.();
    expect(closeTab).toHaveBeenCalledTimes(1);
  });
});
