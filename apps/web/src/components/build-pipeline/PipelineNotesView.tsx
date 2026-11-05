import { useRef } from "react";
import { pipelineFollowUps } from "@orkestrator/protocol/build-pipeline-notes";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import { PipelineNeedsALook } from "./PipelineNeedsALook";
import { KeyInformationDocument } from "./PipelineKeyInformationTab";

/**
 * The Notes step: everything the key information tab shows, with what a person
 * still has to do or look at under the summary. Both are read from the pipeline
 * record.
 */
export function PipelineNotesView({ pipeline }: { pipeline: BuildPipeline }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={scrollRef}
      data-testid="pipeline-notes"
      className="@container max-h-[70vh] overflow-y-auto"
    >
      <KeyInformationDocument
        keyInformation={pipeline.keyInformation}
        scrollRef={scrollRef}
        afterSummary={<PipelineNeedsALook followUps={pipelineFollowUps(pipeline)} />}
      />
    </div>
  );
}
