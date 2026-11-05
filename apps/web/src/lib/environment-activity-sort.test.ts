import { describe, expect, test } from "bun:test";
import type { Environment, Project } from "@/types";
import { displayedActivityResolver, sortEnvironmentsByActivity } from "./environment-activity-sort";

const project: Project = {
  id: "p",
  name: "App",
  gitUrl: "https://github.com/acme/app.git",
  localPath: null,
  addedAt: "2026-10-21T00:00:00Z",
  order: 0,
};

function environment(id: string, overrides: Partial<Environment> = {}): Environment {
  return {
    id,
    projectId: "p",
    name: id,
    branch: id,
    containerId: null,
    environmentType: "local",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-10-21T00:00:00Z",
    networkAccessMode: "restricted",
    order: 0,
    agentActivityState: "idle",
    agentActivityUpdatedAt: "2026-10-21T08:00:00Z",
    ...overrides,
  };
}

describe("sortEnvironmentsByActivity", () => {
  test("priority follows the activity each row displays, not the raw persisted state", () => {
    const newest = environment("newest", { lastActivityAt: "2026-10-21T12:00:00Z" });
    const building = environment("building", { lastActivityAt: "2026-10-21T10:00:00Z" });
    const runtimeWaiting = environment("runtime-waiting", {
      lastActivityAt: "2026-10-21T09:00:00Z",
    });

    // Persisted states alone: all idle, so newest activity first.
    expect(
      sortEnvironmentsByActivity([building, runtimeWaiting, newest], [project]).map(({ id }) => id),
    ).toEqual(["newest", "building", "runtime-waiting"]);

    // The row for an active build shows working, and a fresher runtime
    // observation shows waiting: the sort agrees with what the rows show.
    const displayed = displayedActivityResolver(
      { "runtime-waiting": "waiting" },
      { "runtime-waiting": "2026-10-21T09:30:00Z" },
      new Set(["building"]),
    );
    expect(
      sortEnvironmentsByActivity(
        [building, runtimeWaiting, newest],
        [project],
        "priority",
        displayed,
      ).map(({ id }) => id),
    ).toEqual(["runtime-waiting", "newest", "building"]);

    // Chronological orders read no other state, but a working row still sinks.
    expect(
      sortEnvironmentsByActivity(
        [building, runtimeWaiting, newest],
        [project],
        "newest",
        displayed,
      ).map(({ id }) => id),
    ).toEqual(["newest", "runtime-waiting", "building"]);
  });

  test("puts merged environments below unmerged ones in every order", () => {
    const rows = [
      environment("merged-new", { prState: "merged", lastActivityAt: "2026-10-21T12:00:00Z" }),
      environment("merged-old", { prState: "merged", lastActivityAt: "2026-10-21T09:00:00Z" }),
      environment("open", { prState: "open", lastActivityAt: "2026-10-21T11:00:00Z" }),
      environment("no-pr", { lastActivityAt: "2026-10-21T10:00:00Z" }),
    ];
    const ids = (order: "priority" | "newest" | "oldest") =>
      sortEnvironmentsByActivity(rows, [project], order).map(({ id }) => id);
    expect(ids("priority")).toEqual(["open", "no-pr", "merged-new", "merged-old"]);
    expect(ids("newest")).toEqual(["open", "no-pr", "merged-new", "merged-old"]);
    expect(ids("oldest")).toEqual(["no-pr", "open", "merged-old", "merged-new"]);
  });

  test("keeps the sidebar order for undated rows in oldest order without NaN comparisons", () => {
    const rows = [
      environment("dated", { lastActivityAt: "2026-10-21T10:00:00Z" }),
      environment("b", { order: 1 }),
      environment("a", { order: 0 }),
    ];
    expect(sortEnvironmentsByActivity(rows, [project], "oldest").map(({ id }) => id)).toEqual([
      "a",
      "b",
      "dated",
    ]);
  });
});
