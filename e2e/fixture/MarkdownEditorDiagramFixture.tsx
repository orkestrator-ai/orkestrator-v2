import { useRef, useState } from "react";
import { TiptapMarkdownEditor } from "../../apps/web/src/components/markdown/TiptapMarkdownEditor";
import { setMermaidRenderer } from "../../apps/web/src/lib/chat/rich-markdown/mermaid-render";

// Only the backend diagram renderer is replaced; the editor's node view, the
// transcript's preview block and its sanitizer run in the browser.
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 80">' +
  '<rect x="4" y="20" width="120" height="40" rx="4" fill="none" stroke="currentColor"/>' +
  '<text x="20" y="45" fill="currentColor">GraphTemplate</text>' +
  '<rect x="296" y="20" width="120" height="40" rx="4" fill="none" stroke="currentColor"/>' +
  '<text x="306" y="45" fill="currentColor">CompiledPlan</text>' +
  '<path d="M124 40 H296" stroke="currentColor"/></svg>';
setMermaidRenderer(async () => ({
  ok: true,
  svg,
  diagramType: "flowchart",
  rendererVersion: "markdown-editor-fixture",
  svgBytes: svg.length,
  svgElements: 6,
  edges: 1,
  renderDigest: "markdown-editor-fixture",
}));

const markdown = [
  "## Three layers",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[GraphTemplate] -- compile --> B[CompiledPlan]",
  "```",
  "",
  "Text after the diagram.",
].join("\n");

export function MarkdownEditorDiagramFixture() {
  const latest = useRef(markdown);
  const [saved, setSaved] = useState("");
  const [saveCount, setSaveCount] = useState(0);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <TiptapMarkdownEditor
        markdown={markdown}
        fontFamily="Fira Code"
        fontSize={14}
        onChange={(value) => {
          latest.current = value;
        }}
        onSave={(override) => {
          setSaved(override ?? latest.current);
          setSaveCount((count) => count + 1);
        }}
      />
      <output aria-label="Saved Markdown">{saved}</output>
      <output aria-label="Save count">{saveCount}</output>
    </main>
  );
}
