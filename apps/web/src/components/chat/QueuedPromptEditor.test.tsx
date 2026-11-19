import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueuedPromptEditor, type QueuedPromptEditorProps } from "./QueuedPromptEditor";
import { QueuedPromptStack, type NativeComposeQueuedPrompt } from "./QueuedPromptStack";

const image = { type: "image" as const, path: "/workspace/shot.png", filename: "shot.png" };

function renderEditor(overrides: Partial<QueuedPromptEditorProps> = {}) {
  const props: QueuedPromptEditorProps = {
    position: 2,
    length: 3,
    text: "Second queued",
    attachments: [image],
    busy: false,
    onTextChange: mock(() => {}),
    onRemoveAttachment: mock(() => {}),
    onSave: mock(() => {}),
    onCancel: mock(() => {}),
    onOverwrite: mock(() => {}),
    onDiscard: mock(() => {}),
    ...overrides,
  };
  render(<QueuedPromptEditor {...props} />);
  return props;
}

afterEach(() => cleanup());

describe("QueuedPromptEditor", () => {
  test("opens focused on the prompt's text, with its files removable", () => {
    const props = renderEditor();
    const textarea = screen.getByRole("textbox", { name: "Queued prompt 2 text" });
    expect(document.activeElement).toBe(textarea);
    expect(screen.getByRole("group", { name: "Editing queued prompt 2 of 3" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment shot.png" }));
    expect(props.onRemoveAttachment).toHaveBeenCalledWith(image.path);
  });

  test("Mod+Enter saves and Escape cancels without reaching the tab", () => {
    // Shortcuts the tab also listens for; a plain Enter is just a new line.
    const tabKeys = mock((event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) return;
      tabShortcuts.push(event.key);
    });
    const tabShortcuts: string[] = [];
    document.addEventListener("keydown", tabKeys);
    try {
      const props = renderEditor();
      const textarea = screen.getByRole("textbox", { name: "Queued prompt 2 text" });
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
      expect(props.onSave).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(props.onSave).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(props.onCancel).toHaveBeenCalledTimes(1);
      expect(tabShortcuts).toEqual([]);
    } finally {
      document.removeEventListener("keydown", tabKeys);
    }
  });

  test("a conflict says what happened and offers to keep or drop this edit", () => {
    const props = renderEditor({ conflict: "changed" });
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");
    expect(screen.queryByRole("button", { name: "Save" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Use mine" }));
    expect(props.onOverwrite).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard mine" }));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
  });

  test("a prompt that left the queue cannot be overwritten", () => {
    renderEditor({ conflict: "missing" });
    expect(screen.queryByRole("button", { name: "Use mine" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: "Discard mine" })).toBeTruthy();
  });

  test.each([undefined, "changed"] as const)(
    "composing Escape preserves the editor with conflict %s",
    (conflict) => {
      const props = renderEditor({ conflict });
      const textarea = screen.getByRole("textbox", { name: "Queued prompt 2 text" });
      fireEvent.keyDown(textarea, { key: "Escape", isComposing: true });
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, isComposing: true });
      expect(props.onCancel).not.toHaveBeenCalled();
      expect(props.onDiscard).not.toHaveBeenCalled();
      expect(props.onSave).not.toHaveBeenCalled();
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(conflict ? props.onDiscard : props.onCancel).toHaveBeenCalledTimes(1);
    },
  );
});

describe("QueuedPromptStack edit states", () => {
  function renderStack(items: NativeComposeQueuedPrompt[]) {
    render(
      <QueuedPromptStack
        queue={{
          length: items.length,
          items,
          editor: <div data-testid="the-editor" />,
        }}
        onExit={() => {}}
      />,
    );
  }

  test("shows the editor above the list and labels each held row, in run order", () => {
    const onRelease = mock(async () => {});
    renderStack([
      { id: "q1", text: "First", onRemove: () => {} },
      { id: "q2", text: "Second", editState: "local", onRemove: () => {} },
      { id: "q3", text: "Third", editState: "review", onEdit: () => {}, onRelease },
    ]);
    expect(screen.getByTestId("the-editor")).toBeTruthy();
    const rows = screen.getAllByTestId("compose-queue-item");
    expect(rows.map((row) => row.dataset.queuedPromptId)).toEqual(["q1", "q2", "q3"]);
    const states = screen
      .getAllByTestId("compose-queue-item-edit-state")
      .map((badge) => [badge.dataset.editState, badge.textContent]);
    expect(states).toEqual([
      ["local", "Editing"],
      ["review", "Edit unfinished"],
    ]);
    expect(screen.getByRole("button", { name: "Review the unfinished edit 3 of 3" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release queued prompt 3 of 3 unchanged" }));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  test("a prompt edited on another device offers to take the edit over", () => {
    renderStack([{ id: "q1", text: "First", editState: "elsewhere", onEdit: () => {} }]);
    expect(
      screen.getByRole("button", { name: "Take over editing from the other device 1 of 1" }),
    ).toBeTruthy();
  });
});
