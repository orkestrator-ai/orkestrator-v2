import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/*
 * One transcript row that a renderer cannot survive must degrade to its own
 * fallback line instead of handing the whole tab to the view error boundary.
 * The real NativeMessage is hardened against every malformed shape we have
 * seen, so the failure is injected by stubbing it for this file only —
 * snapshot-and-restore per the repo's module-mock rules, because sibling
 * suites render the real component.
 */
import * as realNativeMessage from "@/components/chat/NativeMessage";
const realNativeMessageSnapshot = { ...realNativeMessage };
mock.module("@/components/chat/NativeMessage", () => ({
  ...realNativeMessageSnapshot,
  NativeMessage: ({
    message,
  }: {
    message: {
      id: string;
      content: string;
      parts: Array<{ type: string; content: string }>;
    };
  }) => {
    if (message.content.includes("poison")) {
      throw new Error("injected renderer failure");
    }
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
    const { messages, renderMessage, resolvePreviousMessage, emptyState, footer } = props;
    return (
      <div>
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

const { MultiReviewReviewerTab, toMultiReviewReviewerMessages } =
  await import("./MultiReviewReviewerTab");

afterEach(cleanup);

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

      fireEvent.click(screen.getByRole("button", { name: "Refresh reviewer transcript" }));

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
