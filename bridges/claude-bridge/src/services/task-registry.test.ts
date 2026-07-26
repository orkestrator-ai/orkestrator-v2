import { describe, expect, test } from "bun:test";

import { TaskRegistry, isTaskListTool } from "./task-registry.js";

// All tool output strings below are verbatim captures from the real
// TaskCreate/TaskUpdate/TaskGet/TaskList tools, not invented shapes.

function create(registry: TaskRegistry, id: string, subject: string) {
  return registry.apply(
    "TaskCreate",
    { subject, description: `${subject} description` },
    `Task #${id} created successfully: ${subject}`,
  );
}

describe("TaskRegistry", () => {
  test("accumulates created tasks into a growing list", () => {
    const registry = new TaskRegistry();

    expect(create(registry, "1", "Cache threadId")).toEqual([
      { id: "1", subject: "Cache threadId", status: "pending" },
    ]);
    expect(create(registry, "2", "Fix transcript cache thrash")).toEqual([
      { id: "1", subject: "Cache threadId", status: "pending" },
      { id: "2", subject: "Fix transcript cache thrash", status: "pending" },
    ]);
  });

  test("resolves a status-only update against the created subject", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Cache threadId");
    create(registry, "2", "Fix transcript cache thrash");

    const snapshot = registry.apply(
      "TaskUpdate",
      { taskId: "1", status: "in_progress" },
      "Updated task #1 status",
    );

    expect(snapshot).toEqual([
      { id: "1", subject: "Cache threadId", status: "in_progress" },
      { id: "2", subject: "Fix transcript cache thrash", status: "pending" },
    ]);
  });

  test("applies a combined subject and status update", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Probe A");

    expect(
      registry.apply(
        "TaskUpdate",
        { taskId: "1", status: "completed", subject: "Probe A renamed" },
        "Updated task #1 subject, status",
      ),
    ).toEqual([{ id: "1", subject: "Probe A renamed", status: "completed" }]);
  });

  test("removes deleted tasks from the list", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Keep me");
    create(registry, "2", "Delete me");

    expect(
      registry.apply(
        "TaskUpdate",
        { taskId: "2", status: "deleted" },
        "Updated task #2 deleted",
      ),
    ).toEqual([{ id: "1", subject: "Keep me", status: "pending" }]);
  });

  test("leaves the list untouched for a non-status update", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Probe A");

    expect(
      registry.apply(
        "TaskUpdate",
        { taskId: "1", owner: "probe-agent" },
        "Updated task #1 owner",
      ),
    ).toEqual([{ id: "1", subject: "Probe A", status: "pending" }]);
  });

  test("orders the list by task id, not by when it was touched", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "One");
    create(registry, "2", "Two");
    create(registry, "10", "Ten");

    registry.apply("TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status");

    expect(registry.snapshot().map((task) => task.id)).toEqual(["1", "2", "10"]);
  });

  test("reconciles wholesale from TaskList, stripping owner and blocked suffixes", () => {
    const registry = new TaskRegistry();

    const snapshot = registry.apply(
      "TaskList",
      {},
      "#2 [completed] Probe A (probe-agent)\n#3 [pending] Probe B [blocked by #2]",
    );

    expect(snapshot).toEqual([
      { id: "2", subject: "Probe A", status: "completed" },
      { id: "3", subject: "Probe B", status: "pending" },
    ]);
  });

  test("prefers the subject captured at creation over the decorated list line", () => {
    const registry = new TaskRegistry();
    // A subject that legitimately ends in a parenthetical is indistinguishable
    // from TaskList's owner suffix, so the created subject must win.
    create(registry, "1", "Fix parser (edge cases)");

    expect(
      registry.apply("TaskList", {}, "#1 [pending] Fix parser (edge cases)"),
    ).toEqual([{ id: "1", subject: "Fix parser (edge cases)", status: "pending" }]);
  });

  test("drops tasks that TaskList no longer reports", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Stale");
    create(registry, "2", "Live");

    expect(registry.apply("TaskList", {}, "#2 [pending] Live")).toEqual([
      { id: "2", subject: "Live", status: "pending" },
    ]);
  });

  test("treats an empty TaskList as an empty list", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Gone");

    expect(registry.apply("TaskList", {}, "")).toEqual([]);
  });

  test("keeps existing state when TaskList output cannot be parsed", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Keep me");

    expect(registry.apply("TaskList", {}, "Something unexpected")).toEqual([
      { id: "1", subject: "Keep me", status: "pending" },
    ]);
  });

  test("reconciles a single task from TaskGet", () => {
    const registry = new TaskRegistry();

    expect(
      registry.apply(
        "TaskGet",
        { taskId: "3" },
        "Task #3: Probe B\nStatus: in_progress\nDescription: Second probe task\nBlocked by: #2",
      ),
    ).toEqual([{ id: "3", subject: "Probe B", status: "in_progress" }]);
  });

  test("synthesizes a placeholder when an update precedes any known create", () => {
    // Happens when a session resumes with tasks the bridge never saw created.
    const registry = new TaskRegistry();

    expect(
      registry.apply(
        "TaskUpdate",
        { taskId: "7", status: "in_progress" },
        "Updated task #7 status",
      ),
    ).toEqual([{ id: "7", subject: "Task #7", status: "in_progress" }]);

    // ...and a later TaskList repairs the missing subject.
    expect(registry.apply("TaskList", {}, "#7 [in_progress] Real subject")).toEqual([
      { id: "7", subject: "Real subject", status: "in_progress" },
    ]);
  });

  test("ignores tools it does not model", () => {
    const registry = new TaskRegistry();
    expect(registry.apply("Read", { file_path: "/tmp/x" }, "contents")).toBeUndefined();
    expect(registry.apply("TodoWrite", {}, "ok")).toBeUndefined();
    expect(registry.apply(undefined, undefined, undefined)).toBeUndefined();
  });

  test("ignores unparseable create output rather than inventing a task", () => {
    const registry = new TaskRegistry();
    expect(registry.apply("TaskCreate", { subject: "X" }, "some error text")).toEqual([]);
  });

  test("accepts snake_case tool names", () => {
    const registry = new TaskRegistry();
    expect(
      registry.apply(
        "task_create",
        { subject: "Snake" },
        "Task #1 created successfully: Snake",
      ),
    ).toEqual([{ id: "1", subject: "Snake", status: "pending" }]);
  });
});

describe("isTaskListTool", () => {
  test("recognizes the task tools in both casings", () => {
    for (const name of ["TaskCreate", "taskupdate", "TaskGet", "task_list"]) {
      expect(isTaskListTool(name)).toBe(true);
    }
  });

  test("rejects other tools", () => {
    for (const name of ["Task", "TodoWrite", "Read", undefined]) {
      expect(isTaskListTool(name)).toBe(false);
    }
  });
});
