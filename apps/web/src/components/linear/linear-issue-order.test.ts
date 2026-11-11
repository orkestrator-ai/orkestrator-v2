import { describe, expect, test } from "bun:test";
import type { LinearIssueListItem } from "@/types/linear";
import { buildLinearLanes } from "./linear-issue-order";

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
