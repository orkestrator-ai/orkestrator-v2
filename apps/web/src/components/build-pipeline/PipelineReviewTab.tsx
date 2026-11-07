import { useEffect, useRef, useState } from "react";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useNodeScope } from "@/lib/node-scope/providers";
import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import { StackedEyes } from "@/components/review/MultiReviewLaunchDialog";
import { PipelineFlowView } from "./PipelineFlowView";
import { usePipelineControls } from "./usePipelineControls";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.build-pipeline");

/**
 * One review pass of a build pipeline, opened as a Multi Review tab: its
 * preparation, every reviewer and the consolidation, on the same graph and
 * inspector as the pipeline tab, read from the pipeline record.
 */
export function PipelineReviewTab({
  pipelineId,
  environmentId,
  passKey,
  isActive,
  ownsGlobalShortcuts = isActive,
}: {
  pipelineId: string;
  environmentId: string;
  passKey: string;
  isActive: boolean;
  ownsGlobalShortcuts?: boolean;
}) {
  const pipeline = useBuildPipelineStore((state) => state.pipelines.get(pipelineId));
  const scope = useNodeScope();
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const controls = usePipelineControls(pipeline, () => setPinnedId(null));
  const hydrationAttemptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (pipeline || hydrationAttemptedFor.current === pipelineId) return;
    hydrationAttemptedFor.current = pipelineId;
    void hydrateBuildPipeline(pipelineId, undefined, undefined, scope).catch((error) => {
      log.warn("pipeline.hydrate-failed", {
        source: "review-tab",
        pipelineId,
        error: formatLogError(error),
      });
    });
  }, [pipeline, pipelineId, scope]);

  if (!pipeline) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading build pipeline…
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header
        data-testid="pipeline-review-header"
        className="flex shrink-0 items-center gap-2.5 border-b border-border/40 bg-zinc-900/40 px-4 py-3"
      >
        <StackedEyes className="size-4 shrink-0 text-cyan-400" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{pipeline.taskTitle}</div>
          <div className="text-xs text-muted-foreground">Build pipeline review</div>
        </div>
      </header>
      <PipelineFlowView
        pipeline={pipeline}
        environmentId={environmentId}
        isActive={isActive}
        ownsGlobalShortcuts={isActive && ownsGlobalShortcuts}
        controls={controls}
        pinnedId={pinnedId}
        onPin={setPinnedId}
        passKey={passKey}
      />
    </div>
  );
}
