/**
 * A transcript text block that is one JSON document, rendered as structure.
 *
 * The whole payload sits behind a single closed disclosure: an agent working to
 * a schema emits these repeatedly, and expanded they would bury the prose around
 * them. A payload that validates as a structured review report gets that
 * report's own renderer; anything else gets the generic labelled tree.
 */

import { useState } from "react";
import {
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  StructuredReviewReportView,
  structuredReviewVerdictSummary,
} from "@/components/review/StructuredReviewReportView";
import { describeJsonValue, type JsonPayload } from "@/lib/chat/json-payload";
import { cn } from "@/lib/utils";
import { JsonTree } from "./JsonTree";

function payloadTitle(payload: JsonPayload): string {
  switch (payload.kind) {
    case "structured-review":
      return "Structured review report";
    case "verification":
      // The outcome is the title: a verdict the reader has to open to learn is
      // no better than the raw JSON it replaced.
      return payload.verdict.complete
        ? "Verification passed"
        : "Verification failed";
    default:
      return Array.isArray(payload.value) ? "JSON list" : "JSON payload";
  }
}

/** The single flattened line a collapsed payload shows beside its title. */
function payloadSummary(payload: JsonPayload): string {
  switch (payload.kind) {
    case "structured-review":
      return structuredReviewVerdictSummary(payload.report);
    case "verification":
      return payload.verdict.rationale.trim().replace(/\s+/g, " ");
    default:
      return describeJsonValue(payload.value);
  }
}

function PayloadIcon({ payload }: { payload: JsonPayload }) {
  switch (payload.kind) {
    case "structured-review":
      return <ClipboardCheck className="size-3.5 shrink-0 text-cyan-300/90" />;
    case "verification":
      return payload.verdict.complete
        ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />
        : <CircleAlert className="size-3.5 shrink-0 text-red-400" />;
    default:
      return <Braces className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

function borderClass(payload: JsonPayload): string {
  switch (payload.kind) {
    case "structured-review":
      return "border-cyan-500/25";
    case "verification":
      return payload.verdict.complete
        ? "border-emerald-500/25"
        : "border-red-500/30";
    default:
      return "border-border/50";
  }
}

export function JsonPayloadPart({ payload }: { payload: JsonPayload }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        "my-1 overflow-hidden rounded-lg border bg-card/30",
        borderClass(payload),
      )}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/40">
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <PayloadIcon payload={payload} />
        <span className="shrink-0 text-xs font-medium text-foreground/90">
          {payloadTitle(payload)}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {payloadSummary(payload)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/40 px-3 py-2.5">
          {payload.kind === "structured-review" ? (
            <StructuredReviewReportView
              className="border-0 bg-transparent p-0 shadow-none @sm:p-0"
              report={payload.report}
              collapsibleSections
              showRawJson={false}
              showHeading={false}
            />
          ) : payload.kind === "verification" ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {payload.verdict.rationale}
            </p>
          ) : (
            <JsonTree value={payload.value} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
