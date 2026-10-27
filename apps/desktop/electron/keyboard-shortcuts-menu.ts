import {
  KEYBOARD_SHORTCUTS_EVENT,
  isKeyboardShortcutsChord,
  type KeyboardShortcutsRequest,
} from "@orkestrator/protocol/keyboard-shortcuts";
import { emitToContents, type RendererContents } from "./desktop-window-contexts.js";

/** The renderer that owns the dialog, and can take keyboard focus from a native view. */
export type KeyboardShortcutsRenderer = RendererContents & { focus(): void };

/**
 * Ask a renderer to show its keyboard shortcuts dialog. The renderer takes
 * keyboard focus first: the request may come from a key pressed in a native
 * preview view, which would otherwise keep typing away from the dialog's search.
 */
export function requestKeyboardShortcuts(
  renderer: KeyboardShortcutsRenderer | null | undefined,
  request: KeyboardShortcutsRequest,
): void {
  if (!renderer || renderer.isDestroyed()) return;
  renderer.focus();
  emitToContents(renderer, KEYBOARD_SHORTCUTS_EVENT, request);
}

/** The fields of an Electron `Input` the chord needs. */
export type ShortcutInput = {
  type: string;
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
};

/** Whether a native view's `before-input-event` is ⌘⇧K / Ctrl+Shift+K. */
export function isKeyboardShortcutsInput(input: ShortcutInput): boolean {
  return (
    (input.type === "keyDown" || input.type === "rawKeyDown") &&
    isKeyboardShortcutsChord({
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      shiftKey: input.shift,
      altKey: input.alt,
    })
  );
}
