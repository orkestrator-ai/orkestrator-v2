import { useEffect, useState } from "react";
import { Inbox, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  FLOATING_NOTICE_ACTION,
  FloatingNotice,
  type FloatingNoticeTone,
} from "@/components/ui/floating-notice";
import type { AgentMailApi } from "@/lib/backend/agent-mail";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { agentMailSenderLabel } from "@/lib/chat/client-only-messages";
import {
  deliverNowNotice,
  formatAgentMailTime,
  openAgentMailForTab,
  useAgentMailScope,
} from "./agent-mail-ui";
import {
  AGENT_MAIL_HOURLY_LIMIT_REASON,
  agentMailAwaitingAgent,
  agentMailReleaseRefusal,
  isAgentMailBudgetHeld,
} from "@orkestrator/protocol/agent-mail";
import { COORDINATOR_DELEGATION_HOLD_REASON } from "@orkestrator/protocol/coordinator";

/** One summary read in flight per node, keyed by that node's store action (plan item 3010). */
const summaryHydrations = new WeakMap<() => Promise<void>, Promise<void>>();

function ensureSummaryHydrated(refresh: () => Promise<void>): void {
  if (summaryHydrations.has(refresh)) return;
  summaryHydrations.set(
    refresh,
    refresh()
      .catch(() => undefined)
      .finally(() => {
        summaryHydrations.delete(refresh);
      }),
  );
}

export function AgentMailBanner({
  environmentId,
  tabId,
  agentAvailable = true,
  deliveryHeldReason,
}: {
  environmentId: string;
  tabId: string;
  agentAvailable?: boolean;
  /** This recipient can be read, but delivery waits for this hold to clear. */
  deliveryHeldReason?: string;
}) {
  const mailboxId = `${environmentId}\0${tabId}`;
  const entry = useAgentMailStore((state) => state.summary.get(mailboxId));
  const mailbox = useAgentMailStore((state) => state.mailboxes.get(mailboxId));
  const refreshMailbox = useAgentMailStore((state) => state.refreshMailbox);
  const refreshSummary = useAgentMailStore((state) => state.refreshSummary);
  const { scope, api } = useAgentMailScope();
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
  const paused = messages.find(isAgentMailBudgetHeld);
  const pending = messages.find((message) => message.placement === "pending-inject");
  const delegationHeld = messages.find(
    (message) =>
      message.placement === "inject-held" &&
      message.placementReason === COORDINATOR_DELEGATION_HOLD_REASON,
  );
  const capabilities = mailbox?.descriptor.capabilities;
  const awaitingAgent = capabilities
    ? messages.filter((message) => agentMailAwaitingAgent(message, capabilities))
    : [];
  // Mail the policy left in the inbox. Delivered and expired mail the agent
  // never acknowledged is not waiting, so it is not counted here.
  const inInbox =
    awaitingAgent.length === 0 && mailbox?.descriptor.injectPolicy === "off"
      ? messages.filter(
          (message) => message.placement === "stored" && !message.ackedAt && !message.discardedAt,
        )
      : [];
  const refusalOf = (message: (typeof messages)[number]) =>
    mailbox
      ? agentMailReleaseRefusal(message, {
          mutedInbound: mailbox.descriptor.mutedInbound,
          canInject: mailbox.descriptor.capabilities.canInject,
        })
      : null;
  const releasable = inInbox.filter((message) => !refusalOf(message));
  const blockedCount = inInbox.length - releasable.length;
  // Nothing in the inbox can be delivered: the card shows the warning tone.
  const undeliverable = releasable.length === 0 && blockedCount > 0;
  if (
    !failed &&
    !paused &&
    !pending &&
    inInbox.length === 0 &&
    awaitingAgent.length === 0 &&
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
      await api.retryAgentMailInject(environmentId, tabId, messageId);
      await refresh();
    } catch (error) {
      reportActionError("retry message delivery", error);
    }
  };
  const discard = async (messageId: string) => {
    setActionError(undefined);
    try {
      await api.discardAgentMailInject(environmentId, tabId, messageId);
      await refresh();
    } catch (error) {
      reportActionError("discard message", error);
    }
  };
  const deliver = async () => {
    // A pending message is already queued with the rest; releasing it steers
    // the queue. Inbox mail is released message by message, all of it.
    // Snapshots sort newest first, retaining send order for timestamp ties.
    // Stable ascending sort keeps that tie order while releasing context first.
    const deliverable = pending
      ? [pending]
      : releasable.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (deliverable.length === 0) return;
    setActionError(undefined);
    const failures: string[] = [];
    let result: Awaited<ReturnType<AgentMailApi["deliverAgentMailNow"]>> | undefined;
    for (const message of deliverable) {
      try {
        result = await api.deliverAgentMailNow(environmentId, tabId, message.id);
      } catch (error) {
        failures.push(`${message.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Reconcile even after partial success or a refusal; queued mail may have
    // changed while requests were in flight.
    try {
      await refresh();
    } catch (error) {
      failures.push(`Refresh: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (failures.length > 0) {
      reportActionError("deliver messages", new Error(failures.join("; ")));
    } else {
      const notice = result ? deliverNowNotice(result) : null;
      if (notice) toast.info(notice.title, { description: notice.description });
    }
  };
  let text = "Message waiting";
  if (failed) text = `Delivery failed: ${failed.placementReason || "unknown reason"}`;
  else if (paused)
    text =
      paused.placementReason === AGENT_MAIL_HOURLY_LIMIT_REASON
        ? "Delivery paused: hourly limit · resumes on its own"
        : "Delivery paused: loop budget";
  else if (deliveryHeldReason) text = `Delivery waiting: ${deliveryHeldReason}`;
  else if (pending?.placementReason === "retrying")
    text = "Delivery was refused · retrying automatically";
  else if (pending?.placementReason === "verifying")
    text = "Checking whether the last delivery arrived · retries automatically";
  else if (pending?.placementReason === "steer-unsupported")
    text = "This agent can't take messages mid-turn · delivers when the turn ends";
  else if (pending?.placementReason === "steer-too-large")
    text = "Message too large for mid-turn delivery · delivers in full when the turn ends";
  else if (pending?.placementReason === "steer-refused")
    text = "Couldn't deliver into the running turn · delivers when the turn ends";
  else if (delegationHeld) text = "Worker report waiting · delivers when the worker turn ends";
  else if (awaitingAgent.length > 0)
    text = `${awaitingAgent.length} message${awaitingAgent.length === 1 ? "" : "s"} in inbox · ${agentAvailable ? "waiting for an agent" : "enable a qualified agent in Settings"}`;
  else if (descriptor?.presence === "draft")
    text = "Delivery waiting: you have unsent text in the composer";
  else if (pending)
    text = `${entry.pendingInjectCount} message${entry.pendingInjectCount === 1 ? "" : "s"} waiting · delivers when this agent is idle`;
  else if (releasable.length > 0) {
    const count = releasable.length;
    text = `${count} message${count === 1 ? "" : "s"} in inbox · pull only`;
    if (blockedCount > 0) text += ` · ${blockedCount} can't be delivered`;
  } else if (blockedCount > 0)
    text = `${blockedCount} message${blockedCount === 1 ? "" : "s"} in inbox · ${refusalOf(inInbox[0]!)}`;
  else
    text = `${entry.pendingInjectCount} message${entry.pendingInjectCount === 1 ? "" : "s"} waiting · delivers when this agent is idle`;

  if (deliveryHeldReason && (failed || paused)) text += ` · ${deliveryHeldReason}`;

  const tone: FloatingNoticeTone = failed
    ? "error"
    : paused || awaitingAgent.length > 0 || undeliverable
      ? "warning"
      : "info";
  const count = Math.max(
    1,
    awaitingAgent.length || inInbox.length || entry.pendingInjectCount + entry.failedInjectCount,
  );
  const newest =
    failed ??
    paused ??
    pending ??
    delegationHeld ??
    awaitingAgent[0] ??
    releasable[0] ??
    inInbox[0];

  const actions = (
    <>
      {failed && (
        <>
          <Button
            size="sm"
            variant="secondary"
            className={FLOATING_NOTICE_ACTION}
            disabled={deliveryHeldReason !== undefined}
            onClick={() => void retry(failed.id)}
          >
            <RotateCcw className="size-3" />
            Retry
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={FLOATING_NOTICE_ACTION}
            onClick={() => void discard(failed.id)}
          >
            Discard
          </Button>
        </>
      )}
      {paused && (
        <Button
          size="sm"
          variant="secondary"
          className={FLOATING_NOTICE_ACTION}
          disabled={deliveryHeldReason !== undefined}
          onClick={() => void retry(paused.id)}
        >
          Resume
        </Button>
      )}
      {!deliveryHeldReason && (pending || releasable.length > 0) && (
        <Button
          size="sm"
          variant="secondary"
          className={FLOATING_NOTICE_ACTION}
          onClick={() => void deliver()}
        >
          Deliver now
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className={FLOATING_NOTICE_ACTION}
        onClick={() => openAgentMailForTab(environmentId, tabId, "inbox", scope)}
      >
        View
      </Button>
    </>
  );
  const sender = newest ? agentMailSenderLabel(newest.from) : undefined;
  const time = newest ? formatAgentMailTime(newest.createdAt) : "";

  return (
    <FloatingNotice
      tone={tone}
      label="Agent mail"
      summary={text}
      icon={Inbox}
      pill={count}
      onDismiss={() => setDismissedRevision(entry.revision)}
      dismissLabel="Dismiss agent mail notice"
      actions={actions}
    >
      {/* Wraps rather than truncates: the reason is what the person acts on. */}
      <p>{text}</p>
      {newest && (
        <div className="mt-2 border-t border-border pt-2">
          <p className="truncate text-muted-foreground">
            {sender}
            {time ? ` · ${time}` : ""}
          </p>
          {newest.subject && (
            <p className="mt-0.5 line-clamp-2 text-foreground/90">{newest.subject}</p>
          )}
        </div>
      )}
      {actionError && (
        <p role="alert" className="mt-2 line-clamp-3 text-failure" title={actionError}>
          {actionError}
        </p>
      )}
    </FloatingNotice>
  );
}
