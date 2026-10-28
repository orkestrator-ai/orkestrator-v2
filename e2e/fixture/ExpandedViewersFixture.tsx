import { useState } from "react";
import { SourceViewerDialog } from "../../apps/web/src/components/chat/rich/CodeBlockViewer";
import { FilePreview } from "../../apps/web/src/components/chat/rich/FilePreview";
import { MediaGalleryDialog } from "../../apps/web/src/components/chat/rich/MediaGallery";
import { MermaidBlock } from "../../apps/web/src/components/chat/rich/MermaidBlock";
import { RichTable } from "../../apps/web/src/components/chat/rich/RichTable";
import { setMermaidRenderer } from "../../apps/web/src/lib/chat/rich-markdown/mermaid-render";

// Only the backend diagram renderer is replaced; the real preview, sanitizer,
// expansion controls and dialog sizing run in the browser.
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text x="10" y="50">Input to output</text></svg>';
setMermaidRenderer(async () => ({
  ok: true,
  svg,
  diagramType: "flowchart",
  rendererVersion: "width-fixture",
  svgBytes: svg.length,
  svgElements: 2,
  edges: 1,
  renderDigest: "width-fixture",
}));
const image = `data:image/svg+xml,${encodeURIComponent(svg)}`;
const galleryItems = [{ title: "Width fixture", element: () => null, load: async () => image }];

export function ExpandedViewersFixture() {
  const [open, setOpen] = useState(false);
  const viewer = new URLSearchParams(window.location.search).get("viewer");
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      {viewer === "source" ? (
        <>
          <button onClick={() => setOpen(true)}>Expand source</button>
          <SourceViewerDialog
            open={open}
            onOpenChange={setOpen}
            title="Expanded source"
            source={"source text ".repeat(100)}
          />
        </>
      ) : viewer === "file" ? (
        <FilePreview
          name="fixture.txt"
          reference={{
            path: "fixture.txt",
            fileUrl: `data:text/plain;base64,${btoa("File preview contents")}`,
          }}
        />
      ) : viewer === "gallery" ? (
        <>
          <button onClick={() => setOpen(true)}>Open gallery</button>
          <MediaGalleryDialog
            items={galleryItems}
            initialIndex={0}
            initialSource={image}
            open={open}
            onOpenChange={setOpen}
          />
        </>
      ) : viewer === "mermaid" ? (
        <MermaidBlock
          source={"flowchart TD\nA[Input] --> B[Output]"}
          closed
          blockKey="width-diagram"
        />
      ) : viewer === "table" ? (
        <RichTable
          blockKey="width-table"
          model={{
            header: ["Name", "Value"],
            rows: [["Fixture", "Contents"]],
            align: [null, null],
          }}
          markdownSource={null}
          partial={false}
        >
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Fixture</td>
              <td>Contents</td>
            </tr>
          </tbody>
        </RichTable>
      ) : null}
    </main>
  );
}
