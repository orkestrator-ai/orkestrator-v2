/**
 * A call the reader opened stays open when the row holding it is renamed.
 *
 * Codex's first replay after live streaming gives every row a new id (and the
 * calls a new source row id) while each call keeps its own id; coalescing
 * renames a row whenever earlier rows merge in front of it. A call's own
 * disclosure is remembered by its call id within the transcript, so neither
 * folds it again (to-do 7270).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { TerminalProvider } from "@/contexts";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { NativeMessage } from "./NativeMessage";

afterEach(() => {
  cleanup();
  useMessagePartExpansionStore.getState().reset();
});

type ToolCall = Extract<NativeMessagePart, { type: "tool-invocation" }>;

function shell(callId: string, command: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    type: "tool-invocation",
    content: command,
    toolName: "Bash",
    toolArgs: { command },
    toolState: "success",
    toolOutput: `output of ${command}`,
    toolUseId: callId,
    createdAt: "2026-11-06T10:00:00.000Z",
    toolDurationMs: 250,
    ...overrides,
  };
}

/** The same calls under a row (and source rows) of another id. */
function renamed(calls: ToolCall[], sourceMessageId: string): ToolCall[] {
  return calls.map((call) => ({ ...call, sourceMessageId }));
}

function view(
  id: string,
  parts: NativeMessagePart[],
  options: {
    scope?: string;
    loadToolDetails?: (detailRef: string) => Promise<NativeAgentToolDetails>;
  } = {},
) {
  return (
    <TerminalProvider>
      <NativeMessage
        agentExpansionScope={options.scope ?? "rename-test"}
        loadToolDetails={options.loadToolDetails}
        message={{
          id,
          role: "assistant",
          content: "",
          createdAt: "2026-11-06T10:00:00.000Z",
          parts,
        }}
      />
    </TerminalProvider>
  );
}

function callTrigger(command: string): HTMLElement {
  const trigger = screen
    .getAllByRole("button")
    .find(
      (button) =>
        button.hasAttribute("aria-expanded") &&
        button.textContent?.includes(command) &&
        !/tool calls:/.test(button.getAttribute("aria-label") ?? ""),
    );
  if (!trigger) throw new Error(`no call trigger for ${command}`);
  return trigger;
}

describe("a call's own expansion across a row rename", () => {
  test("an opened call inside an open group stays open when the row and its sources are renamed", () => {
    const calls = [
      shell("rename-a-1", "git status"),
      shell("rename-a-2", "git diff --stat"),
      shell("rename-a-3", "git log -5"),
    ];
    const { rerender } = renderInAppCommandScope(
      view("live-row-1", renamed(calls, "live-source-1")),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Show 3 tool calls:/ }));
    fireEvent.click(callTrigger("git diff --stat"));
    expect(callTrigger("git diff --stat").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("output of git diff --stat")).toBeTruthy();

    // The replay renames the row and every source row; the call ids survive.
    rerender(view("replayed-row-1", renamed(calls, "replayed-source-1")));
    expect(screen.getByRole("button", { name: /^Fold 3 tool calls:/ })).toBeTruthy();
    expect(callTrigger("git diff --stat").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("output of git diff --stat")).toBeTruthy();
    // Only the call the reader opened.
    expect(callTrigger("git status").getAttribute("aria-expanded")).toBe("false");
  });

  test("an opened call restores under its new row after a virtualized unmount", () => {
    const calls = [shell("rename-b-1", "ls -la")];
    const first = renderInAppCommandScope(view("live-row-2", renamed(calls, "live-source-2")));
    fireEvent.click(callTrigger("ls -la"));
    first.unmount();

    renderInAppCommandScope(view("replayed-row-2", renamed(calls, "replayed-source-2")));
    expect(callTrigger("ls -la").getAttribute("aria-expanded")).toBe("true");
  });

  test("folding the call under its new row folds it for good", () => {
    const calls = [shell("rename-c-1", "pwd")];
    const { rerender } = renderInAppCommandScope(view("live-row-3", calls));
    fireEvent.click(callTrigger("pwd"));
    rerender(view("replayed-row-3", calls));
    fireEvent.click(callTrigger("pwd"));
    expect(callTrigger("pwd").getAttribute("aria-expanded")).toBe("false");
    // History paging can hand the row its earlier id back; no stale key
    // under that id reopens the call.
    rerender(view("live-row-3", calls));
    expect(callTrigger("pwd").getAttribute("aria-expanded")).toBe("false");
  });

  test("a call with deferred output stays open and loaded across the rename", async () => {
    const loadToolDetails = mock(async (detailRef: string): Promise<NativeAgentToolDetails> => ({
      detailRef,
      toolOutput: "stop 2 output",
    }));
    const call = shell("rename-e-1", "sleep 2", { toolOutput: undefined, detailRef: "stop-2" });
    const { rerender } = renderInAppCommandScope(
      view("live-row-5", renamed([call], "live-source-5"), { loadToolDetails }),
    );
    fireEvent.click(callTrigger("sleep 2"));
    await waitFor(() => expect(screen.getByText("stop 2 output")).toBeTruthy());

    rerender(view("replayed-row-5", renamed([call], "replayed-source-5"), { loadToolDetails }));
    expect(callTrigger("sleep 2").getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(screen.getByText("stop 2 output")).toBeTruthy());
  });

  test("the same call id in another transcript is another disclosure", () => {
    const calls = [shell("rename-f-1", "whoami")];
    const first = renderInAppCommandScope(view("row-6", calls, { scope: "transcript-a" }));
    fireEvent.click(callTrigger("whoami"));
    first.unmount();
    renderInAppCommandScope(view("row-6-renamed", calls, { scope: "transcript-b" }));
    expect(callTrigger("whoami").getAttribute("aria-expanded")).toBe("false");
  });
});
