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
  // Three windows; the first owns a native preview (42) and artifact view (43).
  const shell = contents(1);
  const second = contents(2);
  const otherWindow = contents(3);
  const owners = [shell, second, otherWindow].map((contents) => ({
    contents,
    window: { webContents: contents, isFocused: () => true },
    browserPreviewManager: {
      ownsWebContents: (id: number) => contents === shell && id === 42,
      focusWebContents: mock(() => true),
    },
    artifactHosts: {
      activeHost: () =>
        contents === shell
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
  return { shell, second, otherWindow, owners, controller, routing, register };
}

// ⌘⇧/ as macOS reports it. Ctrl+Shift+/ may report the shifted "?".
const chord = {
  type: "keyDown",
  key: "/",
  code: "Slash",
  meta: true,
  control: false,
  shift: true,
  alt: false,
};

describe("native shortcut routing", () => {
  test.each([42, 43])(
    "Close Tab and shortcuts follow native child %s to its window, even after menu activation clears focus",
    (child) => {
      const { routing, register, shell, second, otherWindow } = harness();
      const source = register(child);
      source.emit("focus");
      for (const focusedId of [child, undefined]) {
        const target = routing.focusedTarget(focusedId, shell.id, second);
        expect(target.renderer).toBe(shell);
        emitToContents(target.renderer, "menu-close-tab", undefined);
        expect(shell.send).toHaveBeenLastCalledWith(
          "orkestrator:event",
          "menu-close-tab",
          undefined,
        );
        expect(second.send).not.toHaveBeenCalled();
      }
      // The remembered child belongs to one physical window only.
      expect(routing.focusedTarget(undefined, otherWindow.id, otherWindow).renderer).toBe(
        otherWindow,
      );
      // A live focused renderer wins over a remembered child.
      expect(routing.focusedTarget(second.id, shell.id, shell).renderer).toBe(second);
      source.emit("destroyed");
      expect(routing.focusedTarget(undefined, shell.id, second).renderer).toBe(second);
    },
  );

  test.each(["darwin", "linux"] as const)(
    "workspace new tab from native child reaches its window on %s",
    (platform) => {
      const { register, second, shell } = harness(platform);
      const event = { preventDefault: mock(() => {}) };
      register(43).emit("before-input-event", event, {
        ...chord,
        key: "t",
        code: "KeyT",
        shift: false,
        meta: platform === "darwin",
        control: platform !== "darwin",
      });
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(shell.send).toHaveBeenCalledWith("orkestrator:event", "app-shortcut", "new-agent-tab");
      expect(second.send).not.toHaveBeenCalled();
    },
  );

  test("ignores stale ownership and clears a destroyed window's remembered child", () => {
    const { routing, register, owners, shell, second } = harness();
    register(42).emit("focus");
    const [shellOwner] = owners.splice(0, 1);
    expect(routing.focusedTarget(undefined, shell.id, second).renderer).toBe(second);
    owners.push(shellOwner!);
    register(shell.id).emit("destroyed");
    expect(routing.focusedTarget(undefined, shell.id, second).renderer).toBe(second);
  });

  test.each([1, 2, 43])(
    "registered app/window/artifact %s consumes each chord and repeats without duplicate toggles",
    (id) => {
      const { register, shell, second, controller } = harness();
      const source = register(id);
      const event = { preventDefault: mock(() => {}) };
      const owner = id === 2 ? second : shell;
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

  test("Windows/Linux Ctrl+Shift+/ toggles once, while AltGr (Ctrl+Alt) reaches the page", () => {
    const { register, shell, controller } = harness();
    const source = register(shell.id);
    const ctrl = { ...chord, key: "?", meta: false, control: true };
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
      const { register, shell, second } = harness();
      const event = { preventDefault: mock(() => {}) };
      register(id).emit("before-input-event", event, chord);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(shell.send).not.toHaveBeenCalled();
      expect(second.send).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["⌘K", { meta: true, control: false }],
    ["Ctrl+K", { meta: false, control: true }],
  ])("%s in a native artifact view opens the window's search, once per press", (_, mods) => {
    const { register, shell, second } = harness();
    const search = { ...chord, ...mods, key: "k", code: "KeyK", shift: false };
    const source = register(43);
    const event = { preventDefault: mock(() => {}) };
    source.emit("before-input-event", event, search);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // The window owns the artifact view; the search belongs to the window's shell.
    expect(shell.focus).toHaveBeenCalledTimes(1);
    expect(shell.send).toHaveBeenLastCalledWith(
      "orkestrator:event",
      "app-shortcut",
      "search-projects",
    );
    expect(second.send).not.toHaveBeenCalled();
    source.emit("before-input-event", event, { ...search, isAutoRepeat: true });
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(shell.send).toHaveBeenCalledTimes(1);
  });

  test.each(["darwin", "linux"] as const)(
    "%s: ⌘, and Ctrl+, in a native artifact view open the window's settings; app documents route their own",
    (platform) => {
      const { register, shell, second } = harness(platform);
      const settings = { ...chord, key: ",", code: "Comma", shift: false };
      const artifact = register(43);
      const event = { preventDefault: mock(() => {}) };
      for (const mods of [{ meta: true }, { meta: false, control: true }])
        artifact.emit("before-input-event", event, { ...settings, ...mods });
      // Ctrl+, edits no text, so even macOS text editing does not keep it.
      expect(event.preventDefault).toHaveBeenCalledTimes(2);
      expect(shell.send).toHaveBeenCalledTimes(2);
      for (const call of [1, 2])
        expect(shell.send).toHaveBeenNthCalledWith(
          call,
          "orkestrator:event",
          "app-shortcut",
          "open-settings",
        );
      expect(second.send).not.toHaveBeenCalled();

      const documentEvent = { preventDefault: mock(() => {}) };
      for (const id of [1, 2]) register(id).emit("before-input-event", documentEvent, settings);
      expect(documentEvent.preventDefault).not.toHaveBeenCalled();
      expect(shell.send).toHaveBeenCalledTimes(2);
    },
  );

  test("darwin artifact Ctrl+K stays with text editing while Cmd+K reaches the shell", () => {
    const { register, shell } = harness("darwin");
    const source = register(43);
    const event = { preventDefault: mock(() => {}) };
    const search = { ...chord, key: "k", code: "KeyK", shift: false };
    source.emit("before-input-event", event, { ...search, meta: false, control: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(shell.send).not.toHaveBeenCalled();
    source.emit("before-input-event", event, search);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(shell.send).toHaveBeenCalledWith("orkestrator:event", "app-shortcut", "search-projects");
  });

  test.each([1, 2, 42, 999])(
    "app documents, previews and unknown contents %s keep ⌘K and Ctrl+K",
    (id) => {
      // An app document's own router knows whether a terminal or text field
      // there owns Ctrl+K; a previewed page owns ⌘K as a real browser's would.
      const { register, shell, second, otherWindow } = harness();
      const source = register(id);
      const event = { preventDefault: mock(() => {}) };
      for (const mods of [{ meta: true }, { meta: false, control: true }])
        source.emit("before-input-event", event, {
          ...chord,
          ...mods,
          key: "k",
          code: "KeyK",
          shift: false,
        });
      expect(event.preventDefault).not.toHaveBeenCalled();
      for (const contents of [shell, second, otherWindow]) {
        expect(contents.send).not.toHaveBeenCalled();
        expect(contents.focus).not.toHaveBeenCalled();
      }
    },
  );

  test.each([1, 2, 43])("Ctrl+Shift+/ in app/window/artifact %s toggles like ⌘⇧/", (id) => {
    const { register, shell, second, controller } = harness();
    const event = { preventDefault: mock(() => {}) };
    register(id).emit("before-input-event", event, {
      ...chord,
      key: "?",
      meta: false,
      control: true,
    });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect((id === 2 ? second : shell).send).toHaveBeenLastCalledWith(
      "orkestrator:event",
      "menu-keyboard-shortcuts",
      "toggle",
    );
    controller.forget(id === 2 ? second.id : shell.id);
  });

  test("closed IPC accepts only live app renderers", async () => {
    const { controller, routing, owners, shell, second } = harness();
    const restoreShell = mock(() => true);
    const restoreSecond = mock(() => true);
    controller.request({ renderer: shell, restoreFocus: restoreShell }, "open");
    controller.request({ renderer: second, restoreFocus: restoreSecond }, "open");
    for (const id of [42, 43, 999]) routing.closed(id);
    await Bun.sleep(10);
    expect(restoreShell).not.toHaveBeenCalled();
    expect(restoreSecond).not.toHaveBeenCalled();
    routing.closed(shell.id);
    routing.closed(second.id);
    await Bun.sleep(10);
    expect(restoreShell).toHaveBeenCalledTimes(1);
    expect(restoreSecond).toHaveBeenCalledTimes(1);
    controller.request({ renderer: second, restoreFocus: restoreSecond }, "open");
    owners[1]!.contents.isDestroyed = () => true;
    routing.closed(second.id);
    await Bun.sleep(10);
    expect(restoreSecond).toHaveBeenCalledTimes(1);
    controller.forget(second.id);
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
