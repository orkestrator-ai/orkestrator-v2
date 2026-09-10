import { cn } from "@/lib/utils";

type SessionRefreshShimmerVariant = "transcript" | "pinned";

interface SessionRefreshShimmerProps {
  active: boolean;
  /**
   * `transcript` is the message-shaped skeleton that closes the message list.
   * `pinned` is the single compact bar for the compose dock's notice row, which
   * stays on screen in both dock layouts and at any scroll position.
   */
  variant?: SessionRefreshShimmerVariant;
}

const BAR_WIDTHS: Record<SessionRefreshShimmerVariant, readonly string[]> = {
  transcript: ["w-3/4", "w-full", "w-1/2"],
  pinned: ["w-full"],
};

/**
 * Keep the skeleton mounted so its height can collapse before leaving the flow.
 *
 * Purely decorative, and permanently `aria-hidden`. The refresh is announced by
 * the chat shell's own live region, which is mounted once and mounted early;
 * announcing from here instead would speak twice whenever both variants are on
 * screen, and would create the live region in the same commit as its text.
 */
export function SessionRefreshShimmer({
  active,
  variant = "transcript",
}: SessionRefreshShimmerProps) {
  return (
    <div
      className="session-refresh-reveal"
      data-active={active}
      data-testid={`session-refresh-shimmer-${variant}`}
      aria-hidden="true"
    >
      <div className="min-h-0 overflow-hidden">
        <div className={variant === "transcript" ? "px-2 @sm:px-4" : undefined}>
          <div className={cn("mx-auto max-w-3xl", variant === "transcript" ? "py-3" : "py-1.5")}>
            <div className="session-refresh-shimmer flex flex-col gap-2">
              {BAR_WIDTHS[variant].map((width) => (
                <div key={width} className={cn("h-2 rounded-full bg-muted-foreground/10", width)} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
