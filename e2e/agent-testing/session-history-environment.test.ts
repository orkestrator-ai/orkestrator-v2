import { expect, test } from "bun:test";
import { createHistoryEnvironment, type HistoryInvoke } from "./session-history-environment";

for (const failure of ["start_environment", "get_environment", "missing-worktree"]) {
  test(`cleans the created environment when ${failure} fails`, async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke: HistoryInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === failure) throw new Error(failure);
      // A failed stop must not prevent deletion or replace the original failure.
      if (command === "stop_environment") throw new Error("stop failed");
      return {
        id: "owned",
        ...(failure === "missing-worktree" ? {} : { worktreePath: "/fixture" }),
      } as T;
    };
    await expect(createHistoryEnvironment(invoke, "fixture", "history")).rejects.toThrow(
      failure === "missing-worktree" ? "no worktree" : failure,
    );
    expect(calls.slice(-2)).toEqual([
      ["stop_environment", { environmentId: "owned" }],
      ["delete_environment", { environmentId: "owned" }],
    ]);
  });
}

test("a successful start returns the environment without prematurely cleaning it", async () => {
  const calls: string[] = [];
  const invoke: HistoryInvoke = async <T>(command: string) => {
    calls.push(command);
    return { id: "owned", worktreePath: "/fixture" } as T;
  };
  expect(await createHistoryEnvironment(invoke, "fixture", "history")).toEqual({
    id: "owned",
    worktreePath: "/fixture",
  });
  expect(calls).toEqual(["create_environment", "start_environment", "get_environment"]);
});
