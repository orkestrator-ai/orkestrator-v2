import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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
  NativeMessage: ({ message }: { message: { id: string; content: string } }) => {
    if (message.content.includes("poison")) {
      throw new Error("injected renderer failure");
    }
    return <div>{message.content}</div>;
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
                : index > 0 ? messages[index - 1] : null,
            )}
          </div>
        ))}
        {footer}
      </div>
    );
  },
}));
afterAll(() => {
  mock.module(
    "@/components/chat/VirtualizedMessageList",
    () => realVirtualizedMessageListSnapshot,
  );
});

const { MultiReviewReviewerTab } = await import("./MultiReviewReviewerTab");

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
      messages: [{
        id: "healthy-before",
        role: "assistant",
        content: "Inspecting the changed files",
        createdAt: "2026-08-17T00:00:01.000Z",
        parts: [{ type: "text", content: "Inspecting the changed files" }],
      }, {
        id: "poisoned",
        role: "assistant",
        content: "poison frame",
        createdAt: "2026-08-17T00:00:02.000Z",
        parts: [{ type: "text", content: "poison frame" }],
      }, {
        id: "healthy-after",
        role: "assistant",
        content: "Running the validation suite",
        createdAt: "2026-08-17T00:00:03.000Z",
        parts: [{ type: "text", content: "Running the validation suite" }],
      }],
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
      expect(
        await screen.findByText(/One message could not be displayed/),
      ).toBeTruthy();
      // The header and read-only status line stay up: the view survived.
      expect(screen.getByText("Claude review")).toBeTruthy();
      expect(screen.queryByText("poison frame") === null).toBe(true);
    });
  });
});
