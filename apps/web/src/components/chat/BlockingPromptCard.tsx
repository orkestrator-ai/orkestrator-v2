import type { ReactNode } from "react";
import { AlertTriangle, HelpCircle, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePromptDeadline } from "@/hooks/usePromptDeadline";
import { cn } from "@/lib/utils";

export type BlockingPromptState =
  | "pending"
  | "submitting"
  | "expired"
  | "withdrawn"
  | "stale"
  | "invalid"
  | "retryable-error";

interface BlockingPromptCardProps {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  expiresAt?: number;
  state?: BlockingPromptState;
  error?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  /** A short, stable announcement. Countdown text is deliberately excluded. */
  arrivalAnnouncement?: string;
  role?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  "data-session-id"?: string;
  "data-client-url"?: string;
}

/**
 * Container for any prompt the turn is blocked on — approvals, permission
 * requests and questions.
 *
 * One treatment across all three agents. Claude and OpenCode used a neutral
 * `bg-card` panel while Codex used an amber-accented one; amber wins because it
 * is the only one that reads as "this is waiting for you" rather than as
 * another message. The cards are pinned above the composer, so they carry no
 * outer margin of their own — the dock supplies the spacing.
 */
export function BlockingPromptCard({
  children,
  className,
  title,
  description,
  icon,
  meta,
  actions,
  expiresAt,
  state = "pending",
  error,
  onRetry,
  retrying = false,
  arrivalAnnouncement,
  role = "group",
  "aria-label": ariaLabel,
  ...dataProps
}: BlockingPromptCardProps) {
  const deadline = usePromptDeadline(expiresAt);
  const effectiveState = deadline.expired && state === "pending" ? "invalid" : state;
  const terminalMessage: Partial<Record<BlockingPromptState, string>> = {
    expired: "This request expired and was declined.",
    withdrawn: "This request was withdrawn and is no longer actionable.",
    stale: "This request was already resolved elsewhere.",
    invalid: "This request has an invalid deadline and cannot be answered safely.",
  };
  const statusMessage = terminalMessage[effectiveState];
  const label = ariaLabel ?? (typeof title === "string" ? title : undefined);

  return (
    <div
      {...dataProps}
      role={role}
      aria-label={label}
      aria-busy={effectiveState === "submitting" || retrying || undefined}
      className={cn(
        "overflow-hidden rounded-lg border border-amber-500/40 bg-amber-500/5 shadow-sm",
        className,
      )}
    >
      {(arrivalAnnouncement || title) && (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {arrivalAnnouncement ?? title}
        </span>
      )}

      {title && (
        <div className="flex min-w-0 items-start gap-2 border-b border-border bg-muted/50 px-4 py-2.5">
          <span className="mt-0.5 shrink-0 text-amber-500" aria-hidden>
            {icon ?? <HelpCircle className="h-4 w-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 text-sm font-medium text-foreground">{title}</span>
              {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
              {effectiveState === "submitting" && (
                <Loader2
                  className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground"
                  aria-hidden
                />
              )}
              {effectiveState === "pending" && deadline.remaining && (
                <span
                  className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground"
                  aria-live="off"
                  aria-label={`Time remaining ${deadline.remaining}`}
                >
                  {deadline.remaining}
                </span>
              )}
            </div>
            {description && (
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {description}
              </div>
            )}
          </div>
        </div>
      )}

      {children}

      {(statusMessage || error) && (
        <div
          role={error ? "alert" : "status"}
          className={cn(
            "flex items-center gap-1.5 border-t px-4 py-2.5 text-xs",
            error
              ? "border-destructive/30 bg-destructive/10 text-destructive-foreground"
              : "border-border bg-muted/30 text-muted-foreground",
          )}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{error ?? statusMessage}</span>
          {error && onRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={retrying}
              onClick={onRetry}
              className="h-7 shrink-0 gap-1 px-2"
            >
              {retrying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              )}
              Retry
            </Button>
          )}
        </div>
      )}

      {actions && !statusMessage && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/30 px-4 py-3">
          {actions}
        </div>
      )}
    </div>
  );
}
