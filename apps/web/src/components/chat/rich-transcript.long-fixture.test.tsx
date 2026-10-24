/**
 * Synthetic long-transcript fixture (specification F12).
 *
 * Thousands of messages, 100 rich blocks (code, repeated diagram sources,
 * disclosures with nested code, tables, one malformed chart), a streamed code
 * response, and two transcripts whose backend differs but whose environment,
 * session and message ids collide. A fake highlighter and diagram renderer
 * record call counts and concurrency only — never content.
 *
 * Virtuoso is replaced by a windowed stand-in (it renders a fixed window of
 * rows and nothing else), so mounting, unmounting and scrolling are real for
 * React while layout is not required.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRef, memo, Profiler, useState, type ReactNode } from "react";
import * as realVirtuoso from "react-virtuoso";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { setHighlightBackend, type HighlightInput } from "@/lib/chat/highlighter/client";
import {
  setMermaidRenderer,
  setMermaidSvgSanitizer,
} from "@/lib/chat/rich-markdown/mermaid-render";
import { RichTranscriptScopeContext, type RichTranscriptScope } from "@/lib/chat/rich-identity";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { richViewStoreStats, useRichContentViewStore } from "@/stores/richContentViewStore";

const WINDOW = 20;
const controllers = new Map<unknown[], (start: number) => void>();
const realVirtuosoSnapshot = { ...realVirtuoso };

function WindowedVirtuoso({
  data,
  itemContent,
  firstItemIndex = 0,
  computeItemKey,
}: {
  data: unknown[];
  firstItemIndex?: number;
  itemContent: (index: number, item: unknown) => ReactNode;
  computeItemKey: (index: number, item: unknown) => string;
}) {
  const [start, setStart] = useState(0);
  controllers.set(data, setStart);
  const rows: ReactNode[] = [];
  for (let index = start; index < Math.min(data.length, start + WINDOW); index++) {
    rows.push(
      <div key={computeItemKey(firstItemIndex + index, data[index])}>
        {itemContent(firstItemIndex + index, data[index])}
      </div>,
    );
  }
  return <div data-virtuoso-scroller="true">{rows}</div>;
}

mock.module("react-virtuoso", () => ({ ...realVirtuosoSnapshot, Virtuoso: WindowedVirtuoso }));

const { VirtualizedMessageList } = await import("./VirtualizedMessageList");
const { NativeMessage } = await import("./NativeMessage");

afterAll(() => {
  mock.module("react-virtuoso", () => realVirtuosoSnapshot);
});

// ---------------------------------------------------------------------------
// Fixture

const MESSAGE_COUNT = 3_000;
/**
 * 100 rich blocks in 10 clusters of 10 consecutive messages (one cluster per
 * 300 messages), so a window over a cluster queues real concurrent work.
 */
const CLUSTER_SPACING = 300;
const CLUSTER_OFFSET = 100;
const CLUSTER_SIZE = 10;
const CLUSTER_COUNT = 10;

function richIndex(messageIndex: number): number | null {
  const offset = (messageIndex % CLUSTER_SPACING) - CLUSTER_OFFSET;
  if (offset < 0 || offset >= CLUSTER_SIZE) return null;
  return Math.floor(messageIndex / CLUSTER_SPACING) * CLUSTER_SIZE + offset;
}

/** Window start showing every block of cluster `c`. */
function clusterWindow(c: number): number {
  return c * CLUSTER_SPACING + CLUSTER_OFFSET - (WINDOW - CLUSTER_SIZE) / 2;
}
const DIAGRAMS = [0, 1, 2, 3, 4].map(
  (variant) => `flowchart TD\n  A${variant}[Start] --> B${variant}[Finish]`,
);

/** Kind of the r-th rich block (r in 0..99). */
function richContent(r: number): string {
  const slot = r % 10;
  if (slot <= 6) {
    return ["```ts", `const value${r} = ${r};`, `export { value${r} };`, "```"].join("\n");
  }
  // Ten diagram blocks share five sources.
  if (slot === 7) return ["```mermaid", DIAGRAMS[Math.floor(r / 10) % 5]!, "```"].join("\n");
  if (slot === 8) {
    return [
      "<details>",
      `<summary>Details ${r}</summary>`,
      "",
      "```ts",
      `const nested${r} = true;`,
      "```",
      "",
      "</details>",
    ].join("\n");
  }
  if (r === 99) return ["```chart", '{"kind": "bar", "malformed": true', "```"].join("\n");
  return ["| Key | Value |", "| --- | --- |", `| row ${r} | ${r} |`].join("\n");
}

function fixtureMessages(): NativeMessageType[] {
  return Array.from({ length: MESSAGE_COUNT }, (_, index) => {
    const r = richIndex(index);
    return {
      // Identical ids in both transcripts: scopes must keep them apart.
      id: `msg-${index}`,
      role: "assistant" as const,
      content: "",
      createdAt: "2026-10-20T10:00:00.000Z",
      parts: [
        {
          type: "text" as const,
          content: r === null ? `Plain message ${index} with ordinary prose.` : richContent(r),
          sourcePartId: `part-${index}`,
        },
      ],
    };
  });
}

const SCOPES: RichTranscriptScope[] = [
  {
    backendId: "backend-A",
    environmentId: "env-1",
    logicalSessionKey: "session-1",
    generation: "1",
  },
  {
    backendId: "backend-B",
    environmentId: "env-1",
    logicalSessionKey: "session-1",
    generation: "1",
  },
];

// ---------------------------------------------------------------------------
// Content-free counters

interface Counters {
  highlightCalls: number;
  highlightInFlight: number;
  highlightMaxInFlight: number;
  diagramCalls: number;
  diagramInFlight: number;
  diagramMaxInFlight: number;
  maxQueued: number;
  maxQueuedBytes: number;
  maxSettled: number;
  maxSettledBytes: number;
  maxViewEntries: number;
}

let counters: Counters;
const rowRenders = new Map<string, number>();

function sample(): void {
  const stats = richRenderScheduler.stats();
  counters.maxQueued = Math.max(counters.maxQueued, stats.queued);
  counters.maxQueuedBytes = Math.max(counters.maxQueuedBytes, stats.queuedBytes);
  counters.maxSettled = Math.max(counters.maxSettled, stats.settled);
  counters.maxSettledBytes = Math.max(counters.maxSettledBytes, stats.settledBytes);
  counters.maxViewEntries = Math.max(counters.maxViewEntries, richViewStoreStats().entries);
}

const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 1));

beforeEach(() => {
  counters = {
    highlightCalls: 0,
    highlightInFlight: 0,
    highlightMaxInFlight: 0,
    diagramCalls: 0,
    diagramInFlight: 0,
    diagramMaxInFlight: 0,
    maxQueued: 0,
    maxQueuedBytes: 0,
    maxSettled: 0,
    maxSettledBytes: 0,
    maxViewEntries: 0,
  };
  rowRenders.clear();
  controllers.clear();
  setHighlightBackend({
    async highlight(input: HighlightInput, signal: AbortSignal) {
      counters.highlightCalls++;
      counters.highlightInFlight++;
      counters.highlightMaxInFlight = Math.max(
        counters.highlightMaxInFlight,
        counters.highlightInFlight,
      );
      try {
        const lines = input.code
          .split("\n")
          .map((line) => (line ? [{ c: line, s: "#a0a0a0" }] : []));
        const result = await later({ lines, stateId: null });
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        return result;
      } finally {
        counters.highlightInFlight--;
      }
    },
  });
  setMermaidSvgSanitizer((markup) => ({ svg: markup }));
  setMermaidRenderer(async () => {
    counters.diagramCalls++;
    counters.diagramInFlight++;
    counters.diagramMaxInFlight = Math.max(counters.diagramMaxInFlight, counters.diagramInFlight);
    try {
      return await later({
        ok: true as const,
        svg: '<svg viewBox="0 0 100 50"><text>diagram</text></svg>',
        diagramType: "flowchart",
        rendererVersion: "t",
        svgBytes: 60,
        svgElements: 2,
        edges: 1,
        renderDigest: "d",
      });
    } finally {
      counters.diagramInFlight--;
    }
  });
  richRenderScheduler.clear();
  useRichContentViewStore.getState().reset();
});

afterEach(() => {
  cleanup();
  setHighlightBackend(undefined);
  setMermaidRenderer(null);
  setMermaidSvgSanitizer(null);
});

/** A row probe: counts every commit in which anything inside the row rendered. */
const RowProbe = memo(function RowProbe({
  scope,
  message,
}: {
  scope: string;
  message: NativeMessageType;
}) {
  const id = `${scope}:${message.id}`;
  return (
    <Profiler id={id} onRender={() => rowRenders.set(id, (rowRenders.get(id) ?? 0) + 1)}>
      <NativeMessage message={message} />
    </Profiler>
  );
});

function Transcript({
  scope,
  messages,
  label,
}: {
  scope: RichTranscriptScope;
  messages: NativeMessageType[];
  label: string;
}) {
  return (
    <section aria-label={label}>
      <RichTranscriptScopeContext value={scope}>
        <VirtualizedMessageList
          messages={messages}
          computeItemKey={(_index, item) => item.id}
          renderMessage={(_index, item) => <RowProbe scope={label} message={item} />}
          scrollProps={{
            followOutput: () => false,
            atBottomStateChange: () => {},
            atBottomThreshold: 0,
            restoreStateFrom: undefined,
          }}
          virtuosoRef={createRef()}
        />
      </RichTranscriptScopeContext>
    </section>
  );
}

async function settle(): Promise<void> {
  await waitFor(
    () => {
      sample();
      const stats = richRenderScheduler.stats();
      expect(stats.inflight + stats.queued).toBe(0);
    },
    { timeout: 3_000 },
  );
  sample();
}

function scroll(messages: NativeMessageType[], start: number) {
  act(() => controllers.get(messages)?.(start));
  sample();
}

describe("long transcript fixture", () => {
  test(
    "bounded concurrency and queues; caches converge within bounds over 20 scroll/expand cycles",
    async () => {
      const lists = [fixtureMessages(), fixtureMessages()];
      render(
        <>
          <Transcript scope={SCOPES[0]!} messages={lists[0]!} label="A" />
          <Transcript scope={SCOPES[1]!} messages={lists[1]!} label="B" />
        </>,
      );
      await settle();

      const settledAfterCycle: number[] = [];
      for (let cycle = 0; cycle < 20; cycle++) {
        for (let step = 0; step < CLUSTER_COUNT; step++) {
          // Visit every cluster once per cycle, in a cycle-dependent order.
          const cluster = (cycle * 3 + step * 7) % CLUSTER_COUNT;
          for (const messages of lists) scroll(messages, clusterWindow(cluster));
          // Expand and collapse the cluster's disclosure in both transcripts.
          const r = cluster * CLUSTER_SIZE + 8;
          for (const label of ["A", "B"]) {
            const section = document.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
            // Found by its summary text rather than `getByRole({ name })`:
            // computing accessible names across the whole section dominated
            // this test's runtime. The summary renders inside the toggle.
            const toggle = within(section).getByText(`Details ${r}`).closest("button");
            expect(toggle?.getAttribute("aria-expanded")).toBe("false");
            if (!toggle) throw new Error(`no disclosure toggle for Details ${r}`);
            fireEvent.click(toggle);
            expect(toggle.getAttribute("aria-expanded")).toBe("true");
            sample();
            fireEvent.click(toggle);
          }
          await settle();
        }
        settledAfterCycle.push(richRenderScheduler.stats().settled);
      }

      // Concurrency and queue bounds held at every sample.
      expect(counters.highlightMaxInFlight).toBeLessThanOrEqual(
        FRONTEND_RENDER_POLICY.highlightConcurrency,
      );
      expect(counters.diagramMaxInFlight).toBeLessThanOrEqual(
        FRONTEND_RENDER_POLICY.diagramConcurrency,
      );
      expect(counters.maxQueued).toBeLessThanOrEqual(FRONTEND_RENDER_POLICY.maxQueuedJobs);
      expect(counters.maxQueuedBytes).toBeLessThanOrEqual(
        FRONTEND_RENDER_POLICY.maxQueuedSourceBytes,
      );
      // Settled caches stay within their bounds and stop growing.
      expect(counters.maxSettled).toBeLessThanOrEqual(
        FRONTEND_RENDER_POLICY.maxSettledCacheEntries,
      );
      expect(counters.maxSettledBytes).toBeLessThanOrEqual(
        FRONTEND_RENDER_POLICY.maxSettledCacheBytes,
      );
      expect(counters.maxViewEntries).toBeLessThanOrEqual(
        FRONTEND_RENDER_POLICY.maxInactiveViewStateEntries,
      );
      // More distinct work exists than the cache holds: it fills to its
      // bound once, evicts LRU entries, and stays there for every later cycle.
      expect(richRenderScheduler.counters.evicted).toBeGreaterThan(0);
      for (const settled of settledAfterCycle.slice(1)) {
        expect(settled).toBe(FRONTEND_RENDER_POLICY.maxSettledCacheEntries);
      }
      // Work was actually queued behind the lane limits at some point.
      expect(counters.maxQueued).toBeGreaterThan(0);
      // Identical code in the two scopes was highlighted separately; repeated
      // diagram sources were deduplicated (5 sources, at most once per scope).
      expect(counters.highlightCalls % 2).toBe(0);
      expect(counters.diagramCalls).toBeGreaterThanOrEqual(DIAGRAMS.length);
      expect(counters.diagramCalls).toBeLessThanOrEqual(DIAGRAMS.length * SCOPES.length);
      const stats = richRenderScheduler.stats();
      expect(stats.inflight).toBe(0);
      expect(stats.running).toBe(0);
    },
    { timeout: 120_000 },
  );

  test("settled rows do not re-render on unrelated updates", async () => {
    const lists = [fixtureMessages(), fixtureMessages()];
    const view = render(
      <>
        <Transcript scope={SCOPES[0]!} messages={lists[0]!} label="A" />
        <Transcript scope={SCOPES[1]!} messages={lists[1]!} label="B" />
      </>,
    );
    // Windows over two clusters of code, diagrams, a disclosure and a table.
    scroll(lists[0]!, clusterWindow(0));
    scroll(lists[1]!, clusterWindow(3));
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const before = new Map(rowRenders);

    // 1. The other end of transcript A streams a new message.
    const appended = [
      ...lists[0]!,
      {
        ...lists[0]![0]!,
        id: "msg-new",
        parts: [{ type: "text" as const, content: "Streaming tail", sourcePartId: "tail" }],
      },
    ];
    view.rerender(
      <>
        <Transcript scope={SCOPES[0]!} messages={appended} label="A" />
        <Transcript scope={SCOPES[1]!} messages={lists[1]!} label="B" />
      </>,
    );
    // 2. View state changes for a block in the other transcript.
    act(() => useRichContentViewStore.getState().update('["block","other"]', { open: true }));
    // 3. Unrelated render work completes.
    await richRenderScheduler.request({
      key: "unrelated",
      lane: "highlight",
      sourceBytes: 1,
      run: async () => ({ value: 1, bytes: 1 }),
    }).promise;
    await settle();

    const mounted = Array.from(before.keys());
    expect(mounted.length).toBeGreaterThanOrEqual(WINDOW * 2);
    for (const id of mounted) expect(rowRenders.get(id)).toBe(before.get(id));
  });

  test("a streamed code response never shows a stale highlight; resources are released on close", async () => {
    // Gate highlighting so results can arrive out of order.
    const pending: Array<{ code: string; resolve: () => void }> = [];
    setHighlightBackend({
      highlight(input: HighlightInput) {
        counters.highlightCalls++;
        return new Promise((resolve) => {
          pending.push({
            code: input.code,
            resolve: () =>
              resolve({
                lines: input.code
                  .split("\n")
                  .map((line) => (line ? [{ c: line, s: "#123456" }] : [])),
                stateId: null,
              }),
          });
        });
      },
    });
    let observed = 0;
    const OriginalObserver = globalThis.IntersectionObserver;
    class CountingObserver {
      observe() {
        observed++;
      }
      unobserve() {
        observed--;
      }
      disconnect() {}
    }
    globalThis.IntersectionObserver = CountingObserver as unknown as typeof IntersectionObserver;
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => {
      const url = `blob:fixture/${created.length}`;
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    try {
      const streamed = (content: string): NativeMessageType => ({
        id: "msg-stream",
        role: "assistant",
        content: "",
        createdAt: "2026-10-20T10:00:00.000Z",
        parts: [{ type: "text", content, sourcePartId: "stream" }],
      });
      const table: NativeMessageType = {
        ...streamed(""),
        id: "msg-table",
        parts: [{ type: "text", content: richContent(9), sourcePartId: "table" }],
      };
      const lines = Array.from({ length: 6 }, (_, index) => `const line${index} = ${index};`);
      let content = "```ts\n";
      const view = render(
        <Transcript scope={SCOPES[0]!} messages={[table, streamed(content)]} label="S" />,
      );
      for (const line of lines) {
        content += `${line}\n`;
        view.rerender(
          <Transcript scope={SCOPES[0]!} messages={[table, streamed(content)]} label="S" />,
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
        });
      }
      expect(pending).toHaveLength(0); // Open fences defer highlighting while keeping their line nodes stable.
      const completeContent = content + "```";
      content = completeContent.replace(lines[0]!, "const stale = 0;");
      view.rerender(
        <Transcript scope={SCOPES[0]!} messages={[table, streamed(content)]} label="S" />,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(pending).toHaveLength(1);
      content = completeContent;
      view.rerender(
        <Transcript scope={SCOPES[0]!} messages={[table, streamed(content)]} label="S" />,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(pending.length).toBeGreaterThan(1);
      const body = () => document.querySelector("[data-rich-code-body]")!;
      const highlightedSpans = () => body().querySelectorAll('span[style*="color"]').length;
      const deliver = async (job: { resolve: () => void }) => {
        await act(async () => {
          job.resolve();
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      };
      // Stale replies arrive first, newest first; none of them is ever shown.
      const finalCode = lines.join("\n");
      let finalJob = pending.find((job) => job.code === finalCode);
      for (let guard = 0; !finalJob && guard < 50; guard++) {
        const stale = pending.pop();
        if (stale) {
          await deliver(stale);
          expect(highlightedSpans()).toBe(0);
        } else {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
          });
        }
        finalJob = pending.find((job) => job.code === finalCode);
      }
      expect(finalJob).toBeDefined();
      pending.splice(pending.indexOf(finalJob!), 1);
      await deliver(finalJob!);
      await waitFor(() => expect(highlightedSpans()).toBe(lines.length));
      const settledMarkup = body().innerHTML;
      // Any remaining stale reply after the current one cannot replace it.
      for (const job of pending.splice(0).reverse()) await deliver(job);
      expect(body().innerHTML).toBe(settledMarkup);
      expect(body().textContent).toContain(lines.at(-1)!);

      // Exercise an object-URL resource, then close the transcript.
      fireEvent.click(document.querySelector('button[aria-label="Download CSV (exact text)"]')!);
      expect(observed).toBeGreaterThan(0);
      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(observed).toBe(0);
      expect(created.length).toBeGreaterThan(0);
      expect(revoked.sort()).toEqual([...created].sort());
      expect(richViewStoreStats().mounted).toBe(0);
      expect(richViewStoreStats().pinned).toBe(0);
      const stats = richRenderScheduler.stats();
      expect(stats.inflight + stats.queued + stats.running).toBe(0);
    } finally {
      globalThis.IntersectionObserver = OriginalObserver;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
