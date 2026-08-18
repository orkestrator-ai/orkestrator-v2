import { describe, expect, test } from "bun:test";

import { TranscriptTaskTracker } from "./claude-transcript-tasks.js";

function toolUseLine(id: string, name: string, input: Record<string, unknown>) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}

function toolResultLine(toolUseId: string, content: unknown, options?: { isError?: boolean }) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          ...(options?.isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

describe("TranscriptTaskTracker", () => {
  test("pairs a task tool_use with its later tool_result", () => {
    const tracker = new TranscriptTaskTracker();

    // The tool_use carries the name and args; the result carries the id. Only
    // the pair says what happened.
    expect(
      tracker.applyLine(toolUseLine("t1", "TaskCreate", { subject: "Wire it up" })),
    ).toBeUndefined();

    expect(
      tracker.applyLine(toolResultLine("t1", "Task #1 created successfully: Wire it up")),
    ).toEqual({
      t1: {
        items: [{ id: "1", subject: "Wire it up", status: "pending" }],
        complete: true,
        changedTaskId: "1",
      },
    });
  });

  test("reads a tool_result whose content is an array of text blocks", () => {
    const tracker = new TranscriptTaskTracker();
    tracker.applyLine(toolUseLine("t1", "TaskCreate", { subject: "Blocks" }));

    expect(
      tracker.applyLine(
        toolResultLine("t1", [{ type: "text", text: "Task #1 created successfully: Blocks" }]),
      )?.t1?.items,
    ).toEqual([{ id: "1", subject: "Blocks", status: "pending" }]);
  });

  test("reads content from a top-level line without a message wrapper", () => {
    const tracker = new TranscriptTaskTracker();
    tracker.applyLine({
      type: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "TaskCreate", input: { subject: "Flat" } }],
    });

    expect(
      tracker.applyLine({
        type: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Task #1 created successfully: Flat" },
        ],
      })?.t1?.items,
    ).toEqual([{ id: "1", subject: "Flat", status: "pending" }]);
  });

  test("a failed task call changes nothing", () => {
    const tracker = new TranscriptTaskTracker();
    tracker.applyLine(toolUseLine("t1", "TaskCreate", { subject: "Kept" }));
    tracker.applyLine(toolResultLine("t1", "Task #1 created successfully: Kept"));

    tracker.applyLine(toolUseLine("t2", "TaskUpdate", { taskId: "1", status: "completed" }));
    expect(
      tracker.applyLine(toolResultLine("t2", "Task #1 not found", { isError: true })),
    ).toBeUndefined();

    expect(tracker.snapshot().items).toEqual([{ id: "1", subject: "Kept", status: "pending" }]);
  });

  test("ignores results for tools it never saw used", () => {
    const tracker = new TranscriptTaskTracker();
    // A transcript read that starts mid-file can open on an orphan result.
    expect(tracker.applyLine(toolResultLine("unknown", "Updated task #1 status"))).toBeUndefined();
  });

  test("ignores non-task tools entirely", () => {
    const tracker = new TranscriptTaskTracker();
    tracker.applyLine(toolUseLine("t1", "Bash", { command: "ls" }));

    expect(tracker.applyLine(toolResultLine("t1", "file-a\nfile-b"))).toBeUndefined();
    expect(tracker.snapshot().items).toEqual([]);
  });

  test("keys a line's several results by the tool each belongs to", () => {
    const tracker = new TranscriptTaskTracker();
    tracker.applyLine({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "TaskCreate", input: { subject: "One" } },
          { type: "tool_use", id: "t2", name: "TaskCreate", input: { subject: "Two" } },
        ],
      },
    });

    const snapshot = tracker.applyLine({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Task #1 created successfully: One" },
          { type: "tool_result", tool_use_id: "t2", content: "Task #2 created successfully: Two" },
        ],
      },
    });

    // Each result carries the list as it stood after *that* call, keyed by the
    // tool it belongs to.
    expect(snapshot?.t1?.items).toHaveLength(1);
    expect(snapshot?.t1?.changedTaskId).toBe("1");
    expect(snapshot?.t2?.items).toHaveLength(2);
    expect(snapshot?.t2?.changedTaskId).toBe("2");
  });

  test("replaying the same lines converges on the same list", () => {
    // A full transcript read and the live tail overlap without coordination,
    // so the same line can be applied twice.
    const lines = [
      toolUseLine("t1", "TaskCreate", { subject: "Alpha" }),
      toolResultLine("t1", "Task #1 created successfully: Alpha"),
      toolUseLine("t2", "TaskUpdate", { taskId: "1", status: "completed" }),
      toolResultLine("t2", "Updated task #1 status"),
    ];

    const once = new TranscriptTaskTracker();
    const twice = new TranscriptTaskTracker();
    for (const line of lines) once.applyLine(line);
    for (const line of [...lines, ...lines]) twice.applyLine(line);

    expect(twice.snapshot()).toEqual(once.snapshot());
    expect(once.snapshot().items).toEqual([{ id: "1", subject: "Alpha", status: "completed" }]);
  });

  test("survives lines with no content at all", () => {
    const tracker = new TranscriptTaskTracker();

    for (const line of [null, undefined, 42, "text", {}, { message: {} }, { content: "plain" }]) {
      expect(tracker.applyLine(line)).toBeUndefined();
    }
    expect(tracker.snapshot()).toEqual({ items: [], complete: true });
  });
});
