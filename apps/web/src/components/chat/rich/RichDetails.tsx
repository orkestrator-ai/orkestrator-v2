import { useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { InlineMessageMarkdown } from "@/components/chat/MessageMarkdown";
import { useFindReveal } from "@/lib/chat/rich-markdown/find-reveal";
import { useRichViewField } from "@/stores/richContentViewStore";
import { cn } from "@/lib/utils";
import { RichSearchMirror } from "./RichMarkdownBlocks.shared";

/**
 * A controlled disclosure from `<details>`/`<summary>` Markdown.
 *
 * The summary is rendered by the phrasing-only inline renderer (links are
 * not interactive inside the toggle button). Open/closed state lives in the
 * scoped view store, so it survives virtualized remounts, history paging and
 * theme changes. While closed, the body's searchable text sits in a hidden
 * mirror so find can count it and reveal it; a find reveal opens the body
 * temporarily and is undone when find closes unless the user toggled it.
 */
export function RichDetails({
  summary,
  blockKey,
  bodySearchText,
  children,
}: {
  summary: string;
  blockKey: string;
  /** Text of the body exactly as it renders when open (computed lazily). */
  bodySearchText: () => string;
  children: ReactNode;
}) {
  const [open, setOpen] = useRichViewField(blockKey, "open", false);
  const { revealed, endReveal } = useFindReveal(blockKey);
  const expanded = open || revealed;
  const bodyId = useId();

  const toggle = () => {
    setOpen(!expanded);
    if (revealed) endReveal();
  };

  return (
    <div
      data-rich-block="details"
      data-rich-block-key={blockKey}
      className="my-2 rounded-md border border-border/70 bg-muted/20"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={toggle}
        className="flex w-full items-start gap-1.5 rounded-md px-3 py-1.5 text-left text-sm font-medium text-foreground outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
        {summary ? (
          <InlineMessageMarkdown content={summary} className="min-w-0 flex-1" />
        ) : (
          <span data-rich-chrome="true" className="min-w-0 flex-1 select-none">
            Details
          </span>
        )}
      </button>
      {expanded ? (
        <div
          id={bodyId}
          className="border-t border-border/60 px-3 py-1 [&>:first-child]:mt-1 [&>:last-child]:mb-1"
        >
          {children}
        </div>
      ) : (
        <div id={bodyId} hidden>
          <RichSearchMirror text={bodySearchText()} revealKey={blockKey} />
        </div>
      )}
    </div>
  );
}
