import { afterEach, describe, expect, test, type Mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KEYBOARD_SHORTCUTS_EVENT } from "@orkestrator/protocol/keyboard-shortcuts";
import { listen } from "@/lib/native/events";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

function pressShortcut(init: KeyboardEventInit = { metaKey: true }) {
  fireEvent.keyDown(window, {
    key: "K",
    code: "KeyK",
    shiftKey: true,
    ...init,
  });
}

/**
 * The handler the dialog subscribed for Electron main's View menu event. The
 * browser client's transport never emits it. `listen` is the shared mock from
 * tests/setup.ts.
 */
function desktopMenuEvent(): (payload: unknown) => void {
  const calls = (listen as unknown as Mock<typeof listen>).mock.calls;
  const handler = calls.findLast(([event]) => event === KEYBOARD_SHORTCUTS_EVENT)?.[1];
  expect(handler).toBeDefined();
  return (payload) =>
    act(() => {
      handler?.({ payload });
    });
}

afterEach(() => {
  cleanup();
});

describe("KeyboardShortcutsDialog", () => {
  test("Cmd+Shift+K opens the dialog with the search focused, and toggles it closed", async () => {
    render(<KeyboardShortcutsDialog platform="mac" />);
    expectDomAbsent(screen.queryByTestId("keyboard-shortcuts-dialog"));

    pressShortcut();

    const search = await screen.findByRole("textbox", {
      name: "Search keyboard shortcuts",
    });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(screen.getByTestId("keyboard-shortcut-search-projects").textContent).toContain("⌘");

    pressShortcut();
    await waitFor(() => expectDomAbsent(screen.queryByTestId("keyboard-shortcuts-dialog")));
  });

  test.each(["Escape", "toggle"])("restores the editing surface after %s", async (dismiss) => {
    render(
      <>
        <textarea aria-label="Composer" />
        <KeyboardShortcutsDialog />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    pressShortcut();
    const search = await screen.findByRole("textbox", { name: "Search keyboard shortcuts" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    if (dismiss === "Escape") fireEvent.keyDown(search, { key: "Escape" });
    else pressShortcut();
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });

  test("consumes repeats without toggling and claims the chord before editor handlers", async () => {
    const { container } = render(
      <>
        <textarea aria-label="Editor" />
        <KeyboardShortcutsDialog />
      </>,
    );
    let editorCalls = 0;
    container.addEventListener("keydown", () => {
      editorCalls++;
    });
    const editor = screen.getByRole("textbox", { name: "Editor" });
    fireEvent.keyDown(editor, { key: "K", metaKey: true, shiftKey: true });
    await screen.findByRole("dialog");
    for (let i = 0; i < 3; i++) pressShortcut({ metaKey: true, repeat: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(editorCalls).toBe(0);
    pressShortcut();
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog")));
    pressShortcut({ metaKey: true, repeat: true });
    expectDomAbsent(screen.queryByRole("dialog"));
  });

  test("does not try to restore a removed editing surface", async () => {
    render(<KeyboardShortcutsDialog />);
    const editor = document.createElement("textarea");
    document.body.append(editor);
    editor.focus();
    pressShortcut();
    await screen.findByRole("dialog");
    editor.remove();
    pressShortcut();
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog")));
    expect(document.activeElement === editor).toBe(false);
  });

  test("Cmd+K alone does not open it", () => {
    render(<KeyboardShortcutsDialog platform="mac" />);
    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    expectDomAbsent(screen.queryByTestId("keyboard-shortcuts-dialog"));
  });

  test("filters shortcuts as you type and shows an empty state", async () => {
    render(<KeyboardShortcutsDialog platform="mac" />);
    pressShortcut();
    const search = await screen.findByRole("textbox", {
      name: "Search keyboard shortcuts",
    });

    fireEvent.change(search, { target: { value: "files panel" } });
    expect(screen.getByTestId("keyboard-shortcut-toggle-files-panel")).toBeTruthy();
    expectDomAbsent(screen.queryByTestId("keyboard-shortcut-search-projects"));

    fireEvent.change(search, { target: { value: "zzz no match" } });
    expect(screen.getByText("No shortcuts match that search.")).toBeTruthy();
  });

  test("uses Ctrl labels and hides macOS-only shortcuts elsewhere", async () => {
    render(<KeyboardShortcutsDialog platform="other" />);
    pressShortcut({ ctrlKey: true });

    const row = await screen.findByTestId("keyboard-shortcut-search-projects");
    expect(row.textContent).toContain("Ctrl");
    expectDomAbsent(screen.queryByTestId("keyboard-shortcut-new-agent-tab"));
  });

  test("clears the search when reopened", async () => {
    render(<KeyboardShortcutsDialog platform="mac" />);
    pressShortcut();
    const search = await screen.findByRole("textbox", {
      name: "Search keyboard shortcuts",
    });
    fireEvent.change(search, { target: { value: "zoom" } });

    pressShortcut();
    await waitFor(() => expectDomAbsent(screen.queryByTestId("keyboard-shortcuts-dialog")));
    pressShortcut();

    const reopened = await screen.findByRole("textbox", {
      name: "Search keyboard shortcuts",
    });
    expect((reopened as HTMLInputElement).value).toBe("");
  });

  test("opens on a layout whose K key types no Latin letter", async () => {
    render(<KeyboardShortcutsDialog platform="mac" />);
    // Russian ЙЦУКЕН: ⌘⇧ and the physical K key report key "Л".
    pressShortcut({ metaKey: true, key: "Л" });
    expect(await screen.findByTestId("keyboard-shortcuts-dialog")).toBeTruthy();
    pressShortcut({ metaKey: true, key: "Л" });
    await waitFor(() => expectDomAbsent(screen.queryByTestId("keyboard-shortcuts-dialog")));
  });

  test("opens before a focused surface's own handlers can stop or claim the key", async () => {
    render(
      <>
        <div aria-label="Composer" contentEditable role="textbox" tabIndex={0} />
        <KeyboardShortcutsDialog />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "Composer" });
    // A rich editor's keymap, xterm and Monaco all handle keys at or below the
    // document; none of them may hide the chord from the window listener.
    const stopAtDocument = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("keydown", stopAtDocument, true);
    composer.addEventListener("keydown", stopAtDocument);
    try {
      composer.focus();
      fireEvent.keyDown(composer, { key: "K", code: "KeyK", metaKey: true, shiftKey: true });
      expect(await screen.findByTestId("keyboard-shortcuts-dialog")).toBeTruthy();
    } finally {
      document.removeEventListener("keydown", stopAtDocument, true);
    }
  });

  test("a View menu click opens the dialog and never closes it", async () => {
    render(<KeyboardShortcutsDialog platform="mac" />);
    const emit = desktopMenuEvent();

    emit("open");
    const search = await screen.findByRole("textbox", { name: "Search keyboard shortcuts" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: "zoom" } });
    search.blur();

    // A second click keeps the dialog and its search, and refocuses the search.
    emit("open");
    expect(screen.getByTestId("keyboard-shortcuts-dialog")).toBeTruthy();
    expect((search as HTMLInputElement).value).toBe("zoom");
    expect(document.activeElement).toBe(search);

    pressShortcut();
    await waitFor(() => expectDomAbsent(screen.queryByTestId("keyboard-shortcuts-dialog")));
  });

  test("a chord forwarded from a native preview view toggles like a key press", async () => {
    render(<KeyboardShortcutsDialog platform="mac" />);
    const emit = desktopMenuEvent();

    emit("toggle");
    expect(await screen.findByTestId("keyboard-shortcuts-dialog")).toBeTruthy();
    emit("toggle");
    await waitFor(() => expectDomAbsent(screen.queryByTestId("keyboard-shortcuts-dialog")));
    emit("unknown");
    expectDomAbsent(screen.queryByTestId("keyboard-shortcuts-dialog"));
  });

  test("a distinct quick renderer press after a forwarded toggle closes the dialog", async () => {
    render(<KeyboardShortcutsDialog platform="mac" />);
    desktopMenuEvent()("toggle");
    expect(await screen.findByTestId("keyboard-shortcuts-dialog")).toBeTruthy();
    pressShortcut();
    await waitFor(() => expectDomAbsent(screen.queryByTestId("keyboard-shortcuts-dialog")));
  });

  test.each(["Escape", "toggle"])(
    "desktop dismissal notifies native focus restoration after %s",
    async (dismiss) => {
      const transport = window.orkestrator;
      let closed = 0;
      window.orkestrator = {
        ...transport,
        keyboardShortcuts: {
          closed: async () => {
            closed++;
          },
        },
      } as Window["orkestrator"];
      try {
        render(<KeyboardShortcutsDialog />);
        const emit = desktopMenuEvent();
        emit("toggle");
        const search = await screen.findByRole("textbox", { name: "Search keyboard shortcuts" });
        if (dismiss === "Escape") fireEvent.keyDown(search, { key: "Escape" });
        else emit("toggle");
        await waitFor(() => expect(closed).toBe(1));
        expectDomAbsent(screen.queryByRole("dialog"));
      } finally {
        cleanup();
        window.orkestrator = transport;
      }
    },
  );

  test("the browser client, with no native menu, still toggles from the keyboard", async () => {
    render(<KeyboardShortcutsDialog platform="other" />);
    pressShortcut({ ctrlKey: true });
    expect(await screen.findByTestId("keyboard-shortcuts-dialog")).toBeTruthy();
    pressShortcut({ ctrlKey: true });
    await waitFor(() => expectDomAbsent(screen.queryByTestId("keyboard-shortcuts-dialog")));
  });
});
