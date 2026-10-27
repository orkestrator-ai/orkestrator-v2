import { describe, expect, jest, mock, test } from "bun:test";
import { KEYBOARD_SHORTCUTS_EVENT } from "@orkestrator/protocol/keyboard-shortcuts";
import {
  isKeyboardShortcutsInput,
  KeyboardShortcutsController,
  resolveKeyboardShortcutsTarget,
  requestKeyboardShortcuts,
  type KeyboardShortcutsRenderer,
} from "../electron/keyboard-shortcuts-menu";

function renderer(destroyed = false) {
  const calls: string[] = [];
  const contents: KeyboardShortcutsRenderer = {
    id: 7,
    isDestroyed: () => destroyed,
    focus: mock(() => {
      calls.push("focus");
    }),
    send: mock((channel: string, ...args: unknown[]) => {
      calls.push(`send:${channel}:${args.join(",")}`);
    }),
  };
  return { contents, calls };
}

describe("requestKeyboardShortcuts", () => {
  test("focuses the renderer, then delivers the request on the renderer event channel", () => {
    const { contents, calls } = renderer();
    requestKeyboardShortcuts(contents, "open");
    requestKeyboardShortcuts(contents, "toggle");
    expect(calls).toEqual([
      "focus",
      `send:orkestrator:event:${KEYBOARD_SHORTCUTS_EVENT},open`,
      "focus",
      `send:orkestrator:event:${KEYBOARD_SHORTCUTS_EVENT},toggle`,
    ]);
  });

  test("does nothing without a live renderer", () => {
    const { contents, calls } = renderer(true);
    requestKeyboardShortcuts(contents, "open");
    requestKeyboardShortcuts(null, "open");
    expect(calls).toEqual([]);
  });
});

describe("isKeyboardShortcutsInput", () => {
  const input = {
    type: "keyDown",
    key: "K",
    code: "KeyK",
    meta: true,
    control: false,
    shift: true,
    alt: false,
  };

  test("matches the chord on key down only", () => {
    expect(isKeyboardShortcutsInput(input)).toBe(true);
    expect(isKeyboardShortcutsInput({ ...input, type: "rawKeyDown" })).toBe(false);
    expect(isKeyboardShortcutsInput({ ...input, meta: false, control: true })).toBe(true);
    expect(isKeyboardShortcutsInput({ ...input, type: "keyUp" })).toBe(false);
    expect(isKeyboardShortcutsInput({ ...input, shift: false })).toBe(false);
  });
});

describe("KeyboardShortcutsController", () => {
  test("keeps the native origin across open and close requests and waits for overlay visibility", async () => {
    const { contents } = renderer();
    const controller = new KeyboardShortcutsController();
    let visible = false;
    const restore = mock(() => visible);
    controller.request({ renderer: contents, restoreFocus: restore }, "toggle");
    controller.request({ renderer: contents }, "toggle");
    controller.closed(contents.id);
    await Bun.sleep(10);
    expect(restore).toHaveBeenCalled();
    visible = true;
    await Bun.sleep(40);
    const count = restore.mock.calls.length;
    await Bun.sleep(40);
    expect(restore).toHaveBeenCalledTimes(count);
  });

  test.each([0, 75])("retains the origin when reopening %s ms into restoration", (elapsed) => {
    jest.useFakeTimers();
    const { contents } = renderer();
    const controller = new KeyboardShortcutsController();
    let visible = false;
    const restore = mock(() => visible);
    try {
      controller.request({ renderer: contents, restoreFocus: restore }, "open");
      controller.closed(contents.id);
      if (elapsed) jest.advanceTimersByTime(elapsed);
      expect(restore.mock.calls.length > 0).toBe(elapsed > 0);
      controller.request({ renderer: contents }, "open");
      const attempts = restore.mock.calls.length;
      visible = true;
      jest.advanceTimersByTime(500);
      expect(restore).toHaveBeenCalledTimes(attempts); // Never focus behind an open dialog.
      controller.closed(contents.id);
      jest.advanceTimersByTime(1);
      expect(restore).toHaveBeenCalledTimes(attempts + 1);
      controller.closed(contents.id);
      jest.advanceTimersByTime(500);
      expect(restore).toHaveBeenCalledTimes(attempts + 1); // Origin consumed on success.
    } finally {
      controller.forget(contents.id);
      jest.useRealTimers();
    }
  });

  test("expires an invisible origin instead of restoring it on a later renderer-only open", () => {
    jest.useFakeTimers();
    const { contents } = renderer();
    const controller = new KeyboardShortcutsController();
    const restore = mock(() => false);
    try {
      controller.request({ renderer: contents, restoreFocus: restore }, "open");
      controller.closed(contents.id);
      jest.advanceTimersByTime(500);
      expect(restore).toHaveBeenCalledTimes(20);
      controller.request({ renderer: contents }, "open");
      controller.closed(contents.id);
      jest.advanceTimersByTime(500);
      expect(restore).toHaveBeenCalledTimes(20);
    } finally {
      controller.forget(contents.id);
      jest.useRealTimers();
    }
  });

  test("renderer-only opens have no native restoration and disposal cancels pending restoration", async () => {
    const { contents } = renderer();
    const controller = new KeyboardShortcutsController();
    const restore = mock(() => false);
    controller.request({ renderer: contents }, "open");
    controller.closed(contents.id);
    controller.request({ renderer: contents, restoreFocus: restore }, "open");
    controller.closed(contents.id);
    controller.forget(contents.id);
    await Bun.sleep(40);
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("keyboard shortcut ownership", () => {
  test("routes a realm preview and artifact to the realm, even when only the child is focused", () => {
    const shell = renderer().contents;
    const realm = { ...renderer().contents, id: 8, isFocused: () => false };
    const previewFocus = mock(() => true);
    const artifactFocus = mock(() => true);
    const owners = [
      {
        contents: { ...shell, isFocused: () => false },
        window: { isFocused: () => true },
        browserPreviewManager: null,
        artifactHosts: null,
      },
      {
        contents: realm,
        window: { isFocused: () => true },
        browserPreviewManager: {
          ownsWebContents: (id: number) => id === 42,
          focusWebContents: previewFocus,
        },
        artifactHosts: {
          activeHost: () => ({ webContents: () => ({ id: 43 }), focusIfVisible: artifactFocus }),
        },
      },
    ];
    for (const id of [42, 43]) {
      const target = resolveKeyboardShortcutsTarget(id, owners)!;
      expect(target.renderer.id).toBe(8);
      const controller = new KeyboardShortcutsController();
      controller.request(target, "open");
      expect(realm.send).toHaveBeenLastCalledWith(
        "orkestrator:event",
        "menu-keyboard-shortcuts",
        "open",
      );
      expect(target.restoreFocus?.()).toBe(false); // another surface owns focus
    }
    realm.isFocused = () => true;
    expect(resolveKeyboardShortcutsTarget(42, owners)?.restoreFocus?.()).toBe(true);
    expect(previewFocus).toHaveBeenCalledWith(42);
    expect(resolveKeyboardShortcutsTarget(43, owners)?.restoreFocus?.()).toBe(true);
    expect(artifactFocus).toHaveBeenCalledTimes(1);
    expect(resolveKeyboardShortcutsTarget(999, owners)).toBeNull();
  });
});
