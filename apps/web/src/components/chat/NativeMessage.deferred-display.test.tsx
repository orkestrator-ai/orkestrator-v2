/**
 * A projected row can carry previews of a tool call's large input values and
 * of finished reasoning; the whole value is fetched only when it is expanded.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { NativeMessage } from "./NativeMessage";

function message(parts: NativeMessagePart[]) {
  return {
    id: "deferred-display",
    role: "assistant" as const,
    content: "",
    createdAt: new Date(0).toISOString(),
    parts,
  };
}

afterEach(() => {
  cleanup();
  // Expansion state outlives a render; each test starts collapsed.
  useMessagePartExpansionStore.getState().reset();
});

const FULL_CONTENT = "export const answer = 42;\n".repeat(80);
const PREVIEW = `${FULL_CONTENT.slice(0, 200)}…`;

describe("deferred tool input", () => {
  test("fetches the whole input only when the row is expanded", async () => {
    const loadToolDetails = mock(async (detailRef: string): Promise<NativeAgentToolDetails> => ({
      detailRef,
      toolArgs: { file_path: "/w/src/answer.ts", content: FULL_CONTENT },
    }));
    const { container } = render(
      <NativeMessage
        message={message([
          {
            type: "tool-invocation",
            content: "Write",
            toolName: "Write",
            toolState: "success",
            toolArgs: { file_path: "/w/src/answer.ts", content: PREVIEW },
            toolArgsDetailRef: "args-only-1",
          },
        ])}
        loadToolDetails={loadToolDetails}
      />,
    );

    // The collapsed header reads only inline fields.
    const row = screen.getByRole("button", { name: /answer\.ts/ });
    expect(loadToolDetails).not.toHaveBeenCalled();

    fireEvent.click(row);
    await waitFor(() => expect(loadToolDetails).toHaveBeenCalledWith("args-only-1"));
    await waitFor(() =>
      expect(container.textContent).toContain(JSON.stringify(FULL_CONTENT).slice(1, 400)),
    );
    expect(container.textContent).not.toContain("…");
    // No output was deferred, so nothing claims to be loading one.
    expect(container.textContent).not.toContain("Loading tool details");
  });

  test("loads the output and the input of a row that deferred both", async () => {
    const loadToolDetails = mock(async (detailRef: string): Promise<NativeAgentToolDetails> =>
      detailRef === "output-2"
        ? { detailRef, toolOutput: "wrote 80 lines" }
        : { detailRef, toolArgs: { file_path: "/w/src/answer.ts", content: FULL_CONTENT } },
    );
    const { container } = render(
      <NativeMessage
        message={message([
          {
            type: "tool-invocation",
            content: "Write",
            toolName: "Write",
            toolState: "success",
            toolArgs: { file_path: "/w/src/answer.ts", content: PREVIEW },
            detailRef: "output-2",
            toolArgsDetailRef: "args-2",
          },
        ])}
        loadToolDetails={loadToolDetails}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /answer\.ts/ }));
    expect(await screen.findByText("wrote 80 lines")).toBeTruthy();
    expect(loadToolDetails).toHaveBeenCalledWith("args-2");
    await waitFor(() => expect(container.textContent).not.toContain("…"));
  });

  test("keeps the preview when the whole input cannot be read", async () => {
    const loadToolDetails = mock(async (): Promise<NativeAgentToolDetails> => {
      throw new Error("Native agent tool details are no longer available");
    });
    const { container } = render(
      <NativeMessage
        message={message([
          {
            type: "tool-invocation",
            content: "Write",
            toolName: "Write",
            toolState: "success",
            toolArgs: { file_path: "/w/src/answer.ts", content: PREVIEW },
            toolArgsDetailRef: "args-missing-3",
          },
        ])}
        loadToolDetails={loadToolDetails}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /answer\.ts/ }));
    await waitFor(() => expect(loadToolDetails).toHaveBeenCalled());
    expect(container.textContent).toContain("…");
  });
});

describe("deferred reasoning", () => {
  test("shows the preview collapsed and the whole reasoning once expanded", async () => {
    const whole = "First I read the loader. Then I check the cursor. Finally the cache.";
    const loadToolDetails = mock(async (detailRef: string): Promise<NativeAgentToolDetails> => ({
      detailRef,
      thinking: whole,
    }));
    render(
      <NativeMessage
        message={message([
          {
            type: "thinking",
            content: "First I read the loader…",
            contentDetailRef: "thinking-4",
          },
          { type: "text", content: "Done." },
        ])}
        loadToolDetails={loadToolDetails}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Thinking.*First I read the loader/ });
    expect(loadToolDetails).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    await waitFor(() => expect(loadToolDetails).toHaveBeenCalledWith("thinking-4"));
    expect(await screen.findByText(whole)).toBeTruthy();
  });
});
