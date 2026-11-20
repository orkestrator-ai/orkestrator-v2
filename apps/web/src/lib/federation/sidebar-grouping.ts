/**
 * The sidebar's views: which ones the menu offers, the order the rotate
 * shortcut walks them in, and the environment orderings of the repository
 * list. Everything here is pure.
 *
 * There is one full list (EL01: each repository with its environments across
 * machines) and compact. Sorting by activity replaces the full list without
 * erasing the choice, so it is kept separate from the stored view. Compact is
 * the one view it does not replace: compact lists no environments for it to
 * sort.
 */

import type { SidebarGrouping } from "./aggregate";
import type { EnvironmentOrdering } from "./environment-list";

export type StoredSidebarGrouping = Exclude<SidebarGrouping, "activity">;
export type SidebarSortMode = "project" | "activity";

export interface SidebarView {
  grouping: StoredSidebarGrouping;
  sortMode: SidebarSortMode;
}

export interface SidebarGroupingAvailability {
  /** False in the phone layout, whose overlay sidebar stays a full list. */
  compact: boolean;
}

/**
 * The view the rotate shortcut moves to: the full list and compact in turn,
 * keeping the sort, or null when compact is unavailable.
 */
export function nextSidebarView(
  state: SidebarView,
  availability: SidebarGroupingAvailability,
): SidebarView | null {
  if (!availability.compact) return null;
  return {
    grouping: state.grouping === "compact" ? "repository" : "compact",
    sortMode: state.sortMode,
  };
}

export type SidebarGroupingChoice = StoredSidebarGrouping | "activity";

export interface SidebarGroupingOption {
  value: SidebarGroupingChoice;
  label: string;
}

const COMPACT_OPTION: SidebarGroupingOption = { value: "compact", label: "Compact" };

/**
 * What the menu's "Sidebar view" section offers. In compact it is the only
 * way out by mouse, and compact's menu has no sort section, so it also offers
 * the activity list.
 */
export function sidebarGroupingOptions(input: {
  sortMode: SidebarSortMode;
  compact: boolean;
}): SidebarGroupingOption[] {
  if (!input.compact && input.sortMode === "activity") return [COMPACT_OPTION];
  const options: SidebarGroupingOption[] = [{ value: "repository", label: "Full list" }];
  if (input.compact) options.push({ value: "activity", label: "By activity" });
  options.push(COMPACT_OPTION);
  return options;
}

/** The view a menu choice asks for, or null for a value the menu does not offer. */
export function sidebarViewForChoice(value: string, state: SidebarView): SidebarView | null {
  switch (value) {
    case "compact":
      return { grouping: "compact", sortMode: state.sortMode };
    case "activity":
      return { grouping: "repository", sortMode: "activity" };
    case "repository":
      return { grouping: "repository", sortMode: "project" };
    default:
      return null;
  }
}

/** The menu's "Order environments" choices, By machine first (the default). */
export const ENVIRONMENT_ORDERING_OPTIONS: ReadonlyArray<{
  value: EnvironmentOrdering;
  label: string;
}> = [
  { value: "machine", label: "By machine" },
  { value: "manual", label: "Manual" },
];

export function isEnvironmentOrdering(value: string): value is EnvironmentOrdering {
  return value === "machine" || value === "manual";
}
