import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useFileDirtyStore } from "@/stores/fileDirtyStore";
import * as realMonacoFileEditor from "@/components/terminal/MonacoFileEditor";
import { MarkdownManager } from "@tiptap/markdown";
import type { Editor } from "@tiptap/react";

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
type TiptapEditorElement = HTMLElement & { editor: Editor };

function seedMarkdown(markdown: string): void {
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  useFileDirtyStore.getState().setOriginalContent(TAB_ID, markdown);
}

beforeEach(() => {
  seedMarkdown(ORIGINAL_MARKDOWN);
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
      (await screen.findByRole("textbox", {
        name: "Raw Markdown source",
      }) as HTMLTextAreaElement).value,
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
    const rawEditor = await screen.findByRole("textbox", { name: "Raw Markdown source" });
    fireEvent.change(rawEditor, { target: { value: "# Ready to save" } });
    fireEvent.keyDown(rawEditor, { key: "s", ctrlKey: true });

    expect(useFileDirtyStore.getState().getContent(TAB_ID)).toBe("# Ready to save");
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  test("flushes a pending rendered edit before entering raw mode", async () => {
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

    const editor = await screen.findByTestId(
      "tiptap-markdown-editor",
    ) as TiptapEditorElement;
    act(() => {
      editor.editor.commands.setContent("<p>Changed while rendered</p>");
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Raw" }), { button: 0 });

    expect(
      (await screen.findByRole("textbox", {
        name: "Raw Markdown source",
      }) as HTMLTextAreaElement).value,
    ).toBe("Changed while rendered");
    expect(useFileDirtyStore.getState().isDirty(TAB_ID)).toBe(true);
  });

  test("renders and preserves GFM tables in Rendered mode", async () => {
    const table = "| Name | Value |\n| --- | --- |\n| one | two |";
    seedMarkdown(table);

    render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="TABLE.md"
        initialContent={table}
        language="markdown"
        isActive
        isSaving={false}
        onSave={mock(async () => true)}
      />,
    );

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "two" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Rendered" }).getAttribute("data-state"))
      .toBe("active");
  });

  test("starts frontmatter documents in Rendered mode", async () => {
    const markdown = [
      "---",
      "name: angela-search-scrape",
      "description: Use Angela's production Search & Scrape API.",
      "---",
      "",
      "# Angela Search & Scrape",
    ].join("\n");
    seedMarkdown(markdown);

    render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="SKILL.md"
        initialContent={markdown}
        language="markdown"
        isActive
        isSaving={false}
        onSave={mock(async () => true)}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Angela Search & Scrape" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Rendered" }).getAttribute("data-state"))
      .toBe("active");
    expect(screen.queryByText(/cannot preserve/i) === null).toBe(true);
  });

  test("preserves frontmatter when a rendered edit switches to Raw mode", async () => {
    const markdown = "---\ntitle: Example\n---\n\nOriginal body";
    seedMarkdown(markdown);
    render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="SKILL.md"
        initialContent={markdown}
        language="markdown"
        isActive
        isSaving={false}
        onSave={mock(async () => true)}
      />,
    );

    const editor = await screen.findByTestId(
      "tiptap-markdown-editor",
    ) as TiptapEditorElement;
    act(() => {
      editor.editor.commands.setContent("<p>Updated body</p>");
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Raw" }), { button: 0 });

    expect(
      (await screen.findByRole("textbox", {
        name: "Raw Markdown source",
      }) as HTMLTextAreaElement).value,
    ).toBe("---\ntitle: Example\n---\n\nUpdated body");
  });

  test("keeps frontmatter stable across Raw, Rendered, edit, and save", async () => {
    const markdown = "---\ntitle: Example\n---\n\nOriginal body";
    const onSave = mock(async () => true);
    seedMarkdown(markdown);
    render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="SKILL.md"
        initialContent={markdown}
        language="markdown"
        isActive
        isSaving={false}
        onSave={onSave}
      />,
    );

    await screen.findByText("Original body");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Raw" }), { button: 0 });
    fireEvent.change(await screen.findByRole("textbox", {
      name: "Raw Markdown source",
    }), {
      target: { value: "---\ntitle: Example\n---\n\nRaw body" },
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Rendered" }), {
      button: 0,
    });

    const editor = await screen.findByTestId("tiptap-markdown-editor") as
      TiptapEditorElement;
    expect(await screen.findByText("Raw body")).toBeTruthy();
    expect(editor.textContent).not.toContain("title: Example");
    act(() => {
      editor.editor.commands.setContent("<p>Saved body</p>");
    });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    expect(onSave).toHaveBeenCalledWith(
      "---\ntitle: Example\n---\n\nSaved body",
    );
  });

  test("renders and preserves delimiter blocks that are not frontmatter", async () => {
    const markdown = "Intro\n\n---\n\ntitle: x\n\n---\n\nBody";
    seedMarkdown(markdown);
    render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="RULES.md"
        initialContent={markdown}
        language="markdown"
        isActive
        isSaving={false}
        onSave={mock(async () => true)}
      />,
    );

    expect(await screen.findByText("Intro")).toBeTruthy();
    expect(screen.getByText("title: x")).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
    const editor = await screen.findByTestId("tiptap-markdown-editor") as
      TiptapEditorElement;
    act(() => {
      editor.editor.commands.setContent(
        "<p>Updated intro</p><hr><p>title: x</p><hr><p>Body</p>",
      );
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Raw" }), { button: 0 });

    const raw = (await screen.findByRole("textbox", {
      name: "Raw Markdown source",
    }) as HTMLTextAreaElement).value;
    expect(raw).toContain("Updated intro");
    expect(raw).toContain("title: x");
    expect(raw).toContain("Body");
    expect(raw.match(/---/g)?.length).toBe(2);
  });

  test("starts lossy Markdown in raw mode and blocks Rendered mode", () => {
    const unsupported = "Paragraph\n\n[^1]: footnote";
    seedMarkdown(unsupported);

    render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="FOOTNOTES.md"
        initialContent={unsupported}
        language="markdown"
        isActive
        isSaving={false}
        onSave={mock(async () => true)}
      />,
    );

    const renderedTab = screen.getByRole("tab", { name: "Rendered" });
    expect(screen.getByRole("tab", { name: "Raw" }).getAttribute("data-state"))
      .toBe("active");
    expect(screen.getByText(/cannot preserve/i)).toBeTruthy();
    fireEvent.mouseDown(renderedTab, { button: 0 });
    expect(renderedTab.getAttribute("data-state")).toBe("inactive");
  });

  test("allows Rendered mode after unsupported syntax is removed in raw mode", async () => {
    const unsupported = "Paragraph\n\n[^1]: footnote";
    seedMarkdown(unsupported);
    render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="FOOTNOTES.md"
        initialContent={unsupported}
        language="markdown"
        isActive
        isSaving={false}
        onSave={mock(async () => true)}
      />,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Raw Markdown source" }), {
      target: { value: "# Safe again" },
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Rendered" }), {
      button: 0,
    });

    expect(await screen.findByRole("heading", { name: "Safe again" })).toBeTruthy();
    expect(screen.queryByText(/cannot preserve/i) === null).toBe(true);
  });

  test("falls back to Raw mode when Tiptap reports a content error", async () => {
    const originalParse = MarkdownManager.prototype.parse;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let parseCalls = 0;
    MarkdownManager.prototype.parse = function (
      this: MarkdownManager,
      ...args
    ) {
      parseCalls += 1;
      if (parseCalls === 1) {
        return originalParse.apply(this, args);
      }
      return {
        type: "doc",
        content: [{ type: "unknownTestNode" }],
      };
    } as typeof MarkdownManager.prototype.parse;

    try {
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

      expect(
        await screen.findByText(/Invalid JSON content/i),
      ).toBeTruthy();
      expect(screen.getByRole("tab", { name: "Raw" }).getAttribute("data-state"))
        .toBe("active");
      expect(
        (await screen.findByRole("textbox", {
          name: "Raw Markdown source",
        }) as HTMLTextAreaElement).value,
      ).toBe(ORIGINAL_MARKDOWN);
    } finally {
      MarkdownManager.prototype.parse = originalParse;
      warn.mockRestore();
    }
  });

  test("shows saving state and disables pointer interaction while inactive", () => {
    const { container } = render(
      <MarkdownEditorTab
        tabId={TAB_ID}
        filePath="README.md"
        initialContent={ORIGINAL_MARKDOWN}
        language="markdown"
        isActive={false}
        isSaving
        onSave={mock(async () => true)}
      />,
    );

    expect(screen.getByText("Saving...")).toBeTruthy();
    expect(container.firstElementChild?.className).toContain("pointer-events-none");
    expect(container.firstElementChild?.className).toContain("opacity-0");
  });
});
