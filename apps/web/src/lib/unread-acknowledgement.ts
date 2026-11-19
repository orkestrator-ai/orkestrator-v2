import { createSessionKey } from "@/lib/utils";
import type { EnvironmentPaneState, PaneLayoutHydrationStatus } from "@/stores/paneLayoutStore";
import { getAllLeaves } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";

/**
 * What showing an environment acknowledges of its unread work.
 *
 * - `environment`: the badge belongs to the environment as a whole (no
 *   attributed sessions), so seeing the environment acknowledges all of it.
 * - `sessions`: these attributed sessions are on screen (or have no tab
 *   that could show them); `remaining` are the ones still unseen.
 * - `none`: every attributed session has a tab here and none is on screen.
 * - `pending`: the environment's tabs are not known yet.
 */
export type UnreadAcknowledgement =
  | { kind: "environment" }
  | { kind: "sessions"; sessionKeys: string[]; remaining: string[] }
  | { kind: "none" }
  | { kind: "pending" };

/**
 * Tabs currently rendered in an environment: each pane's selected tab, and
 * an agent tab embedded in a selected design canvas whose agent panel shows.
 */
function onScreenTabIds(layout: EnvironmentPaneState): Set<string> {
  const visible = new Set<string>();
  for (const leaf of getAllLeaves(layout.root)) {
    const active = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
    if (!active) continue;
    visible.add(active.id);
    if (active.designCanvasData?.agentPanel?.open === false) continue;
    for (const tab of leaf.tabs) {
      if (tab.embeddedIn === active.id) visible.add(tab.id);
    }
  }
  return visible;
}

/**
 * Decides which unread results an environment on screen has shown.
 *
 * An attributed session is acknowledged when one of its tabs is on screen.
 * A session with no tab in this layout at all (a closed tab, a pipeline
 * worker, a session another surface owns) cannot be shown by any tab, so
 * seeing the environment acknowledges it, as for an unattributed badge.
 */
export function unreadAcknowledgement(
  environment: Pick<Environment, "id" | "unreadSessionKeys">,
  layout: EnvironmentPaneState | undefined,
  hydration: PaneLayoutHydrationStatus | undefined,
): UnreadAcknowledgement {
  const keys = (environment.unreadSessionKeys ?? []).filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
  if (keys.length === 0) return { kind: "environment" };
  if (!layout || hydration === "pending") return { kind: "pending" };

  const visibleTabIds = onScreenTabIds(layout);
  const tabSessionKeys = new Set<string>();
  const visibleSessionKeys = new Set<string>();
  for (const leaf of getAllLeaves(layout.root)) {
    for (const tab of leaf.tabs) {
      const key = createSessionKey(environment.id, tab.id);
      tabSessionKeys.add(key);
      if (visibleTabIds.has(tab.id)) visibleSessionKeys.add(key);
    }
  }
  const sessionKeys = keys.filter((key) => visibleSessionKeys.has(key) || !tabSessionKeys.has(key));
  if (sessionKeys.length === 0) return { kind: "none" };
  const acknowledged = new Set(sessionKeys);
  return {
    kind: "sessions",
    sessionKeys,
    remaining: keys.filter((key) => !acknowledged.has(key)),
  };
}
