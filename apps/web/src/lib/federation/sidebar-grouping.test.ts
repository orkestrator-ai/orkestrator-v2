import { describe, expect, test } from "bun:test";
import {
  ENVIRONMENT_ORDERING_OPTIONS,
  isEnvironmentOrdering,
  nextSidebarView,
  sidebarGroupingOptions,
  sidebarViewForChoice,
} from "./sidebar-grouping";

describe("the rotation", () => {
  test("moves between the full list and compact, keeping the sort", () => {
    const available = { compact: true };
    expect(nextSidebarView({ grouping: "repository", sortMode: "project" }, available)).toEqual({
      grouping: "compact",
      sortMode: "project",
    });
    expect(nextSidebarView({ grouping: "compact", sortMode: "project" }, available)).toEqual({
      grouping: "repository",
      sortMode: "project",
    });
    // Leaving compact returns to the activity list when that was the sort.
    expect(nextSidebarView({ grouping: "compact", sortMode: "activity" }, available)).toEqual({
      grouping: "repository",
      sortMode: "activity",
    });
  });

  test("has nowhere to go in the phone layout, which has no compact", () => {
    expect(
      nextSidebarView({ grouping: "repository", sortMode: "project" }, { compact: false }),
    ).toBeNull();
  });
});

describe("the menu", () => {
  test("offers the full list and compact, and the activity list from compact", () => {
    expect(sidebarGroupingOptions({ sortMode: "project", compact: false })).toEqual([
      { value: "repository", label: "Full list" },
      { value: "compact", label: "Compact" },
    ]);
    expect(
      sidebarGroupingOptions({ sortMode: "project", compact: true }).map((o) => o.value),
    ).toEqual(["repository", "activity", "compact"]);
    // Sorted by activity the sort section is on screen, so only compact is added.
    expect(sidebarGroupingOptions({ sortMode: "activity", compact: false })).toEqual([
      { value: "compact", label: "Compact" },
    ]);
  });

  test("no longer offers by machine, by project or by repository grouping", () => {
    const labels = sidebarGroupingOptions({ sortMode: "project", compact: true }).map(
      (option) => option.label,
    );
    expect(labels).not.toContain("By machine");
    expect(labels).not.toContain("By project");
    expect(labels).not.toContain("By repository");
  });

  test("maps each choice to a view, and refuses the retired groupings", () => {
    const state = { grouping: "compact" as const, sortMode: "activity" as const };
    expect(sidebarViewForChoice("repository", state)).toEqual({
      grouping: "repository",
      sortMode: "project",
    });
    expect(sidebarViewForChoice("activity", state)).toEqual({
      grouping: "repository",
      sortMode: "activity",
    });
    expect(sidebarViewForChoice("compact", { ...state, sortMode: "project" })).toEqual({
      grouping: "compact",
      sortMode: "project",
    });
    for (const retired of ["machine", "project", "nonsense"]) {
      expect(sidebarViewForChoice(retired, state)).toBeNull();
    }
  });

  test("orders environments by machine (the default) or by hand", () => {
    expect(ENVIRONMENT_ORDERING_OPTIONS).toEqual([
      { value: "machine", label: "By machine" },
      { value: "manual", label: "Manual" },
    ]);
    expect(isEnvironmentOrdering("manual")).toBe(true);
    expect(isEnvironmentOrdering("project")).toBe(false);
  });
});
