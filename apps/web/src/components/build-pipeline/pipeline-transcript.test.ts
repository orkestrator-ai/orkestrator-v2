import { describe, expect, test } from "bun:test";
import { toPipelineTranscript } from "./pipeline-transcript";

const FALLBACK = "2026-07-29T00:00:00.000Z";

describe("toPipelineTranscript", () => {
  test("renders bridge messages as native messages with their parts intact", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "Ran the tests",
        createdAt: "2026-07-29T00:01:00.000Z",
        modelId: "gpt-5-codex",
        parts: [
          { type: "text", content: "Ran the tests" },
          {
            type: "tool-invocation",
            content: "shell",
            toolName: "shell",
            toolArgs: { command: "bun test" },
            toolState: "success",
            toolOutput: "33 pass",
          },
        ],
      }],
      "codex",
      FALLBACK,
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: "message-1",
      role: "assistant",
      createdAt: "2026-07-29T00:01:00.000Z",
      modelId: "gpt-5-codex",
    });
    expect(transcript[0]!.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-invocation",
    ]);
    expect(transcript[0]!.parts[1]).toMatchObject({
      toolName: "shell",
      toolArgs: { command: "bun test" },
      toolOutput: "33 pass",
    });
  });

  test("groups Claude child tools under the Task that spawned them", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        timestamp: "2026-07-29T00:01:00.000Z",
        parts: [
          {
            type: "tool-invocation",
            toolName: "Task",
            toolUseId: "task-1",
            toolArgs: { description: "Audit the diff" },
          },
          {
            type: "tool-invocation",
            toolName: "Bash",
            parentTaskUseId: "task-1",
            toolArgs: { command: "git diff" },
          },
        ],
      }],
      "claude",
      FALLBACK,
    );

    expect(transcript).toHaveLength(1);
    const [part] = transcript[0]!.parts;
    expect(part?.type).toBe("task-group");
    expect(part?.type === "task-group" && part.childTools).toHaveLength(1);
    // Claude records the message time as `timestamp`; the native model reads
    // `createdAt`, and a missing one would render as an invalid date.
    expect(transcript[0]!.createdAt).toBe("2026-07-29T00:01:00.000Z");
  });

  test("reads OpenCode's info/parts envelope", () => {
    const transcript = toPipelineTranscript(
      [{
        info: {
          id: "message-1",
          role: "assistant",
          time: { created: 1_800_000_000_000 },
        },
        parts: [{ type: "text", text: "All criteria pass" }],
      }],
      "opencode",
      FALLBACK,
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]!.content).toBe("All criteria pass");
    expect(transcript[0]!.parts[0]).toMatchObject({
      type: "text",
      content: "All criteria pass",
    });
  });

  test("drops entries and parts it cannot understand instead of rendering them", () => {
    const transcript = toPipelineTranscript(
      [
        null,
        42,
        "text",
        {},
        { role: "assistant", content: "   ", parts: [] },
        {
          id: "message-1",
          role: "assistant",
          content: "kept",
          parts: [
            { type: "mystery-part", content: "ignored" },
            null,
            { content: "typeless" },
            { type: "text", content: "kept" },
          ],
        },
      ],
      "codex",
      FALLBACK,
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]!.parts).toHaveLength(1);
    expect(transcript[0]!.parts[0]).toMatchObject({ type: "text", content: "kept" });
  });

  test("replaces collection fields the renderer iterates when they are malformed", () => {
    // A persisted snapshot from an older build can carry any shape at all, and
    // the renderer maps over these without checking.
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "subagent",
            content: "reviewer",
            subagentActions: "not-an-array",
          },
          {
            type: "tool-invocation",
            toolName: "TaskCreate",
            taskSnapshot: { items: "not-an-array" },
          },
          {
            type: "tool-invocation",
            toolName: "Read",
            toolArgs: "not-a-record",
          },
        ],
      }],
      "codex",
      FALLBACK,
    );

    const parts = transcript[0]!.parts;
    expect(parts[0]).toMatchObject({ type: "subagent", subagentActions: [] });
    expect(parts[1]!.taskSnapshot).toBeUndefined();
    expect(parts[2]!.toolArgs).toBeUndefined();
  });

  test("drops empty groups and unanchored task groups", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "kept",
        parts: [
          { type: "tool-group", content: "", parts: [] },
          { type: "agent-group", content: "", parts: [{ type: "text", content: "x" }] },
          { type: "task-group", content: "", task: { type: "text", content: "x" } },
          { type: "text", content: "kept" },
        ],
      }],
      "codex",
      FALLBACK,
    );

    expect(transcript[0]!.parts.map((part) => part.type)).toEqual(["text"]);
  });

  test("falls back to the stage start time when a message carries none", () => {
    const transcript = toPipelineTranscript(
      [{ id: "message-1", role: "assistant", content: "no timestamp" }],
      "codex",
      FALLBACK,
    );

    expect(transcript[0]!.createdAt).toBe(FALLBACK);
  });

  test("keeps message order across mixed shapes", () => {
    const transcript = toPipelineTranscript(
      [
        { id: "first", role: "user", content: "build it" },
        {
          info: { id: "second", role: "assistant", time: { created: 1 } },
          parts: [{ type: "text", text: "building" }],
        },
        { id: "third", role: "assistant", content: "done" },
      ],
      "codex",
      FALLBACK,
    );

    expect(transcript.map((message) => message.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
