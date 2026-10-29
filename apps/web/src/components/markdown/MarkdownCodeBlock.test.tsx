import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { REPRESENTATIVE_BAR_CHART } from "@orkestrator/protocol/testing/rich-content-fixtures";
import type {
  MermaidRenderRequest,
  MermaidRenderResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  setMermaidRenderer,
  setMermaidSvgSanitizer,
} from "@/lib/chat/rich-markdown/mermaid-render";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { TiptapMarkdownEditor } from "./TiptapMarkdownEditor";

type EditorElement = HTMLElement & { editor: Editor };
const MERMAID = "flowchart LR\n  A[Original] --> B[Diagram]";
const CHART = JSON.stringify(REPRESENTATIVE_BAR_CHART, null, 2);

// Hold only the two editor debounce timers; renderer scheduling and Testing
// Library's polling still run normally. This lets edits occur within 400 ms
// without relying on the machine's wall-clock speed.
function holdEditorTimers() {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const pending = new Map<ReturnType<typeof setTimeout>, { delay: number; run: () => void }>();
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if ((delay === 300 || delay === 400) && typeof handler === "function") {
      const handle = {} as ReturnType<typeof setTimeout>;
      pending.set(handle, { delay, run: () => handler(...args) });
      return handle;
    }
    return set(handler, delay, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle && pending.delete(handle)) return;
    clear(handle);
  }) as typeof clearTimeout;
  return {
    flush: (delay: number) => {
      for (const [handle, timer] of Array.from(pending)) {
        if (timer.delay !== delay) continue;
        pending.delete(handle);
        timer.run();
      }
    },
    restore: () => {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}

let timers: ReturnType<typeof holdEditorTimers>;
let renderer: ReturnType<
  typeof mock<(input: MermaidRenderRequest) => Promise<MermaidRenderResponse>>
>;

beforeEach(() => {
  timers = holdEditorTimers();
  renderer = mock(async () => {
    const svg = '<svg viewBox="0 0 200 100"><text>Diagram</text></svg>';
    return {
      ok: true,
      svg,
      diagramType: "flowchart",
      rendererVersion: "test",
      svgBytes: svg.length,
      svgElements: 2,
      edges: 1,
      renderDigest: "test",
    };
  });
  setMermaidRenderer(renderer);
  setMermaidSvgSanitizer((svg) => ({ svg }));
  richRenderScheduler.clear();
  useRichContentViewStore.getState().reset();
});

afterEach(() => {
  cleanup();
  timers.restore();
  setMermaidRenderer(null);
  setMermaidSvgSanitizer(null);
});

async function mountFence(
  language = "mermaid",
  source = MERMAID,
  onSave = (_markdown?: string) => {},
) {
  render(
    <TiptapMarkdownEditor
      markdown={`Before\n\n\`\`\`${language}\n${source}\n\`\`\`\n\nAfter`}
      fontFamily="Fira Code"
      fontSize={14}
      onChange={() => {}}
      onSave={onSave}
    />,
  );
  return (await screen.findByTestId("tiptap-markdown-editor")) as EditorElement;
}

function fenceRange(element: EditorElement) {
  let position = -1;
  let size = 0;
  element.editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") {
      position = pos;
      size = node.nodeSize;
      return false;
    }
  });
  if (position < 0) throw new Error("Missing fence");
  return { from: position + 1, to: position + size - 1 };
}

async function replaceSource(element: EditorElement, source: string) {
  const { from, to } = fenceRange(element);
  await act(async () => {
    element.editor.commands.setTextSelection({ from, to });
    if (source) element.editor.commands.insertContent({ type: "text", text: source });
    else element.editor.commands.deleteSelection();
  });
}

function sourceBlock(element: EditorElement) {
  return element.querySelector<HTMLElement>("[data-markdown-diagram-source]")!;
}

async function leaveSource(element: EditorElement) {
  await act(async () => {
    element.editor.commands.setTextSelection(1);
  });
}

async function settlePreview() {
  await act(async () => timers.flush(400));
}

describe("diagram fences through Tiptap", () => {
  for (const control of ["canvas", "toolbar"] as const) {
    for (const modifier of ["metaKey", "ctrlKey"] as const) {
      test(`saves pending fence edits from the ${control} with ${modifier}`, async () => {
        const onSave = mock((_markdown?: string) => {});
        const element = await mountFence("mermaid", MERMAID, onSave);
        await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ });
        const latest = `${MERMAID}\n  B --> C[Latest]`;
        await replaceSource(element, latest);
        await leaveSource(element);
        await settlePreview();
        const target =
          control === "canvas"
            ? await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ })
            : await screen.findByRole("button", { name: "Zoom in" });
        target.focus();
        expect(document.activeElement).toBe(target);
        expect(fireEvent.keyDown(target, { key: "s", [modifier]: true })).toBe(false);
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith(`Before\n\n\`\`\`mermaid\n${latest}\n\`\`\`\n\nAfter`);
        expect(element.editor.state.selection.from).toBe(1);
      });
    }
  }

  test("keeps preview navigation in the canvas and offers only editable source", async () => {
    const element = await mountFence();
    const canvas = await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ });
    expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();
    expect(canvas.getAttribute("aria-label")).not.toContain("Show source");
    canvas.focus();
    const selection = element.editor.state.selection.from;
    expect(fireEvent.keyDown(canvas, { key: "ArrowRight" })).toBe(false);
    expect(element.editor.state.selection.from).toBe(selection);
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    await waitFor(() => expect(sourceBlock(element).dataset.state).toBe("open"));
    expect(element.editor.state.selection.from).toBe(fenceRange(element).to);
    expect(sourceBlock(element).querySelector("[data-node-view-content]")).toBeTruthy();
  });

  test("clearing and retyping before settling never renders stale or empty source", async () => {
    const element = await mountFence();
    await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ });
    expect(renderer).toHaveBeenCalledTimes(1);
    await replaceSource(element, "");
    expect(sourceBlock(element).dataset.state).toBe("open");
    expect(element.querySelector("[data-markdown-diagram-preview] svg")).toBeNull();
    const latest = "flowchart TD\n  New --> Result";
    await replaceSource(element, latest);
    expect(element.querySelector("[data-markdown-diagram-preview] svg")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Updating preview…");
    expect(renderer).toHaveBeenCalledTimes(1);
    await settlePreview();
    await waitFor(() => expect(renderer).toHaveBeenCalledTimes(2));
    expect(renderer.mock.calls.map(([request]) => request.source)).toEqual([MERMAID, latest]);
    await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ });
    expect(element.editor.getMarkdown()).toContain(latest);
  });

  test("creates an empty fence with editable source and waits for nonempty settled text", async () => {
    const element = await mountFence("mermaid", "");
    expect(sourceBlock(element).dataset.state).toBe("open");
    expect(renderer).not.toHaveBeenCalled();
    await settlePreview();
    expect(renderer).not.toHaveBeenCalled();
    await replaceSource(element, MERMAID);
    expect(renderer).not.toHaveBeenCalled();
    await settlePreview();
    await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ });
    expect(renderer.mock.calls.map(([request]) => request.source)).toEqual([MERMAID]);
  });

  test("renders, edits, serializes, collapses and reopens a chart fence", async () => {
    const element = await mountFence("chart", CHART);
    await waitFor(() =>
      expect(element.querySelectorAll('[data-chart-mark="bar"]')).toHaveLength(6),
    );
    expect(sourceBlock(element).dataset.state).toBe("collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    await waitFor(() => expect(sourceBlock(element).dataset.state).toBe("open"));
    const latest = CHART.replace(REPRESENTATIVE_BAR_CHART.title, "Updated chart title");
    await replaceSource(element, latest);
    await settlePreview();
    await screen.findAllByText("Updated chart title");
    expect(element.editor.getMarkdown()).toBe(`Before\n\n\`\`\`chart\n${latest}\n\`\`\`\n\nAfter`);
    await leaveSource(element);
    await waitFor(() => expect(sourceBlock(element).dataset.state).toBe("collapsed"));
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    await waitFor(() => expect(sourceBlock(element).dataset.state).toBe("open"));
    expect(sourceBlock(element).textContent).toBe(latest);
    expect(element.editor.state.selection.from).toBe(fenceRange(element).to);
  });

  test("shows malformed chart input and recovers after editing the fence", async () => {
    const element = await mountFence("chart", '{"schemaVersion": 1,');
    await screen.findByText("The chart specification is invalid");
    expect(element.querySelector("[data-chart-source-view]")?.textContent).toBe(
      '{"schemaVersion": 1,',
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    await replaceSource(element, CHART);
    await settlePreview();
    await waitFor(() =>
      expect(element.querySelectorAll('[data-chart-mark="bar"]')).toHaveLength(6),
    );
    expect(screen.queryByText("The chart specification is invalid")).toBeNull();
    expect(element.editor.getMarkdown()).toContain(`\`\`\`chart\n${CHART}\n\`\`\``);
  });

  test("recreates diagram and plain views across language changes and undo/redo", async () => {
    const element = await mountFence("text", MERMAID);
    const { from } = fenceRange(element);
    await act(async () => {
      element.editor.commands.setTextSelection(from + 4);
      element.editor.commands.updateAttributes("codeBlock", { language: "mermaid" });
    });
    await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ });
    expect(sourceBlock(element).dataset.state).toBe("open");
    expect(element.editor.state.selection.from).toBe(from + 4);
    await act(async () => {
      expect(element.editor.commands.undo()).toBe(true);
    });
    expect(element.querySelector("[data-markdown-diagram]")).toBeNull();
    expect(element.querySelector("pre > code.language-text")?.textContent).toBe(MERMAID);
    expect(element.editor.state.selection.from).toBe(from + 4);
    await act(async () => {
      expect(element.editor.commands.redo()).toBe(true);
    });
    await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ });
    await act(async () => {
      element.editor.commands.updateAttributes("codeBlock", { language: "chart" });
    });
    await screen.findByText("The chart specification is invalid");
    expect(element.querySelector('[data-markdown-diagram="chart"]')).toBeTruthy();
    expect(element.editor.state.selection.from).toBe(from + 4);
    expect(sourceBlock(element).textContent).toBe(MERMAID);
    await act(async () => {
      element.editor.commands.updateAttributes("codeBlock", { language: "ts" });
    });
    expect(element.querySelector("[data-markdown-diagram]")).toBeNull();
    expect(element.querySelector("pre > code.language-ts")?.textContent).toBe(MERMAID);
    expect(element.editor.getMarkdown()).toContain(`\`\`\`ts\n${MERMAID}\n\`\`\``);
  });

  test("undo and redo restore edited fence text and keep the selection in its source", async () => {
    const element = await mountFence();
    await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ });
    const original = element.editor.getMarkdown();
    const latest = `${MERMAID}\n  B --> C[History]`;
    await replaceSource(element, latest);
    const changed = element.editor.getMarkdown();
    await act(async () => {
      expect(element.editor.commands.undo()).toBe(true);
    });
    expect(element.editor.getMarkdown()).toBe(original);
    expect(sourceBlock(element).textContent).toBe(MERMAID);
    expect(element.editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    await act(async () => {
      expect(element.editor.commands.redo()).toBe(true);
    });
    expect(element.editor.getMarkdown()).toBe(changed);
    expect(sourceBlock(element).textContent).toBe(latest);
    expect(sourceBlock(element).dataset.state).toBe("open");
    expect(element.editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    await settlePreview();
    await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ });
    expect(renderer.mock.calls.at(-1)?.[0].source).toBe(latest);
  });

  test("read-only fences preserve source and selection while preview controls remain usable", async () => {
    const element = await mountFence();
    await screen.findByRole("img", { name: /^Mermaid flowchart diagram/ });
    await act(async () => {
      element.editor.setEditable(false);
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Edit source" })).toBeNull());
    expect(element.getAttribute("contenteditable")).toBe("false");
    expect(sourceBlock(element).textContent).toBe(MERMAID);
    const selection = element.editor.state.selection.from;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(element.editor.state.selection.from).toBe(selection);
    expect(element.editor.getMarkdown()).toContain(MERMAID);
    await act(async () => {
      element.editor.setEditable(true);
    });
    await screen.findByRole("button", { name: "Edit source" });
    expect(sourceBlock(element).dataset.state).toBe("collapsed");
  });
});
