import { describe, expect, test } from "bun:test";
import {
  compareActivityTimestampsDesc,
  compareEnvironmentsByActivity,
  displayedEnvironmentActivity,
  type ActivityOrderFields,
  type ActivitySortOrder,
} from "./environment-activity-order.js";

type Row = ActivityOrderFields & { id: string };

const sortIds = (rows: Row[], order: ActivitySortOrder) =>
  [...rows]
    .sort((left, right) => compareEnvironmentsByActivity(left, right, order))
    .map(({ id }) => id);

describe("compareEnvironmentsByActivity", () => {
  test("priority: unread, then waiting and idle, newest first within each, then working", () => {
    const rows: Row[] = [
      { id: "idle-new", activity: "idle", lastActivityAt: "2026-07-23T10:00:00Z" },
      { id: "working", activity: "working", lastActivityAt: "2026-07-21T10:00:00Z" },
      { id: "waiting-old", activity: "waiting", lastActivityAt: "2026-07-19T10:00:00Z" },
      { id: "waiting-new", activity: "waiting", lastActivityAt: "2026-07-20T10:00:00Z" },
      { id: "unread", hasUnreadWork: true, lastActivityAt: "2026-07-18T10:00:00Z" },
      { id: "no-activity", lastActivityAt: "2026-07-24T10:00:00Z" },
    ];
    expect(sortIds(rows, "priority")).toEqual([
      "unread",
      "waiting-new",
      "waiting-old",
      "no-activity",
      "idle-new",
      "working",
    ]);
  });

  describe("groups every order keeps", () => {
    const rows: Row[] = [
      {
        id: "merged-unread",
        prState: "merged",
        hasUnreadWork: true,
        lastActivityAt: "2026-07-24T10:00:00Z",
      },
      {
        id: "merged-working",
        prState: "merged",
        activity: "working",
        lastActivityAt: "2026-07-25T10:00:00Z",
      },
      { id: "working-new", activity: "working", lastActivityAt: "2026-07-23T10:00:00Z" },
      {
        id: "working-unread",
        activity: "working",
        hasUnreadWork: true,
        lastActivityAt: "2026-07-22T10:00:00Z",
      },
      { id: "closed", prState: "closed", lastActivityAt: "2026-07-21T10:00:00Z" },
      { id: "open", prState: "open", activity: "waiting", lastActivityAt: "2026-07-20T10:00:00Z" },
      { id: "no-pr", lastActivityAt: "2026-07-19T10:00:00Z" },
    ];

    test("priority keeps unread and waiting at the top of their own group", () => {
      expect(sortIds(rows, "priority")).toEqual([
        "open",
        "closed",
        "no-pr",
        "working-unread",
        "working-new",
        "merged-unread",
        "merged-working",
      ]);
    });

    test("newest and oldest order by time alone within each group", () => {
      expect(sortIds(rows, "newest")).toEqual([
        "closed",
        "open",
        "no-pr",
        "working-new",
        "working-unread",
        "merged-unread",
        "merged-working",
      ]);
      expect(sortIds(rows, "oldest")).toEqual([
        "no-pr",
        "open",
        "closed",
        "working-unread",
        "working-new",
        "merged-unread",
        "merged-working",
      ]);
    });
  });

  test("priority recency prefers lastActivityAt over the snapshot time", () => {
    const rows: Row[] = [
      {
        id: "refreshed",
        activity: "working",
        lastActivityAt: "2026-10-21T10:00:00Z",
        activityUpdatedAt: "2026-10-21T15:00:00Z",
      },
      {
        id: "recent",
        activity: "working",
        lastActivityAt: "2026-10-21T12:00:00Z",
        activityUpdatedAt: "2026-10-21T09:00:00Z",
      },
      // An older remote summary without lastActivityAt still has an order.
      { id: "legacy", activity: "working", activityUpdatedAt: "2026-10-21T11:00:00Z" },
    ];
    expect(sortIds(rows, "priority")).toEqual(["recent", "legacy", "refreshed"]);
  });

  test("chronological orders use lastActivityAt within a group, undated rows last, then first", () => {
    const rows: Row[] = [
      { id: "old", activity: "waiting", lastActivityAt: "2026-07-20T10:00:00Z" },
      { id: "undated", hasUnreadWork: true, activityUpdatedAt: "2026-07-25T10:00:00Z" },
      { id: "new", activity: "idle", lastActivityAt: "2026-07-22T10:00:00Z" },
      { id: "invalid", lastActivityAt: "not-a-date" },
    ];
    expect(sortIds(rows, "newest")).toEqual(["new", "old", "undated", "invalid"]);
    expect(sortIds(rows, "oldest")).toEqual(["undated", "invalid", "old", "new"]);
  });

  test("ties compare as zero so callers can add their own stable fallback", () => {
    const left: Row = { id: "a", activity: "idle" };
    const right: Row = { id: "b", activity: "idle" };
    for (const order of ["priority", "newest", "oldest"] as const) {
      expect(compareEnvironmentsByActivity(left, right, order) === 0).toBe(true);
    }
  });
});

describe("compareActivityTimestampsDesc", () => {
  test("never returns NaN for undated pairs", () => {
    expect(compareActivityTimestampsDesc(undefined, null)).toBe(0);
    expect(compareActivityTimestampsDesc("bad", "")).toBe(0);
    expect(compareActivityTimestampsDesc("2026-01-01T00:00:00Z", undefined)).toBe(-1);
    expect(compareActivityTimestampsDesc(undefined, "2026-01-01T00:00:00Z")).toBe(1);
  });
});

describe("displayedEnvironmentActivity", () => {
  test("shows an active build as working and a missing state as idle", () => {
    expect(displayedEnvironmentActivity("idle", true)).toBe("working");
    expect(displayedEnvironmentActivity("waiting", true)).toBe("working");
    expect(displayedEnvironmentActivity("waiting", false)).toBe("waiting");
    expect(displayedEnvironmentActivity(undefined, false)).toBe("idle");
  });
});
