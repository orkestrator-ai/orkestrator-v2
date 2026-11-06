import { MermaidBlock } from "../../apps/web/src/components/chat/rich/MermaidBlock";
import { setMermaidRenderer } from "../../apps/web/src/lib/chat/rich-markdown/mermaid-render";

// The backend diagram renderer answers the way a host without the preview
// worker does, or with a syntax error, so the block's failure notices show.
setMermaidRenderer(async ({ source }) =>
  source.includes("broken")
    ? {
        ok: false,
        error: {
          code: "validation_failed",
          message: "Parse error: expecting 'SQE', got 'PS'",
          line: 2,
          column: 14,
        },
      }
    : {
        ok: false,
        error: {
          code: "renderer_unavailable",
          message: "Diagram rendering is unavailable on this host",
        },
      },
);

const unavailable = ["flowchart LR", "  A[Agent] --> B[Bridge]", "  B --> C[Backend]"].join("\n");
const broken = ["flowchart LR", "  broken[Agent --> (B", "  B --> C"].join("\n");

export function RichBlockNoticesFixture() {
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-[56rem] space-y-4 text-sm">
        <p>Here is how the request flows through the system:</p>
        <MermaidBlock source={unavailable} closed blockKey="fixture-unavailable" />
        <p>And a diagram with a syntax error:</p>
        <MermaidBlock source={broken} closed blockKey="fixture-broken" />
      </div>
    </main>
  );
}
