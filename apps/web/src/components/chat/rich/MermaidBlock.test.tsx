import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FRONTEND_RENDER_POLICY, MERMAID_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type {
  MermaidRenderRequest,
  MermaidRenderResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  restoreRichFindReveals,
  revealRichBlockForFind,
  searchRootText,
} from "@/lib/chat/rich-markdown/find-reveal";
import {
  setMermaidRenderer,
  setMermaidSvgSanitizer,
} from "@/lib/chat/rich-markdown/mermaid-render";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { MermaidBlock } from "./MermaidBlock";
import { pinRichViewWithRecovery, resetRichViewPinRecovery } from "./CodeBlockViewer";

const SOURCE = "flowchart TD\n  A[Input] --> B{Valid?}\n  B -->|Yes| C[Render]";
const SVG =
  '<svg viewBox="0 0 200 100"><g class="node"><text>Input</text></g><script>alert(1)</script></svg>';

function ok(svg = SVG): MermaidRenderResponse {
  return {
    ok: true,
    svg,
    diagramType: "flowchart",
    rendererVersion: "test",
    svgBytes: svg.length,
    svgElements: 4,
    edges: 2,
    renderDigest: "digest",
  };
}

let renderer: ReturnType<
  typeof mock<(input: MermaidRenderRequest) => Promise<MermaidRenderResponse>>
>;
const sanitize = mock((markup: string) => ({
  svg: markup.replace(/<script>[\s\S]*?<\/script>/g, ""),
}));

beforeEach(() => {
  renderer = mock(async () => ok());
  setMermaidRenderer(renderer);
  setMermaidSvgSanitizer(sanitize);
  sanitize.mockClear();
  richRenderScheduler.clear();
  useRichContentViewStore.getState().reset();
  resetRichViewPinRecovery();
});

afterEach(() => {
  cleanup();
  setMermaidRenderer(null);
  setMermaidSvgSanitizer(null);
});

describe("MermaidBlock", () => {
  test("renders a closed fence through the renderer and sanitizes the SVG again before insertion", async () => {
    const { container } = render(<MermaidBlock source={SOURCE} closed blockKey="m1" />);
    await waitFor(() =>
      expect(container.querySelector("[data-rich-search-exclude] svg")).toBeTruthy(),
    );
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(renderer.mock.calls[0]?.[0]).toMatchObject({ source: SOURCE });
    expect(sanitize).toHaveBeenCalledWith(SVG);
    expect(container.innerHTML).not.toContain("<script");
    // The SVG labels are not searchable; the source is, through its mirror.
    expect(searchRootText(container)).toBe(SOURCE);
  });

  test("a closed fence keeps the preview's frame while its first render is pending", async () => {
    let resolveRender!: (response: MermaidRenderResponse) => void;
    renderer = mock(
      () => new Promise<MermaidRenderResponse>((resolve) => (resolveRender = resolve)),
    );
    setMermaidRenderer(renderer);
    const { container } = render(<MermaidBlock source={SOURCE} closed blockKey="m-frame" />);
    await waitFor(() => expect(renderer).toHaveBeenCalledTimes(1));
    // Not the variable-height source: the same fixed frame the diagram uses.
    const placeholder = container.querySelector("[data-rich-preview-placeholder]");
    expect(placeholder?.className).toContain("h-80");
    expect(container.querySelector("pre") === null).toBe(true);
    expect(searchRootText(container)).toBe(SOURCE);
    await act(async () => resolveRender(ok()));
    await waitFor(() =>
      expect(container.querySelector("[data-rich-search-exclude] svg")).toBeTruthy(),
    );
    expect(container.querySelector("[data-rich-preview-placeholder]") === null).toBe(true);
    expect(container.querySelector(".h-80")).toBeTruthy();
  });

  test("never renders an open (streaming or clipped) fence", async () => {
    const { container } = render(
      <MermaidBlock source={SOURCE} closed={false} live blockKey="m2" />,
    );
    expect(screen.getByText("Waiting for the complete diagram…")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderer).not.toHaveBeenCalled();
    expect(searchRootText(container)).toBe(SOURCE);
  });

  test("source over the 32 KiB limit is refused before any render request", async () => {
    const source = `flowchart TD\n${"%".repeat(MERMAID_POLICY.maxSourceBytes)}`;
    render(<MermaidBlock source={source} closed blockKey="m3" />);
    expect(await screen.findByText("Diagram exceeds a rendering limit")).toBeTruthy();
    expect(renderer).not.toHaveBeenCalled();
  });

  test("a syntax error shows its location, keeps the source and is never retried automatically", async () => {
    renderer.mockImplementation(async () => ({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Parse error on line 2",
        retryClass: "after-edit",
        line: 2,
        column: 5,
      },
    }));
    const first = render(<MermaidBlock source={SOURCE} closed blockKey="m4" />);
    expect(await screen.findByText("Diagram syntax error")).toBeTruthy();
    expect(screen.getAllByText(/line 2, column 5/).length).toBeGreaterThan(0);
    expect(searchRootText(first.container)).toBe(SOURCE);
    expect(screen.queryByRole("button", { name: "Retry rendering" }) === null).toBe(true);
    first.unmount();
    render(<MermaidBlock source={SOURCE} closed blockKey="m4" />);
    expect(await screen.findByText("Diagram syntax error")).toBeTruthy();
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  test("an unavailable renderer (thrown backend error) shows the source and an explicit retry", async () => {
    renderer.mockImplementation(async () => {
      throw new Error(
        JSON.stringify({
          code: "renderer_unavailable",
          message: "No preview worker",
          retryClass: "never",
        }),
      );
    });
    render(<MermaidBlock source={SOURCE} closed blockKey="m5" />);
    expect(await screen.findByText("Diagram renderer unavailable")).toBeTruthy();
    expect(renderer).toHaveBeenCalledTimes(1);
    renderer.mockImplementation(async () => ok());
    fireEvent.click(screen.getByRole("button", { name: "Retry rendering" }));
    await waitFor(() => expect(renderer).toHaveBeenCalledTimes(2));
  });

  test("labels an earlier source's preview while the new source renders", async () => {
    const { container, rerender } = render(<MermaidBlock source={SOURCE} closed blockKey="m6" />);
    await waitFor(() =>
      expect(container.querySelector("[data-rich-search-exclude] svg")).toBeTruthy(),
    );
    renderer.mockImplementation(() => new Promise(() => {}));
    rerender(<MermaidBlock source={`${SOURCE}\n  C --> D`} closed blockKey="m6" />);
    expect(await screen.findByText(/earlier version of this diagram/)).toBeTruthy();
  });

  test("source view choice persists and find reveal shows the source temporarily", async () => {
    const { container, unmount } = render(<MermaidBlock source={SOURCE} closed blockKey="m7" />);
    await waitFor(() =>
      expect(container.querySelector("[data-rich-search-exclude] svg")).toBeTruthy(),
    );
    act(() => revealRichBlockForFind("m7", "find-test"));
    expect(container.querySelector("[data-rich-search-exclude] svg") === null).toBe(true);
    expect(container.querySelector("[data-rich-search-mirror]") === null).toBe(true);
    act(() => restoreRichFindReveals("find-test"));
    expect(container.querySelector("[data-rich-search-exclude] svg")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    unmount();
    const remounted = render(<MermaidBlock source={SOURCE} closed blockKey="m7" />);
    expect(screen.getByRole("button", { name: "Show source" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(searchRootText(remounted.container)).toBe(SOURCE);
  });

  test("the expanded dialog persists in the scoped view store across unmount/remount", async () => {
    const first = render(<MermaidBlock source={SOURCE} closed blockKey="m8" />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand diagram" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useRichContentViewStore.getState().entries.get("m8")?.expanded).toBe(true);

    // Scrolled away (virtualized out) and back: same identity, dialog restored.
    first.unmount();
    expect(screen.queryByRole("dialog") === null).toBe(true);
    render(<MermaidBlock source={SOURCE} closed blockKey="m8" />);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(renderer).toHaveBeenCalledTimes(1);

    // Closing it is persisted too, and a different identity never shares it.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(useRichContentViewStore.getState().entries.get("m8")?.expanded).toBe(false);
    cleanup();
    render(<MermaidBlock source={SOURCE} closed blockKey="m9" />);
    await screen.findByRole("button", { name: "Expand diagram" });
    expect(screen.queryByRole("dialog") === null).toBe(true);
  });

  test("a displaced expanded diagram offers Reopen, which restores the dialog and its zoom", async () => {
    const { container } = render(<MermaidBlock source={SOURCE} closed blockKey="m10" />);
    fireEvent.click(await screen.findByRole("button", { name: "Zoom in" }));
    const zoomed = useRichContentViewStore.getState().entries.get("m10")?.viewport;
    expect(zoomed?.scale).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "Expand diagram" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => {
      for (let index = 0; index < FRONTEND_RENDER_POLICY.maxPinnedViewStateEntries; index++)
        pinRichViewWithRecovery(`other-diagram-${index}`);
    });
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    const notice = container.querySelector("[data-rich-pin-displaced]") as HTMLElement;
    expect(notice.textContent).toContain("expanded diagram was closed");

    act(() => useRichContentViewStore.getState().clearPrefixes(["m10"]));
    fireEvent.click(within(notice).getByRole("button", { name: /Reopen/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(useRichContentViewStore.getState().entries.get("m10")?.viewport).toEqual(zoomed!);
  });
});

test("transient capacity failure retries automatically without user action", async () => {
  const { RichRenderCapacityError } = await import("@/lib/chat/rich-render-cache");
  const request = richRenderScheduler.request.bind(richRenderScheduler);
  let count = 0;
  richRenderScheduler.request = ((input) =>
    ++count === 1
      ? { promise: Promise.reject(new RichRenderCapacityError("jobs")), cancel() {} }
      : request(input)) as typeof richRenderScheduler.request;
  const { container } = render(<MermaidBlock source={SOURCE} closed blockKey="capacity" />);
  await waitFor(() =>
    expect(container.querySelector("[data-rich-search-exclude] svg")).toBeTruthy(),
  );
  expect(renderer).toHaveBeenCalledTimes(1);
  expect(count).toBe(2);
  richRenderScheduler.request = request;
});
