/**
 * How the window's sidebar lists machines' projects, and what that decides
 * for another node's workspace: whether its coordinator defers to the
 * command node's, and which tab one of its projects opens on.
 */

import type { WorkspaceBoardTab } from "./workspace-request";

/**
 * How the window's sidebar lists machines' projects. The repository list
 * (and compact, which shows the same repositories) links each repository's
 * projects across machines; the activity list does not. Earlier builds also
 * had "machine" and "project" groupings, which are now the repository list.
 */
export type WindowGrouping = "repository" | "activity";

/**
 * The grouping a node's workspace follows. Compact counts as the repository
 * list; the phone layout's drawer is a full list, which sorts by activity
 * when the stored sort mode says so.
 */
export function windowGroupingFor(
  sortMode: "project" | "activity",
  grouping: "repository" | "compact",
  phoneLayout = false,
): WindowGrouping {
  if (grouping === "compact")
    return phoneLayout && sortMode === "activity" ? "activity" : "repository";
  return sortMode === "activity" ? "activity" : "repository";
}

/**
 * Whether another node's coordinator defers to the command node's. The
 * repository list links each repository's projects across machines, so
 * coordination for it runs on the command node where it can. Sorted by
 * activity the machines are not linked, and a node's own coordinator opens
 * directly.
 */
export function coordinatorDefersToCommandNode(grouping: WindowGrouping): boolean {
  return grouping === "repository";
}

/**
 * The tab a project opens on from its entry in the window's sidebar. The
 * command node's projects open on their coordinator. Another node's open on
 * its own coordinator too, except where that coordinator defers to the
 * command node's (the repository list): there they open on their home.
 */
export function projectLandingTab(
  grouping: WindowGrouping,
  onCommandNode: boolean,
  commandHasCopy = true,
): "home" | "coordinator" {
  return !onCommandNode && commandHasCopy && coordinatorDefersToCommandNode(grouping)
    ? "home"
    : "coordinator";
}

/**
 * The landing tab a sidebar project entry asks the node for
 * (`WorkspaceRequest.landingTab`), used only by a project with no last tab of
 * its own: the coordinator where it lands there, nothing where it lands on the
 * home, which is where another node's workspace opens a project by default.
 */
export function projectLandingBoardTab(
  grouping: WindowGrouping,
  onCommandNode: boolean,
  commandHasCopy = true,
): WorkspaceBoardTab | undefined {
  return projectLandingTab(grouping, onCommandNode, commandHasCopy) === "coordinator"
    ? "coordinator"
    : undefined;
}
