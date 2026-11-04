/**
 * The sidebar's group-by modes: which ones the menu offers and the order the
 * rotate shortcut walks them in. Everything here is pure.
 *
 * Sorting by activity replaces the groupings without erasing them, so it is
 * kept separate from the stored grouping. Compact is the one mode it does not
 * replace: compact lists no environments for it to sort.
 */

import type { SidebarGrouping } from "./aggregate";

export type StoredSidebarGrouping = Exclude<SidebarGrouping, "activity">;
export type SidebarSortMode = "project" | "activity";

/** The fixed rotation: the menu's existing modes in menu order, then compact. */
export const SIDEBAR_GROUPING_ORDER: readonly StoredSidebarGrouping[] = [
  "machine",
  "project",
  "repository",
  "compact",
];

export interface SidebarView {
  grouping: StoredSidebarGrouping;
  sortMode: SidebarSortMode;
}

export interface SidebarViewState extends SidebarView {
  groupingBeforeCompact: Exclude<StoredSidebarGrouping, "compact">;
}

export interface SidebarGroupingAvailability {
  /** Other machines are shown, so "by project" and "by repository" change the list. */
  mergedModes: boolean;
  /** False in the phone layout, whose overlay sidebar stays a full list. */
  compact: boolean;
}

/** The view the rotate shortcut moves to, or null when there is nothing to rotate to. */
export function nextSidebarView(
  state: SidebarViewState,
  availability: SidebarGroupingAvailability,
): SidebarView | null {
  // Sorted by activity the groupings are not on screen, so the activity list
  // and compact are the only stops. The sort and grouping are kept for return.
  if (state.sortMode === "activity") {
    if (state.grouping === "compact") {
      return { grouping: state.groupingBeforeCompact, sortMode: "activity" };
    }
    return availability.compact ? { grouping: "compact", sortMode: "activity" } : null;
  }
  const available = (grouping: StoredSidebarGrouping) =>
    grouping === "machine" ||
    (grouping === "compact" ? availability.compact : availability.mergedModes);
  const start = SIDEBAR_GROUPING_ORDER.indexOf(state.grouping);
  for (let step = 1; step <= SIDEBAR_GROUPING_ORDER.length; step++) {
    const grouping = SIDEBAR_GROUPING_ORDER[(start + step) % SIDEBAR_GROUPING_ORDER.length]!;
    if (available(grouping)) {
      return grouping === state.grouping ? null : { grouping, sortMode: "project" };
    }
  }
  return null;
}

export type SidebarGroupingChoice = StoredSidebarGrouping | "activity";

export interface SidebarGroupingOption {
  value: SidebarGroupingChoice;
  label: string;
}

const COMPACT_OPTION: SidebarGroupingOption = { value: "compact", label: "Compact" };

/**
 * What the sort menu offers. In compact it is the only way out by mouse, and
 * compact's menu has no sort section, so it also offers the activity list.
 */
export function sidebarGroupingOptions(input: {
  federated: boolean;
  sortMode: SidebarSortMode;
  compact: boolean;
}): SidebarGroupingOption[] {
  if (!input.compact && input.sortMode === "activity") return [COMPACT_OPTION];
  const options: SidebarGroupingOption[] = input.federated
    ? [
        { value: "machine", label: "By machine" },
        { value: "project", label: "By project" },
        { value: "repository", label: "By repository" },
      ]
    : [{ value: "machine", label: "Full list" }];
  if (input.compact) options.push({ value: "activity", label: "By activity" });
  options.push(COMPACT_OPTION);
  return options;
}

/** The view a menu choice asks for, or null for a value the menu does not offer. */
export function sidebarViewForChoice(value: string, state: SidebarViewState): SidebarView | null {
  switch (value) {
    case "compact":
      return { grouping: "compact", sortMode: state.sortMode };
    case "activity":
      return {
        grouping: state.grouping === "compact" ? state.groupingBeforeCompact : state.grouping,
        sortMode: "activity",
      };
    case "machine":
    case "project":
    case "repository":
      return { grouping: value, sortMode: "project" };
    default:
      return null;
  }
}
