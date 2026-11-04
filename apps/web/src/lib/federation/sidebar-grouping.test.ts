import { describe, expect, test } from "bun:test";
import {
  nextSidebarView,
  sidebarGroupingOptions,
  sidebarViewForChoice,
  SIDEBAR_GROUPING_ORDER,
  type SidebarViewState,
  type StoredSidebarGrouping,
} from "./sidebar-grouping";

const EVERYTHING = { mergedModes: true, compact: true };

function state(
  grouping: StoredSidebarGrouping,
  overrides: Partial<SidebarViewState> = {},
): SidebarViewState {
  return { grouping, groupingBeforeCompact: "machine", sortMode: "project", ...overrides };
}

/** Every stop the shortcut makes from `start` until it returns there. */
function walk(start: SidebarViewState, availability = EVERYTHING): string[] {
  const stops: string[] = [];
  let current = start;
  for (let press = 0; press < 8; press++) {
    const next = nextSidebarView(current, availability);
    if (!next) break;
    stops.push(next.sortMode === "activity" ? `activity/${next.grouping}` : next.grouping);
    current = {
      ...current,
      ...next,
      groupingBeforeCompact:
        next.grouping === "compact" ? current.groupingBeforeCompact : next.grouping,
    };
    if (current.grouping === start.grouping && current.sortMode === start.sortMode) break;
  }
  return stops;
}

describe("the rotation", () => {
  test("is the menu's modes in menu order, then compact, then back to the start", () => {
    expect(SIDEBAR_GROUPING_ORDER).toEqual(["machine", "project", "repository", "compact"]);
    expect(walk(state("machine"))).toEqual(["project", "repository", "compact", "machine"]);
  });

  test("starts from wherever the sidebar is", () => {
    expect(nextSidebarView(state("repository"), EVERYTHING)).toEqual({
      grouping: "compact",
      sortMode: "project",
    });
    expect(nextSidebarView(state("compact"), EVERYTHING)).toEqual({
      grouping: "machine",
      sortMode: "project",
    });
  });

  test("skips the merged modes while no other machine is shown", () => {
    const availability = { mergedModes: false, compact: true };
    expect(walk(state("machine"), availability)).toEqual(["compact", "machine"]);
    // A choice stored while other machines were shown still moves on.
    expect(nextSidebarView(state("repository"), availability)?.grouping).toBe("compact");
  });

  test("skips compact in the phone layout, and leaves it if it was stored", () => {
    const availability = { mergedModes: true, compact: false };
    expect(walk(state("machine"), availability)).toEqual(["project", "repository", "machine"]);
    expect(nextSidebarView(state("compact"), availability)?.grouping).toBe("machine");
  });

  test("has nowhere to go when only one mode is available", () => {
    expect(nextSidebarView(state("machine"), { mergedModes: false, compact: false })).toBeNull();
  });

  test("sorted by activity it stops only at compact and the activity list, keeping both", () => {
    const sorted = state("repository", { sortMode: "activity" });
    expect(nextSidebarView(sorted, EVERYTHING)).toEqual({
      grouping: "compact",
      sortMode: "activity",
    });
    expect(
      nextSidebarView(
        state("compact", { sortMode: "activity", groupingBeforeCompact: "repository" }),
        EVERYTHING,
      ),
    ).toEqual({ grouping: "repository", sortMode: "activity" });
    expect(nextSidebarView(sorted, { mergedModes: true, compact: false })).toBeNull();
  });
});

describe("the menu's options", () => {
  const values = (input: Parameters<typeof sidebarGroupingOptions>[0]) =>
    sidebarGroupingOptions(input).map((option) => option.value);

  test("a window naming machines offers its modes and compact", () => {
    expect(values({ federated: true, sortMode: "project", compact: false })).toEqual([
      "machine",
      "project",
      "repository",
      "compact",
    ]);
  });

  test("a window naming no machines offers the full list and compact", () => {
    expect(
      sidebarGroupingOptions({ federated: false, sortMode: "project", compact: false }),
    ).toEqual([
      { value: "machine", label: "Full list" },
      { value: "compact", label: "Compact" },
    ]);
  });

  test("sorted by activity only compact can be chosen", () => {
    expect(values({ federated: true, sortMode: "activity", compact: false })).toEqual(["compact"]);
  });

  test("compact's own menu can reach every list, so it can be left with a mouse", () => {
    expect(values({ federated: true, sortMode: "activity", compact: true })).toEqual([
      "machine",
      "project",
      "repository",
      "activity",
      "compact",
    ]);
    expect(values({ federated: false, sortMode: "project", compact: true })).toEqual([
      "machine",
      "activity",
      "compact",
    ]);
  });
});

describe("a menu choice", () => {
  test("compact keeps the sort, so leaving it can return there", () => {
    expect(sidebarViewForChoice("compact", state("machine", { sortMode: "activity" }))).toEqual({
      grouping: "compact",
      sortMode: "activity",
    });
  });

  test("a grouping shows that grouping, whatever the sort was", () => {
    expect(sidebarViewForChoice("repository", state("compact", { sortMode: "activity" }))).toEqual({
      grouping: "repository",
      sortMode: "project",
    });
  });

  test("the activity list restores the grouping compact replaced", () => {
    expect(
      sidebarViewForChoice("activity", state("compact", { groupingBeforeCompact: "project" })),
    ).toEqual({ grouping: "project", sortMode: "activity" });
  });

  test("ignores anything the menu does not offer", () => {
    expect(sidebarViewForChoice("nonsense", state("machine"))).toBeNull();
  });
});
