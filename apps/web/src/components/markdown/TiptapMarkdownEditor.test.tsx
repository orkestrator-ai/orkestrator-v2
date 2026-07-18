import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  test("renders GFM tables in WYSIWYG mode", async () => {
    render(
      <TiptapMarkdownEditor
        markdown={"| Name | Value |\n| --- | --- |\n| one | two |"}
        fontFamily="Fira Code"
        fontSize={14}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "two" })).toBeTruthy();
  });

  test("debounces rich-editor changes into Markdown", async () => {
    const onChange = mock((_markdown: string) => {});
    render(
      <TiptapMarkdownEditor
        markdown="Original"
        fontFamily="Fira Code"
        fontSize={14}
        onChange={onChange}
        onSave={() => {}}
      />,
    );

    const editor = await screen.findByTestId("tiptap-markdown-editor");
    editor.innerHTML = "<p>Updated in rendered mode</p>";
    fireEvent.input(editor, {
      data: "Updated in rendered mode",
      inputType: "insertText",
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });

    expect(onChange).toHaveBeenCalledWith("Updated in rendered mode");
  });

  test("flushes a pending rich edit on save", async () => {
    const onChange = mock((_markdown: string) => {});
    const onSave = mock((_markdownOverride?: string) => {});
    render(
      <TiptapMarkdownEditor
        markdown="Original"
        fontFamily="Fira Code"
        fontSize={14}
        onChange={onChange}
        onSave={onSave}
      />,
    );

    const editor = await screen.findByTestId("tiptap-markdown-editor");
    editor.innerHTML = "<p>Save immediately</p>";
    fireEvent.input(editor, { data: "Save immediately", inputType: "insertText" });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    expect(onSave).toHaveBeenCalledWith("Save immediately");
    expect(onChange).toHaveBeenCalledWith("Save immediately");
  });

  test("flushes a pending rich edit on unmount", async () => {
    const onChange = mock((_markdown: string) => {});
    const view = render(
      <TiptapMarkdownEditor
        markdown="Original"
        fontFamily="Fira Code"
        fontSize={14}
        onChange={onChange}
        onSave={() => {}}
      />,
    );

    const editor = await screen.findByTestId("tiptap-markdown-editor");
    editor.innerHTML = "<p>Flush on unmount</p>";
    fireEvent.input(editor, { data: "Flush on unmount", inputType: "insertText" });
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();

    expect(onChange).toHaveBeenCalledWith("Flush on unmount");
  });
});
