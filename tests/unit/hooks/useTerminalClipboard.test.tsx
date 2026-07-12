import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { mockWriteText } from "../../mocks/clipboard";
import { useTerminalClipboard } from "../../../apps/web/src/hooks/useTerminalClipboard";

afterEach(() => {
  cleanup();
  mockWriteText.mockReset();
  mockWriteText.mockImplementation(async () => undefined);
});

function createTerminal() {
  let selectionCallback = () => undefined;
  let keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  const terminal = {
    hasSelection: mock(() => true),
    getSelection: mock(() => "selected text"),
    onSelectionChange: mock((callback: () => void) => {
      selectionCallback = callback;
      return { dispose: mock(() => undefined) };
    }),
    selectAll: mock(() => undefined),
    focus: mock(() => undefined),
    attachCustomKeyEventHandler: mock((callback: (event: KeyboardEvent) => boolean) => {
      keyHandler = callback;
    }),
  };
  return { terminal, selection: () => selectionCallback(), key: (event: KeyboardEvent) => keyHandler?.(event) };
}

describe("useTerminalClipboard", () => {
  test("tracks selection, copies, and selects all", async () => {
    const fake = createTerminal();
    const writeRef = { current: mock(async () => undefined) };
    const { result, unmount } = renderHook(() => useTerminalClipboard({
      terminal: fake.terminal as never,
      containerId: "container-1",
      writeRef,
    }));

    expect(result.current.hasSelection).toBe(true);
    await act(async () => result.current.handleCopySelection());
    expect(mockWriteText).toHaveBeenCalledWith("selected text");
    act(() => result.current.handleSelectAll());
    expect(fake.terminal.selectAll).toHaveBeenCalledTimes(1);
    expect(fake.terminal.focus).toHaveBeenCalledTimes(1);
    unmount();
    expect(fake.terminal.onSelectionChange.mock.results[0]?.value.dispose).toHaveBeenCalledTimes(1);
  });

  test("handles terminal clipboard shortcuts without overriding shell Ctrl+C", async () => {
    const fake = createTerminal();
    const writeRef = { current: mock(async () => undefined) };
    const { result } = renderHook(() => useTerminalClipboard({
      terminal: fake.terminal as never,
      containerId: "",
      writeRef,
    }));
    act(() => result.current.attachClipboardKeyHandler());

    expect(fake.key(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(true);
    expect(fake.key(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(false);
    await act(async () => Promise.resolve());
    expect(mockWriteText).toHaveBeenCalledWith("selected text");

    expect(fake.key(new KeyboardEvent("keydown", { key: "a", metaKey: true }))).toBe(false);
    expect(fake.terminal.selectAll).toHaveBeenCalledTimes(1);
    expect(fake.key(new KeyboardEvent("keyup", { key: "v", metaKey: true }))).toBe(true);
  });

  test("is inert without a terminal", async () => {
    const writeRef = { current: mock(async () => undefined) };
    const { result } = renderHook(() => useTerminalClipboard({ terminal: null, containerId: "container", writeRef }));
    await result.current.handleCopySelection();
    result.current.handleSelectAll();
    result.current.handlePaste();
    result.current.attachClipboardKeyHandler();
    expect(mockWriteText).not.toHaveBeenCalled();
    expect(writeRef.current).not.toHaveBeenCalled();
  });
});
