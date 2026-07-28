import { BuildChatTab } from "@/components/build-pipeline/BuildChatTab";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneNode } from "@/types/paneLayout";

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
 * visible tab is no longer its owner. When no pane contains the pipeline tab,
 * this supervisor mounts a non-visible driver directly at app scope. Closing a
 * tab therefore never recreates it or changes pane focus, while the workflow
 * continues consuming backend state and events.
 */
export function BuildPipelineSupervisor() {
  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const paneEnvironments = usePaneLayoutStore((state) => state.environments);
  const hydration = usePaneLayoutStore((state) => state.hydration);

  const controllers = [];
  for (const pipeline of pipelines.values()) {
    if (
      !pipeline.environmentId
      || pipeline.phase === "complete"
      || pipeline.phase === "failed"
    ) {
      continue;
    }
    const paneState = paneEnvironments.get(pipeline.environmentId);
    const mountedPaneOwnsDriver = hydration.get(pipeline.environmentId) === "done"
      && paneState
      && hasPipelineTab(paneState.root, pipeline.id);
    if (mountedPaneOwnsDriver) continue;
    controllers.push(
      <div key={pipeline.id} className="hidden" aria-hidden="true">
        <BuildChatTab
          data={{
            environmentId: pipeline.environmentId,
            pipelineId: pipeline.id,
            taskId: pipeline.taskId,
            isLocal: pipeline.environmentType === "local",
          }}
          isActive={false}
        />
      </div>,
    );
  }

  return controllers;
}
