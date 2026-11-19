import { useId, useState, type ReactNode } from "react";
import { AlertCircle, ChevronRight, Clock, RotateCcw, Sparkles } from "lucide-react";
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  classifyProviderFailure,
  providerFailurePresentation,
  supportedProviderFailureRemedies,
  type ProviderFailureDescriptor,
  type ProviderFailureReason,
} from "@orkestrator/protocol/provider-failures";
import { Button } from "@/components/ui/button";
import { formatProviderFailureReset } from "@/lib/provider-failure";
import { cn } from "@/lib/utils";
import { useProviderFailureActions } from "./provider-failure-actions";

/** Waiting fixes these; the rest need the user to change something. */
const TRANSIENT: ReadonlySet<ProviderFailureReason> = new Set([
  "usage-limit",
  "rate-limit",
  "provider-unavailable",
]);

interface ProviderFailureAlertProps {
  /** The provider's own failure text, shown under Details. */
  text: string;
  failure?: ProviderFailureDescriptor;
  platform?: AgentPlatform;
  /** The failure row's id and time; the actions apply to one exact failure. */
  failureId?: string;
  occurredAt?: string;
  timestampLabel?: string;
  /**
   * The platform's own sign-in control, when it has one (OpenCode's provider
   * credential action). Shown only for an authentication failure.
   */
  signIn?: ReactNode;
  /** `row`: a transcript row of its own. `inline`: inside a reply, after its parts. */
  placement?: "row" | "inline";
  /** Injected clock for tests. */
  now?: number;
}

/**
 * One presentation for every provider's failed turn: what happened in plain
 * words, the recovery the host can actually perform, and the provider's own
 * message behind a disclosure. The same reason reads the same whichever
 * agent hit it (`@orkestrator/protocol/provider-failures`).
 */
export function ProviderFailureAlert({
  text,
  failure,
  platform,
  failureId,
  occurredAt,
  timestampLabel,
  signIn,
  placement = "row",
  now,
}: ProviderFailureAlertProps) {
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [renderedAt] = useState(() => Date.now());
  const actions = useProviderFailureActions(failureId);
  const classification = classifyProviderFailure({
    reason: failure?.reason,
    text,
    resetsAt: failure?.resetsAt,
  });
  const { reason } = classification;
  const agentLabel = platform ? AGENT_PLATFORM_LABELS[platform] : undefined;
  const { title, explanation } = providerFailurePresentation(reason, agentLabel);
  const remedies = supportedProviderFailureRemedies(reason, {
    "sign-in": signIn !== undefined && signIn !== null,
    retry: Boolean(actions.retry && failureId && occurredAt),
    "change-model": Boolean(actions.changeModel),
  });
  const resetTime = formatProviderFailureReset(classification.resetsAt, now ?? renderedAt);
  const resetLine = resetTime
    ? `The limit resets at ${resetTime}.`
    : classification.resetHint
      ? `${agentLabel ?? "The provider"} says it resets ${classification.resetHint}.`
      : undefined;
  const details = text.trim();
  const transient = TRANSIENT.has(reason);

  return (
    <div className={cn(placement === "row" && "px-2 @sm:px-4 py-3")}>
      <div className={cn(placement === "row" && "max-w-3xl mx-auto min-w-0")}>
        <div
          data-transcript-item="error"
          data-provider-failure={reason}
          role="group"
          aria-label={title}
          className={cn(
            "flex items-start gap-2 rounded-md border",
            placement === "row" ? "p-3" : "my-1 p-2.5",
            transient
              ? "border-amber-500/25 bg-amber-500/10"
              : "border-destructive/25 bg-destructive/10",
          )}
        >
          <AlertCircle
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0",
              transient ? "text-amber-500 dark:text-amber-400" : "text-failure",
            )}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">{title}</div>
            <p className="mt-0.5 text-sm text-muted-foreground break-words">{explanation}</p>
            {resetLine ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-foreground/90">
                <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                {resetLine}
              </p>
            ) : null}
            {remedies.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {remedies.map((remedy) => {
                  if (remedy === "sign-in") return <div key={remedy}>{signIn}</div>;
                  if (remedy === "retry") {
                    return (
                      <Button
                        key={remedy}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={actions.retryUnavailableReason !== undefined}
                        onClick={() => actions.retry?.(failureId!, occurredAt!)}
                      >
                        <RotateCcw aria-hidden="true" />
                        Retry
                      </Button>
                    );
                  }
                  return (
                    <Button
                      key={remedy}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => actions.changeModel?.()}
                    >
                      <Sparkles aria-hidden="true" />
                      Change model
                    </Button>
                  );
                })}
                {remedies.includes("retry") && actions.retryUnavailableReason ? (
                  <span className="text-xs text-muted-foreground">
                    {actions.retryUnavailableReason}
                  </span>
                ) : null}
              </div>
            ) : null}
            {details ? (
              <div className="mt-2">
                <button
                  type="button"
                  aria-expanded={detailsOpen}
                  aria-controls={detailsId}
                  onClick={() => setDetailsOpen((open) => !open)}
                  className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight
                    className={cn("h-3 w-3 transition-transform", detailsOpen && "rotate-90")}
                    aria-hidden="true"
                  />
                  Details
                </button>
                <div
                  id={detailsId}
                  hidden={!detailsOpen}
                  data-agent-chat-search-content="true"
                  className="mt-1 max-h-64 overflow-auto rounded border border-border/60 bg-background/60 p-2 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap break-words"
                >
                  {details}
                </div>
              </div>
            ) : null}
            {timestampLabel ? (
              <div className="mt-1 text-[11px] text-muted-foreground">{timestampLabel}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
