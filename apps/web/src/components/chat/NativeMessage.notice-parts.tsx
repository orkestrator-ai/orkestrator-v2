/**
 * Transcript rows for things that happened *to* the conversation rather than
 * in it: a compaction boundary, a provider retry, a status line, an image.
 *
 * Presentation only, and deliberately provider-neutral — every one of these is
 * populated by an adapter from a different vendor event, and none of them may
 * learn which. A provider with no source for a kind simply never emits it.
 */
import { useMemo } from "react";
import { AlertTriangle, Info, RefreshCw, Scissors, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import { InlineMessageMarkdown, MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { FilePart } from "./NativeMessage.file-parts";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

/**
 * The point after which the model no longer remembers what is above it.
 *
 * Shown even when the provider supplied no summary text: the boundary itself
 * is the information, and it is the single most confusing thing about a long
 * session when it is invisible.
 */
export function CompactionPart({
  part,
  expansionKey,
}: {
  part: Extract<NativeMessagePart, { type: "compaction" }>;
  expansionKey: string;
}) {
  const [isOpen, setIsOpen] = useMessagePartExpansion(expansionKey);
  const summary = part.content.trim();
  const before = part.compactedTokensBefore ?? part.tokenCount;
  const detail =
    part.tokenCountText ?? (before !== undefined ? `${formatTokens(before)} tokens before` : "");

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <Scissors className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-xs text-muted-foreground">Context compacted</span>
      {detail ? (
        <span className="truncate text-[10px] text-muted-foreground/70">{detail}</span>
      ) : null}
    </div>
  );

  if (!summary) {
    return (
      <div className="my-2 flex items-center gap-3">
        <div className="h-px flex-1 bg-border/60" />
        {header}
        <div className="h-px flex-1 bg-border/60" />
      </div>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-2">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border/60" />
        <CollapsibleTrigger className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 hover:bg-elevated-hover">
          {header}
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            {isOpen ? "Hide summary" : "Show summary"}
          </span>
        </CollapsibleTrigger>
        <div className="h-px flex-1 bg-border/60" />
      </div>
      <CollapsibleContent>
        <div className="mt-1.5 rounded-lg border border-border/60 bg-elevated/40 px-3 py-2 text-xs leading-relaxed">
          <MessageMarkdown content={summary} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A provider retrying a request.
 *
 * The lifecycle is `toolState`: `pending` while retrying, settled afterwards.
 * A row that stays pending forever is an adapter bug — this kind exists
 * precisely to replace the stale cards that never settled.
 */
export function RetryPart({ part }: { part: Extract<NativeMessagePart, { type: "retry" }> }) {
  const settled = part.toolState === "success" || part.toolState === "failure";
  const failed = part.toolState === "failure";
  const attempt = part.retryAttempt;
  const label = failed
    ? "Retry failed"
    : settled
      ? "Retried"
      : attempt !== undefined
        ? `Retrying (attempt ${attempt})`
        : "Retrying";

  return (
    <div
      className={cn(
        "my-1 flex min-w-0 items-center gap-2 text-[11px]",
        failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <RefreshCw
        className={cn("h-3 w-3 shrink-0", !settled && "animate-spin")}
        aria-hidden="true"
      />
      <span className="shrink-0">{label}</span>
      {part.content ? (
        <span className="truncate text-muted-foreground/70">{part.content}</span>
      ) : null}
    </div>
  );
}

const STATUS_ICONS = {
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
} as const;

const STATUS_CLASSES = {
  info: "text-muted-foreground",
  warning: "text-amber-400/90",
  error: "text-destructive",
} as const;

/**
 * A short provider status line, in the flow rather than in a panel.
 *
 * Deliberately one line and not expandable: anything that needs more room than
 * this is either a message or an error that ended the turn, and both already
 * have their own presentation.
 */
export function StatusPart({ part }: { part: Extract<NativeMessagePart, { type: "status" }> }) {
  const severity = part.severity ?? "info";
  const Icon = STATUS_ICONS[severity];
  const content = useMemo(() => part.content.trim(), [part.content]);
  if (!content) return null;

  return (
    <div
      className={cn("my-1 flex min-w-0 items-start gap-2 text-[11px]", STATUS_CLASSES[severity])}
    >
      <Icon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <div className="min-w-0 leading-relaxed">
        <InlineMessageMarkdown content={content} />
      </div>
    </div>
  );
}

const IMAGE_SOURCE_LABELS = {
  attachment: "Attached image",
  generated: "Generated image",
  viewed: "Image read",
} as const;

/**
 * An image in the transcript.
 *
 * The rendering, caching and container-aware fetch all already exist on
 * `FilePart`; this adds only the caption and the provenance label, so there is
 * one implementation of "show a picture" rather than two that drift.
 */
export function ImagePart({
  part,
  containerId,
}: {
  part: Extract<NativeMessagePart, { type: "image" }>;
  containerId?: string;
}) {
  const source = part.imageSource ?? "attachment";
  const caption = part.content.trim();
  return (
    <div className="my-1 space-y-1">
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
        {IMAGE_SOURCE_LABELS[source]}
      </div>
      <FilePart
        path={caption || part.filename || "image"}
        fileUrl={part.fileUrl}
        filename={part.filename}
        containerId={containerId}
        // Provenance is the reason to show it at all, so it loads without a
        // click — unlike a generic file row, which may be one of many.
        eagerPreview
      />
    </div>
  );
}
