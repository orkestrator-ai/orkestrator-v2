import { AlertTriangle, Clock, CloudOff, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FreshnessNotice } from "@/lib/view-freshness";

const ICONS: Record<FreshnessNotice["kind"], typeof AlertTriangle> = {
  stale: AlertTriangle,
  degraded: AlertTriangle,
  unsupported: Radio,
  "remote-stale": CloudOff,
  "remote-unknown": Clock,
};

function toneClass(kind: FreshnessNotice["kind"]): string {
  return kind === "stale" || kind === "degraded"
    ? "text-amber-600 dark:text-amber-400"
    : "text-muted-foreground";
}

/**
 * Freshness of one view: an inline icon inside a control whose tooltip carries
 * the detail (`icon`), or a strip with the label and detail (`strip`).
 */
export function FreshnessIndicator({
  notice,
  variant = "icon",
  className,
}: {
  notice: FreshnessNotice;
  variant?: "icon" | "strip";
  className?: string;
}) {
  const Icon = ICONS[notice.kind];
  if (variant === "icon") {
    return (
      <Icon
        aria-hidden="true"
        data-freshness={notice.kind}
        className={cn("size-3 shrink-0", toneClass(notice.kind), className)}
      />
    );
  }
  return (
    <div
      role="status"
      data-freshness={notice.kind}
      className={cn(
        "flex items-start gap-2 border-b border-border/60 px-3 py-1.5 text-[11px] leading-4",
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-3 shrink-0", toneClass(notice.kind))} />
      <span className="min-w-0 text-muted-foreground">
        <span className={cn("font-medium", toneClass(notice.kind))}>{notice.label}.</span>{" "}
        {notice.detail}
      </span>
    </div>
  );
}
