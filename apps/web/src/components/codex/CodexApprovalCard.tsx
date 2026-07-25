import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileDiff, Globe, ShieldAlert, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { respondToApproval } from "@/lib/codex-client";
import { useCodexStore } from "@/stores/codexStore";
import type {
  CodexApproval,
  CodexApprovalDecision,
  CodexClient,
} from "@/lib/codex-client";

interface CodexApprovalCardProps {
  approval: CodexApproval;
  client: CodexClient;
  sessionId: string;
  sessionKey: string;
}

/** Formats the remaining time as `m:ss`, or null once expired. */
function formatRemaining(msRemaining: number): string | null {
  /**
   * Fail closed on a deadline we cannot read.
   *
   * A missing or non-numeric `expiresAt` used to render `NaN:NaN` next to live
   * Approve/Decline buttons. This card is the control that runs commands, so an
   * approval we cannot describe must look inert rather than actionable.
   */
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return null;
  const totalSeconds = Math.ceil(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Live countdown to the bridge's auto-deny.
 *
 * Shown because the deadline is real and silent: if the user walks away the
 * request is denied and the turn continues without it, so a card with no visible
 * clock would be misleading.
 */
function useCountdown(expiresAt: number): string | null {
  const [remaining, setRemaining] = useState(() => formatRemaining(expiresAt - Date.now()));

  useEffect(() => {
    const update = () => setRemaining(formatRemaining(expiresAt - Date.now()));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return remaining;
}

function ApprovalIcon({ approval }: { approval: CodexApproval }) {
  if (approval.kind === "permissions") {
    return <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />;
  }
  if (approval.kind === "file-change") {
    return <FileDiff className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />;
  }
  if (approval.networkHost) {
    return <Globe className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />;
  }
  return <Terminal className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />;
}

function approvalTitle(approval: CodexApproval): string {
  switch (approval.kind) {
    case "command":
      return approval.networkHost
        ? `Codex wants to reach ${approval.networkHost}`
        : "Codex wants to run a command";
    case "file-change":
      return "Codex wants to change files";
    case "permissions":
      return "Codex wants additional permissions";
  }
}

/**
 * Prompt for one pending approval.
 *
 * The turn is blocked while this is on screen, so the card is deliberately loud
 * and the destructive option is not the visually dominant one — a mis-click should
 * fall towards declining, which is also what happens on timeout.
 */
export function CodexApprovalCard({
  approval,
  client,
  sessionId,
  sessionKey,
}: CodexApprovalCardProps) {
  const removePendingApproval = useCodexStore((state) => state.removePendingApproval);
  const [submitting, setSubmitting] = useState<CodexApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remaining = useCountdown(approval.expiresAt);

  const respond = useCallback(
    async (decision: CodexApprovalDecision) => {
      if (submitting) return;
      setSubmitting(decision);
      setError(null);

      const result = await respondToApproval(client, sessionId, approval.approvalId, decision);

      if (result === "applied" || result === "stale" || result === "forbidden") {
        // `stale` and `forbidden` both mean this card can no longer do anything, so
        // it must go — leaving it would invite the user to click forever.
        removePendingApproval(sessionKey, approval.approvalId);
        return;
      }

      // Only a transport/server error is retryable, so only that keeps the card.
      setError("Could not send your decision. Please try again.");
      setSubmitting(null);
    },
    [approval.approvalId, client, removePendingApproval, sessionId, sessionKey, submitting],
  );

  const expired = remaining === null;

  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
      role="group"
      aria-label={approvalTitle(approval)}
    >
      <div className="flex items-start gap-2">
        <ApprovalIcon approval={approval} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-foreground">{approvalTitle(approval)}</span>
            {!expired && (
              <span
                className="shrink-0 text-xs tabular-nums text-muted-foreground"
                // Announced politely: it updates every second and would otherwise
                // spam a screen reader.
                aria-live="off"
              >
                {remaining}
              </span>
            )}
          </div>

          {approval.reason && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{approval.reason}</p>
          )}

          {approval.command && (
            <pre className="mt-2 overflow-x-auto rounded border border-border/60 bg-background/60 p-2 text-xs">
              <code>{approval.command}</code>
            </pre>
          )}

          {approval.cwd && (
            <p className="mt-1 truncate text-xs text-muted-foreground" title={approval.cwd}>
              in {approval.cwd}
            </p>
          )}

          {approval.changes && approval.changes.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {approval.changes.map((change) => (
                <li key={change.path} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "w-12 shrink-0 font-mono",
                      change.kind === "add" && "text-emerald-500",
                      change.kind === "delete" && "text-red-500",
                      change.kind === "update" && "text-muted-foreground",
                    )}
                  >
                    {change.kind}
                  </span>
                  <span className="truncate" title={change.path}>
                    {change.path}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {approval.permissions && (
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {approval.permissions.network && <li>Network access</li>}
              {approval.permissions.fileSystem && <li>Filesystem access beyond the workspace</li>}
            </ul>
          )}

          {approval.grantRoot && (
            <p className="mt-1 text-xs text-muted-foreground">
              Requests write access under <code>{approval.grantRoot}</code> for the rest of the
              session.
            </p>
          )}

          {expired ? (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              This request expired and was declined.
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="default"
                disabled={submitting !== null}
                onClick={() => void respond("deny")}
              >
                {submitting === "deny" ? "Declining…" : "Decline"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={submitting !== null}
                onClick={() => void respond("cancel")}
              >
                {submitting === "cancel" ? "Cancelling…" : "Cancel turn"}
              </Button>
              {/*
                * Deliberately quieter than "Approve": it is the much broader
                * grant ("yes, and stop asking"), so it must not read as an
                * equal-weight alternative to approving this one request.
                */}
              {approval.supportsApproveForSession && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={submitting !== null}
                  onClick={() => void respond("approve-for-session")}
                >
                  {submitting === "approve-for-session" ? "Approving…" : "Approve for session"}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={submitting !== null}
                onClick={() => void respond("approve")}
              >
                {submitting === "approve" ? "Approving…" : "Approve"}
              </Button>
            </div>
          )}

          {error && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
