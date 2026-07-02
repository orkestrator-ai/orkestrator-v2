import { describe, expect, test } from "bun:test";
import type { ClaudeMessage } from "@/lib/claude-client";
import {
  applyTmuxAgentUsageSummaries,
  parseTmuxAgentUsageSummaries,
} from "./claude-tmux-usage";

describe("Claude tmux agent usage summaries", () => {
  test("parses tool-use and token counts from Claude's tmux pane", () => {
    const summaries = parseTmuxAgentUsageSummaries(`
Running 3 Explore agents...
├ Review API-client source modules group 1 · 8 tool uses · 20.4k tokens
│ └ Reading 8 files...
├ Review API-client source modules group 2 · 11 tool uses · 20.6k tokens
└ Review ATS + web/crawl source modules · 21 tool uses · 42.7k tokens
`);

    expect(summaries).toEqual([
      {
        name: "Review API-client source modules group 1",
        role: "Explore",
        toolUseCount: 8,
        tokenCount: 20_400,
        tokenCountText: "20.4k tokens",
      },
      {
        name: "Review API-client source modules group 2",
        role: "Explore",
        toolUseCount: 11,
        tokenCount: 20_600,
        tokenCountText: "20.6k tokens",
      },
      {
        name: "Review ATS + web/crawl source modules",
        role: "Explore",
        toolUseCount: 21,
        tokenCount: 42_700,
        tokenCountText: "42.7k tokens",
      },
    ]);
  });

  test("parses token-only counts from Claude's current tmux agent rows", () => {
    const summaries = parseTmuxAgentUsageSummaries(`
● main
○ Explore  Review db-api test correctness                 1m 6s · ↓ 45.7k tokens
○ Explore  Review web test correctness                      57s · ↓ 37.3k tokens
`);

    expect(summaries).toEqual([
      {
        name: "Review db-api test correctness",
        role: "Explore",
        tokenCount: 45_700,
        tokenCountText: "45.7k tokens",
      },
      {
        name: "Review web test correctness",
        role: "Explore",
        tokenCount: 37_300,
        tokenCountText: "37.3k tokens",
      },
    ]);
  });

  test("applies parsed counts to matching Claude Agent tool parts", () => {
    const message: ClaudeMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      timestamp: "2026-06-25T18:20:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "pending",
          toolArgs: {
            description: "Review API-client source modules group 1",
            subagent_type: "Explore",
          },
          toolUseId: "agent-1",
        },
        {
          type: "tool-invocation",
          toolName: "Read",
          toolTitle: "Read",
          toolState: "success",
          parentTaskUseId: "agent-1",
        },
      ],
    };

    const [updated] = applyTmuxAgentUsageSummaries([message], [
      {
        name: "Review API-client source modules group 1",
        role: "Explore",
        toolUseCount: 8,
        tokenCount: 20_400,
        tokenCountText: "20.4k tokens",
      },
    ]);

    expect(updated?.parts[0]).toMatchObject({
      toolUseCount: 8,
      tokenCount: 20_400,
      tokenCountText: "20.4k tokens",
      agentUsageDisplay: "token-only",
    });
    expect(updated?.parts[1]).not.toHaveProperty("toolUseCount");
  });

  test("parses singular tool use, comma grouping, and m/b suffixes", () => {
    const summaries = parseTmuxAgentUsageSummaries(`
Running 3 Worker agents...
├ Single step agent · 1 tool use · 980 tokens
├ Heavy agent · 1,024 tool uses · 1.2m tokens
└ Huge agent · 2,048 tool uses · 1.5b tokens
`);

    expect(summaries).toEqual([
      {
        name: "Single step agent",
        role: "Worker",
        toolUseCount: 1,
        tokenCount: 980,
        tokenCountText: "980 tokens",
      },
      {
        name: "Heavy agent",
        role: "Worker",
        toolUseCount: 1024,
        tokenCount: 1_200_000,
        tokenCountText: "1.2m tokens",
      },
      {
        name: "Huge agent",
        role: "Worker",
        toolUseCount: 2048,
        tokenCount: 1_500_000_000,
        tokenCountText: "1.5b tokens",
      },
    ]);
  });

  test("leaves role undefined when no running-agents header precedes the row", () => {
    const summaries = parseTmuxAgentUsageSummaries(
      "Some headerless agent · 4 tool uses · 5.0k tokens",
    );

    expect(summaries).toEqual([
      {
        name: "Some headerless agent",
        role: undefined,
        toolUseCount: 4,
        tokenCount: 5_000,
        tokenCountText: "5.0k tokens",
      },
    ]);
  });

  test("matches a running agent by ordinal position when the name differs", () => {
    const message: ClaudeMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      timestamp: "2026-06-25T18:20:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "pending",
          toolArgs: { description: "Something the pane abbreviated" },
          toolUseId: "agent-1",
        },
      ],
    };

    const [updated] = applyTmuxAgentUsageSummaries([message], [
      {
        name: "Pane shortened label",
        role: "Explore",
        toolUseCount: 6,
        tokenCount: 12_000,
        tokenCountText: "12.0k tokens",
      },
    ]);

    expect(updated?.parts[0]).toMatchObject({
      toolUseCount: 6,
      tokenCount: 12_000,
      tokenCountText: "12.0k tokens",
    });
  });

  test("never attributes running-agent counts to a finished agent", () => {
    const completedAgent: ClaudeMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      timestamp: "2026-06-25T18:20:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "success",
          toolArgs: { description: "Old finished agent" },
          toolUseId: "agent-old",
        },
      ],
    };
    const runningAgent: ClaudeMessage = {
      id: "assistant-2",
      role: "assistant",
      content: "",
      timestamp: "2026-06-25T18:21:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "pending",
          toolArgs: { description: "Currently running agent" },
          toolUseId: "agent-new",
        },
      ],
    };

    const [oldUpdated, newUpdated] = applyTmuxAgentUsageSummaries(
      [completedAgent, runningAgent],
      [
        {
          name: "Currently running agent",
          role: "Explore",
          toolUseCount: 8,
          tokenCount: 20_400,
          tokenCountText: "20.4k tokens",
        },
      ],
    );

    // The finished agent (iterated first) must NOT inherit the running counts,
    // even though it would otherwise win the ordinal fallback.
    expect(oldUpdated?.parts[0]).not.toHaveProperty("toolUseCount");
    expect(newUpdated?.parts[0]).toMatchObject({
      toolUseCount: 8,
      tokenCount: 20_400,
      tokenCountText: "20.4k tokens",
      agentUsageDisplay: "token-only",
    });
  });

  test("applies exact token-only matches to completed agents", () => {
    const message: ClaudeMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      timestamp: "2026-06-25T18:20:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "success",
          toolArgs: {
            description: "Review db-api test correctness",
            subagent_type: "Explore",
          },
          toolUseId: "agent-1",
        },
      ],
    };

    const [updated] = applyTmuxAgentUsageSummaries(
      [message],
      [
        {
          name: "Review db-api test correctness",
          role: "Explore",
          tokenCount: 45_700,
          tokenCountText: "45.7k tokens",
        },
      ],
    );

    expect(updated?.parts[0]).toMatchObject({
      tokenCount: 45_700,
      tokenCountText: "45.7k tokens",
      agentUsageDisplay: "token-only",
    });
    expect(updated?.parts[0]).not.toHaveProperty("toolUseCount");
  });
});
