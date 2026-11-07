import type { ReactNode } from "react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePromptDeadline } from "@/hooks/usePromptDeadline";
import { cn } from "@/lib/utils";
import { PromptDeadline, type PromptDeadlineProps } from "./PromptDeadline";

export type BlockingPromptState =
  "pending" | "submitting" | "expired" | "withdrawn" | "stale" | "invalid" | "retryable-error";

/** Pause state and control for a card's countdown. */
export type BlockingPromptCardDeadline = Omit<PromptDeadlineProps, "expiresAt">;

interface BlockingPromptCardProps {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  expiresAt?: number;
  /** Pause state and control for the countdown; absent shows the bare countdown. */
  deadline?: BlockingPromptCardDeadline;
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
 * One treatment across every agent, on the same neutral surface as the
 * floating pane notices (`components/ui/floating-notice.tsx`): an amber-tinted
 * frame read as an alarm, so "this is waiting for you" is carried by a small
 * warning dot beside the title instead. The cards are pinned above the
 * composer, so they carry no outer margin of their own — the dock supplies the
 * spacing.
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
  deadline: deadlineControl,
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
        "overflow-hidden rounded-xl border border-border bg-panel-surface/95 text-foreground shadow-xl shadow-black/40 backdrop-blur-sm",
        className,
      )}
    >
      {(arrivalAnnouncement || title) && (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {arrivalAnnouncement ?? title}
        </span>
      )}

      {title && (
        <div className="flex min-w-0 items-start gap-2 px-4 pt-3">
          {icon ? (
            <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden>
              {icon}
            </span>
          ) : (
            <span
              aria-hidden
              data-testid="blocking-prompt-dot"
              className="mt-1.5 inline-block size-2 shrink-0 rounded-full bg-yellow-300"
            />
          )}
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
              {effectiveState === "pending" && (
                <PromptDeadline
                  expiresAt={expiresAt}
                  {...deadlineControl}
                  className={cn("ml-auto text-xs", deadlineControl?.className)}
                />
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
              : "border-border text-muted-foreground",
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
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
          {actions}
        </div>
      )}
    </div>
  );
}
