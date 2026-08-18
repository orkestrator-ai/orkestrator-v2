/**
 * A transcript text block that is one JSON document, rendered as structure.
 *
 * The whole payload sits behind a single closed disclosure: an agent working to
 * a schema emits these repeatedly, and expanded they would bury the prose around
 * them. A payload that validates as a structured review report gets that
 * report's own renderer; anything else gets the generic labelled tree.
 */

import { Braces, CheckCircle2, ChevronRight, CircleAlert, ClipboardCheck } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StructuredReviewReportView } from "@/components/review/StructuredReviewReportView";
import { jsonPayloadSummary, jsonPayloadTitle, type JsonPayload } from "@/lib/chat/json-payload";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import { cn } from "@/lib/utils";
import { JsonTree } from "./JsonTree";

function PayloadIcon({ payload }: { payload: JsonPayload }) {
  switch (payload.kind) {
    case "structured-review":
      return <ClipboardCheck className="size-3.5 shrink-0 text-cyan-300/90" />;
    case "verification":
      return payload.verdict.complete ? (
        <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />
      ) : (
        <CircleAlert className="size-3.5 shrink-0 text-red-400" />
      );
    default:
      return <Braces className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

function borderClass(payload: JsonPayload): string {
  switch (payload.kind) {
    case "structured-review":
      return "border-cyan-500/25";
    case "verification":
      return payload.verdict.complete ? "border-emerald-500/25" : "border-red-500/30";
    default:
      return "border-border/50";
  }
}

/**
 * The exact document, one disclosure below the tree.
 *
 * The tree humanizes keys, so it cannot show what the agent actually wrote.
 * Anything the tree summarizes — a truncated container, a branch past the
 * render depth — has to remain reachable without leaving the transcript.
 */
function RawJsonDisclosure({ source, expansionKey }: { source: string; expansionKey: string }) {
  const [isOpen, setIsOpen] = useMessagePartExpansion(expansionKey);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mt-2">
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1.5 rounded-md py-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", isOpen && "rotate-90")}
        />
        Raw JSON
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-h-80 overflow-auto rounded-md border border-border/50 bg-background/60 p-2 text-xs text-foreground/80">
          {source}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function JsonPayloadPart({
  payload,
  expansionKey,
}: {
  payload: JsonPayload;
  /**
   * Stable identity for this payload's position in the transcript. Expansion
   * is stored against it so the virtualized list unmounting the row while it
   * is off-screen does not collapse what the reader opened.
   */
  expansionKey: string;
}) {
  const [isOpen, setIsOpen] = useMessagePartExpansion(expansionKey);

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn("my-1 overflow-hidden rounded-lg border bg-card/30", borderClass(payload))}
    >
      <CollapsibleTrigger
        data-agent-chat-search-content="true"
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <PayloadIcon payload={payload} />
        {/*
          Adjacent with no whitespace between them: `jsonPayloadSearchText`
          concatenates the same two strings so the find index matches this row
          exactly. A test asserts the two stay equal.
        */}
        <span className="shrink-0 text-xs font-medium text-foreground/90">
          {jsonPayloadTitle(payload)}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {jsonPayloadSummary(payload)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/40 px-3 py-2.5">
          {payload.kind === "structured-review" ? (
            <StructuredReviewReportView
              className="border-0 bg-transparent p-0 shadow-none @sm:p-0"
              report={payload.report}
              collapsibleSections
              sectionExpansionKey={`${expansionKey}/report-section`}
              showRawJson={false}
              showHeading={false}
            />
          ) : payload.kind === "verification" ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {payload.verdict.rationale}
            </p>
          ) : (
            <>
              <JsonTree value={payload.value} expansionKey={`${expansionKey}/tree`} />
              <RawJsonDisclosure source={payload.source} expansionKey={`${expansionKey}/raw`} />
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
