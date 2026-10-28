import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { emitToContents } from "../electron/desktop-window-contexts";
import { KeyboardShortcutsController } from "../electron/keyboard-shortcuts-menu";
import { KeyboardShortcutsRouting } from "../electron/keyboard-shortcuts-routing";

function harness(platform: NodeJS.Platform = "linux") {
  const contents = (id: number) => ({
    id,
    isDestroyed: () => false,
    isFocused: () => true,
    focus: mock(() => {}),
    send: mock(() => {}),
  });
  const shell = contents(1);
  const realm = contents(2);
  const otherWindow = contents(3);
  const window = { webContents: shell, isFocused: () => true };
  const owners = [shell, realm, otherWindow].map((contents) => ({
    contents,
    window: contents === otherWindow ? { webContents: otherWindow, isFocused: () => true } : window,
    browserPreviewManager: {
      ownsWebContents: (id: number) => contents === realm && id === 42,
      focusWebContents: mock(() => true),
    },
    artifactHosts: {
      activeHost: () =>
        contents === realm
          ? { webContents: () => ({ id: 43 }), focusIfVisible: mock(() => true) }
          : null,
    },
  }));
  const controller = new KeyboardShortcutsController();
  const routing = new KeyboardShortcutsRouting(() => owners, controller, platform);
  const register = (id: number) => {
    const source = Object.assign(new EventEmitter(), { id });
    routing.register(source);
    return source;
  };
  return { shell, realm, otherWindow, owners, controller, routing, register };
}

const chord = {
  type: "keyDown",
  key: "K",
  code: "KeyK",
  meta: true,
  control: false,
  shift: true,
  alt: false,
};

describe("native shortcut routing", () => {
  test.each([42, 43])(
    "Close Tab and shortcuts follow realm child %s, even after menu activation clears focus",
    (child) => {
      const { routing, register, shell, realm, otherWindow } = harness();
      const source = register(child);
      source.emit("focus");
      for (const focusedId of [child, undefined]) {
        const target = routing.focusedTarget(focusedId, shell.id, shell);
        expect(target.renderer).toBe(realm);
        emitToContents(target.renderer, "menu-close-tab", undefined);
        expect(realm.send).toHaveBeenLastCalledWith(
          "orkestrator:event",
          "menu-close-tab",
          undefined,
        );
        expect(shell.send).not.toHaveBeenCalled();
      }
      // The remembered child belongs to one physical window only.
      expect(routing.focusedTarget(undefined, otherWindow.id, otherWindow).renderer).toBe(
        otherWindow,
      );
      // A live focused renderer wins over a remembered child.
      expect(routing.focusedTarget(shell.id, shell.id, realm).renderer).toBe(shell);
      source.emit("destroyed");
      expect(routing.focusedTarget(undefined, shell.id, shell).renderer).toBe(shell);
    },
  );

  test("ignores stale ownership and clears a destroyed window's remembered child", () => {
    const { routing, register, owners, shell, realm } = harness();
    register(42).emit("focus");
    owners.splice(1, 1);
    expect(routing.focusedTarget(undefined, shell.id, shell).renderer).toBe(shell);
    owners.push({
      ...owners[0]!,
      contents: realm,
      browserPreviewManager: {
        ownsWebContents: (id) => id === 42,
        focusWebContents: mock(() => true),
      },
    });
    register(shell.id).emit("destroyed");
    expect(routing.focusedTarget(undefined, shell.id, shell).renderer).toBe(shell);
  });

  test.each([1, 2, 43])(
    "registered app/realm/artifact %s consumes each chord and repeats without duplicate toggles",
    (id) => {
      const { register, shell, realm, controller } = harness();
      const source = register(id);
      const event = { preventDefault: mock(() => {}) };
      const owner = id === 1 ? shell : realm;
      source.emit("before-input-event", event, chord);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(owner.send).toHaveBeenCalledTimes(1);
      expect(owner.send).toHaveBeenLastCalledWith(
        "orkestrator:event",
        "menu-keyboard-shortcuts",
        "toggle",
      );
      source.emit("before-input-event", event, { ...chord, isAutoRepeat: true });
      expect(event.preventDefault).toHaveBeenCalledTimes(2);
      expect(owner.send).toHaveBeenCalledTimes(1);
      source.emit("before-input-event", event, { ...chord, type: "keyUp" });
      source.emit("before-input-event", event, { ...chord, alt: true });
      expect(event.preventDefault).toHaveBeenCalledTimes(2);
      controller.forget(owner.id);
    },
  );

  test("Windows/Linux Ctrl+Shift+K toggles once, while AltGr (Ctrl+Alt) reaches the page", () => {
    const { register, shell, controller } = harness();
    const source = register(shell.id);
    const ctrl = { ...chord, meta: false, control: true };
    const event = { preventDefault: mock(() => {}) };
    source.emit("before-input-event", event, ctrl);
    // Electron also delivers rawKeyDown for a Ctrl chord; it is not a second press.
    source.emit("before-input-event", event, { ...ctrl, type: "rawKeyDown" });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(shell.send).toHaveBeenCalledTimes(1);
    expect(shell.send).toHaveBeenLastCalledWith(
      "orkestrator:event",
      "menu-keyboard-shortcuts",
      "toggle",
    );

    const altGr = { preventDefault: mock(() => {}) };
    source.emit("before-input-event", altGr, { ...ctrl, alt: true });
    expect(altGr.preventDefault).not.toHaveBeenCalled();
    expect(shell.send).toHaveBeenCalledTimes(1);
    controller.forget(shell.id);
  });

  test.each([42, 999])(
    "preview-owned or unknown contents %s leave input to their own hook",
    (id) => {
      const { register, shell, realm } = harness();
      const event = { preventDefault: mock(() => {}) };
      register(id).emit("before-input-event", event, chord);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(shell.send).not.toHaveBeenCalled();
      expect(realm.send).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["⌘K", { meta: true, control: false }],
    ["Ctrl+K", { meta: false, control: true }],
  ])("%s in a native artifact view opens the window's search, once per press", (_, mods) => {
    const { register, shell, realm } = harness();
    const search = { ...chord, ...mods, key: "k", shift: false };
    const source = register(43);
    const event = { preventDefault: mock(() => {}) };
    source.emit("before-input-event", event, search);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // The realm owns the artifact, but the search belongs to its window.
    expect(shell.focus).toHaveBeenCalledTimes(1);
    expect(shell.send).toHaveBeenLastCalledWith(
      "orkestrator:event",
      "app-shortcut",
      "search-projects",
    );
    expect(realm.send).not.toHaveBeenCalled();
    source.emit("before-input-event", event, { ...search, isAutoRepeat: true });
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(shell.send).toHaveBeenCalledTimes(1);
  });

  test("darwin artifact Ctrl+K stays with text editing while Cmd+K reaches the shell", () => {
    const { register, shell } = harness("darwin");
    const source = register(43);
    const event = { preventDefault: mock(() => {}) };
    source.emit("before-input-event", event, {
      ...chord,
      shift: false,
      meta: false,
      control: true,
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(shell.send).not.toHaveBeenCalled();
    source.emit("before-input-event", event, { ...chord, shift: false });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(shell.send).toHaveBeenCalledWith("orkestrator:event", "app-shortcut", "search-projects");
  });

  test.each([1, 2, 42, 999])(
    "app documents, previews and unknown contents %s keep ⌘K and Ctrl+K",
    (id) => {
      // An app document's own router knows whether a terminal or text field
      // there owns Ctrl+K; a previewed page owns ⌘K as a real browser's would.
      const { register, shell, realm, otherWindow } = harness();
      const source = register(id);
      const event = { preventDefault: mock(() => {}) };
      for (const mods of [{ meta: true }, { meta: false, control: true }])
        source.emit("before-input-event", event, { ...chord, ...mods, key: "k", shift: false });
      expect(event.preventDefault).not.toHaveBeenCalled();
      for (const contents of [shell, realm, otherWindow]) {
        expect(contents.send).not.toHaveBeenCalled();
        expect(contents.focus).not.toHaveBeenCalled();
      }
    },
  );

  test.each([1, 2, 43])("Ctrl+Shift+K in app/realm/artifact %s toggles like ⌘⇧K", (id) => {
    const { register, shell, realm, controller } = harness();
    const event = { preventDefault: mock(() => {}) };
    register(id).emit("before-input-event", event, { ...chord, meta: false, control: true });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect((id === 1 ? shell : realm).send).toHaveBeenLastCalledWith(
      "orkestrator:event",
      "menu-keyboard-shortcuts",
      "toggle",
    );
    controller.forget(id === 1 ? shell.id : realm.id);
  });

  test("closed IPC accepts only live app renderers and realms", async () => {
    const { controller, routing, owners, shell, realm } = harness();
    const restoreShell = mock(() => true);
    const restoreRealm = mock(() => true);
    controller.request({ renderer: shell, restoreFocus: restoreShell }, "open");
    controller.request({ renderer: realm, restoreFocus: restoreRealm }, "open");
    for (const id of [42, 43, 999]) routing.closed(id);
    await Bun.sleep(10);
    expect(restoreShell).not.toHaveBeenCalled();
    expect(restoreRealm).not.toHaveBeenCalled();
    routing.closed(shell.id);
    routing.closed(realm.id);
    await Bun.sleep(10);
    expect(restoreShell).toHaveBeenCalledTimes(1);
    expect(restoreRealm).toHaveBeenCalledTimes(1);
    controller.request({ renderer: realm, restoreFocus: restoreRealm }, "open");
    owners[1]!.contents.isDestroyed = () => true;
    routing.closed(realm.id);
    await Bun.sleep(10);
    expect(restoreRealm).toHaveBeenCalledTimes(1);
    controller.forget(realm.id);
  });

  test.each(["destroyed", "did-navigate"])("%s invalidates pending restoration", async (event) => {
    const { register, controller, shell } = harness();
    const restore = mock(() => true);
    controller.request({ renderer: shell, restoreFocus: restore }, "open");
    controller.closed(shell.id);
    register(shell.id).emit(event);
    await Bun.sleep(10);
    expect(restore).not.toHaveBeenCalled();
  });
});
