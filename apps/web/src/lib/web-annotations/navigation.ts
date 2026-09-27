/**
 * App navigation for web annotations: open a thread in a browser tab's panel,
 * jump to a destination chat, or start a new agent tab. Everything goes
 * through the existing pane-layout workflow; nothing here dispatches work.
 */
import { WEB_ANNOTATION_COMMANDS } from "@orkestrator/protocol/web-annotations";
import { createUuid } from "@/lib/uuid";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { getAllLeaves, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { TabInfo } from "@/types/paneLayout";
import { describeWebAnnotationError, webAnnotationCommand } from "./client";

function browserTabs(environmentId: string): TabInfo[] {
  return usePaneLayoutStore
    .getState()
    .getAllTabs(environmentId)
    .filter((tab) => tab.type === "browser" && tab.browserData);
}

function activate(environmentId: string, tabId: string): boolean {
  const panes = usePaneLayoutStore.getState();
  const pane = panes.findPaneWithTab(tabId, environmentId);
  if (!pane) return false;
  panes.setActiveTab(pane.id, tabId, environmentId);
  panes.setActivePane(pane.id, environmentId);
  return true;
}

/**
 * Show one thread in a browser tab's annotation panel. Annotations belong to
 * the environment, so when the original tab is gone a browser tab (new if
 * necessary) opens the panel with all pages visible.
 */
export function openWebAnnotationThread(
  environmentId: string,
  annotationId: string,
  options: { preferTabId?: string } = {},
): boolean {
  const panes = usePaneLayoutStore.getState();
  if (!panes.environments.get(environmentId)) return false;
  const tabs = browserTabs(environmentId);
  let tab =
    tabs.find((candidate) => candidate.id === options.preferTabId) ??
    tabs.find(
      (candidate) => candidate.browserData?.annotationPanel?.selectedAnnotationId === annotationId,
    ) ??
    tabs.find((candidate) => candidate.browserData?.annotationPanel?.open) ??
    tabs[0];
  if (!tab) {
    tab = {
      id: `browser-${createUuid()}`,
      type: "browser",
      browserData: {
        url: "",
        annotationPanel: { open: true, filter: { scope: "all", state: "all" } },
      },
    };
    panes.addTab(panes.getActivePaneId(environmentId), tab, environmentId);
  }
  usePaneLayoutStore
    .getState()
    .updateTabBrowserAnnotationPanel(
      tab.id,
      { open: true, selectedAnnotationId: annotationId },
      environmentId,
    );
  return activate(environmentId, tab.id);
}

/** Resolve a chat marker's request to its first annotation and open that thread. */
export async function openWebAnnotationRequest(
  environmentId: string,
  requestId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { request } = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.requestGet, {
      environmentId,
      requestId,
    });
    const selection = [...request.selections].sort((a, b) => a.reference - b.reference)[0];
    if (!selection) return { ok: false, error: "This request has no annotations." };
    return openWebAnnotationThread(environmentId, selection.annotationId)
      ? { ok: true }
      : { ok: false, error: "The browser annotation panel could not be opened." };
  } catch (error) {
    return { ok: false, error: describeWebAnnotationError(error) };
  }
}

/** Focus an existing chat tab. False when that tab is not open in this layout. */
export function openConversationTab(environmentId: string, tabId: string): boolean {
  return activate(environmentId, tabId);
}

export function isConversationTabOpen(environmentId: string, tabId: string): boolean {
  const layout = usePaneLayoutStore.getState().environments.get(environmentId);
  if (!layout) return false;
  return getAllLeaves(layout.root).some((leaf) => leaf.tabs.some((tab) => tab.id === tabId));
}

/**
 * Open a new, unassigned agent tab through the ordinary pane workflow. The
 * user picks its provider there; no annotation is sent because of it.
 */
export function openNewAgentSession(environmentId: string): string | null {
  const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
  const panes = usePaneLayoutStore.getState();
  if (!environment || !panes.environments.get(environmentId)) return null;
  const isLocal = environment.environmentType === "local";
  const id = createUuid();
  const tab: TabInfo = {
    id,
    type: "agent-native",
    nativeAgentData: {
      platform: undefined,
      containerId: isLocal ? undefined : (environment.containerId ?? undefined),
      environmentId,
      isLocal,
    },
  };
  panes.addTab(panes.getActivePaneId(environmentId), tab, environmentId);
  return id;
}
