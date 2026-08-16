import { describe, expect, test } from "bun:test";

// Must precede every bridge import below: `acp-tools.js` pulls in
// `acp-context.js`, which resolves `ACP_PROVIDER` at module scope and throws
// without it. Keep this first.
import "./testing/unit-test-env.js";
import {
  MAX_WAIT_DIAGNOSTIC_BYTES,
  codedError,
  isRetryableWaitError,
  nativeFetch,
  unusedPort,
  waitFor,
} from "./acp-test-harness.js";
import {
  mergeCursorTodos,
  parseAcpPlanEntries,
  parseCursorTodos,
  restoreCursorTodosFromMessages,
  isAcpTodosToolName,
  preserveTaskLaunchArgs,
  MAX_CURSOR_TODOS,
  MAX_CURSOR_TODO_CANDIDATES,
} from "./acp-tools.js";


describe("waitFor", () => {
  test("retries ConnectionRefused until the read succeeds", async () => {
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts < 3) throw codedError("ConnectionRefused");
      return { ready: true };
    }, (current) => current.ready);
    expect(value).toEqual({ ready: true });
    expect(attempts).toBe(3);
  });

  test("retries ECONNREFUSED until the read succeeds", async () => {
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts < 2) throw codedError("ECONNREFUSED");
      return "up";
    }, (current) => current === "up");
    expect(value).toBe("up");
    expect(attempts).toBe(2);
  });

  test("retries a real Bun fetch connection failure until the read succeeds", async () => {
    const port = await unusedPort();
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts >= 3) return "recovered";
      // `unusedPort` releases the port before returning, so a parallel worker
      // could in principle bind it between then and now. Convert that into an
      // explicit non-retryable error, which `waitFor` rethrows on the spot and
      // names, instead of letting it surface as a bare `expect(1).toBe(3)`.
      // Reaching attempt 3 therefore also proves Bun's own error shape is what
      // `isRetryableWaitError` classifies as retryable.
      throw await nativeFetch(`http://127.0.0.1:${port}/health`).then(
        () => new Error(`Expected 127.0.0.1:${port} to refuse the connection, but it answered`),
        (reason: unknown) => reason,
      );
    }, (current) => current === "recovered");
    expect(value).toBe("recovered");
    expect(attempts).toBe(3);
  });

  test("polls until accept is satisfied and returns the accepted value", async () => {
    let reads = 0;
    const value = await waitFor(async () => {
      reads += 1;
      return { status: reads < 3 ? "running" : "idle" };
    }, (current) => current.status === "idle");
    expect(value).toEqual({ status: "idle" });
    expect(reads).toBe(3);
  });

  test("rethrows a non-retryable coded error on the first attempt", async () => {
    const error = codedError("EPERM");
    let attempts = 0;
    await expect(waitFor(async () => {
      attempts += 1;
      throw error;
    }, () => true)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("rethrows errors that have no code on the first attempt", async () => {
    const error = new Error("parse failed");
    let attempts = 0;
    await expect(waitFor(async () => {
      attempts += 1;
      throw error;
    }, () => true)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("rethrows non-object rejections on the first attempt", async () => {
    // `isRetryableWaitError` reads `error.code`, so a bare string that merely
    // *names* a retryable code — and a nullish rejection — must fail fast
    // rather than spin until the deadline.
    for (const rejection of ["ConnectionRefused", null]) {
      let attempts = 0;
      await expect(waitFor(async () => {
        attempts += 1;
        throw rejection;
      }, () => true)).rejects.toBe(rejection);
      expect(attempts).toBe(1);
    }
  });

  test("times out when ConnectionRefused never recovers and names the code", async () => {
    let attempts = 0;
    // 400 ms rather than a value just above the 20 ms poll interval: the
    // assertion below is about retrying, and one scheduler stall on a loaded
    // parallel run must not be able to consume the budget before attempt two.
    await expect(waitFor(async () => {
      attempts += 1;
      throw codedError("ConnectionRefused");
    }, () => true, 400)).rejects.toThrow(
      "Timed out waiting for ACP state: undefined (last error: ConnectionRefused)",
    );
    expect(attempts).toBeGreaterThan(1);
  });

  test("reports the last read value when accept is never satisfied", async () => {
    await expect(waitFor(
      async () => ({ status: "running" }),
      (current) => current.status === "idle",
      200,
    )).rejects.toThrow('Timed out waiting for ACP state: {"status":"running"}');
  });

  test("truncates an oversized diagnostic instead of logging the whole snapshot", async () => {
    const oversized = "x".repeat(MAX_WAIT_DIAGNOSTIC_BYTES * 2);
    const rejection = await waitFor(async () => oversized, () => false, 200)
      .then(() => null, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    const { message } = rejection as Error;
    expect(message).toContain("chars, truncated)");
    expect(message.length).toBeLessThan(oversized.length);
  });
});

describe("Cursor todo list helpers", () => {
  test("parses well-formed Cursor todos and drops malformed entries", () => {
    expect(parseCursorTodos([
      { id: "1", content: "Valid", status: "pending" },
      { id: "", content: "Missing id", status: "pending" },
      { id: "2", content: "Valid too", status: "done" },
      { id: "3", content: "Cancelled", status: "cancelled" },
      { content: "Plan entry", status: "in_progress", priority: "high" },
      null,
      "nope",
    ])).toEqual([
      { id: "1", content: "Valid", status: "pending" },
      { id: "2", content: "Missing id", status: "pending" },
      { id: "3", content: "Cancelled", status: "cancelled" },
      { id: "4", content: "Plan entry", status: "in_progress" },
    ]);
  });

  test("does not let a generated id overwrite an explicit neighbour", () => {
    expect(parseCursorTodos([
      { id: "2", content: "Explicit two", status: "pending" },
      { content: "No id", status: "pending" },
    ])).toEqual([
      { id: "2", content: "Explicit two", status: "pending" },
      { id: "1", content: "No id", status: "pending" },
    ]);
    expect(parseCursorTodos([
      { content: "No id first", status: "in_progress" },
      { id: "1", content: "Explicit one", status: "completed" },
    ])).toEqual([
      { id: "2", content: "No id first", status: "in_progress" },
      { id: "1", content: "Explicit one", status: "completed" },
    ]);
  });

  test("does not treat ACP tool kind plan as a todo tool", () => {
    expect(isAcpTodosToolName("plan")).toBe(false);
    expect(isAcpTodosToolName("todo_write")).toBe(true);
    expect(isAcpTodosToolName("todo_list")).toBe(true);
    expect(isAcpTodosToolName("updateTodos")).toBe(true);
  });

  test("parses ACP plan entries from v1 entries and v2 plan.entries", () => {
    const entries = [
      { content: "First", priority: "high", status: "completed" },
      { content: "Second", priority: "low", status: "pending" },
    ];
    expect(parseAcpPlanEntries({ entries })).toEqual([
      { id: "1", content: "First", status: "completed" },
      { id: "2", content: "Second", status: "pending" },
    ]);
    expect(parseAcpPlanEntries({ plan: { entries } })).toEqual([
      { id: "1", content: "First", status: "completed" },
      { id: "2", content: "Second", status: "pending" },
    ]);
    expect(parseAcpPlanEntries({ entries: [] })).toEqual([]);
    expect(parseAcpPlanEntries({ goal: "ship it" })).toBeUndefined();
  });

  test("merges by id, appends new items, and replaces when merge is false", () => {
    const current = [
      { id: "1", content: "First", status: "pending" as const },
      { id: "2", content: "Second", status: "in_progress" as const },
    ];
    expect(mergeCursorTodos(current, [
      { id: "2", content: "Second", status: "completed" },
      { id: "3", content: "Third", status: "pending" },
    ], true)).toEqual([
      { id: "1", content: "First", status: "pending" },
      { id: "2", content: "Second", status: "completed" },
      { id: "3", content: "Third", status: "pending" },
    ]);
    expect(mergeCursorTodos(current, [
      { id: "9", content: "Only", status: "pending" },
    ], false)).toEqual([
      { id: "9", content: "Only", status: "pending" },
    ]);
  });

  test("does not inherit merge: false onto a later todo list that omits merge", () => {
    expect(preserveTaskLaunchArgs(
      {
        merge: false,
        todos: [{ id: "1", content: "Plan item", status: "pending" }],
      },
      { todos: [{ id: "2", content: "Write item", status: "in_progress" }] },
    )).toEqual({
      todos: [{ id: "2", content: "Write item", status: "in_progress" }],
    });
    expect(preserveTaskLaunchArgs(
      {
        merge: true,
        todos: [{ id: "1", content: "Kept", status: "pending" }],
      },
      { _toolName: "updateTodos" },
    )).toEqual({
      _toolName: "updateTodos",
      merge: true,
      todos: [{ id: "1", content: "Kept", status: "pending" }],
    });
  });

  test("restores the newest stamped Cursor todo list from a transcript", () => {
    expect(restoreCursorTodosFromMessages([
      {
        id: "a",
        role: "assistant",
        content: "",
        createdAt: "2026-08-16T00:00:00.000Z",
        parts: [
          {
            type: "tool-invocation",
            content: "Update TODOs",
            sourcePartId: "tool:1",
            sourceMessageId: "a",
            toolUseId: "1",
            toolName: "updateTodos",
            toolArgs: {
              merge: false,
              todos: [{ id: "1", content: "Old", status: "pending" }],
            },
          },
        ],
      },
      {
        id: "b",
        role: "assistant",
        content: "",
        createdAt: "2026-08-16T00:00:01.000Z",
        parts: [
          {
            type: "tool-invocation",
            content: "Update TODOs",
            sourcePartId: "tool:2",
            sourceMessageId: "b",
            toolUseId: "2",
            toolName: "updateTodos",
            toolArgs: {
              merge: true,
              todos: [{ id: "1", content: "New", status: "completed" }],
            },
          },
        ],
      },
    ])).toEqual([{ id: "1", content: "New", status: "completed" }]);
  });

  test("ignores a non-todo tool part that happens to carry a todos argument", () => {
    expect(restoreCursorTodosFromMessages([
      {
        id: "a",
        role: "assistant",
        content: "",
        createdAt: "2026-08-16T00:00:00.000Z",
        parts: [
          {
            type: "tool-invocation",
            content: "Update TODOs",
            sourcePartId: "tool:1",
            sourceMessageId: "a",
            toolUseId: "1",
            toolName: "todo_write",
            toolArgs: {
              merge: true,
              todos: [{ id: "1", content: "Mine", status: "pending" }],
            },
          },
          {
            type: "tool-invocation",
            content: "Sync tasks",
            sourcePartId: "tool:2",
            sourceMessageId: "a",
            toolUseId: "2",
            toolName: "mcp__tracker__sync",
            toolArgs: {
              todos: [{ id: "9", content: "Someone else's list", status: "pending" }],
            },
          },
        ],
      },
    ])).toEqual([{ id: "1", content: "Mine", status: "pending" }]);
  });

  test("bounds both the parsed list and the candidate scan", () => {
    const oversized: Array<Record<string, unknown>> = Array.from(
      { length: MAX_CURSOR_TODO_CANDIDATES + 5 },
      (_, index) => ({ content: `Item ${index + 1}`, status: "pending" }),
    );
    // Reusing id "1" past the scan bound must never be reached: if it were,
    // it would reserve "1" and push every generated id along by one.
    oversized[oversized.length - 1] = {
      id: "1",
      content: "Beyond the candidate bound",
      status: "pending",
    };

    const parsed = parseCursorTodos(oversized);

    expect(parsed).toHaveLength(MAX_CURSOR_TODOS);
    expect(parsed[0]).toEqual({ id: "1", content: "Item 1", status: "pending" });
    expect(parsed.at(-1)).toEqual({
      id: String(MAX_CURSOR_TODOS),
      content: `Item ${MAX_CURSOR_TODOS}`,
      status: "pending",
    });
  });
});
