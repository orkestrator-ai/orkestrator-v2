import {
  KeyboardShortcutsController,
  isKeyboardShortcutsInput,
  resolveKeyboardShortcutsTarget,
  type KeyboardShortcutsOwner,
  type KeyboardShortcutsRenderer,
  type ShortcutInput,
} from "./keyboard-shortcuts-menu.js";

type Owner = KeyboardShortcutsOwner & { window: { webContents: { id: number } } };
type InputEvent = { preventDefault(): void };
type Contents = {
  id: number;
  on(event: "focus" | "did-navigate", listener: () => void): unknown;
  on(
    event: "before-input-event",
    listener: (event: InputEvent, input: ShortcutInput & { isAutoRepeat?: boolean }) => void,
  ): unknown;
  once(event: "destroyed", listener: () => void): unknown;
};

/** Native input wiring and remembered child ownership, shared by menu commands. */
export class KeyboardShortcutsRouting {
  // Native menu activation can temporarily clear WebContents focus. Remember
  // the child per physical window so realm menu commands keep their owner.
  private readonly lastFocus = new Map<number, number>();

  constructor(
    private readonly owners: () => Iterable<Owner>,
    private readonly controller: KeyboardShortcutsController,
  ) {}

  target(id: number | undefined) {
    return resolveKeyboardShortcutsTarget(id, this.owners());
  }

  focusedTarget(
    focusedId: number | undefined,
    windowId: number,
    fallback: KeyboardShortcutsRenderer,
  ) {
    return this.target(focusedId ?? this.lastFocus.get(windowId)) ?? { renderer: fallback };
  }

  closed(rendererId: number): void {
    // Native children have no preload and cannot restore another owner's focus.
    for (const owner of this.owners()) {
      if (owner.contents.id === rendererId && !owner.contents.isDestroyed()) {
        this.controller.closed(rendererId);
        return;
      }
    }
  }

  register(contents: Contents): void {
    const id = contents.id;
    contents.on("focus", () => {
      const target = this.target(id);
      if (!target) return;
      for (const owner of this.owners()) {
        if (owner.contents.id === target.renderer.id) {
          this.lastFocus.set(owner.window.webContents.id, id);
          return;
        }
      }
    });
    contents.once("destroyed", () => {
      this.controller.forget(id);
      for (const [owner, child] of this.lastFocus) {
        if (owner === id || child === id) this.lastFocus.delete(owner);
      }
    });
    contents.on("did-navigate", () => this.controller.forget(id));
    contents.on("before-input-event", (event, input) => {
      if (!isKeyboardShortcutsInput(input)) return;
      const target = this.target(id);
      if (!target) return;
      // Preview managers own their hook; handling it here would toggle twice.
      for (const owner of this.owners()) {
        if (owner.browserPreviewManager?.ownsWebContents(id)) return;
      }
      event.preventDefault();
      if (!input.isAutoRepeat) this.controller.request(target, "toggle");
    });
  }
}
