import type { ReactNode } from "react";
import { AlertOctagon, AlertTriangle, Info, Lightbulb, MessageSquareWarning } from "lucide-react";
import type { RichCalloutKind } from "@/lib/chat/rich-markdown/remark-rich-markdown";
import { cn } from "@/lib/utils";

/**
 * Presentation for the five GFM alert kinds. Meaning never depends on colour:
 * every callout has a distinct icon, a text label and a distinct border style,
 * so it reads correctly in monochrome and forced-colours modes. Content cannot
 * choose any of this: the kind comes from a fixed marker vocabulary.
 */
const CALLOUTS: Record<
  RichCalloutKind,
  { label: string; icon: typeof Info; frame: string; accent: string }
> = {
  note: {
    label: "Note",
    icon: Info,
    frame: "border-l-4 border-solid border-sky-500/70 bg-sky-500/5",
    accent: "text-sky-600 dark:text-sky-300",
  },
  tip: {
    label: "Tip",
    icon: Lightbulb,
    frame: "border-l-4 border-dotted border-emerald-500/70 bg-emerald-500/5",
    accent: "text-emerald-600 dark:text-emerald-300",
  },
  important: {
    label: "Important",
    icon: MessageSquareWarning,
    frame: "border-l-4 border-double border-violet-500/70 bg-violet-500/5",
    accent: "text-violet-600 dark:text-violet-300",
  },
  warning: {
    label: "Warning",
    icon: AlertTriangle,
    frame: "border-l-4 border-dashed border-amber-500/80 bg-amber-500/5",
    accent: "text-amber-700 dark:text-amber-300",
  },
  caution: {
    label: "Caution",
    icon: AlertOctagon,
    frame: "border-2 border-solid border-red-500/70 bg-red-500/5",
    accent: "text-red-600 dark:text-red-300",
  },
};

export function isRichCalloutKind(value: unknown): value is RichCalloutKind {
  return typeof value === "string" && value in CALLOUTS;
}

export function RichCallout({ kind, children }: { kind: RichCalloutKind; children: ReactNode }) {
  const callout = CALLOUTS[kind];
  const Icon = callout.icon;
  return (
    <div
      role="note"
      aria-label={callout.label}
      data-rich-block="callout"
      data-callout-kind={kind}
      className={cn("my-2 rounded-md px-3 py-2 forced-colors:border-[CanvasText]", callout.frame)}
    >
      <div
        data-rich-chrome="true"
        className={cn(
          "flex select-none items-center gap-1.5 text-xs font-semibold",
          callout.accent,
        )}
      >
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span>{callout.label}</span>
      </div>
      <div className="mt-1 [&>:first-child]:mt-0 [&>:last-child]:mb-0">{children}</div>
    </div>
  );
}
