import { describe, expect, mock, test } from "bun:test";
import {
  applyWindowTitle,
  focusWindowById,
  projectMenuWindows,
  type FocusableWindow,
  type MenuSourceWindow,
} from "../../../apps/desktop/electron/window-menu";

function sourceWindow(options: {
  title?: string;
  destroyed?: boolean;
}): MenuSourceWindow & { getTitle: ReturnType<typeof mock> } {
  return {
    isDestroyed: () => options.destroyed ?? false,
    getTitle: mock(() => options.title ?? ""),
  };
}

function focusableWindow(options: { destroyed?: boolean; minimized?: boolean }): FocusableWindow {
  return {
    isDestroyed: () => options.destroyed ?? false,
    isMinimized: () => options.minimized ?? false,
    restore: mock(() => undefined),
    show: mock(() => undefined),
    focus: mock(() => undefined),
  };
}

describe("projectMenuWindows", () => {
  test("projects live windows with their id, title, and focused flag", () => {
    const focused = sourceWindow({ title: "Orkestrator AI — Local" });
    const other = sourceWindow({ title: "Orkestrator AI — Staging" });
    const contexts = new Map([
      [11, { window: focused }],
      [22, { window: other }],
    ]);

    expect(projectMenuWindows(contexts, focused)).toEqual([
      { id: 11, title: "Orkestrator AI — Local", focused: true },
      { id: 22, title: "Orkestrator AI — Staging", focused: false },
    ]);
    expect(other.getTitle).toHaveBeenCalledTimes(1);
  });

  test("skips destroyed windows without reading their title", () => {
    const destroyed = sourceWindow({ title: "Destroyed", destroyed: true });
    const live = sourceWindow({ title: "Live" });
    const contexts = new Map([
      [1, { window: destroyed }],
      [2, { window: live }],
    ]);

    expect(projectMenuWindows(contexts, null)).toEqual([{ id: 2, title: "Live", focused: false }]);
    expect(destroyed.getTitle).not.toHaveBeenCalled();
  });

  test("returns an empty list when nothing is registered", () => {
    expect(projectMenuWindows([], null)).toEqual([]);
  });
});

describe("focusWindowById", () => {
  test("is a no-op for an unknown id", () => {
    expect(() => focusWindowById(new Map(), 99)).not.toThrow();
  });

  test("is a no-op for a destroyed window", () => {
    const window = focusableWindow({ destroyed: true });
    focusWindowById(new Map([[7, { window }]]), 7);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  test("restores a minimized window before showing and focusing it", () => {
    const window = focusableWindow({ minimized: true });
    focusWindowById(new Map([[7, { window }]]), 7);
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  test("does not restore a window that is already visible", () => {
    const window = focusableWindow({ minimized: false });
    focusWindowById(new Map([[7, { window }]]), 7);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });
});

describe("applyWindowTitle", () => {
  test("uses the active connection name and refreshes the menu", () => {
    const setTitle = mock((_title: string) => undefined);
    const refreshMenu = mock(() => undefined);

    applyWindowTitle({ setTitle }, "Orkestrator AI", "Staging", refreshMenu);

    expect(setTitle).toHaveBeenCalledWith("Orkestrator AI — Staging");
    expect(refreshMenu).toHaveBeenCalledTimes(1);
  });

  test("falls back to Local when no connection is active", () => {
    const setTitle = mock((_title: string) => undefined);
    const refreshMenu = mock(() => undefined);

    applyWindowTitle({ setTitle }, "Orkestrator AI", undefined, refreshMenu);

    expect(setTitle).toHaveBeenCalledWith("Orkestrator AI — Local");
    expect(refreshMenu).toHaveBeenCalledTimes(1);
  });
});
