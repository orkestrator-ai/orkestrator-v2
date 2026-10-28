import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { APP_SHORTCUT_EVENT, type AppShortcutId } from "@orkestrator/protocol/keyboard-shortcuts";
import { frameEnvelope, realmSearchParams } from "@/lib/federation/workspace-realm";
import { listen } from "@/lib/native/events";
import {
  onAppShortcut,
  requestAppShortcut,
  setUnhandledAppShortcut,
  shortcutFocus,
} from "./app-shortcuts";

const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalHref = window.location.href;
const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
const disposers: (() => void)[] = [];

function setPlatform(value: "MacIntel" | "Win32") {
  Object.defineProperty(navigator, "platform", { value, configurable: true });
}

function handle(id: AppShortcutId) {
  const handler = mock(() => {});
  disposers.push(onAppShortcut(id, handler));
  return handler;
}

function mount<T extends HTMLElement>(element: T, parent: HTMLElement = document.body): T {
  parent.append(element);
  return element;
}

/** A key press on `target`, and whether the surface's own listener saw it. */
function press(target: HTMLElement, init: KeyboardEventInit) {
  let surfaceSaw = false;
  const listener = () => {
    surfaceSaw = true;
  };
  target.addEventListener("keydown", listener);
  const event = new KeyboardEvent("keydown", {
    code: "KeyK",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  target.removeEventListener("keydown", listener);
  return { claimed: event.defaultPrevented, surfaceSaw };
}

function terminal() {
  const host = mount(document.createElement("div"));
  host.className = "xterm";
  return mount(document.createElement("textarea"), host);
}

beforeEach(() => setPlatform("MacIntel"));

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
  else delete (navigator as { platform?: string }).platform;
  happyDOM.setURL(originalHref);
  delete (window.orkestrator as { workspaceRealm?: unknown } | undefined)?.workspaceRealm;
  document.body.innerHTML = "";
});

describe("which surface has focus", () => {
  test("terminals, text fields and everything else", () => {
    expect(shortcutFocus(terminal())).toBe("terminal");
    expect(shortcutFocus(mount(document.createElement("textarea")))).toBe("text");
    expect(shortcutFocus(mount(document.createElement("input")))).toBe("text");
    const checkbox = mount(document.createElement("input"));
    checkbox.type = "checkbox";
    expect(shortcutFocus(checkbox)).toBe("page");
    const editable = mount(document.createElement("div"));
    editable.contentEditable = "true";
    expect(shortcutFocus(editable)).toBe("text");
    const monaco = mount(document.createElement("div"));
    monaco.className = "monaco-editor";
    expect(shortcutFocus(mount(document.createElement("div"), monaco))).toBe("text");
    expect(shortcutFocus(mount(document.createElement("button")))).toBe("page");
    expect(shortcutFocus(window)).toBe("page");
  });
});

describe("the window's key router", () => {
  test("⌘K opens search from the composer before the composer sees it", () => {
    const search = handle("search-projects");
    const composer = mount(document.createElement("textarea"));
    expect(press(composer, { key: "k", metaKey: true })).toEqual({
      claimed: true,
      surfaceSaw: false,
    });
    expect(search).toHaveBeenCalledTimes(1);
    // Holding the keys consumes the repeats without toggling again.
    expect(press(composer, { key: "k", metaKey: true, repeat: true }).claimed).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  test("in a terminal, Ctrl+K stays with the shell and ⌘K opens search", () => {
    const search = handle("search-projects");
    const xterm = terminal();
    for (const platform of ["MacIntel", "Win32"] as const) {
      setPlatform(platform);
      expect(press(xterm, { key: "k", ctrlKey: true })).toEqual({
        claimed: false,
        surfaceSaw: true,
      });
    }
    expect(search).not.toHaveBeenCalled();
    setPlatform("MacIntel");
    expect(press(xterm, { key: "k", metaKey: true }).claimed).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  test("Ctrl+K in a text field is kill-line on macOS and search elsewhere", () => {
    const search = handle("search-projects");
    const field = mount(document.createElement("input"));
    expect(press(field, { key: "k", ctrlKey: true }).claimed).toBe(false);
    expect(search).not.toHaveBeenCalled();
    // Outside a text field it is search on macOS too.
    expect(
      press(mount(document.createElement("button")), { key: "k", ctrlKey: true }).claimed,
    ).toBe(true);
    setPlatform("Win32");
    expect(press(field, { key: "k", ctrlKey: true }).claimed).toBe(true);
    expect(search).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["MacIntel", { metaKey: true }],
    ["MacIntel", { ctrlKey: true }],
    ["Win32", { ctrlKey: true }],
    ["Win32", { metaKey: true }],
  ] as const)(
    "on %s, %p+Shift+K opens the shortcuts dialog from every surface",
    (platform, mod) => {
      setPlatform(platform);
      const dialog = handle("show-shortcuts");
      const editable = mount(document.createElement("div"));
      editable.contentEditable = "true";
      const surfaces = [terminal(), mount(document.createElement("textarea")), editable];
      for (const surface of surfaces) {
        expect(press(surface, { key: "K", shiftKey: true, ...mod })).toEqual({
          claimed: true,
          surfaceSaw: false,
        });
      }
      expect(dialog).toHaveBeenCalledTimes(surfaces.length);
    },
  );

  test("other chords are left alone", () => {
    const search = handle("search-projects");
    expect(
      press(mount(document.createElement("div")), { key: "k", metaKey: true, altKey: true }),
    ).toEqual({ claimed: false, surfaceSaw: true });
    expect(
      press(mount(document.createElement("div")), { key: "j", code: "KeyJ", metaKey: true }),
    ).toEqual({ claimed: false, surfaceSaw: true });
    expect(search).not.toHaveBeenCalled();
  });

  test("a key from a native artifact view arrives from Electron main", () => {
    const search = handle("search-projects");
    const calls = (listen as unknown as Mock<typeof listen>).mock.calls;
    const emit = calls.findLast(([event]) => event === APP_SHORTCUT_EVENT)?.[1];
    expect(emit).toBeDefined();
    emit?.({ payload: "close-tab" } as never);
    expect(search).not.toHaveBeenCalled();
    emit?.({ payload: "search-projects" } as never);
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe("delivery to the owner", () => {
  function enterRealm() {
    const search = realmSearchParams({ projectId: "p" });
    search.set("workspace", "w1");
    happyDOM.setURL(`http://localhost/?${search.toString()}`);
  }

  test("a desktop realm forwards ⌘K to its window, and keeps ⌘⇧K for its own dialog", () => {
    enterRealm();
    const post = mock(() => {});
    window.orkestrator = {
      ...window.orkestrator!,
      workspaceRealm: { post, onMessage: () => () => {} },
    } as typeof window.orkestrator;
    const search = handle("search-projects");
    const dialog = handle("show-shortcuts");
    const composer = mount(document.createElement("textarea"));
    expect(press(composer, { key: "k", metaKey: true }).claimed).toBe(true);
    expect(post).toHaveBeenCalledWith({ type: "shortcut", shortcut: "search-projects" });
    expect(search).not.toHaveBeenCalled();
    press(composer, { key: "K", metaKey: true, shiftKey: true });
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("a browser realm frame forwards ⌘K to its parent window over the realm channel", () => {
    enterRealm();
    const parentPost = mock(() => {});
    const descriptor = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage: parentPost },
    });
    try {
      handle("show-shortcuts");
      press(mount(document.createElement("textarea")), { key: "k", ctrlKey: true });
      // Ctrl+K in a macOS text field is kill-line; ⌘K is forwarded.
      expect(parentPost).not.toHaveBeenCalled();
      press(mount(document.createElement("textarea")), { key: "k", metaKey: true });
      expect(parentPost).toHaveBeenCalledWith(
        frameEnvelope("w1", { type: "shortcut", shortcut: "search-projects" }),
        window.location.origin,
      );
    } finally {
      if (descriptor) Object.defineProperty(window, "parent", descriptor);
    }
  });

  test("a request with its UI hidden waits only if the window is showing it", () => {
    const show = mock(() => true);
    disposers.push(setUnhandledAppShortcut(show));
    requestAppShortcut("search-projects");
    expect(show).toHaveBeenCalledWith("search-projects");
    const search = handle("search-projects");
    expect(search).toHaveBeenCalledTimes(1);

    for (const dispose of disposers.splice(0)) dispose();
    disposers.push(setUnhandledAppShortcut(() => false));
    requestAppShortcut("search-projects");
    expect(handle("search-projects")).not.toHaveBeenCalled();
  });
});
