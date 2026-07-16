import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import {
  TiptapMarkdownEditor,
  type TiptapMarkdownEditorHandle,
} from "./TiptapMarkdownEditor";

afterEach(() => {
  cleanup();
});

describe("TiptapMarkdownEditor", () => {
  test("renders Markdown without rewriting untouched source", async () => {
    const onChange = mock((_markdown: string) => {});
    const ref = createRef<TiptapMarkdownEditorHandle>();

    render(
      <TiptapMarkdownEditor
        ref={ref}
        markdown={"# Rendered heading\n\n- [ ] pending"}
        fontFamily="Fira Code"
        fontSize={14}
        onChange={onChange}
        onSave={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Rendered heading" })).toBeTruthy();
    });

    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(ref.current?.flushPendingChanges()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("handles Cmd+S and Ctrl+S inside rendered mode", async () => {
    const onSave = mock((_markdownOverride?: string) => {});

    render(
      <TiptapMarkdownEditor
        markdown="# Save me"
        fontFamily="Fira Code"
        fontSize={14}
        onChange={() => {}}
        onSave={onSave}
      />,
    );

    const editor = await screen.findByTestId("tiptap-markdown-editor");
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenNthCalledWith(1, undefined);
    expect(onSave).toHaveBeenNthCalledWith(2, undefined);
  });
});
