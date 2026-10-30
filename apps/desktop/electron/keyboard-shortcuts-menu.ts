import {
  APP_SHORTCUT_EVENT,
  KEYBOARD_SHORTCUTS_EVENT,
  matchAppShortcut,
  type AppShortcutId,
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

/** The app shortcut a native `before-input-event` key press is, if any. */
export function appShortcutForInput(input: ShortcutInput): AppShortcutId | null {
  if (input.type !== "keyDown") return null;
  return matchAppShortcut({
    key: input.key,
    code: input.code,
    metaKey: input.meta,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
  });
}

/** Whether a native view's `before-input-event` is ⌘⇧/ / Ctrl+Shift+/. */
export function isKeyboardShortcutsInput(input: ShortcutInput): boolean {
  return appShortcutForInput(input) === "show-shortcuts";
}

/**
 * Hand a window-owned app shortcut to the window's shell renderer, giving it
 * keyboard focus first so the UI it opens (the search) takes the next keys.
 */
export function requestAppShortcut(
  renderer: KeyboardShortcutsRenderer | null | undefined,
  id: AppShortcutId,
): void {
  if (!renderer || renderer.isDestroyed()) return;
  renderer.focus();
  emitToContents(renderer, APP_SHORTCUT_EVENT, id);
}

export type KeyboardShortcutsTarget = {
  renderer: KeyboardShortcutsRenderer;
  /** Returns true only after the original, still visible native view took focus. */
  restoreFocus?: () => boolean;
};

export type KeyboardShortcutsOwner = {
  contents: KeyboardShortcutsRenderer & { isFocused(): boolean };
  window: { isFocused(): boolean };
  browserPreviewManager: {
    ownsWebContents(id: number): boolean;
    focusWebContents(id: number): boolean;
  } | null;
  artifactHosts: {
    activeHost(): {
      webContents(): { id: number } | null;
      focusIfVisible(): boolean;
    } | null;
  } | null;
};

/** Match actual WebContents ownership; renderer focus alone misses child views. */
export function resolveKeyboardShortcutsTarget(
  id: number | undefined,
  owners: Iterable<KeyboardShortcutsOwner>,
): KeyboardShortcutsTarget | null {
  if (id === undefined) return null;
  for (const owner of owners) {
    if (owner.contents.isDestroyed()) continue;
    if (owner.contents.id === id) return { renderer: owner.contents };
    const previews = owner.browserPreviewManager;
    const host = owner.artifactHosts?.activeHost();
    const restore = previews?.ownsWebContents(id)
      ? () => previews.focusWebContents(id)
      : host?.webContents()?.id === id
        ? () => host.focusIfVisible()
        : null;
    if (restore)
      return {
        renderer: owner.contents,
        restoreFocus: () =>
          !owner.contents.isDestroyed() &&
          owner.window.isFocused() &&
          owner.contents.isFocused() &&
          restore(),
      };
  }
  return null;
}

/** Owns focus across the native-view → dialog → native-view round trip. */
export class KeyboardShortcutsController {
  private readonly origins = new Map<number, () => boolean>();
  private readonly restores = new Map<number, ReturnType<typeof setTimeout>>();

  forget(rendererId: number): void {
    this.origins.delete(rendererId);
    clearTimeout(this.restores.get(rendererId));
    this.restores.delete(rendererId);
  }

  request(target: KeyboardShortcutsTarget | null, request: KeyboardShortcutsRequest): void {
    if (!target || target.renderer.isDestroyed()) return;
    const id = target.renderer.id;
    // Keep the origin while cancelling: a renderer may reopen before the
    // overlay becomes visible, and its final dismissal still owes this focus.
    clearTimeout(this.restores.get(id));
    this.restores.delete(id);
    if (target.restoreFocus && !this.origins.has(id)) this.origins.set(id, target.restoreFocus);
    requestKeyboardShortcuts(target.renderer, request);
  }

  closed(rendererId: number): void {
    const restore = this.origins.get(rendererId);
    if (!restore) return;
    clearTimeout(this.restores.get(rendererId));
    // Overlay visibility updates travel over a different IPC channel. Wait for
    // the live view to be shown again; a hidden/disposed view never takes focus.
    let remaining = 20;
    const attempt = () => {
      this.restores.delete(rendererId);
      if (restore() || --remaining === 0) {
        this.origins.delete(rendererId);
        return;
      }
      this.restores.set(rendererId, setTimeout(attempt, 25));
    };
    this.restores.set(rendererId, setTimeout(attempt, 0));
  }
}
