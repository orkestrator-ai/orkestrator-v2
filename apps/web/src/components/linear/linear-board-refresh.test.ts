import { afterEach, describe, expect, mock, test } from "bun:test";
import { appCommandScope } from "@/lib/node-scope-slots";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { LinearIssueListItem } from "@/types/linear";
import {
  LINEAR_BOARD_SNAPSHOT_LIMIT,
  LINEAR_FOCUS_REFRESH_INTERVAL_MS,
  forgetLinearBoardSnapshot,
  isNodeShown,
  readLinearBoardSnapshot,
  reconcileByKey,
  rememberLinearBoardSnapshot,
  type LinearBoardSnapshot,
  watchLinearBoardReturns,
} from "./linear-board-refresh";

function issue(id: string, fields: Partial<LinearIssueListItem> = {}): LinearIssueListItem {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Issue ${id}`,
    status: "Todo",
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...fields,
  };
}

function snapshotWith(issues: LinearIssueListItem[]): LinearBoardSnapshot {
  return {
    connection: { connected: true, hasToken: true },
    boardLink: null,
    boardState: "unsupported",
    issues,
    boardStates: [],
  };
}

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  forgetLinearBoardSnapshot(appCommandScope());
  getWindowScope().select(null);
});

describe("reconcileByKey", () => {
  test("keeps the shown array when nothing changed", () => {
    const shown = [issue("a"), issue("b")];
    const next = shown.map((item) => ({ ...item }));
    expect(reconcileByKey(shown, next, (item) => item.id)).toBe(shown);
  });

  test("replaces only the changed ticket and keeps the others' objects", () => {
    const shown = [issue("a"), issue("b")];
    const relabelled = issue("b", { issueLabels: [{ id: "l1", name: "merged" }] });
    const merged = reconcileByKey(shown, [{ ...shown[0]! }, relabelled], (item) => item.id);
    expect(merged).not.toBe(shown);
    expect(merged[0]).toBe(shown[0]!);
    expect(merged[1]).toBe(relabelled);
  });

  test("follows the new order, additions and removals", () => {
    const shown = [issue("a"), issue("b"), issue("c")];
    const added = issue("d");
    const merged = reconcileByKey(
      shown,
      [{ ...shown[2]! }, added, { ...shown[0]! }],
      (item) => item.id,
    );
    expect(merged.map((item) => item.id)).toEqual(["c", "d", "a"]);
    expect(merged[0]).toBe(shown[2]!);
    expect(merged[2]).toBe(shown[0]!);
  });
});

describe("board snapshots", () => {
  test("remembers per project and forgets on request", () => {
    const scope = appCommandScope();
    rememberLinearBoardSnapshot(scope, "p1", snapshotWith([issue("a")]));
    expect(readLinearBoardSnapshot(scope, "p1")?.issues.map((item) => item.id)).toEqual(["a"]);
    expect(readLinearBoardSnapshot(scope, "p2")).toBeUndefined();
    forgetLinearBoardSnapshot(scope, "p1");
    expect(readLinearBoardSnapshot(scope, "p1")).toBeUndefined();
  });

  test("keeps at most the limit, dropping the least recently remembered project", () => {
    const scope = appCommandScope();
    for (let index = 0; index <= LINEAR_BOARD_SNAPSHOT_LIMIT; index += 1) {
      rememberLinearBoardSnapshot(scope, `p${index}`, snapshotWith([]));
      // Touching p0 again keeps it the newest, so p1 goes first instead.
      if (index === 1) rememberLinearBoardSnapshot(scope, "p0", snapshotWith([]));
    }
    expect(readLinearBoardSnapshot(scope, "p0")).toBeDefined();
    expect(readLinearBoardSnapshot(scope, "p1")).toBeUndefined();
    expect(readLinearBoardSnapshot(scope, `p${LINEAR_BOARD_SNAPSHOT_LIMIT}`)).toBeDefined();
  });
});

describe("watchLinearBoardReturns", () => {
  const otherNode = "bk_other-node" as BackendId;

  test("refreshes when the node is shown again after another node was", () => {
    const scope = appCommandScope();
    const windowScope = getWindowScope();
    const refresh = mock(() => {});
    stops.push(watchLinearBoardReturns(scope, windowScope, refresh));
    expect(isNodeShown(scope, windowScope)).toBe(true);

    windowScope.select({ nodeId: otherNode, projectId: "p", environmentId: null });
    expect(isNodeShown(scope, windowScope)).toBe(false);
    expect(refresh).not.toHaveBeenCalled();

    windowScope.select({ nodeId: scope.nodeId, projectId: "p", environmentId: null });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Another selection on the same node is not a return.
    windowScope.select({ nodeId: scope.nodeId, projectId: "q", environmentId: null });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("refreshes on window focus at most once per interval, and not while hidden", () => {
    const scope = appCommandScope();
    const windowScope = getWindowScope();
    const refresh = mock(() => {});
    let clock = 1_000_000;
    stops.push(watchLinearBoardReturns(scope, windowScope, refresh, () => clock));

    // Focus right after the mount's own read is not another read.
    window.dispatchEvent(new Event("focus"));
    expect(refresh).not.toHaveBeenCalled();

    clock += LINEAR_FOCUS_REFRESH_INTERVAL_MS;
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);

    windowScope.select({ nodeId: otherNode, projectId: "p", environmentId: null });
    clock += LINEAR_FOCUS_REFRESH_INTERVAL_MS;
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("stops listening when stopped", () => {
    const scope = appCommandScope();
    const windowScope = getWindowScope();
    const refresh = mock(() => {});
    let clock = 0;
    const stop = watchLinearBoardReturns(scope, windowScope, refresh, () => clock);
    stop();
    clock += LINEAR_FOCUS_REFRESH_INTERVAL_MS;
    window.dispatchEvent(new Event("focus"));
    windowScope.select({ nodeId: otherNode, projectId: "p", environmentId: null });
    windowScope.select(null);
    expect(refresh).not.toHaveBeenCalled();
  });
});
