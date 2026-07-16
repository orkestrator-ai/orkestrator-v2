import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { createMarkdownExtensions } from "./tiptap-extensions";

const STORE_SYNC_DELAY_MS = 300;

export interface TiptapMarkdownEditorHandle {
  /** Flush any editor update that has not reached the dirty store yet. */
  flushPendingChanges: () => string | null;
}

interface TiptapMarkdownEditorProps {
  markdown: string;
  fontFamily: string;
  fontSize: number;
  onChange: (markdown: string) => void;
  onSave: (markdownOverride?: string) => void | Promise<unknown>;
  onParseError?: (error: Error) => void;
}

export const TiptapMarkdownEditor = forwardRef<
  TiptapMarkdownEditorHandle,
  TiptapMarkdownEditorProps
>(function TiptapMarkdownEditor(
  { markdown, fontFamily, fontSize, onChange, onSave, onParseError },
  ref,
) {
  const editorRef = useRef<Editor | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasPendingChangesRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onParseErrorRef = useRef(onParseError);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onParseErrorRef.current = onParseError;
  }, [onChange, onParseError, onSave]);

  const syncEditorToStore = useCallback((): string | null => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.isDestroyed || !hasPendingChangesRef.current) {
      return null;
    }

    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }

    const currentMarkdown = currentEditor.getMarkdown();
    hasPendingChangesRef.current = false;
    onChangeRef.current(currentMarkdown);
    return currentMarkdown;
  }, []);

  useImperativeHandle(ref, () => ({
    flushPendingChanges: syncEditorToStore,
  }), [syncEditorToStore]);

  const editor = useEditor({
    extensions: createMarkdownExtensions(),
    content: markdown,
    contentType: "markdown",
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "prose prose-invert max-w-none min-h-full px-8 py-6 text-foreground focus:outline-none " +
          "prose-headings:text-foreground prose-p:my-3 prose-headings:mt-6 prose-headings:mb-3 " +
          "prose-a:text-primary prose-code:text-foreground prose-code:bg-muted prose-code:rounded prose-code:px-1 prose-code:py-0.5 " +
          "prose-code:font-[var(--markdown-mono-font)] prose-pre:font-[var(--markdown-mono-font)] " +
          "prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-blockquote:text-muted-foreground " +
          "prose-table:text-sm prose-th:text-foreground [&_table]:border-collapse [&_th]:border [&_th]:border-border " +
          "[&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 " +
          "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0 " +
          "[&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:items-start [&_ul[data-type=taskList]_li]:gap-2 " +
          "[&_ul[data-type=taskList]_li>label]:mt-1 [&_ul[data-type=taskList]_li>div]:flex-1",
        "data-testid": "tiptap-markdown-editor",
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          const markdownOverride = syncEditorToStore() ?? undefined;
          void onSaveRef.current(markdownOverride);
          return true;
        }

        return false;
      },
    },
    onCreate: ({ editor: createdEditor }) => {
      editorRef.current = createdEditor;
    },
    onUpdate: ({ editor: updatedEditor }) => {
      editorRef.current = updatedEditor;
      hasPendingChangesRef.current = true;

      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
      }

      syncTimerRef.current = setTimeout(() => {
        syncEditorToStore();
      }, STORE_SYNC_DELAY_MS);
    },
    onContentError: ({ error }) => {
      onParseErrorRef.current?.(error);
    },
    onDestroy: () => {
      const destroyedEditor = editorRef.current;
      if (destroyedEditor && hasPendingChangesRef.current) {
        if (syncTimerRef.current) {
          clearTimeout(syncTimerRef.current);
          syncTimerRef.current = null;
        }
        hasPendingChangesRef.current = false;
        onChangeRef.current(destroyedEditor.getMarkdown());
      }
      editorRef.current = null;
    },
  });

  useEffect(() => {
    if (editor) {
      editorRef.current = editor;
    }
  }, [editor]);

  useEffect(() => {
    return () => {
      syncEditorToStore();
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [syncEditorToStore]);

  return (
    <EditorContent
      editor={editor}
      className="min-h-full"
      style={{
        fontSize: `${fontSize}px`,
        fontFamily: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
        // Expose the configured monospace face to descendants without making
        // the entire rendered document use the terminal font.
        "--markdown-mono-font": `"${fontFamily}", "Fira Code", monospace`,
      } as CSSProperties}
    />
  );
});
