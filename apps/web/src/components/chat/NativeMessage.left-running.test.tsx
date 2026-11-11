/**
 * A command still running when its turn ended, with no end to come (Codex's
 * `toolLeftRunning`), reads "left running" without a spinner, never
 * "running..." on an idle thread (#2064).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { TerminalProvider } from "@/contexts";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { summarizeToolGroup } from "@/lib/chat/tool-group-summary";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { toPipelineTranscript } from "../build-pipeline/pipeline-transcript";
import { NativeMessage } from "./NativeMessage";

afterEach(() => {
  cleanup();
  useMessagePartExpansionStore.getState().reset();
});

function command(id: string, cmd: string, overrides: Partial<NativeMessagePart> = {}) {
  return {
    type: "tool-invocation",
    content: cmd,
    toolName: "bash",
    toolArgs: { command: cmd },
    toolTitle: cmd,
    toolUseId: id,
    createdAt: "2026-11-06T10:00:00.000Z",
    toolState: "success",
    toolOutput: `output of ${cmd}`,
    ...overrides,
  } as NativeMessagePart;
}

function leftRunning(id: string, cmd: string): NativeMessagePart {
  const part = command(id, cmd, { toolLeftRunning: true, toolOutput: "listening on :3000" });
  delete (part as { toolState?: unknown }).toolState;
  return part;
}

function renderParts(id: string, parts: NativeMessagePart[]) {
  return renderInAppCommandScope(
    <TerminalProvider>
      <NativeMessage
        agentExpansionScope="left-running-test"
        message={{
          id,
          role: "assistant",
          content: "Started the server.",
          createdAt: "2026-11-06T10:00:00.000Z",
          parts,
        }}
      />
    </TerminalProvider>,
  );
}

describe("a command left running", () => {
  test("reads left running, with no spinner, and still opens to its output", () => {
    const { container } = renderParts("left-running-1", [leftRunning("bg-1", "bun run dev")]);
    const badge = screen.getByText("left running");
    expect(badge.className).not.toContain("animate-pulse");
    expect(badge.getAttribute("title")).toContain("Still running when the turn ended");
    expect(container.textContent).not.toContain("running...");

    fireEvent.click(screen.getByRole("button", { name: /bun run dev/ }));
    expect(screen.getByText("listening on :3000")).toBeTruthy();
  });

  test("pipeline conversion retains and renders the left-running badge", () => {
    const converted = toPipelineTranscript(
      [
        {
          id: "pipeline-background",
          role: "assistant",
          content: "",
          parts: [leftRunning("pipeline-bg", "bun run dev")],
        },
      ],
      "codex",
      "2026-11-06T10:00:00.000Z",
    );
    expect(converted).toHaveLength(1);
    const parts = converted[0]!.parts.flatMap((part) =>
      part.type === "tool-group" ? part.parts : [part],
    );
    expect(parts[0]!.toolLeftRunning).toBe(true);
    expect(parts[0]!.toolState).toBeUndefined();
    const { container } = renderParts("pipeline-background", parts);
    expect(screen.getByText("left running")).toBeTruthy();
    expect(container.textContent).not.toContain("running...");
  });

  test("a folded group holding it does not read running", () => {
    const parts = [
      command("bg-g-1", "git status"),
      command("bg-g-2", "bun install"),
      leftRunning("bg-g-3", "bun run dev"),
    ];
    const { container } = renderParts("left-running-2", parts);
    const head = screen.getByRole("button", { name: /^Show 3 tool calls:/ });
    expect(head.textContent).not.toContain("running...");
    expect(container.textContent).not.toContain("running...");
    expect(summarizeToolGroup(parts)?.pendingCount).toBe(0);
  });
});
