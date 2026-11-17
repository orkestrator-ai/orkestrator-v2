import { lazy, useCallback, useMemo, type ReactNode } from "react";
import { AGENT_PLATFORM_LABELS, isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { DesignSessionLink } from "@orkestrator/protocol/design-operations";
import { LazyLoadBoundary, type LazyLoadErrorDetails } from "@/components/LazyLoadBoundary";
import { DesignAgentDock, DesignAgentPanelEmpty } from "@/components/design/DesignAgentDock";
import { useNodeScope } from "@/lib/node-scope/providers";
import { useDesignStore } from "@/stores/designStore";
import { DEFAULT_DESIGN_AGENT_PANEL, findEmbeddedTab } from "@/stores/pane-layout-embedded";
import { getAllLeaves, paneLayoutStore, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  getNativeAgentData,
  type DesignAgentPanelState,
  type NativeAgentData,
  type TabInfo,
} from "@/types/paneLayout";

const LazyDesignCanvasTab = lazy(async () => ({
  default: (await import("@/components/design/DesignCanvasTab")).DesignCanvasTab,
}));

const NO_LINKS: readonly DesignSessionLink[] = [];

export interface EmbeddedAgentView {
  isActive: boolean;
  hiddenByLayout: boolean;
  ownsGlobalShortcuts: boolean;
}

/**
 * A design canvas tab: the canvas plus, in a dockable panel, the agent tab
 * embedded in it. The agent itself is rendered by the pane (`renderAgent`) so
 * it is exactly the conversation an ordinary agent tab would show.
 */
export function DesignCanvasPaneTab({
  tab,
  paneTabs,
  environmentId,
  isTabActive,
  isActive,
  hiddenByLayout,
  ownsGlobalShortcuts,
  loadingFallback,
  renderError,
  renderAgent,
}: {
  tab: TabInfo & { designCanvasData: NonNullable<TabInfo["designCanvasData"]> };
  paneTabs: readonly TabInfo[];
  environmentId: string;
  isTabActive: boolean;
  /** The pane is shown (not merely laid out under the mobile switcher). */
  isActive: boolean;
  hiddenByLayout: boolean;
  ownsGlobalShortcuts: boolean;
  loadingFallback: ReactNode;
  renderError: (details: LazyLoadErrorDetails) => ReactNode;
  renderAgent: (tab: TabInfo, data: NativeAgentData, view: EmbeddedAgentView) => ReactNode;
}) {
  const scope = useNodeScope();
  const layouts = scope.store(paneLayoutStore);
  const { canvasId } = tab.designCanvasData;
  const embedded = findEmbeddedTab(paneTabs, tab.id);
  // Until the user shows or hides it, the panel shows exactly when there is
  // an agent in it: a blank design keeps its whole tab for the canvas.
  const storedPanel = tab.designCanvasData.agentPanel;
  const hasAgent = Boolean(embedded);
  const panel = useMemo(
    () => storedPanel ?? { ...DEFAULT_DESIGN_AGENT_PANEL, open: hasAgent },
    [hasAgent, storedPanel],
  );
  const embeddedData = embedded ? getNativeAgentData(embedded) : null;
  const visible = isTabActive && (isActive || hiddenByLayout);

  const links = useDesignStore((state) => {
    for (const projection of state.projections.values())
      if (projection.canvasId === canvasId && projection.environmentId === environmentId)
        return projection.workspace?.sessions ?? NO_LINKS;
    return NO_LINKS;
  });
  const environment = usePaneLayoutStore((state) => state.environments.get(environmentId));
  const candidates = useMemo(() => {
    if (embedded || !environment || links.length === 0) return [];
    const open = new Map(
      getAllLeaves(environment.root)
        .flatMap((leaf) => leaf.tabs)
        .map((candidate) => [candidate.id, candidate] as const),
    );
    return links.flatMap((link) => {
      const linked = open.get(link.tabId);
      if (!linked || linked.embeddedIn || !getNativeAgentData(linked)) return [];
      const name =
        link.label ?? (link.role === "implementation" ? "Implement design" : "Design chat");
      const agent = isAgentPlatform(link.platform) ? AGENT_PLATFORM_LABELS[link.platform] : null;
      return [{ tabId: link.tabId, label: agent ? `${name} · ${agent}` : name }];
    });
  }, [embedded, environment, links]);

  const changePanel = useCallback(
    (patch: Partial<DesignAgentPanelState>) =>
      layouts.getState().updateDesignAgentPanel(tab.id, { ...panel, ...patch }, environmentId),
    [environmentId, layouts, panel, tab.id],
  );
  const adopt = useCallback(
    (tabId: string) => {
      if (layouts.getState().setTabEmbedding(tabId, tab.id, environmentId))
        changePanel({ open: true });
    },
    [changePanel, environmentId, layouts, tab.id],
  );
  const closeDesign = useCallback(() => {
    // Closing the tab never deletes the design; its agent's conversation is retained.
    const store = layouts.getState();
    const owner = store.findPaneWithTab(tab.id, environmentId);
    if (owner) store.removeTab(owner.id, tab.id, environmentId);
  }, [environmentId, layouts, tab.id]);

  return (
    <DesignAgentDock
      panel={panel}
      onPanelChange={changePanel}
      visible={visible}
      ownsGlobalShortcuts={ownsGlobalShortcuts}
      onAdopt={adopt}
      {...(embedded && embeddedData
        ? {
            agent: { environmentId, tabId: embedded.id, platform: embeddedData.platform },
            onPopOut: () => layouts.getState().setTabEmbedding(embedded.id, null, environmentId),
          }
        : {})}
      renderCanvas={(view) => (
        <LazyLoadBoundary loadingFallback={loadingFallback} renderError={renderError}>
          <LazyDesignCanvasTab
            canvasId={canvasId}
            environmentId={environmentId}
            isActive={isTabActive && isActive}
            ownsGlobalShortcuts={view.ownsGlobalShortcuts}
            agentPanel={view.agentPanel}
            onClose={closeDesign}
          />
        </LazyLoadBoundary>
      )}
      renderAgent={(view) =>
        embedded && embeddedData ? (
          renderAgent(embedded, embeddedData, {
            isActive: view.isActive && isActive,
            hiddenByLayout: view.isActive && hiddenByLayout,
            ownsGlobalShortcuts: view.ownsGlobalShortcuts,
          })
        ) : (
          <DesignAgentPanelEmpty candidates={candidates} onEmbed={adopt} />
        )
      }
    />
  );
}
