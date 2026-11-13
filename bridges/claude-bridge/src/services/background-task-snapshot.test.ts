import { describe, expect, test } from "bun:test";
import type { BackgroundTaskSnapshot } from "../types/index.js";
import {
  backgroundTasksForSnapshot,
  SNAPSHOT_BACKGROUND_TASKS_MAX_BYTES,
  SNAPSHOT_TASK_DESCRIPTION_MAX_CHARS,
  SNAPSHOT_TASK_TEXT_MAX_CHARS,
} from "./background-task-snapshot.js";
import { MAX_TERMINAL_BACKGROUND_TASKS } from "./session-manager-background-tasks.js";

function settledAgent(index: number, textLength: number): BackgroundTaskSnapshot {
  return {
    id: `task-${index}`,
    status: "completed",
    description: `Review part ${index}`,
    startedAt: 1_000 + index,
    endedAt: 2_000 + index,
    taskType: "local_agent",
    prompt: "p".repeat(textLength),
    summary: "s".repeat(textLength),
    progressSummary: "g".repeat(textLength),
  };
}

function settledShell(index: number): BackgroundTaskSnapshot {
  return {
    id: `shell-${index}`,
    status: "completed",
    startedAt: 1_000 + index,
    endedAt: 2_000 + index,
    taskType: "local_bash",
    // The bridge's own shell bounds: a 4 000-character command and 2 000-character tail.
    command: "c".repeat(4_000),
    outputTail: "o".repeat(2_000),
  };
}

function record(tasks: BackgroundTaskSnapshot[]): Record<string, BackgroundTaskSnapshot> {
  return Object.fromEntries(tasks.map((task) => [task.id, task]));
}

const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("backgroundTasksForSnapshot", () => {
  test("serves an ordinary task set unchanged", () => {
    const tasks = record([settledAgent(1, 200), settledShell(2)]);
    expect(backgroundTasksForSnapshot(tasks)).toEqual(tasks);
    expect(backgroundTasksForSnapshot(undefined)).toEqual({});
  });

  test("cuts each free-text field to what the backend keeps", () => {
    const task: BackgroundTaskSnapshot = {
      ...settledAgent(1, SNAPSHOT_TASK_TEXT_MAX_CHARS + 500),
      description: "d".repeat(SNAPSHOT_TASK_DESCRIPTION_MAX_CHARS + 10),
      outputTail: `${"a".repeat(SNAPSHOT_TASK_TEXT_MAX_CHARS)}END`,
    };
    const served = backgroundTasksForSnapshot({ [task.id]: task })[task.id]!;
    expect(served.prompt).toHaveLength(SNAPSHOT_TASK_TEXT_MAX_CHARS);
    expect(served.summary).toHaveLength(SNAPSHOT_TASK_TEXT_MAX_CHARS);
    expect(served.description).toHaveLength(SNAPSHOT_TASK_DESCRIPTION_MAX_CHARS);
    // A tail keeps its end.
    expect(served.outputTail).toHaveLength(SNAPSHOT_TASK_TEXT_MAX_CHARS);
    expect(served.outputTail!.endsWith("END")).toBe(true);
    // The in-memory record is never modified.
    expect(task.prompt).toHaveLength(SNAPSHOT_TASK_TEXT_MAX_CHARS + 500);
  });

  test("keeps a full history of settled shell tasks within the budget", () => {
    // The shape that broke a long session: the history bound alone allowed
    // 128 shell tasks at ~6 KB each, past the backend's old 512 KiB read cap.
    const tasks = record(
      Array.from({ length: MAX_TERMINAL_BACKGROUND_TASKS }, (_, index) => settledShell(index)),
    );
    expect(encodedBytes(tasks)).toBeGreaterThan(512 * 1024);

    const served = backgroundTasksForSnapshot(tasks);
    expect(encodedBytes(served)).toBeLessThanOrEqual(SNAPSHOT_BACKGROUND_TASKS_MAX_BYTES);
    // Every task is still listed; the oldest lose their detail first.
    expect(Object.keys(served)).toEqual(Object.keys(tasks));
    const newest = served[`shell-${MAX_TERMINAL_BACKGROUND_TASKS - 1}`]!;
    const oldest = served["shell-0"]!;
    expect(newest.command).toHaveLength(4_000);
    expect(oldest.command).toBeUndefined();
    expect(oldest.outputTail).toBeUndefined();
    expect(oldest).toMatchObject({ id: "shell-0", status: "completed", endedAt: 2_000 });
  });

  test("always serves live tasks, outlined when the budget is spent", () => {
    const live: BackgroundTaskSnapshot = {
      ...settledAgent(999, SNAPSHOT_TASK_TEXT_MAX_CHARS),
      status: "running",
      endedAt: undefined,
      startedAt: 1,
    };
    const tasks = record([...Array.from({ length: 40 }, (_, i) => settledAgent(i, 4_000)), live]);
    const budget = 20 * 1024;

    const served = backgroundTasksForSnapshot(tasks, budget);
    expect(encodedBytes(served)).toBeLessThanOrEqual(budget);
    // Detail goes to the live task before any settled one, however old it is.
    expect(served[live.id]?.prompt).toHaveLength(SNAPSHOT_TASK_TEXT_MAX_CHARS);
    expect(served["task-39"]?.prompt).toBeUndefined();
    // Every task is still listed.
    expect(Object.keys(served)).toEqual(Object.keys(tasks));

    // Past what even outlines fit, the oldest settled tasks are left out and
    // the live one is still served.
    const tight = backgroundTasksForSnapshot(tasks, 1024);
    expect(tight[live.id]).toMatchObject({ id: live.id, status: "running" });
    expect(tight["task-39"]).toBeDefined();
    expect(tight["task-0"]).toBeUndefined();

    const tiny = backgroundTasksForSnapshot({ [live.id]: live }, 64);
    expect(tiny[live.id]).toMatchObject({ id: live.id, status: "running" });
    expect(tiny[live.id]?.prompt).toBeUndefined();
  });

  test("keeps the original entry order", () => {
    const tasks = record([settledAgent(3, 5_000), settledAgent(1, 5_000), settledAgent(2, 5_000)]);
    const served = backgroundTasksForSnapshot(tasks, 30 * 1024);
    expect(Object.keys(served)).toEqual(Object.keys(tasks).filter((id) => id in served));
  });
});
