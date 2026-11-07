/**
 * How the window's sidebar groups machines' projects, and what that decides
 * for another node's workspace: whether its coordinator defers to the
 * command node's, and which tab one of its projects opens on.
 */

import type { WorkspaceBoardTab } from "./workspace-request";

/** How the window's sidebar groups machines' projects. */
export type WindowGrouping = "machine" | "project" | "repository" | "activity";

/**
 * The grouping a node's workspace follows. Compact links a repository's
 * projects across machines as repository grouping does, so it counts as
 * that; the phone layout's drawer is a full list, which sorts by activity
 * when the stored sort mode says so.
 */
export function windowGroupingFor(
  sortMode: "project" | "activity",
  grouping: Exclude<WindowGrouping, "activity"> | "compact",
  phoneLayout = false,
): WindowGrouping {
  if (grouping === "compact")
    return phoneLayout && sortMode === "activity" ? "activity" : "repository";
  return sortMode === "activity" ? "activity" : grouping;
}

/**
 * Whether another node's coordinator defers to the command node's. Grouped by
 * repository, the window links each repository's projects across machines,
 * so coordination for it runs on the command node where it can. Grouped by
 * machine, project or activity the machines are not linked, and a node's own
 * coordinator opens directly.
 */
export function coordinatorDefersToCommandNode(grouping: WindowGrouping): boolean {
  return grouping === "repository";
}

/**
 * The tab a project opens on from its entry in the window's sidebar. The
 * command node's projects open on their coordinator. Another node's open on
 * its own coordinator too, except where that coordinator defers to the
 * command node's (grouped by repository): there they open on their home.
 */
export function projectLandingTab(
  grouping: WindowGrouping,
  onCommandNode: boolean,
): "home" | "coordinator" {
  return !onCommandNode && coordinatorDefersToCommandNode(grouping) ? "home" : "coordinator";
}

/**
 * What a sidebar project entry asks the node to show, as board navigation:
 * the coordinator where it lands there, nothing where it lands on the home,
 * which is where another node's workspace opens a project by default.
 */
export function projectLandingBoardTab(
  grouping: WindowGrouping,
  onCommandNode: boolean,
): WorkspaceBoardTab | undefined {
  return projectLandingTab(grouping, onCommandNode) === "coordinator" ? "coordinator" : undefined;
}
