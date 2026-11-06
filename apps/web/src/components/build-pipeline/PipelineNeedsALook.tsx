import { useId, useState } from "react";
import { CheckCircle2, ChevronRight, CircleAlert } from "lucide-react";
import type {
  PipelineFollowUp,
  PipelineFollowUpKind,
} from "@orkestrator/protocol/build-pipeline-notes";
import { cn } from "@/lib/utils";
import { KeyInformationText } from "./KeyInformationText";

const FOLLOW_UP_GROUPS: ReadonlyArray<{ kind: PipelineFollowUpKind; title: string }> = [
  { kind: "not-checked", title: "Not verified" },
  { kind: "not-done", title: "Not done" },
  { kind: "open-issue", title: "Open review issues" },
  { kind: "test", title: "Tests not passed" },
];

/**
 * What a person still has to do or look at, in the Notes step and its tab.
 * It opens collapsed; only its header toggles it, so the items stay selectable.
 */
export function PipelineNeedsALook({ followUps }: { followUps: readonly PipelineFollowUp[] }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  if (followUps.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 aria-hidden className="size-4 shrink-0 text-emerald-400" />
        Nothing was flagged for a person to look at.
      </p>
    );
  }
  return (
    <section aria-label="Needs a look" className="rounded-lg border border-amber-500/30">
      <h2 className="text-sm font-medium text-amber-300">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          className="focus-hairline flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left transition-colors hover:bg-amber-500/5"
          onClick={() => setExpanded((value) => !value)}
        >
          <CircleAlert aria-hidden className="size-4 shrink-0" />
          Needs a look
          <span className="font-normal tabular-nums text-muted-foreground">{followUps.length}</span>
          <ChevronRight
            aria-hidden
            className={cn(
              "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
      </h2>
      {expanded ? <NeedsALookItems id={bodyId} followUps={followUps} /> : null}
    </section>
  );
}

function NeedsALookItems({
  id,
  followUps,
}: {
  id: string;
  followUps: readonly PipelineFollowUp[];
}) {
  return (
    <div id={id} className="grid gap-3 px-4 pb-3">
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
  );
}
