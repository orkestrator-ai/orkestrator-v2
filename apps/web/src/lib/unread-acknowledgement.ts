import { createSessionKey } from "@/lib/utils";
import { unreadResultActivityAt, type UnreadResultRead } from "@/lib/unread-result-view";
import { selectMobilePaneId } from "@/components/pane-layout/MobilePaneSwitcher";
import type { EnvironmentPaneState, PaneLayoutHydrationStatus } from "@/stores/paneLayoutStore";
import { getAllLeaves } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";

export type UnreadAcknowledgement =
  | { kind: "environment" }
  | { kind: "sessions"; sessionKeys: string[] }
  | { kind: "none" }
  | { kind: "pending" };

function onScreenTabIds(layout: EnvironmentPaneState, mobile: boolean): Set<string> {
  const visible = new Set<string>();
  const leaves = getAllLeaves(layout.root);
  const mobilePaneId = mobile ? selectMobilePaneId(leaves, layout.activePaneId) : undefined;
  for (const leaf of leaves) {
    if (mobilePaneId && leaf.id !== mobilePaneId) continue;
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

/** Match actual render receipts to the events still pending in the visible layout. */
export function unreadAcknowledgement(
  environment: Pick<
    Environment,
    | "id"
    | "unreadSessionKeys"
    | "unreadSessionEntries"
    | "unreadEnvironmentReason"
    | "unreadSessionOverflow"
    | "lastActivityAt"
  >,
  layout: EnvironmentPaneState | undefined,
  hydration: PaneLayoutHydrationStatus | undefined,
  mobile: boolean,
  rendered: ReadonlyMap<string, UnreadResultRead>,
): UnreadAcknowledgement {
  const keys = environment.unreadSessionKeys ?? [];
  if (keys.length === 0 && !environment.unreadSessionOverflow) return { kind: "environment" };
  if (keys.length > 0 && layout && hydration === "done") {
    const visible = new Set(
      Array.from(onScreenTabIds(layout, mobile), (id) => createSessionKey(environment.id, id)),
    );
    const sessionKeys = keys.filter((key) => {
      const read = rendered.get(key);
      return (
        read && visible.has(key) && read.activityAt === unreadResultActivityAt(environment, key)
      );
    });
    if (sessionKeys.length > 0) return { kind: "sessions", sessionKeys };
  }
  if (environment.unreadEnvironmentReason) return { kind: "environment" };
  if (keys.length > 0 && (!layout || hydration !== "done")) return { kind: "pending" };
  return { kind: "none" };
}
