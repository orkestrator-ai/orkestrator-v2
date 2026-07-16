import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useFileDirtyStore } from "@/stores/fileDirtyStore";
import * as realMonacoFileEditor from "@/components/terminal/MonacoFileEditor";

const realMonacoFileEditorSnapshot = { ...realMonacoFileEditor };

mock.module("@/components/terminal/MonacoFileEditor", () => ({
  MonacoFileEditor: ({
    value,
    onChange,
    onSave,
  }: {
    value: string;
    onChange: (value: string) => void;
    onSave: () => void;
  }) => (
    <textarea
      aria-label="Raw Markdown source"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSave();
        }
      }}
    />
  ),
}));

const { MarkdownEditorTab } = await import("./MarkdownEditorTab");

const TAB_ID = "markdown-tab";
const ORIGINAL_MARKDOWN = "# Original heading\n\nOriginal body.";

beforeEach(() => {
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  useFileDirtyStore.getState().setOriginalContent(TAB_ID, ORIGINAL_MARKDOWN);
});

afterEach(() => {
  cleanup();
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
});

afterAll(() => {
  mock.module(
    "@/components/terminal/MonacoFileEditor",
    () => realMonacoFileEditorSnapshot,
  );
});

describe("MarkdownEditorTab", () => {
  test("starts rendered and preserves untouched source when entering raw mode", async () => {
    render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="README.md"
        initialContent={ORIGINAL_MARKDOWN}
        language="markdown"
        isActive
        isSaving={false}
        onSave={mock(async () => true)}
      />,
    );

    await screen.findByRole("heading", { name: "Original heading" });
    const rawTab = screen.getByRole("tab", { name: "Raw" });
    fireEvent.mouseDown(rawTab, { button: 0 });

    expect(useFileDirtyStore.getState().getContent(TAB_ID)).toBe(ORIGINAL_MARKDOWN);
    expect(useFileDirtyStore.getState().isDirty(TAB_ID)).toBe(false);
    expect(rawTab.getAttribute("data-state")).toBe("active");
    expect(
      (screen.getByRole("textbox", { name: "Raw Markdown source" }) as HTMLTextAreaElement).value,
    ).toBe(ORIGINAL_MARKDOWN);
  });

  test("rehydrates rendered mode from the dirty-store Markdown string", async () => {
    render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="README.md"
        initialContent={ORIGINAL_MARKDOWN}
        language="markdown"
        isActive
        isSaving={false}
        onSave={mock(async () => true)}
      />,
    );

    await screen.findByRole("heading", { name: "Original heading" });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Raw" }), { button: 0 });

    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown source" }), {
      target: { value: "# Updated in raw mode\n\nChanged body." },
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Rendered" }), {
      button: 0,
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Updated in raw mode" })).toBeTruthy();
    });
    expect(useFileDirtyStore.getState().isDirty(TAB_ID)).toBe(true);
  });

  test("saves the current dirty-store content from raw mode", async () => {
    const onSave = mock(async () => true);
    render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="README.md"
        initialContent={ORIGINAL_MARKDOWN}
        language="markdown"
        isActive
        isSaving={false}
        onSave={onSave}
      />,
    );

    await screen.findByRole("heading", { name: "Original heading" });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Raw" }), { button: 0 });
    const rawEditor = screen.getByRole("textbox", { name: "Raw Markdown source" });
    fireEvent.change(rawEditor, { target: { value: "# Ready to save" } });
    fireEvent.keyDown(rawEditor, { key: "s", ctrlKey: true });

    expect(useFileDirtyStore.getState().getContent(TAB_ID)).toBe("# Ready to save");
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
