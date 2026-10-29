import { useEffect, useId, useState } from "react";
import { CodeBlock } from "@tiptap/extension-code-block";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { Code2 } from "lucide-react";
import { ChartFenceBlock } from "@/components/chat/rich/ChartFenceBlock";
import { MermaidBlock } from "@/components/chat/rich/MermaidBlock";
import { cn } from "@/lib/utils";

type ProseMirrorNode = NodeViewRendererProps["node"];

/** Fence languages drawn by the transcript's rich blocks. */
const DIAGRAM_LANGUAGES = new Set(["mermaid", "chart"]);

/** Typing settles before a diagram is re-rendered from the edited source. */
const PREVIEW_SETTLE_MS = 400;

function diagramLanguage(node: ProseMirrorNode): "mermaid" | "chart" | null {
  const language: unknown = node.attrs.language;
  return typeof language === "string" && DIAGRAM_LANGUAGES.has(language)
    ? (language as "mermaid" | "chart")
    : null;
}

function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return settled;
}

/**
 * A `mermaid` or `chart` fence in the rendered Markdown editor: the same
 * preview block the transcript draws, above the fence's editable source. The
 * source collapses while the cursor is elsewhere and expands as soon as the
 * selection enters it (by click, arrow keys or "Edit source"). It is clipped
 * rather than removed from layout so ProseMirror can always place a DOM
 * selection inside it.
 */
function DiagramCodeBlockView({ node, editor, getPos, selectionInside }: ReactNodeViewProps) {
  const language = diagramLanguage(node) ?? "mermaid";
  const source = useSettledValue(node.textContent, PREVIEW_SETTLE_MS);
  const blockKey = `markdown-editor:${useId()}`;
  const empty = node.textContent.length === 0;
  const editing = selectionInside || empty;

  const editSource = () => {
    const position = getPos();
    if (typeof position !== "number") return;
    editor
      .chain()
      .focus()
      .setTextSelection(position + node.nodeSize - 1)
      .run();
  };

  return (
    <NodeViewWrapper data-markdown-diagram={language} className="not-prose relative my-4">
      <div contentEditable={false} data-markdown-diagram-preview="" className="select-none">
        {empty ? null : language === "mermaid" ? (
          <MermaidBlock source={source} closed blockKey={blockKey} />
        ) : (
          <ChartFenceBlock source={source} closed blockKey={blockKey} />
        )}
        {editing || !editor.isEditable ? null : (
          <button
            type="button"
            onClick={editSource}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Code2 aria-hidden="true" className="h-3 w-3" />
            Edit source
          </button>
        )}
      </div>
      <pre
        data-markdown-diagram-source=""
        data-state={editing ? "open" : "collapsed"}
        className={cn(
          "m-0 rounded-md border border-border bg-muted p-3 font-[var(--markdown-mono-font)] text-sm",
          !editing && "pointer-events-none absolute h-px w-px overflow-hidden opacity-0",
        )}
      >
        <NodeViewContent<"code"> as="code" className={`language-${language}`} />
      </pre>
    </NodeViewWrapper>
  );
}

const renderDiagramCodeBlock = ReactNodeViewRenderer(DiagramCodeBlockView, {
  // Clicks, drags and keys inside the diagram (pan, zoom, toolbar) belong to
  // the preview; only the editable source is ProseMirror's.
  stopEvent: ({ event }) =>
    event.target instanceof Element &&
    event.target.closest("[data-markdown-diagram-preview]") !== null,
  // Leaving the diagram languages recreates the node as a plain fence.
  update: ({ newNode, updateProps }) => {
    if (!diagramLanguage(newNode)) return false;
    updateProps();
    return true;
  },
});

/**
 * Plain fences keep the stock `<pre><code>` markup without a React renderer;
 * changing to a diagram language recreates the node with the preview.
 */
function plainCodeBlockView(
  node: ProseMirrorNode,
  languageClassPrefix: string | null | undefined,
): ReturnType<NodeViewRenderer> {
  const language = node.attrs.language as string | null;
  const dom = document.createElement("pre");
  const contentDOM = document.createElement("code");
  if (language && languageClassPrefix) contentDOM.className = `${languageClassPrefix}${language}`;
  dom.appendChild(contentDOM);
  return {
    dom,
    contentDOM,
    update: (next: ProseMirrorNode) =>
      next.type === node.type && next.attrs.language === language && !diagramLanguage(next),
  };
}

export const MarkdownCodeBlock = CodeBlock.extend({
  addNodeView() {
    const languageClassPrefix = this.options.languageClassPrefix;
    return (props) =>
      diagramLanguage(props.node)
        ? renderDiagramCodeBlock(props)
        : plainCodeBlockView(props.node, languageClassPrefix);
  },
});
