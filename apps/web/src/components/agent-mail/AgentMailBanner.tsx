import { useEffect, useState } from "react";
import { AlertTriangle, Inbox, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { openAgentMailForTab } from "./AgentMailButton";

let summaryHydration: Promise<void> | null = null;

function ensureSummaryHydrated(refresh: () => Promise<void>): void {
  if (summaryHydration) return;
  summaryHydration = refresh()
    .catch(() => undefined)
    .finally(() => {
      summaryHydration = null;
    });
}

export function AgentMailBanner({
  environmentId,
  tabId,
}: {
  environmentId: string;
  tabId: string;
}) {
  const mailboxId = `${environmentId}\0${tabId}`;
  const entry = useAgentMailStore((state) => state.summary.get(mailboxId));
  const mailbox = useAgentMailStore((state) => state.mailboxes.get(mailboxId));
  const refreshMailbox = useAgentMailStore((state) => state.refreshMailbox);
  const refreshSummary = useAgentMailStore((state) => state.refreshSummary);
  const [dismissedRevision, setDismissedRevision] = useState<number>();
  const [actionError, setActionError] = useState<string>();

  useEffect(() => ensureSummaryHydrated(refreshSummary), [refreshSummary]);

  useEffect(() => {
    if (
      !entry ||
      (entry.pendingInjectCount === 0 &&
        entry.failedInjectCount === 0 &&
        entry.agentUnackedCount === 0)
    )
      return;
    void refreshMailbox(environmentId, tabId).catch(() => undefined);
  }, [entry, environmentId, refreshMailbox, tabId]);

  if (!entry || dismissedRevision === entry.revision) return null;
  const messages = mailbox?.messages ?? [];
  const failed = messages.find((message) => message.placement === "inject_failed");
  const paused = messages.find(
    (message) =>
      message.placement === "inject-held" && message.placementReason === "loop-budget-exhausted",
  );
  const pending = messages.find((message) => message.placement === "pending-inject");
  const pullOnly = messages.find(
    (message) =>
      message.placement === "stored" &&
      !message.ackedAt &&
      !message.discardedAt &&
      mailbox?.descriptor.injectPolicy === "off",
  );
  if (
    !failed &&
    !paused &&
    !pending &&
    !pullOnly &&
    entry.pendingInjectCount === 0 &&
    entry.failedInjectCount === 0
  )
    return null;
  const descriptor = mailbox?.descriptor;
  const refresh = () => Promise.all([refreshMailbox(environmentId, tabId), refreshSummary()]);
  const reportActionError = (action: string, error: unknown) => {
    setActionError(error instanceof Error ? error.message : String(error));
    toast.error(`Could not ${action}`, {
      description: error instanceof Error ? error.message : String(error),
    });
  };
  const retry = async (messageId: string) => {
    setActionError(undefined);
    try {
      await backend.retryAgentMailInject(environmentId, tabId, messageId);
      await refresh();
    } catch (error) {
      reportActionError("retry message delivery", error);
    }
  };
  const discard = async (messageId: string) => {
    setActionError(undefined);
    try {
      await backend.discardAgentMailInject(environmentId, tabId, messageId);
      await refresh();
    } catch (error) {
      reportActionError("discard message", error);
    }
  };
  const deliver = async () => {
    const deliverable = pending ?? pullOnly;
    if (!deliverable) return;
    setActionError(undefined);
    if (descriptor?.presence !== "idle" && descriptor?.presence !== "unknown") {
      toast.info("Delivery is still waiting", {
        description:
          descriptor?.presence === "draft"
            ? "You have unsent text in the composer."
            : `Recipient is ${descriptor?.presence.replaceAll("_", " ")}.`,
      });
      return;
    }
    try {
      await backend.updateAgentMailboxPolicy({ environmentId, tabId, inject: "idle" });
      await backend.retryAgentMailInject(environmentId, tabId, deliverable.id);
      await refresh();
    } catch (error) {
      reportActionError("deliver message", error);
    }
  };
  let text = "Message waiting";
  if (failed) text = `Delivery failed: ${failed.placementReason || "unknown reason"}`;
  else if (paused) text = "Delivery paused: loop budget";
  else if (descriptor?.presence === "draft")
    text = "Delivery waiting: you have unsent text in the composer";
  else if (pullOnly) {
    const count = Math.max(1, entry.agentUnackedCount);
    text = `${count} message${count === 1 ? "" : "s"} in inbox · pull only`;
  } else
    text = `${entry.pendingInjectCount} message${entry.pendingInjectCount === 1 ? "" : "s"} waiting · delivers when this agent is idle`;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/25 bg-amber-400/[0.07] px-3 py-1.5 text-xs">
      {failed || paused ? (
        <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
      ) : (
        <Inbox className="h-3.5 w-3.5 text-cyan-300" />
      )}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {actionError && (
        <span role="alert" className="max-w-48 truncate text-red-300">
          {actionError}
        </span>
      )}
      {failed && (
        <>
          <Button size="sm" variant="ghost" onClick={() => void retry(failed.id)}>
            <RotateCcw className="mr-1 h-3 w-3" />
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void discard(failed.id)}>
            Discard
          </Button>
        </>
      )}
      {paused && (
        <Button size="sm" variant="ghost" onClick={() => void retry(paused.id)}>
          Resume
        </Button>
      )}
      {(pullOnly || (pending && descriptor?.injectPolicy === "off")) && (
        <Button size="sm" variant="ghost" onClick={() => openAgentMailForTab(environmentId, tabId)}>
          Open inbox
        </Button>
      )}
      {(pending || pullOnly) && (
        <Button size="sm" variant="ghost" onClick={() => void deliver()}>
          {descriptor?.injectPolicy === "off" ? "Switch to deliver when idle" : "Deliver now"}
        </Button>
      )}
      <button
        type="button"
        aria-label="Dismiss agent mail notice"
        onClick={() => setDismissedRevision(entry.revision)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
