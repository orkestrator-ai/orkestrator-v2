import { describe, expect, test } from "bun:test";
import type { LinearIssueListItem } from "@/types/linear";
import { buildLinearLanes, planLinearDrop, type LinearLane } from "./linear-issue-order";

function issue(id: string, status: string, extra: Partial<LinearIssueListItem> = {}) {
  return {
    id,
    identifier: id.toUpperCase(),
    title: id,
    status,
    updatedAt: "2026-11-11T00:00:00.000Z",
    ...extra,
  } satisfies LinearIssueListItem;
}

describe("buildLinearLanes", () => {
  test("keeps every board state as a lane, empty ones too, in Linear's order", () => {
    const lanes = buildLinearLanes(
      [issue("a", "Todo", { statusType: "unstarted" })],
      [
        { id: "3", name: "Done", type: "completed", position: 3 },
        { id: "1", name: "Backlog", type: "backlog", position: 0 },
        { id: "2", name: "Todo", type: "unstarted", position: 1 },
        { id: "4", name: "In Review", type: "started", position: 2 },
      ],
      "manual",
    );
    expect(lanes.map((lane) => [lane.status, lane.issues.length])).toEqual([
      ["Backlog", 0],
      ["Todo", 1],
      ["In Review", 0],
      ["Done", 0],
    ]);
  });

  test("adds a lane for a state the board did not list", () => {
    const lanes = buildLinearLanes(
      [issue("a", "Triage", { statusType: "triage" })],
      [{ id: "1", name: "Todo", type: "unstarted" }],
      "manual",
    );
    expect(lanes.map((lane) => lane.status)).toEqual(["Triage", "Todo"]);
  });

  test("orders issues inside a lane by the chosen order, keeping Linear's order by default", () => {
    const issues = [
      issue("low", "Todo", { priority: 4, createdAt: "2026-01-02T00:00:00Z" }),
      issue("urgent", "Todo", { priority: 1, createdAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(buildLinearLanes(issues, [], "manual")[0]?.issues.map((i) => i.id)).toEqual([
      "low",
      "urgent",
    ]);
    expect(buildLinearLanes(issues, [], "priority")[0]?.issues.map((i) => i.id)).toEqual([
      "urgent",
      "low",
    ]);
    expect(buildLinearLanes(issues, [], "createdAt")[0]?.issues.map((i) => i.id)).toEqual([
      "low",
      "urgent",
    ]);
  });
});

describe("Linear board order", () => {
  test("sorts a lane by Linear's sortOrder, unordered issues last in arrival order", () => {
    const issues = [
      issue("late", "Todo"),
      issue("second", "Todo", { sortOrder: 5 }),
      issue("later", "Todo"),
      issue("first", "Todo", { sortOrder: -2.5 }),
    ];
    expect(buildLinearLanes(issues, [], "manual")[0]?.issues.map((i) => i.id)).toEqual([
      "first",
      "second",
      "late",
      "later",
    ]);
  });
});

describe("planLinearDrop", () => {
  const lane = (issues: ReturnType<typeof issue>[]): LinearLane => ({
    status: "Todo",
    stateId: "s-todo",
    issues,
  });
  const todo = lane([
    issue("a", "Todo", { sortOrder: 1 }),
    issue("b", "Todo", { sortOrder: 2 }),
    issue("c", "Todo", { sortOrder: 4 }),
  ]);
  const plan = (...args: Parameters<typeof planLinearDrop>) => {
    const result = planLinearDrop(...args);
    return result ? Object.fromEntries(result) : null;
  };
  const other = (id: string, sortOrder?: number) =>
    issue(id, "Done", sortOrder === undefined ? {} : { sortOrder });

  test("spreads dropped issues evenly between their new neighbours", () => {
    expect(
      plan(todo, [other("x"), other("y"), other("z")], { issueId: "c", before: true }),
    ).toEqual({ x: 2.5, y: 3, z: 3.5 });
  });

  test("steps one unit past the lane's first or last card", () => {
    expect(plan(todo, [other("x"), other("y")], { issueId: "a", before: true })).toEqual({
      x: -1,
      y: 0,
    });
    expect(plan(todo, [other("x"), other("y")], null)).toEqual({ x: 5, y: 6 });
  });

  test("leaves the dropped cards out of their own neighbours", () => {
    // `a` moves below `b`: its neighbours are `b` and `c`, not itself.
    expect(plan(todo, [todo.issues[0]!], { issueId: "b", before: false })).toEqual({ a: 3 });
  });

  test("a drop that changes nothing, or lands on a dropped card, plans nothing", () => {
    expect(plan(todo, [todo.issues[1]!], { issueId: "a", before: false })).toBeNull();
    expect(plan(todo, [todo.issues[2]!], null)).toBeNull();
    expect(plan(todo, [todo.issues[0]!], { issueId: "a", before: true })).toBeNull();
  });

  test("an empty lane receives fresh increasing positions in carried board order", () => {
    const dropped = [other("x", 20), other("y", 1)];
    const positions = planLinearDrop(lane([]), dropped, null)!;
    expect(Object.fromEntries(positions)).toEqual({ x: 1, y: 2 });
    const patched = dropped.map((item) => ({
      ...item,
      status: "Todo",
      sortOrder: positions.get(item.id),
    }));
    expect(buildLinearLanes(patched, [], "manual")[0]!.issues.map((item) => item.id)).toEqual([
      "x",
      "y",
    ]);
  });

  for (const orders of [
    [1, 1, 2],
    [1, 1 + Number.EPSILON, 2],
    [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    [undefined, undefined, undefined],
  ]) {
    test(`repairs unusable positions ${orders.join(",")} and preserves the final sequence`, () => {
      const items = orders.map((sortOrder, i) => issue(["a", "b", "c"][i]!, "Todo", { sortOrder }));
      const positions = planLinearDrop(lane(items), [items[2]!], { issueId: "b", before: true })!;
      const patched = items.map((item) => ({
        ...item,
        sortOrder: positions.get(item.id) ?? item.sortOrder,
      }));
      const ordered = buildLinearLanes(patched, [], "manual")[0]!.issues;
      expect(ordered.map((item) => item.id)).toEqual(["a", "c", "b"]);
      expect(
        ordered.every(
          (item, index) =>
            Number.isFinite(item.sortOrder) &&
            (index === 0 || item.sortOrder! > ordered[index - 1]!.sortOrder!),
        ),
      ).toBe(true);
    });
  }
});
