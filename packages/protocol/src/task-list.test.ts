import { describe, expect, test } from "bun:test";

import {
  MAX_SNAPSHOT_ITEMS,
  TaskRegistry,
  isTaskListTool,
  taskToolKind,
} from "./task-list";

// All tool output strings below are verbatim captures from the real
// TaskCreate/TaskUpdate/TaskGet/TaskList tools, not invented shapes, except
// where a test explicitly probes an unrecognized shape.

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

    expect(create(registry, "1", "Cache threadId")).toEqual({
      items: [{ id: "1", subject: "Cache threadId", status: "pending" }],
      complete: true,
      changedTaskId: "1",
    });
    expect(create(registry, "2", "Fix transcript cache thrash")).toEqual({
      items: [
        { id: "1", subject: "Cache threadId", status: "pending" },
        { id: "2", subject: "Fix transcript cache thrash", status: "pending" },
      ],
      complete: true,
      changedTaskId: "2",
    });
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

    expect(snapshot?.items).toEqual([
      { id: "1", subject: "Cache threadId", status: "in_progress" },
      { id: "2", subject: "Fix transcript cache thrash", status: "pending" },
    ]);
    expect(snapshot?.changedTaskId).toBe("1");
    expect(snapshot?.complete).toBe(true);
  });

  test("applies a combined subject and status update", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Probe A");

    expect(
      registry.apply(
        "TaskUpdate",
        { taskId: "1", status: "completed", subject: "Probe A renamed" },
        "Updated task #1 subject, status",
      )?.items,
    ).toEqual([{ id: "1", subject: "Probe A renamed", status: "completed" }]);
  });

  test("removes deleted tasks from the list", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Keep me");
    create(registry, "2", "Delete me");

    const snapshot = registry.apply(
      "TaskUpdate",
      { taskId: "2", status: "deleted" },
      "Updated task #2 deleted",
    );

    expect(snapshot?.items).toEqual([{ id: "1", subject: "Keep me", status: "pending" }]);
    // The call still reports what it acted on even though the row is gone.
    expect(snapshot?.changedTaskId).toBe("2");
  });

  test("leaves the list untouched for a non-status update", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Probe A");

    expect(
      registry.apply(
        "TaskUpdate",
        { taskId: "1", owner: "probe-agent" },
        "Updated task #1 owner",
      )?.items,
    ).toEqual([{ id: "1", subject: "Probe A", status: "pending" }]);
  });

  test("resolves the task id from output alone when args omit it", () => {
    const registry = new TaskRegistry();
    create(registry, "4", "From output");

    // No trailing field list after the id — the id must still resolve.
    expect(registry.apply("TaskUpdate", {}, "Updated task #4")?.changedTaskId).toBe("4");
  });

  test("accepts a numeric task id and the snake_case arg spelling", () => {
    const registry = new TaskRegistry();
    create(registry, "5", "Numeric id");

    expect(
      registry.apply("TaskUpdate", { taskId: 5, status: "completed" }, "Updated task #5 status")
        ?.items,
    ).toEqual([{ id: "5", subject: "Numeric id", status: "completed" }]);

    expect(
      registry.apply("TaskUpdate", { task_id: "5", status: "pending" }, "Updated task #5 status")
        ?.items,
    ).toEqual([{ id: "5", subject: "Numeric id", status: "pending" }]);
  });

  test("orders the list by task id, not by when it was touched", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "One");
    create(registry, "2", "Two");
    create(registry, "10", "Ten");

    registry.apply("TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status");

    expect(registry.snapshot().items.map((task) => task.id)).toEqual(["1", "2", "10"]);
  });

  test("orders non-numeric ids deterministically after numeric ones", () => {
    const registry = new TaskRegistry();
    create(registry, "2", "Numeric");
    // Nothing validates the id in TaskUpdate args, so a non-numeric one must
    // not feed NaN to the comparator and scramble the order.
    registry.apply("TaskUpdate", { taskId: "beta", status: "pending" }, "Updated task beta");
    registry.apply("TaskUpdate", { taskId: "alpha", status: "pending" }, "Updated task alpha");

    expect(registry.snapshot().items.map((task) => task.id)).toEqual(["2", "alpha", "beta"]);
  });

  test("reconciles wholesale from TaskList, stripping owner and blocked suffixes", () => {
    const registry = new TaskRegistry();

    const snapshot = registry.apply(
      "TaskList",
      {},
      "#2 [completed] Probe A (probe-agent)\n#3 [pending] Probe B [blocked by #2]",
    );

    expect(snapshot?.items).toEqual([
      { id: "2", subject: "Probe A", status: "completed" },
      { id: "3", subject: "Probe B", status: "pending" },
    ]);
    // A listing reads; it changes nothing, so nothing is highlighted.
    expect(snapshot?.changedTaskId).toBeUndefined();
  });

  test("accepts a spaced or hyphenated status token in a list line", () => {
    const registry = new TaskRegistry();

    expect(
      registry.apply("TaskList", {}, "#1 [in progress] Spaced\n#2 [in-progress] Hyphenated")
        ?.items,
    ).toEqual([
      { id: "1", subject: "Spaced", status: "in_progress" },
      { id: "2", subject: "Hyphenated", status: "in_progress" },
    ]);
  });

  test("prefers the subject captured at creation over the decorated list line", () => {
    const registry = new TaskRegistry();
    // A subject that legitimately ends in a parenthetical is indistinguishable
    // from TaskList's owner suffix, so the created subject must win.
    create(registry, "1", "Fix parser (edge cases)");

    expect(registry.apply("TaskList", {}, "#1 [pending] Fix parser (edge cases)")?.items).toEqual(
      [{ id: "1", subject: "Fix parser (edge cases)", status: "pending" }],
    );
  });

  test("drops tasks that TaskList no longer reports", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Stale");
    create(registry, "2", "Live");

    expect(registry.apply("TaskList", {}, "#2 [pending] Live")?.items).toEqual([
      { id: "2", subject: "Live", status: "pending" },
    ]);
  });

  test("treats an empty TaskList as an empty list", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Gone");

    expect(registry.apply("TaskList", {}, "")?.items).toEqual([]);
  });

  test("treats a prose empty-list response as an empty list", () => {
    for (const output of [
      "No tasks found.",
      "no tasks",
      "There are no open tasks.",
      "Task list is empty",
      "(no tasks)",
    ]) {
      const registry = new TaskRegistry();
      create(registry, "1", "Should be cleared");

      const snapshot = registry.apply("TaskList", {}, output);
      expect(snapshot?.items, `cleared by: ${output}`).toEqual([]);
      expect(snapshot?.complete).toBe(true);
    }
  });

  test("reports no snapshot when TaskList output cannot be parsed", () => {
    const registry = new TaskRegistry();
    create(registry, "1", "Keep me");

    // Not "the list is empty" — "I have no idea what this is". The caller must
    // fall back to the raw output rather than render a list as fact.
    expect(registry.apply("TaskList", {}, "Something unexpected")).toBeUndefined();
    // ...and the state it already had survives untouched.
    expect(registry.snapshot().items).toEqual([
      { id: "1", subject: "Keep me", status: "pending" },
    ]);
  });

  test("reconciles a single task from TaskGet", () => {
    const registry = new TaskRegistry();
    create(registry, "3", "Probe B");

    const snapshot = registry.apply(
      "TaskGet",
      { taskId: "3" },
      "Task #3: Probe B\nStatus: in_progress\nDescription: Second probe task\nBlocked by: #2",
    );

    expect(snapshot?.items).toEqual([
      { id: "3", subject: "Probe B", status: "in_progress" },
    ]);
    // A read changes nothing, so no row is highlighted as changed.
    expect(snapshot?.changedTaskId).toBeUndefined();
  });

  test("falls back to the TaskGet arg id when the header does not parse", () => {
    const registry = new TaskRegistry();
    create(registry, "3", "Known subject");

    expect(
      registry.apply("TaskGet", { taskId: "3" }, "Status: completed")?.items,
    ).toEqual([{ id: "3", subject: "Known subject", status: "completed" }]);
  });

  test("reports no snapshot for a TaskGet that yields nothing usable", () => {
    const registry = new TaskRegistry();

    expect(registry.apply("TaskGet", { taskId: "9" }, "Task not found")).toBeUndefined();
    expect(registry.snapshot().items).toEqual([]);
  });

  describe("completeness", () => {
    test("a registry that saw the session from the start is complete", () => {
      const registry = new TaskRegistry();
      expect(registry.snapshot().complete).toBe(true);
      expect(create(registry, "1", "Seen created")?.complete).toBe(true);
    });

    test("an update for a task it never saw created marks the list incomplete", () => {
      // Happens when the registry starts watching a session that already has
      // tasks. Its view is missing whatever came before, so it must not claim
      // to be the whole list.
      const registry = new TaskRegistry();

      const snapshot = registry.apply(
        "TaskUpdate",
        { taskId: "7", status: "in_progress" },
        "Updated task #7 status",
      );

      expect(snapshot?.items).toEqual([
        { id: "7", subject: "Task #7", status: "in_progress" },
      ]);
      expect(snapshot?.complete).toBe(false);
    });

    test("a TaskGet for an unknown task marks the list incomplete", () => {
      const registry = new TaskRegistry();

      expect(
        registry.apply("TaskGet", { taskId: "7" }, "Status: pending")?.complete,
      ).toBe(false);
    });

    test("a later TaskList repairs both the subject and the completeness", () => {
      const registry = new TaskRegistry();
      registry.apply("TaskUpdate", { taskId: "7", status: "in_progress" }, "Updated task #7 status");

      const snapshot = registry.apply("TaskList", {}, "#7 [in_progress] Real subject");

      expect(snapshot?.items).toEqual([
        { id: "7", subject: "Real subject", status: "in_progress" },
      ]);
      expect(snapshot?.complete).toBe(true);
    });

    test("an update carrying its own subject does not mark the list incomplete", () => {
      // The subject came with the call, so nothing was synthesized — but the
      // list can still be missing earlier tasks, so this stays conservative
      // only about what it actually knows.
      const registry = new TaskRegistry();

      expect(
        registry.apply(
          "TaskUpdate",
          { taskId: "7", subject: "Named by the call", status: "pending" },
          "Updated task #7 subject, status",
        )?.complete,
      ).toBe(true);
    });
  });

  describe("size cap", () => {
    test("caps the list and reports how many were dropped", () => {
      const registry = new TaskRegistry();
      const overflow = 3;
      for (let i = 1; i <= MAX_SNAPSHOT_ITEMS + overflow; i++) {
        create(registry, String(i), `Task ${i}`);
      }

      const snapshot = registry.snapshot();
      expect(snapshot.items).toHaveLength(MAX_SNAPSHOT_ITEMS);
      expect(snapshot.truncated).toBe(overflow);
      // The cap keeps the lowest ids, so the list still reads in order.
      expect(snapshot.items[0]?.id).toBe("1");
    });

    test("omits the truncation marker when nothing was dropped", () => {
      const registry = new TaskRegistry();
      create(registry, "1", "Only one");

      expect(registry.snapshot().truncated).toBeUndefined();
    });
  });

  describe("idempotency", () => {
    test("replaying the same calls converges on the same list", () => {
      // Both backends can see a tool result more than once — the bridge when a
      // message is re-parsed, the tmux tail when a full transcript read
      // overlaps lines already streamed.
      const once = new TaskRegistry();
      const twice = new TaskRegistry();

      for (const registry of [once, twice, twice]) {
        create(registry, "1", "Alpha");
        create(registry, "2", "Beta");
        registry.apply("TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status");
      }

      expect(twice.snapshot()).toEqual(once.snapshot());
    });
  });

  test("ignores tools it does not model", () => {
    const registry = new TaskRegistry();
    expect(registry.apply("Read", { file_path: "/tmp/x" }, "contents")).toBeUndefined();
    expect(registry.apply("TodoWrite", {}, "ok")).toBeUndefined();
    expect(registry.apply("Task", {}, "subagent output")).toBeUndefined();
    expect(registry.apply(undefined, undefined, undefined)).toBeUndefined();
  });

  test("reports no snapshot for unparseable create output rather than inventing a task", () => {
    const registry = new TaskRegistry();

    // Without an id there is nothing an update could ever refer to, so the
    // caller must show the call itself instead of an empty list.
    expect(registry.apply("TaskCreate", { subject: "X" }, "some error text")).toBeUndefined();
    expect(registry.snapshot().items).toEqual([]);
  });

  test("reports no snapshot for an update with no resolvable id", () => {
    const registry = new TaskRegistry();
    expect(registry.apply("TaskUpdate", {}, "Nothing to see here")).toBeUndefined();
  });

  test("accepts snake_case tool names", () => {
    const registry = new TaskRegistry();
    expect(
      registry.apply("task_create", { subject: "Snake" }, "Task #1 created successfully: Snake")
        ?.items,
    ).toEqual([{ id: "1", subject: "Snake", status: "pending" }]);
  });

  test("snapshot copies do not alias registry state", () => {
    const registry = new TaskRegistry();
    const first = create(registry, "1", "Original")!;
    create(registry, "2", "Second");

    // The snapshot stamped onto an earlier part must keep showing the list as
    // it stood then, not follow later mutations.
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.subject).toBe("Original");
  });
});

describe("taskToolKind", () => {
  test("classifies each task tool in both casings and spellings", () => {
    expect(taskToolKind("TaskCreate")).toBe("create");
    expect(taskToolKind("task_create")).toBe("create");
    expect(taskToolKind("taskupdate")).toBe("update");
    expect(taskToolKind("TaskGet")).toBe("get");
    expect(taskToolKind("task_list")).toBe("list");
    expect(taskToolKind(" TaskList ")).toBe("list");
  });

  test("returns undefined for anything else", () => {
    for (const name of ["Task", "TodoWrite", "Read", "", undefined]) {
      expect(taskToolKind(name)).toBeUndefined();
    }
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
