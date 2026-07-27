import { beforeEach, describe, expect, test } from "bun:test";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  AGENT_HANDOFF_PROMPT_BUDGET,
  countAgentHandoffToolCalls,
  createAgentHandoffSnapshot,
  mergeAgentHandoffDisplayMessages,
  parseAgentHandoffSnapshot,
  resetAgentHandoffCache,
} from "./agent-handoff";

const messages: NativeMessage[] = [
  {
    id: "user-1",
    role: "user",
    content: "Fix the failing build",
    parts: [{ type: "text", content: "Fix the failing build" }],
    createdAt: "2026-07-27T10:00:00.000Z",
  },
  {
    id: "assistant-1",
    role: "assistant",
    content: "I found the problem.",
    parts: [
      { type: "thinking", content: "private intermediate reasoning" },
      {
        type: "tool-group",
        content: "",
        parts: [
          {
            type: "tool-invocation",
            content: "bun test",
            toolName: "Bash",
            toolArgs: { command: "bun test" },
            toolState: "success",
            toolOutput: "2 tests passed",
          },
          {
            type: "tool-invocation",
            content: "edit",
            toolName: "Edit",
            toolState: "success",
            toolDiff: {
              filePath: "src/fix.ts",
              additions: 2,
              deletions: 1,
              diff: "+fixed",
            },
          },
        ],
      },
      { type: "text", content: "The build now passes." },
    ],
    createdAt: "2026-07-27T10:01:00.000Z",
  },
];

beforeEach(resetAgentHandoffCache);

describe("agent handoff snapshots", () => {
  test("serializes conversation and completed tool evidence without exporting thinking", () => {
    const handoff = createAgentHandoffSnapshot({
      id: "handoff-1",
      environmentId: "env-1",
      sourceProvider: "claude",
      destinationProvider: "codex",
      sourceSessionId: "claude-session",
      sourceTitle: "Build fix",
      sourceModel: "sonnet",
      messages,
      now: "2026-07-27T11:00:00.000Z",
    });

    expect(handoff.stats).toMatchObject({
      messageCount: 2,
      toolCallCount: 2,
      includedMessageCount: 2,
      omittedMessageCount: 0,
    });
    expect(handoff.bootstrapPrompt).toContain(
      '<orkestrator-handoff id="handoff-1" source="claude" destination="codex">',
    );
    expect(handoff.bootstrapPrompt).toContain("[TOOL Bash (success)]");
    expect(handoff.bootstrapPrompt).toContain('"command": "bun test"');
    expect(handoff.bootstrapPrompt).toContain("2 tests passed");
    expect(handoff.bootstrapPrompt).toContain("src/fix.ts");
    expect(handoff.bootstrapPrompt).toContain("never replay");
    expect(handoff.bootstrapPrompt).not.toContain("private intermediate reasoning");
    expect(parseAgentHandoffSnapshot(handoff)).toEqual(handoff);
  });

  test("counts nested task and subagent tools exactly once", () => {
    expect(countAgentHandoffToolCalls(messages)).toBe(2);
  });

  test("keeps the complete imported display transcript and hides the bootstrap carrier", () => {
    const handoff = createAgentHandoffSnapshot({
      id: "handoff-1",
      environmentId: "env-1",
      sourceProvider: "claude",
      destinationProvider: "codex",
      sourceSessionId: "claude-session",
      messages,
    });
    const providerMessages: NativeMessage[] = [
      {
        id: "bootstrap",
        role: "user",
        content: handoff.bootstrapPrompt,
        parts: [{ type: "text", content: handoff.bootstrapPrompt }],
        createdAt: "2026-07-27T11:01:00.000Z",
      },
      {
        id: "answer",
        role: "assistant",
        content: "I will verify the build.",
        parts: [{ type: "text", content: "I will verify the build." }],
        createdAt: "2026-07-27T11:02:00.000Z",
      },
    ];

    const merged = mergeAgentHandoffDisplayMessages(handoff, providerMessages);
    expect(merged.map((message) => message.id)).toEqual([
      "handoff:handoff-1:source:user-1",
      "handoff:handoff-1:source:assistant-1",
      "handoff:handoff-1:boundary",
      "answer",
    ]);
    expect(merged[2]?.content).toContain("2 messages · 2 tool calls");
  });

  test("bounds destination context while retaining the complete visual snapshot", () => {
    const largeMessages = Array.from({ length: 20 }, (_, index): NativeMessage => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}:${"x".repeat(30_000)}`,
      parts: [{ type: "text", content: `${index}:${"x".repeat(30_000)}` }],
      createdAt: new Date(index * 1_000).toISOString(),
    }));
    const handoff = createAgentHandoffSnapshot({
      id: "handoff-large",
      environmentId: "env-1",
      sourceProvider: "opencode",
      destinationProvider: "claude",
      sourceSessionId: "opencode-session",
      messages: largeMessages,
    });

    expect(handoff.messages).toHaveLength(20);
    expect(handoff.bootstrapPrompt.length).toBeLessThanOrEqual(AGENT_HANDOFF_PROMPT_BUDGET);
    expect(handoff.stats.omittedMessageCount).toBeGreaterThan(0);
    expect(handoff.bootstrapPrompt).toContain("remain visible in Orkestrator");
  });

  test("rejects malformed or same-provider snapshots", () => {
    expect(parseAgentHandoffSnapshot({})).toBeNull();
    const handoff = createAgentHandoffSnapshot({
      id: "handoff-1",
      environmentId: "env-1",
      sourceProvider: "claude",
      destinationProvider: "codex",
      sourceSessionId: "claude-session",
      messages,
    });
    expect(parseAgentHandoffSnapshot({
      ...handoff,
      destinationProvider: "claude",
    })).toBeNull();
  });
});
