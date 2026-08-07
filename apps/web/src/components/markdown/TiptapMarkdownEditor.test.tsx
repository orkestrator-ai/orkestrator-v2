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
import type { Editor } from "@tiptap/react";
import {
  TiptapMarkdownEditor,
  type TiptapMarkdownEditorHandle,
} from "./TiptapMarkdownEditor";

type TiptapEditorElement = HTMLElement & { editor: Editor };

function interceptStoreSyncTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const interceptedHandle = {} as ReturnType<typeof setTimeout>;
  let scheduledCallback: (() => void) | undefined;

  globalThis.setTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (timeout === 300 && typeof handler === "function") {
      scheduledCallback = () => handler(...args);
      return interceptedHandle;
    }
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle === interceptedHandle) {
      scheduledCallback = undefined;
      return;
    }
    originalClearTimeout(handle);
  }) as typeof globalThis.clearTimeout;

  return {
    hasScheduledCallback: () => scheduledCallback !== undefined,
    runScheduledCallback: () => {
      const callback = scheduledCallback;
      scheduledCallback = undefined;
      callback?.();
    },
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

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

  test("leaves ordinary editor key presses unhandled", async () => {
    const onSave = mock((_markdownOverride?: string) => {});
    render(
      <TiptapMarkdownEditor
        markdown="# Keep typing"
        fontFamily="Fira Code"
        fontSize={14}
        onChange={() => {}}
        onSave={onSave}
      />,
    );

    const editor = await screen.findByTestId("tiptap-markdown-editor");
    expect(fireEvent.keyDown(editor, { key: "x" })).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
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

    const editor = await screen.findByTestId(
      "tiptap-markdown-editor",
    ) as TiptapEditorElement;
    const timeout = interceptStoreSyncTimeout();
    try {
      act(() => {
        editor.editor.commands.setContent("<p>Updated in rendered mode</p>");
      });

      expect(timeout.hasScheduledCallback()).toBe(true);
      expect(onChange).not.toHaveBeenCalled();
      act(() => timeout.runScheduledCallback());
      expect(onChange).toHaveBeenCalledWith("Updated in rendered mode");
    } finally {
      cleanup();
      timeout.restore();
    }
  });

  test("preserves leading frontmatter when serializing a rendered edit", async () => {
    const onChange = mock((_markdown: string) => {});
    const ref = createRef<TiptapMarkdownEditorHandle>();
    const frontmatter = [
      "---",
      "name: angela-search-scrape",
      "description: Use Angela's production API.",
      "---",
      "",
      "",
    ].join("\n");

    render(
      <TiptapMarkdownEditor
        ref={ref}
        markdown={`${frontmatter}# Original\n\nBody`}
        fontFamily="Fira Code"
        fontSize={14}
        onChange={onChange}
        onSave={() => {}}
      />,
    );

    const editor = await screen.findByTestId(
      "tiptap-markdown-editor",
    ) as TiptapEditorElement;
    expect(screen.getByRole("heading", { name: "Original" })).toBeTruthy();
    expect(editor.textContent).not.toContain("angela-search-scrape");

    act(() => {
      editor.editor.commands.setContent("<h1>Updated</h1><p>Body</p>");
    });
    expect(ref.current?.flushPendingChanges()).toBe(
      `${frontmatter}# Updated\n\nBody`,
    );
    expect(onChange).toHaveBeenCalledWith(`${frontmatter}# Updated\n\nBody`);
  });

  test("inserts a separator when adding the first body to EOF frontmatter", async () => {
    const onChange = mock((_markdown: string) => {});
    const ref = createRef<TiptapMarkdownEditorHandle>();
    const view = render(
      <TiptapMarkdownEditor
        ref={ref}
        markdown={"---\ntitle: Empty page\n---"}
        fontFamily="Fira Code"
        fontSize={14}
        onChange={onChange}
        onSave={() => {}}
      />,
    );

    let editor = await screen.findByTestId(
      "tiptap-markdown-editor",
    ) as TiptapEditorElement;
    act(() => {
      editor.editor.commands.setContent("<p>First body</p>");
    });
    expect(ref.current?.flushPendingChanges()).toBe(
      "---\ntitle: Empty page\n---\nFirst body",
    );
    expect(onChange).toHaveBeenCalledWith(
      "---\ntitle: Empty page\n---\nFirst body",
    );

    const firstSerialization = onChange.mock.calls.at(-1)?.[0];
    view.unmount();
    onChange.mockClear();
    const reopenedRef = createRef<TiptapMarkdownEditorHandle>();
    render(
      <TiptapMarkdownEditor
        ref={reopenedRef}
        markdown={firstSerialization!}
        fontFamily="Fira Code"
        fontSize={14}
        onChange={onChange}
        onSave={() => {}}
      />,
    );

    editor = await screen.findByTestId(
      "tiptap-markdown-editor",
    ) as TiptapEditorElement;
    act(() => {
      editor.editor.commands.setContent("<p>Second body</p>");
    });
    expect(reopenedRef.current?.flushPendingChanges()).toBe(
      "---\ntitle: Empty page\n---\nSecond body",
    );
    expect(onChange).toHaveBeenCalledWith(
      "---\ntitle: Empty page\n---\nSecond body",
    );
  });

  test("debounces multiple updates into the latest Markdown once", async () => {
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

    const editor = await screen.findByTestId("tiptap-markdown-editor") as
      TiptapEditorElement;
    const timeout = interceptStoreSyncTimeout();
    try {
      act(() => {
        editor.editor.commands.setContent("<p>First update</p>");
        editor.editor.commands.setContent("<p>Latest update</p>");
      });

      expect(timeout.hasScheduledCallback()).toBe(true);
      expect(onChange).not.toHaveBeenCalled();
      act(() => timeout.runScheduledCallback());
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith("Latest update");
    } finally {
      cleanup();
      timeout.restore();
    }
  });

  test("uses refreshed change and save callbacks after rerender", async () => {
    const firstOnChange = mock((_markdown: string) => {});
    const latestOnChange = mock((_markdown: string) => {});
    const firstOnSave = mock((_markdownOverride?: string) => {});
    const latestOnSave = mock((_markdownOverride?: string) => {});
    const view = render(
      <TiptapMarkdownEditor
        markdown="Original"
        fontFamily="Fira Code"
        fontSize={14}
        onChange={firstOnChange}
        onSave={firstOnSave}
      />,
    );

    view.rerender(
      <TiptapMarkdownEditor
        markdown="Original"
        fontFamily="Fira Code"
        fontSize={14}
        onChange={latestOnChange}
        onSave={latestOnSave}
      />,
    );

    const editor = await screen.findByTestId(
      "tiptap-markdown-editor",
    ) as TiptapEditorElement;
    act(() => {
      editor.editor.commands.setContent("<p>Latest callbacks</p>");
    });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    expect(firstOnChange).not.toHaveBeenCalled();
    expect(firstOnSave).not.toHaveBeenCalled();
    expect(latestOnChange).toHaveBeenCalledWith("Latest callbacks");
    expect(latestOnSave).toHaveBeenCalledWith("Latest callbacks");
  });

  test("forwards content errors through the latest parse-error callback", async () => {
    const firstOnParseError = mock((_error: Error) => {});
    const latestOnParseError = mock((_error: Error) => {});
    const view = render(
      <TiptapMarkdownEditor
        markdown="# Valid projection"
        fontFamily="Fira Code"
        fontSize={14}
        onChange={() => {}}
        onSave={() => {}}
        onParseError={firstOnParseError}
      />,
    );
    view.rerender(
      <TiptapMarkdownEditor
        markdown="# Valid projection"
        fontFamily="Fira Code"
        fontSize={14}
        onChange={() => {}}
        onSave={() => {}}
        onParseError={latestOnParseError}
      />,
    );

    const element = await screen.findByTestId("tiptap-markdown-editor") as
      TiptapEditorElement;
    const error = new Error("Invalid content after initialization");
    act(() => {
      element.editor.emit("contentError", {
        editor: element.editor,
        error,
        disableCollaboration: () => {},
      });
    });

    expect(firstOnParseError).not.toHaveBeenCalled();
    expect(latestOnParseError).toHaveBeenCalledWith(error);
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

    const editor = await screen.findByTestId(
      "tiptap-markdown-editor",
    ) as TiptapEditorElement;
    act(() => {
      editor.editor.commands.setContent("<p>Save immediately</p>");
    });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    expect(onSave).toHaveBeenCalledWith("Save immediately");
    expect(onChange).toHaveBeenCalledWith("Save immediately");
  });

  test("preserves EOF TOML frontmatter when saving the first body", async () => {
    const onChange = mock((_markdown: string) => {});
    const onSave = mock((_markdownOverride?: string) => {});
    render(
      <TiptapMarkdownEditor
        markdown={'+++\r\ntitle = "Empty page"\r\n+++'}
        fontFamily="Fira Code"
        fontSize={14}
        onChange={onChange}
        onSave={onSave}
      />,
    );

    const editor = await screen.findByTestId(
      "tiptap-markdown-editor",
    ) as TiptapEditorElement;
    act(() => {
      editor.editor.commands.setContent("<p>First body</p>");
    });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    const expected = '+++\r\ntitle = "Empty page"\r\n+++\r\nFirst body';
    expect(onChange).toHaveBeenCalledWith(expected);
    expect(onSave).toHaveBeenCalledWith(expected);
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

    const editor = await screen.findByTestId(
      "tiptap-markdown-editor",
    ) as TiptapEditorElement;
    act(() => {
      editor.editor.commands.setContent("<p>Flush on unmount</p>");
    });
    view.unmount();

    expect(onChange).toHaveBeenCalledWith("Flush on unmount");
  });

  test("preserves EOF frontmatter when the editor destroys with a pending edit", async () => {
    const onChange = mock((_markdown: string) => {});
    render(
      <TiptapMarkdownEditor
        markdown={"---\ntitle: Example\n---"}
        fontFamily="Fira Code"
        fontSize={14}
        onChange={onChange}
        onSave={() => {}}
      />,
    );

    const editor = await screen.findByTestId("tiptap-markdown-editor") as
      TiptapEditorElement;
    act(() => {
      editor.editor.commands.setContent("<p>Unmounted body</p>");
    });
    act(() => {
      editor.editor.destroy();
    });

    expect(onChange).toHaveBeenCalledWith(
      "---\ntitle: Example\n---\nUnmounted body",
    );
  });
});
