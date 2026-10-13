/**
 * Provider-neutral metadata on tool and sub-agent cards: a settled tool's
 * runtime (`toolDurationMs`) and the model/effort a child ran on
 * (`subagentModelId`, `subagentReasoningEffort`).
 *
 * Each producer fills the same fields, so every assertion is made against a
 * synthetic part with no platform: the cards must not learn which provider
 * produced them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalProvider } from "@/contexts";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { NativeMessage } from "./NativeMessage";

afterEach(cleanup);

let messageCounter = 0;

function renderParts(
  parts: NativeMessagePart[],
  options: { resolveModelLabel?: (modelId: string) => string } = {},
) {
  messageCounter += 1;
  return render(
    <TerminalProvider>
      <NativeMessage
        message={{
          // Unique per test so persisted expansion state cannot leak between them.
          id: `part-meta-${messageCounter}`,
          role: "assistant",
          content: "",
          createdAt: "2026-10-13T10:00:00.000Z",
          parts,
        }}
        resolveModelLabel={options.resolveModelLabel}
      />
    </TerminalProvider>,
  );
}

function shellPart(overrides: Partial<NativeMessagePart> = {}): NativeMessagePart {
  return {
    type: "tool-invocation",
    content: "ls",
    toolName: "Bash",
    toolArgs: { command: "ls -la" },
    toolState: "success",
    toolUseId: "call-shell",
    ...overrides,
  } as NativeMessagePart;
}

describe("tool card duration", () => {
  test("shows a settled shell call's runtime beside its state", () => {
    renderParts([shellPart({ toolDurationMs: 2_400 })]);
    const label = screen.getByText("2.4s");
    expect(label.getAttribute("title")).toBe("Ran for 2.4s");
    expect(screen.getByText("success")).toBeTruthy();
  });

  test("shows a failed call's runtime and a long one in minutes", () => {
    renderParts([shellPart({ toolState: "failure", toolDurationMs: 65_000 })]);
    expect(screen.getByText("1m 5s")).toBeTruthy();
  });

  test("keeps sub-second runtimes in milliseconds", () => {
    renderParts([
      shellPart({
        toolName: "mcp__github__get_me",
        isMcpTool: true,
        mcpServerName: "github",
        toolArgs: { query: "me" },
        toolDurationMs: 320,
      }),
    ]);
    expect(screen.getByText("320ms")).toBeTruthy();
  });

  test("never shows a duration on a running call", () => {
    const { container } = renderParts([shellPart({ toolState: "pending", toolDurationMs: 2_400 })]);
    expect(container.textContent).not.toContain("2.4s");
    expect(screen.getByText("running...")).toBeTruthy();
  });

  test("shows nothing when the provider reported no usable duration", () => {
    const { container } = renderParts([
      shellPart({ toolUseId: "a" }),
      shellPart({ toolUseId: "b", toolDurationMs: -5 }),
      shellPart({ toolUseId: "c", toolDurationMs: Number.NaN }),
    ]);
    expect(container.querySelector('[title^="Ran for"]')).toBeNull();
  });

  test("a refused call never ran, so it has no runtime", () => {
    const { container } = renderParts([
      shellPart({
        toolState: "failure",
        toolDenied: { reason: "blocked by rule", source: "rule" },
        toolDurationMs: 40,
      }),
    ]);
    expect(screen.getByText("denied")).toBeTruthy();
    expect(container.textContent).not.toContain("40ms");
  });

  test("the edit card shows the same label", () => {
    renderParts([
      {
        type: "tool-invocation",
        content: "src/a.ts",
        toolName: "Edit",
        toolState: "success",
        toolUseId: "call-edit",
        toolDiff: { filePath: "/workspace/src/a.ts", diff: "-old\n+new" },
        toolDurationMs: 1_240,
      },
    ]);
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("1.2s").getAttribute("title")).toBe("Ran for 1.2s");
  });
});

describe("sub-agent model and effort", () => {
  function subagentPart(overrides: Partial<NativeMessagePart> = {}): NativeMessagePart {
    return {
      type: "subagent",
      content: "Explore the repo",
      subagentId: "child-1",
      subagentName: "explorer",
      toolState: "success",
      agentState: "finished",
      subagentActions: [],
      ...overrides,
    } as NativeMessagePart;
  }

  test("shows the child's model through the tab's label resolver, and its effort", () => {
    renderParts(
      [subagentPart({ subagentModelId: "gpt-5.6-sol", subagentReasoningEffort: "high" })],
      { resolveModelLabel: (id) => (id === "gpt-5.6-sol" ? "GPT 5.6 Sol" : id) },
    );
    fireEvent.click(screen.getByRole("button", { name: /explorer/i }));
    expect(screen.getByText("Model")).toBeTruthy();
    expect(screen.getByText("GPT 5.6 Sol")).toBeTruthy();
    expect(screen.getByText("Effort")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
  });

  test("falls back to the raw model id and omits an unreported effort", () => {
    renderParts([subagentPart({ subagentModelId: "opencode/sonnet" })]);
    fireEvent.click(screen.getByRole("button", { name: /explorer/i }));
    expect(screen.getByText("opencode/sonnet")).toBeTruthy();
    expect(screen.queryByText("Effort")).toBeNull();
  });

  test("prefers the reported model over a launch argument", () => {
    renderParts([
      subagentPart({
        subagentModelId: "gpt-5.6-sol",
        toolArgs: { model: "requested-model" },
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /explorer/i }));
    expect(screen.getByText("gpt-5.6-sol")).toBeTruthy();
    expect(screen.queryByText("requested-model")).toBeNull();
  });

  test("a task-shaped agent card reads the same fields", () => {
    renderParts([
      {
        type: "task-group",
        content: "Task: Review",
        task: {
          type: "tool-invocation",
          content: "Task: Review",
          toolName: "Task",
          toolState: "success",
          agentState: "finished",
          toolUseId: "call-task",
          toolArgs: { description: "Review the diff" },
          subagentModelId: "gpt-5.6-sol",
          subagentReasoningEffort: "xhigh",
        },
        childTools: [],
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /review the diff/i }));
    expect(screen.getByText("gpt-5.6-sol")).toBeTruthy();
    expect(screen.getByText("xhigh")).toBeTruthy();
  });
});
