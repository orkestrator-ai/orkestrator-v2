import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
