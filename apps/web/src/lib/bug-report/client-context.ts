import type { BugReportClientContext } from "@orkestrator/protocol/bug-report";
import { hostUpdateChannelOfVersion } from "@orkestrator/protocol/host-maintenance";
import { BUNDLED_APP_VERSION } from "@/lib/app-version";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { selectionOnScope } from "@/stores/windowSelectionStore";
import type { PaneNode } from "@/types/paneLayout";
import { recentRendererErrors } from "./renderer-errors";

const CHANNEL_LABELS = { stable: "Stable", beta: "Beta", unstable: "Unstable" } as const;

function activeTabType(root: PaneNode, paneId: string): string | undefined {
  if (root.kind === "leaf") {
    if (root.id !== paneId) return undefined;
    return root.tabs.find((tab) => tab.id === root.activeTabId)?.type;
  }
  return activeTabType(root.children[0], paneId) ?? activeTabType(root.children[1], paneId);
}

/**
 * What this window can say about itself when a report starts: versions, the
 * machine, identifiers of what is on screen, and recent renderer errors.
 * Never prompts, transcripts or file contents.
 */
export function collectBugReportClientContext(machine: {
  id: string | null;
  label: string;
}): BugReportClientContext {
  const desktop = Boolean(window.orkestrator);
  const electronVersion = /\bElectron\/([\d.]+)/.exec(navigator.userAgent)?.[1];
  const channel = hostUpdateChannelOfVersion(BUNDLED_APP_VERSION);
  // What this window's own node shows: another node's view is its own report's.
  const scope = getWindowScope().commandScope();
  const selection = selectionOnScope(scope);
  const selectedProjectId = selection?.projectId ?? null;
  const selectedEnvironmentId = selection?.environmentId ?? null;
  const environment = selectedEnvironmentId
    ? scope.store(environmentStore).getState().getEnvironmentById(selectedEnvironmentId)
    : undefined;
  const pane = selectedEnvironmentId
    ? scope.store(paneLayoutStore).getState().environments.get(selectedEnvironmentId)
    : undefined;
  const tabType = pane ? activeTabType(pane.root, pane.activePaneId) : undefined;
  return {
    surface: desktop ? "desktop" : "web",
    appVersion: BUNDLED_APP_VERSION,
    ...(electronVersion ? { electronVersion } : {}),
    ...(channel ? { channel: CHANNEL_LABELS[channel] } : {}),
    userAgent: navigator.userAgent,
    machine,
    view: {
      ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
      ...(selectedEnvironmentId ? { environmentId: selectedEnvironmentId } : {}),
      ...(environment?.environmentType ? { environmentType: environment.environmentType } : {}),
      ...(environment?.status ? { environmentStatus: environment.status } : {}),
      ...(tabType ? { activeTabType: tabType } : {}),
    },
    rendererErrors: recentRendererErrors(),
  };
}
