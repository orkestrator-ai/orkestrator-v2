import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { utf8ByteLength } from "@orkestrator/protocol/rich-content-policy";
import type { MermaidRenderRequest } from "@orkestrator/protocol/transcript-artifact-commands";
import { setHighlightBackend, type HighlightInput } from "@/lib/chat/highlighter/client";
import { bumpFontGeneration } from "@/lib/chat/highlighter/font-generation";
import { useHighlightedLines } from "@/lib/chat/highlighter/use-highlighted-lines";
import {
  peekMermaidPreview,
  requestMermaidPreview,
  setMermaidRenderer,
  setMermaidSvgSanitizer,
} from "@/lib/chat/rich-markdown/mermaid-render";
import { RichTranscriptScopeContext, type RichTranscriptScope } from "@/lib/chat/rich-identity";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import {
  RichRowVisibilityContext,
  TranscriptRowVisibilityTracker,
} from "@/lib/chat/rich-render-priority";

const SCOPE_A: RichTranscriptScope = {
  backendId: "backend-A",
  environmentId: "env-1",
  logicalSessionKey: "session-1",
  generation: "g",
};
/** Identical environment/session ids on another backend. */
const SCOPE_B: RichTranscriptScope = { ...SCOPE_A, backendId: "backend-B" };
/** Identical session id in another environment of the same backend. */
const SCOPE_C: RichTranscriptScope = { ...SCOPE_A, environmentId: "env-2" };

interface Gate {
  input: HighlightInput;
  release: () => void;
}

let calls: HighlightInput[];
let gates: Gate[];
let gated: boolean;

beforeEach(() => {
  calls = [];
  gates = [];
  gated = false;
  setHighlightBackend({
    highlight(input) {
      calls.push(input);
      const output = {
        lines: input.code.split("\n").map((line) => [{ c: line, s: "#f00" }]),
        stateId: null,
      };
      if (!gated) return Promise.resolve(output);
      return new Promise((resolve) => {
        gates.push({ input, release: () => resolve(output) });
      });
    },
  });
  richRenderScheduler.clear();
});

afterEach(() => {
  cleanup();
  setHighlightBackend(undefined);
  setMermaidRenderer(null);
  setMermaidSvgSanitizer(null);
});

function Highlighted({ code }: { code: string }) {
  const state = useHighlightedLines({
    displayText: code,
    closed: true,
    language: "typescript",
    theme: "dark",
    enabled: true,
  });
  return <div data-status={state.status}>{code}</div>;
}

function inScope(scope: RichTranscriptScope, children: ReactNode) {
  return <RichTranscriptScopeContext value={scope}>{children}</RichTranscriptScopeContext>;
}

describe("render cache scope isolation", () => {
  test("identical code in two backends and two environments never shares a highlight entry", async () => {
    const code = "const same = 1;";
    const { container } = render(
      <>
        {inScope(SCOPE_A, <Highlighted code={code} />)}
        {inScope(SCOPE_B, <Highlighted code={code} />)}
        {inScope(SCOPE_C, <Highlighted code={code} />)}
        {/* The same conversation twice shares one job. */}
        {inScope(SCOPE_A, <Highlighted code={code} />)}
      </>,
    );
    await waitFor(() => expect(container.querySelectorAll('[data-status="ready"]').length).toBe(4));
    expect(calls).toHaveLength(3);
    expect(richRenderScheduler.stats().settled).toBe(3);
  });

  test("identical diagram source in two scopes runs two renders and shares no entry", async () => {
    const renders: MermaidRenderRequest[] = [];
    setMermaidRenderer(async (input) => {
      renders.push(input);
      return {
        ok: true,
        svg: `<svg viewBox="0 0 10 10"><text>${renders.length}</text></svg>`,
        diagramType: "flowchart",
        rendererVersion: "t",
        svgBytes: 10,
        svgElements: 2,
        edges: 0,
        renderDigest: "d",
      };
    });
    setMermaidSvgSanitizer((markup) => ({ svg: markup }));
    const source = "flowchart TD\n  A --> B";
    const a = await requestMermaidPreview(source, "dark", { scope: SCOPE_A }).promise;
    expect(peekMermaidPreview(source, "dark", { scope: SCOPE_B })).toBeNull();
    const b = await requestMermaidPreview(source, "dark", { scope: SCOPE_B }).promise;
    expect(renders).toHaveLength(2);
    expect(a.svg).not.toBe(b.svg);
    const peekA = peekMermaidPreview(source, "dark", { scope: SCOPE_A });
    expect(peekA?.ok ? peekA.value.svg : null).toBe(a.svg);
    // The same scope again is a cache hit.
    await requestMermaidPreview(source, "dark", { scope: SCOPE_A }).promise;
    expect(renders).toHaveLength(2);
  });

  test("a font generation change is part of highlight cache identity", async () => {
    const { container } = render(inScope(SCOPE_A, <Highlighted code="let x = 1;" />));
    await waitFor(() => expect(container.querySelector('[data-status="ready"]')).toBeTruthy());
    expect(calls).toHaveLength(1);
    act(() => bumpFontGeneration());
    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => expect(container.querySelector('[data-status="ready"]')).toBeTruthy());
  });
});

describe("render priority and queue accounting", () => {
  /**
   * Two running jobs fill the highlight lane so later requests stay queued.
   * They settle when released or aborted (a clear), freeing their slots.
   */
  async function fillHighlightLane(): Promise<Array<() => void>> {
    const releases: Array<() => void> = [];
    for (const key of ["blocker-1", "blocker-2"]) {
      richRenderScheduler
        .request<string>({
          key,
          lane: "highlight",
          sourceBytes: 1,
          run: (signal) =>
            new Promise<{ value: string; bytes: number }>((resolve, reject) => {
              releases.push(() => resolve({ value: key, bytes: 1 }));
              signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        })
        .promise.catch(() => {});
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(richRenderScheduler.stats().running).toBe(2);
    return releases;
  }

  test("queued source bytes count UTF-8, not UTF-16 length", async () => {
    gated = true;
    await fillHighlightLane();
    const code = "const é = '日本語 🚀';";
    render(inScope(SCOPE_A, <Highlighted code={code} />));
    await waitFor(() => expect(richRenderScheduler.stats().queued).toBe(1));
    expect(richRenderScheduler.stats().queuedBytes).toBe(utf8ByteLength(code));
    expect(utf8ByteLength(code)).not.toBe(code.length * 2);
  });

  test("overscan rows request prefetch; visible rows run first; scrolling in promotes", async () => {
    gated = true;
    const order: string[] = [];
    setHighlightBackend({
      highlight(input) {
        order.push(input.code);
        return new Promise(() => {});
      },
    });
    const tracker = new TranscriptRowVisibilityTracker();
    tracker.setVisible("overscan-1", false);
    tracker.setVisible("overscan-2", false);
    tracker.setVisible("visible", true);
    const row = (key: string, code: string) => (
      <RichRowVisibilityContext value={tracker.source(key)}>
        <Highlighted code={code} />
      </RichRowVisibilityContext>
    );
    // Fill the lane with two unrelated jobs so the rows' work queues.
    const releases = await fillHighlightLane();
    render(
      inScope(
        SCOPE_A,
        <>
          {row("overscan-1", "overscan one")}
          {row("overscan-2", "overscan two")}
          {row("visible", "visible row")}
        </>,
      ),
    );
    await waitFor(() => expect(richRenderScheduler.stats().queued).toBe(3));
    // The second overscan row scrolls into view before any slot frees up.
    act(() => tracker.setVisible("overscan-2", true));
    // Free the lane: queued work starts visible-first, promoted prefetch next.
    for (const release of releases) release();
    await waitFor(() => expect(order).toHaveLength(2));
    expect(order).toEqual(["visible row", "overscan two"]);
  });
});
