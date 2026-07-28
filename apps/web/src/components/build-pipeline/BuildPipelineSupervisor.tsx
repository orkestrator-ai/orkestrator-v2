import { useEffect } from "react";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneNode, TabInfo } from "@/types/paneLayout";

function hasPipelineTab(node: PaneNode, pipelineId: string): boolean {
  if (node.kind === "leaf") {
    return node.tabs.some((tab) => tab.buildTabData?.pipelineId === pipelineId);
  }
  return node.children.some((child) => hasPipelineTab(child, pipelineId));
}

/**
 * App-lifetime liveness guard for build workflows.
 *
 * The provider-specific pipeline driver still lives in BuildChatTab, but the
 * visible tab is no longer its owner: closing that tab or restoring a layout
 * that omitted it recreates a hidden controller tab from the authoritative
 * pipeline snapshot. This mirrors LoopedReviewSupervisor and removes the
 * unmount-prone component-state gap called out by the state audit.
 */
export function BuildPipelineSupervisor() {
  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const paneEnvironments = usePaneLayoutStore((state) => state.environments);
  const hydration = usePaneLayoutStore((state) => state.hydration);
  const addTab = usePaneLayoutStore((state) => state.addTab);

  useEffect(() => {
    for (const pipeline of pipelines.values()) {
      if (
        !pipeline.environmentId
        || pipeline.phase === "complete"
        || pipeline.phase === "failed"
        || hydration.get(pipeline.environmentId) !== "done"
      ) {
        continue;
      }
      const paneState = paneEnvironments.get(pipeline.environmentId);
      if (!paneState || hasPipelineTab(paneState.root, pipeline.id)) continue;
      const tab: TabInfo = {
        id: `build-${pipeline.id}`,
        type: "claude-build",
        displayTitle: "Build",
        buildTabData: {
          environmentId: pipeline.environmentId,
          pipelineId: pipeline.id,
          taskId: pipeline.taskId,
          isLocal: pipeline.environmentType === "local",
        },
      };
      addTab(paneState.activePaneId, tab, pipeline.environmentId);
    }
  }, [addTab, hydration, paneEnvironments, pipelines]);

  return null;
}
