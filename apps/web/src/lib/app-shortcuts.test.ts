import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import { APP_SHORTCUT_EVENT, type AppShortcutId } from "@orkestrator/protocol/keyboard-shortcuts";
import { listen } from "@/lib/native/events";
import {
  retainAppShortcutRouter,
  onAppShortcut,
  requestAppShortcut,
  setShownAppShortcutWorkspace,
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
    "on %s, %p+Shift+/ opens the shortcuts dialog from every surface",
    (platform, mod) => {
      setPlatform(platform);
      const dialog = handle("show-shortcuts");
      const editable = mount(document.createElement("div"));
      editable.contentEditable = "true";
      const surfaces = [terminal(), mount(document.createElement("textarea")), editable];
      for (const surface of surfaces) {
        // Browsers report the shifted Ctrl chord as ?; macOS reports ⌘⇧/ as /.
        const key = "metaKey" in mod ? "/" : "?";
        expect(press(surface, { key, code: "Slash", shiftKey: true, ...mod })).toEqual({
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

test("router references share one listener and final release removes DOM and native subscriptions", async () => {
  const nativeListen = listen as unknown as Mock<typeof listen>;
  const unlisten = mock(() => {});
  let ready!: (dispose: () => void) => void;
  nativeListen.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  const add = spyOn(window, "addEventListener");
  const remove = spyOn(window, "removeEventListener");
  const callsBefore = nativeListen.mock.calls.length;
  const first = retainAppShortcutRouter();
  const second = retainAppShortcutRouter();
  const search = handle("search-projects");
  const disposeHandler = disposers.pop()!;
  try {
    expect(nativeListen.mock.calls.length - callsBefore).toBe(1);
    expect(add.mock.calls.filter(([name]) => name === "keydown")).toHaveLength(1);
    first();
    first(); // Releases are idempotent.
    second();
    expect(remove.mock.calls.filter(([name]) => name === "keydown")).toHaveLength(0);
    press(mount(document.createElement("button")), { key: "k", metaKey: true });
    expect(search).toHaveBeenCalledTimes(1);
    disposeHandler();
    const removed = remove.mock.calls.filter(([name]) => name === "keydown");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual(add.mock.calls.find(([name]) => name === "keydown"));
    expect(
      press(mount(document.createElement("button")), { key: "k", metaKey: true }).claimed,
    ).toBe(false);
    // A native subscription that resolves after final release is still disposed.
    ready(unlisten);
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
    const again = retainAppShortcutRouter();
    expect(nativeListen.mock.calls.length - callsBefore).toBe(2);
    again();
  } finally {
    first();
    second();
    disposeHandler();
    add.mockRestore();
    remove.mockRestore();
  }
});

describe("delivery to the owner", () => {
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

describe("one key router for the nodes shown in the window's tree (plan item 5003)", () => {
  test("a workspace shortcut reaches only the workspace on show; window shortcuts are the window's", () => {
    const commandWorkspace = { node: "command" };
    const leafWorkspace = { node: "leaf" };
    let shown: object | null = leafWorkspace;
    disposers.push(setShownAppShortcutWorkspace(() => shown));
    const commandTab = mock(() => {});
    const leafTab = mock(() => {});
    disposers.push(onAppShortcut("new-agent-tab", commandTab, { workspace: commandWorkspace }));
    disposers.push(onAppShortcut("new-agent-tab", leafTab, { workspace: leafWorkspace }));
    const search = handle("search-projects");
    const settings = handle("open-settings");
    const grouping = handle("rotate-sidebar-grouping");
    const shortcuts = handle("show-shortcuts");

    // Typed in the in-tree leaf's composer: this document's router takes them all.
    const composer = mount(document.createElement("textarea"));
    const inTree = mount(document.createElement("div"));
    inTree.dataset.testid = "in-tree-workspace";
    inTree.append(composer);
    expect(press(composer, { key: "t", metaKey: true }).claimed).toBe(true);
    expect(leafTab).toHaveBeenCalledTimes(1);
    expect(commandTab).not.toHaveBeenCalled();
    press(composer, { key: "k", metaKey: true });
    press(composer, { key: ",", metaKey: true });
    press(composer, { key: "d", metaKey: true, shiftKey: true });
    press(composer, { key: "/", metaKey: true, shiftKey: true });
    expect([search, settings, grouping, shortcuts].map((fn) => fn.mock.calls.length)).toEqual([
      1, 1, 1, 1,
    ]);

    // The window's own node on show again: ⌘T is its workspace's.
    shown = commandWorkspace;
    requestAppShortcut("new-agent-tab");
    expect(commandTab).toHaveBeenCalledTimes(1);
    expect(leafTab).toHaveBeenCalledTimes(1);

    // A node whose scope is still opening: neither hidden workspace opens a tab.
    shown = null;
    requestAppShortcut("new-agent-tab");
    expect(commandTab).toHaveBeenCalledTimes(1);
    expect(leafTab).toHaveBeenCalledTimes(1);
  });

  test("without a shown workspace (a fixture) every handler runs", () => {
    const one = mock(() => {});
    const two = mock(() => {});
    disposers.push(onAppShortcut("new-agent-tab", one, { workspace: {} }));
    disposers.push(onAppShortcut("new-agent-tab", two));
    requestAppShortcut("new-agent-tab");
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });
});
