import { useRef } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import {
  pipelineFollowUps,
  type PipelineFollowUp,
  type PipelineFollowUpKind,
} from "@orkestrator/protocol/build-pipeline-notes";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import { KeyInformationText } from "./KeyInformationText";
import { KeyInformationDocument } from "./PipelineKeyInformationTab";

const FOLLOW_UP_GROUPS: ReadonlyArray<{ kind: PipelineFollowUpKind; title: string }> = [
  { kind: "not-checked", title: "Not verified" },
  { kind: "not-done", title: "Not done" },
  { kind: "open-issue", title: "Open review issues" },
  { kind: "test", title: "Tests not passed" },
];

/**
 * The Notes step: everything the key information tab shows, with what a person
 * still has to do or look at under the summary. Both are read from the pipeline
 * record.
 */
export function PipelineNotesView({ pipeline }: { pipeline: BuildPipeline }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followUps = pipelineFollowUps(pipeline);
  return (
    <div
      ref={scrollRef}
      data-testid="pipeline-notes"
      className="@container max-h-[70vh] overflow-y-auto"
    >
      <KeyInformationDocument
        keyInformation={pipeline.keyInformation}
        scrollRef={scrollRef}
        afterSummary={<NeedsALook followUps={followUps} />}
      />
    </div>
  );
}

function NeedsALook({ followUps }: { followUps: readonly PipelineFollowUp[] }) {
  if (followUps.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 aria-hidden className="size-4 shrink-0 text-emerald-400" />
        Nothing was flagged for a person to look at.
      </p>
    );
  }
  return (
    <section aria-label="Needs a look" className="rounded-lg border border-amber-500/30 px-4 py-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-amber-300">
        <CircleAlert aria-hidden className="size-4 shrink-0" />
        Needs a look
        <span className="font-normal tabular-nums text-muted-foreground">{followUps.length}</span>
      </h2>
      <div className="mt-3 grid gap-3">
        {FOLLOW_UP_GROUPS.map(({ kind, title }) => {
          const items = followUps.filter((item) => item.kind === kind);
          if (items.length === 0) return null;
          return (
            <div key={kind}>
              <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {title}
              </h3>
              <ul className="mt-1 grid gap-1.5">
                {items.map((item, index) => (
                  <li key={`${index}:${item.text}`} className="text-sm leading-5">
                    <KeyInformationText text={item.text} />
                    {item.detail ? (
                      <div className="text-xs leading-5 text-muted-foreground">
                        <KeyInformationText text={item.detail} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
