import { AutoPipelineBuildNotes } from "../review/AutoPipelineBuildNotes";
import { useRef } from "react";
import { pipelineFollowUps } from "@orkestrator/protocol/build-pipeline-notes";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import { PipelineNeedsALook } from "./PipelineNeedsALook";
import { KeyInformationDocument } from "./PipelineKeyInformationTab";

/**
 * The Notes step: everything the key information tab shows, led by what a
 * person still has to do or look at. Both are read from the pipeline record.
 */
export function PipelineNotesView({ pipeline }: { pipeline: BuildPipeline }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={scrollRef}
      data-testid="pipeline-notes"
      className="@container max-h-[70vh] overflow-y-auto"
    >
      {pipeline.sessions.find((session) => session.adoptedBuildNotes)?.adoptedBuildNotes && (
        <details className="m-4 rounded border border-divider p-3">
          <summary>Original interactive Build notes</summary>
          <AutoPipelineBuildNotes
            notes={
              pipeline.sessions.find((session) => session.adoptedBuildNotes)!.adoptedBuildNotes!
            }
          />
        </details>
      )}
      <KeyInformationDocument
        keyInformation={pipeline.keyInformation}
        scrollRef={scrollRef}
        lead={<PipelineNeedsALook followUps={pipelineFollowUps(pipeline)} />}
      />
    </div>
  );
}
