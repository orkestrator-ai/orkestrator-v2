import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";

/*
 * One transcript row that a renderer cannot survive must degrade to its own
 * fallback line instead of handing the whole tab to the view error boundary.
 * The real NativeMessage is hardened against every malformed shape we have
 * seen, so the failure is injected by stubbing it for this file only —
 * snapshot-and-restore per the repo's module-mock rules, because sibling
 * suites render the real component.
 */
import * as realNativeMessage from "@/components/chat/NativeMessage";
import { ToolDetailLoaderContext } from "@/components/chat/NativeMessage.shared";
import { useContext, useState } from "react";
const realNativeMessageSnapshot = { ...realNativeMessage };

/** The first detail reference in a (possibly grouped) part tree. */
function findDeferredRef(parts: unknown[] | undefined): string | undefined {
  for (const part of parts ?? []) {
    const record = part as { detailRef?: string; parts?: unknown[]; childTools?: unknown[] };
    const found =
      record.detailRef ?? findDeferredRef(record.parts) ?? findDeferredRef(record.childTools);
    if (found) return found;
  }
  return undefined;
}

/** Stands in for a tool row whose body is deferred behind a detail reference. */
function DeferredRowStub({ detailRef }: { detailRef: string }) {
  const loadToolDetails = useContext(ToolDetailLoaderContext);
  const [loaded, setLoaded] = useState<string | undefined>();
  return (
    <button
      type="button"
      onClick={() =>
        void loadToolDetails?.(detailRef).then((details) => setLoaded(details.toolOutput))
      }
    >
      {loaded ?? "Expand deferred tool"}
    </button>
  );
}
mock.module("@/components/chat/NativeMessage", () => ({
  ...realNativeMessageSnapshot,
  NativeMessage: ({
    message,
  }: {
    message: {
      id: string;
      content: string;
      parts: Array<{ type: string; content: string; detailRef?: string }>;
    };
  }) => {
    if (message.content.includes("poison")) {
      throw new Error("injected renderer failure");
    }
    const deferred = findDeferredRef(message.parts);
    if (deferred) return <DeferredRowStub detailRef={deferred} />;
    // Mirrors the real component: text parts are the content roots, with
    // `content` as the fallback for messages that carry no text part.
    const textParts = message.parts.filter((part) => part.type === "text");
    return (
      <div>
        {textParts.length > 0
          ? textParts.map((part, index) => <div key={index}>{part.content}</div>)
          : message.content}
      </div>
    );
  },
}));
afterAll(() => {
  mock.module("@/components/chat/NativeMessage", () => realNativeMessageSnapshot);
});

/*
 * react-virtuoso measures a real viewport, so its rows never render under
 * happy-dom. Every native chat tab's suite stubs it the same way to assert on
 * the transcript the shared renderer produced.
 */
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  ...realVirtualizedMessageListSnapshot,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VirtualizedMessageList: (props: any) => {
    const { messages, renderMessage, resolvePreviousMessage, emptyState, footer, header } = props;
    return (
      <div>
        {header}
        {messages.length === 0 ? emptyState : null}
        {messages.map((message: unknown, index: number) => (
          <div key={index}>
            {renderMessage(
              index,
              message,
              resolvePreviousMessage
                ? resolvePreviousMessage(messages, index)
                : index > 0
                  ? messages[index - 1]
                  : null,
            )}
          </div>
        ))}
        {footer}
      </div>
    );
  },
}));
afterAll(() => {
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

import type {
  MultiReviewReviewerHistoryPage,
  MultiReviewReviewerTranscript,
} from "@orkestrator/protocol/multi-review";

type LoadHistoryPage = (
  workflowId: string,
  reviewerId: string,
  options: { before: string; limit?: number; targetBytes?: number },
) => Promise<MultiReviewReviewerHistoryPage>;
const { MultiReviewReviewerTab, toMultiReviewReviewerMessages } =
  await import("./MultiReviewReviewerTab");

afterEach(cleanup);

async function openTranscriptRefreshMenu() {
  fireEvent.contextMenu(screen.getByTestId("multi-review-reviewer-transcript-body"));
  return screen.findByRole("menuitem", { name: "Refresh transcript" });
}

/** React logs boundary-caught errors through console.error; keep output clean. */
async function withSilencedReactErrors<T>(run: () => Promise<T> | T): Promise<T> {
  const originalError = console.error;
  console.error = mock(() => undefined) as typeof console.error;
  try {
    return await run();
  } finally {
    console.error = originalError;
  }
}

describe("MultiReviewReviewerTab message containment", () => {
  test("a message that fails to render degrades to one row, not the whole view", async () => {
    const loadTranscript = mock(async () => ({
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      workflowPhase: "reviewing" as const,
      agent: "claude" as const,
      model: "default",
      status: "running" as const,
      startedAt: "2026-08-17T00:00:00.000Z",
      messages: [
        {
          id: "healthy-before",
          role: "assistant",
          content: "Inspecting the changed files",
          createdAt: "2026-08-17T00:00:01.000Z",
          parts: [{ type: "text", content: "Inspecting the changed files" }],
        },
        {
          id: "poisoned",
          role: "assistant",
          content: "poison frame",
          createdAt: "2026-08-17T00:00:02.000Z",
          parts: [{ type: "text", content: "poison frame" }],
        },
        {
          id: "healthy-after",
          role: "assistant",
          content: "Running the validation suite",
          createdAt: "2026-08-17T00:00:03.000Z",
          parts: [{ type: "text", content: "Running the validation suite" }],
        },
      ],
    }));

    await withSilencedReactErrors(async () => {
      render(
        <MultiReviewReviewerTab
          data={{
            environmentId: "env-1",
            workflowId: "multi-1",
            reviewerId: "reviewer-1",
            isLocal: true,
          }}
          isActive
          loadTranscript={loadTranscript}
        />,
      );

      await waitFor(() => expect(loadTranscript).toHaveBeenCalled());
      expect(await screen.findByText("Inspecting the changed files")).toBeTruthy();
      expect(await screen.findByText("Running the validation suite")).toBeTruthy();
      expect(await screen.findByText(/One message could not be displayed/)).toBeTruthy();
      // The header and read-only status line stay up: the view survived.
      expect(screen.getByText("Claude review")).toBeTruthy();
      expect(screen.queryByText("poison frame") === null).toBe(true);
    });
  });

  test("retries a failed row when a later transcript refresh replaces the message", async () => {
    // Same refresh() the 4s poll uses. The first snapshot injects a renderer
    // throw; the next snapshot keeps the message id but is a new object without
    // the poison, which is the resetKey change the row boundary retries on.
    let loads = 0;
    const loadTranscript = mock(async () => {
      loads += 1;
      const midContent = loads === 1 ? "poison frame" : "Captured the worktree snapshot";
      return {
        workflowId: "multi-1",
        reviewerId: "reviewer-1",
        workflowPhase: "reviewing" as const,
        agent: "claude" as const,
        model: "default",
        status: "running" as const,
        startedAt: "2026-08-17T00:00:00.000Z",
        messages: [
          {
            id: "healthy-before",
            role: "assistant" as const,
            content: "Inspecting the changed files",
            createdAt: "2026-08-17T00:00:01.000Z",
            parts: [{ type: "text" as const, content: "Inspecting the changed files" }],
          },
          {
            id: "row-mid",
            role: "assistant" as const,
            content: midContent,
            createdAt: "2026-08-17T00:00:02.000Z",
            parts: [{ type: "text" as const, content: midContent }],
          },
          {
            id: "healthy-after",
            role: "assistant" as const,
            content: "Running the validation suite",
            createdAt: "2026-08-17T00:00:03.000Z",
            parts: [{ type: "text" as const, content: "Running the validation suite" }],
          },
        ],
      };
    });

    await withSilencedReactErrors(async () => {
      render(
        <MultiReviewReviewerTab
          data={{
            environmentId: "env-1",
            workflowId: "multi-1",
            reviewerId: "reviewer-1",
            isLocal: true,
          }}
          isActive
          loadTranscript={loadTranscript}
        />,
      );

      expect(await screen.findByText(/One message could not be displayed/)).toBeTruthy();
      expect(screen.getByText("Inspecting the changed files")).toBeTruthy();
      expect(screen.getByText("Running the validation suite")).toBeTruthy();

      expect(screen.queryByRole("button", { name: /Refresh.*transcript/ }) === null).toBe(true);
      fireEvent.click(await openTranscriptRefreshMenu());

      expect(await screen.findByText("Captured the worktree snapshot")).toBeTruthy();
      expect(screen.queryByText(/One message could not be displayed/) === null).toBe(true);
      expect(screen.getByText("Inspecting the changed files")).toBeTruthy();
      expect(screen.getByText("Running the validation suite")).toBeTruthy();
      expect(screen.getByText("Claude review")).toBeTruthy();
    });
  });
});

/*
 * Codex and the ACP agents answer a schema-constrained turn in the text
 * channel, and re-draft the whole report there on every progress update. The
 * shape below is taken from a live Codex reviewer transcript: six text parts,
 * each a longer draft of the same document, and no prose at all.
 */
describe("toMultiReviewReviewerMessages machine output", () => {
  const snapshot = (parts: Array<{ type: string; content: string }>) => ({
    workflowId: "multi-1",
    reviewerId: "reviewer-2",
    workflowPhase: "reviewing" as const,
    agent: "codex" as const,
    model: "gpt-5.6-sol",
    status: "running" as const,
    startedAt: "2026-08-17T13:21:09.717Z",
    messages: [
      {
        id: "assistant",
        role: "assistant",
        content: parts.at(-1)?.content ?? "",
        createdAt: "2026-08-17T13:21:10.000Z",
        parts,
      },
    ],
  });

  test("withholds progressively longer report drafts", () => {
    const drafts = [
      '{"reviewScope":{"targetBranch":"","filesReviewed":[]',
      '{"reviewScope":{"targetBranch":"main","filesReviewed":["a.ts"]},"issues":[]}',
      '{"reviewScope":{"targetBranch":"main","filesReviewed":["a.ts","b.ts"]},"issues":[{"title":"x"',
    ];
    const messages = toMultiReviewReviewerMessages(
      snapshot(drafts.map((content) => ({ type: "text", content }))),
    );
    const rendered = messages.flatMap((message) => [
      message.content,
      ...message.parts.map((part) => part.content),
    ]);
    for (const draft of drafts) expect(rendered).not.toContain(draft);
  });

  test("keeps the prose commentary the prompt now asks for", () => {
    const messages = toMultiReviewReviewerMessages(
      snapshot([
        { type: "text", content: "Captured the worktree snapshot; reviewing the diff." },
        { type: "text", content: '{"reviewScope":{"targetBranch":"main"' },
        { type: "text", content: "Validation passed; compiling the final report." },
      ]),
    );

    const text = messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "text").map((part) => part.content),
    );
    expect(text).toEqual([
      "Captured the worktree snapshot; reviewing the diff.",
      "Validation passed; compiling the final report.",
    ]);
  });

  test("removes a completed report appended to prose in one provider part", () => {
    const commentary = "Validation passed; compiling the final report.";
    const report = JSON.stringify({
      reviewScope: { targetBranch: "main", filesReviewed: ["a.ts"] },
      issues: [],
    });
    const combined = `${commentary} ${report}`;
    const messages = toMultiReviewReviewerMessages(snapshot([{ type: "text", content: combined }]));

    const rendered = messages.flatMap((message) => [
      message.content,
      ...message.parts.map((part) => part.content),
    ]);
    expect(rendered).toContain(commentary);
    expect(rendered.join(" ")).not.toContain("reviewScope");
  });

  test("drops a message whose only content was a draft", () => {
    const messages = toMultiReviewReviewerMessages(
      snapshot([{ type: "text", content: '{"reviewScope":{"targetBranch":"main"}}' }]),
    );
    expect(messages).toHaveLength(0);
  });

  test("renders no raw JSON in the transcript body", async () => {
    const draft = '{"reviewScope":{"targetBranch":"main","baseRef":"origin/main';
    const loadTranscript = mock(async () =>
      snapshot([
        { type: "text", content: "Reading the review skill." },
        { type: "text", content: draft },
      ]),
    );

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-2",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
      />,
    );

    await waitFor(() => expect(loadTranscript).toHaveBeenCalled());
    expect(await screen.findByText("Reading the review skill.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("reviewScope");
  });
});

describe("MultiReviewReviewerTab deferred tool details", () => {
  test("expanding a deferred row reads its body from this reviewer's session", async () => {
    const loadTranscript = mock(async () => ({
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      workflowPhase: "reviewing" as const,
      agent: "codex" as const,
      model: "default",
      status: "running" as const,
      startedAt: "2026-08-17T00:00:00.000Z",
      messages: [
        {
          id: "tool-row",
          role: "assistant",
          content: "",
          createdAt: "2026-08-17T00:00:01.000Z",
          parts: [{ type: "tool-invocation", content: "Read", detailRef: "bd1.locator" }],
        },
      ],
    }));
    const loadToolDetails = mock(async (_workflowId: string, _reviewerId: string, ref: string) => ({
      detailRef: ref,
      toolOutput: "the deferred body",
    }));
    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
        loadToolDetails={loadToolDetails}
      />,
    );
    fireEvent.click(await screen.findByText("Expand deferred tool"));
    expect(await screen.findByText("the deferred body")).toBeTruthy();
    expect(loadToolDetails).toHaveBeenCalledWith("multi-1", "reviewer-1", "bd1.locator");
  });
});

describe("MultiReviewReviewerTab earlier history", () => {
  const data = {
    environmentId: "env-1",
    workflowId: "multi-1",
    reviewerId: "reviewer-1",
    isLocal: true,
  };

  function row(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      role: "assistant",
      content: `text ${id}`,
      createdAt: "2026-08-17T00:00:01.000Z",
      parts: [{ type: "text", content: `text ${id}` }],
      ...extra,
    };
  }

  function tail(
    ids: string[],
    overrides: Partial<MultiReviewReviewerTranscript> = {},
  ): MultiReviewReviewerTranscript {
    return {
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      workflowPhase: "reviewing",
      agent: "codex",
      model: "default",
      status: "running",
      startedAt: "2026-08-17T00:00:00.000Z",
      messages: ids.map((id) => row(id)),
      transcript: "snapshot",
      truncated: true,
      historyCursor: "cursor-tail",
      historyEpoch: "epoch-1",
      ...overrides,
    };
  }

  /** Visible row texts, in document order. */
  function shownRows(): string[] {
    return screen.queryAllByText(/^text m\d+$/).map((node) => node.textContent ?? "");
  }

  test("load earlier prepends a page, drops rows already shown, and expands its details", async () => {
    const loadTranscript = mock(async () => tail(["m3", "m4"]));
    const loadHistoryPage = mock<LoadHistoryPage>(
      async (_workflowId: string, _reviewerId: string, options: { before: string }) =>
        options.before === "cursor-tail"
          ? {
              status: "page" as const,
              messages: [
                row("m1"),
                {
                  ...row("m2"),
                  content: "",
                  parts: [{ type: "tool-invocation", content: "Read", detailRef: "bd1.early" }],
                },
                row("m3"),
              ],
              historyEpoch: "epoch-1",
              nextCursor: "cursor-m1",
              complete: false,
              truncated: true,
            }
          : {
              status: "page" as const,
              messages: [row("m0")],
              historyEpoch: "epoch-1",
              complete: true,
              truncated: false,
            },
    );
    const loadToolDetails = mock(async (_workflowId: string, _reviewerId: string, ref: string) => ({
      detailRef: ref,
      toolOutput: "the earlier body",
    }));
    render(
      <MultiReviewReviewerTab
        data={data}
        isActive
        loadTranscript={loadTranscript}
        loadHistoryPage={loadHistoryPage}
        loadToolDetails={loadToolDetails}
      />,
    );
    await screen.findByText("text m4");
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await screen.findByText("text m1");
    expect(loadHistoryPage).toHaveBeenCalledWith("multi-1", "reviewer-1", {
      before: "cursor-tail",
      limit: 100,
    });
    // m3 was already on screen as the tail's head; it is shown once.
    expect(shownRows()).toEqual(["text m1", "text m3", "text m4"]);

    fireEvent.click(screen.getByText("Expand deferred tool"));
    expect(await screen.findByText("the earlier body")).toBeTruthy();
    expect(loadToolDetails).toHaveBeenCalledWith("multi-1", "reviewer-1", "bd1.early");

    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await screen.findByText("text m0");
    expect(loadHistoryPage.mock.calls.at(-1)?.[2]).toEqual({ before: "cursor-m1", limit: 100 });
    expect(shownRows()).toEqual(["text m0", "text m1", "text m3", "text m4"]);
    // The start of history ends the control without any notice of loss.
    expectDomAbsent(
      screen.queryByRole("button", { name: "Load earlier messages" }),
      "load earlier control",
    );
    expectDomAbsent(screen.queryByText(/not available/), "history loss notice");
  });

  test("an expired cursor drops loaded pages and re-reads the transcript for a new cursor", async () => {
    let reads = 0;
    const loadTranscript = mock(
      async (
        _workflowId: string,
        _reviewerId: string,
        _options?: { knownSourceToken?: string },
      ) => {
        reads += 1;
        return reads === 1
          ? tail(["m3", "m4"], { sourceToken: "token-1" })
          : tail(["m5", "m6"], { historyCursor: "cursor-new", historyEpoch: "epoch-2" });
      },
    );
    const loadHistoryPage = mock<LoadHistoryPage>(async () => ({
      status: "expired" as const,
      reason: "history-changed" as const,
    }));
    render(
      <MultiReviewReviewerTab
        data={data}
        isActive
        loadTranscript={loadTranscript}
        loadHistoryPage={loadHistoryPage}
      />,
    );
    await screen.findByText("text m4");
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    expect(await screen.findByText(/history changed/)).toBeTruthy();
    await screen.findByText("text m6");
    // The re-read asked for a full snapshot rather than confirming the old token.
    expect(loadTranscript.mock.calls.at(-1)?.[2]).toEqual({ knownSourceToken: undefined });
    expect(shownRows()).toEqual(["text m5", "text m6"]);

    loadHistoryPage.mockImplementation(async () => ({
      status: "page",
      messages: [row("m4")],
      historyEpoch: "epoch-2",
      complete: true,
      truncated: false,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await screen.findByText("text m4");
    expect(loadHistoryPage.mock.calls.at(-1)?.[2]).toEqual({ before: "cursor-new", limit: 100 });
  });

  test("returning to the tab after the reviewer continued keeps loaded history contiguous", async () => {
    let current = tail(["m3", "m4"]);
    const loadTranscript = mock(async () => current);
    const loadHistoryPage = mock<LoadHistoryPage>(async () => ({
      status: "page" as const,
      messages: [row("m1"), row("m2")],
      historyEpoch: "epoch-1",
      nextCursor: "cursor-m1",
      complete: false,
      truncated: true,
    }));
    const view = render(
      <MultiReviewReviewerTab
        data={data}
        isActive
        loadTranscript={loadTranscript}
        loadHistoryPage={loadHistoryPage}
      />,
    );
    await screen.findByText("text m4");
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await screen.findByText("text m1");

    // Hidden while the reviewer writes two more rows; m3 ages out of the tail.
    view.rerender(
      <MultiReviewReviewerTab
        data={data}
        isActive={false}
        loadTranscript={loadTranscript}
        loadHistoryPage={loadHistoryPage}
      />,
    );
    current = tail(["m4", "m5", "m6"], { historyCursor: "cursor-m4" });
    view.rerender(
      <MultiReviewReviewerTab
        data={data}
        isActive
        loadTranscript={loadTranscript}
        loadHistoryPage={loadHistoryPage}
      />,
    );
    await screen.findByText("text m6");
    // The row that left the tail stays between the loaded page and the tail.
    expect(shownRows()).toEqual(["text m1", "text m2", "text m3", "text m4", "text m5", "text m6"]);
    // Paging continues from the loaded page, not from the new tail's head.
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(loadHistoryPage).toHaveBeenCalledTimes(2));
    expect(loadHistoryPage.mock.calls.at(-1)?.[2]).toEqual({ before: "cursor-m1", limit: 100 });

    // A reviewer that moved on further than a whole window cannot be stitched
    // without a gap: the loaded pages go and the new tail's cursor is used.
    current = tail(["m20", "m21"], { historyCursor: "cursor-m20" });
    fireEvent.click(await openTranscriptRefreshMenu());
    await screen.findByText("text m21");
    expect(shownRows()).toEqual(["text m20", "text m21"]);
    expect(screen.getByText(/history moved on/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() =>
      expect(loadHistoryPage.mock.calls.at(-1)?.[2]).toEqual({ before: "cursor-m20", limit: 100 }),
    );
  });

  test("history that cannot be paged further says so instead of ending silently", async () => {
    const loadTranscript = mock(async () => tail(["m3"]));
    const loadHistoryPage = mock<LoadHistoryPage>(async () => ({
      status: "page" as const,
      messages: [row("m2")],
      historyEpoch: "epoch-1",
      complete: false,
      truncated: true,
    }));
    render(
      <MultiReviewReviewerTab
        data={data}
        isActive
        loadTranscript={loadTranscript}
        loadHistoryPage={loadHistoryPage}
      />,
    );
    await screen.findByText("text m3");
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await screen.findByText("text m2");
    expect(screen.getByText(/Earlier messages are not available/)).toBeTruthy();
    expectDomAbsent(
      screen.queryByRole("button", { name: "Load earlier messages" }),
      "load earlier control",
    );
  });
});
