import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Inbox, Loader2, RotateCcw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useConfigStore } from "@/stores/configStore";
import * as backend from "@/lib/backend";
import type {
  AgentMailMessage,
  AgentMailMessageSummary,
  MailboxDescriptor,
} from "@orkestrator/protocol/agent-mail";
import { AGENT_MAIL_DEFAULT_LIST_LIMIT } from "@orkestrator/protocol/agent-mail";

const OPEN_EVENT = "orkestrator:open-agent-mail";

export function openAgentMailForTab(
  environmentId: string,
  tabId: string,
  mode: "inbox" | "compose" | "settings" = "inbox",
): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { environmentId, tabId, mode } }));
}

function senderLabel(message: Pick<AgentMailMessage, "from">): string {
  if (message.from.kind === "user") return "You";
  if (message.from.kind === "external") return "External client";
  if (message.from.kind === "system") return "Orkestrator workflow";
  if (message.from.kind === "coordinator") return message.from.title || "Project coordinator";
  return message.from.title || `${message.from.environmentId} / ${message.from.tabId}`;
}

function policyLabel(mailbox: MailboxDescriptor): string {
  if (mailbox.mutedInbound) return "muted";
  return mailbox.injectPolicy === "idle" ? "deliver when idle" : "pull only";
}

function sendLabel(mailbox: MailboxDescriptor | undefined): string {
  if (!mailbox) return "Send message";
  if (mailbox.injectPolicy === "off") return "Send · pull only";
  if (mailbox.presence === "idle") return "Send · recipient idle, delivers now";
  if (mailbox.presence === "draft") return "Send · recipient is composing";
  return "Send · recipient busy, delivers when idle";
}

function messageStatusLabel(
  mailbox: MailboxDescriptor,
  message: AgentMailMessageSummary,
  sent: boolean,
): string {
  if (
    sent &&
    mailbox.presence === "draft" &&
    (message.placement === "pending-inject" || message.placement === "inject-held")
  ) {
    return "recipient is composing";
  }
  return message.placement;
}

type MessageRow = { mailbox: MailboxDescriptor; message: AgentMailMessageSummary; sent: boolean };

type MailboxAddress = { environmentId: string; tabId: string };

function mailboxIdOf(address: MailboxAddress): string {
  return `${address.environmentId}\0${address.tabId}`;
}

/**
 * The single agent-mail surface: the inbox button in the window's top-right
 * corner. Per-tab entry points ("Message this tab…", "Inbox settings…", the
 * delivery banner) route here through `openAgentMailForTab`, which opens this
 * dropdown with the tab's mailbox preselected.
 */
export function AgentMailButton() {
  const summary = useAgentMailStore((state) => state.summary);
  const mailboxes = useAgentMailStore((state) => state.mailboxes);
  const failedSent = useAgentMailStore((state) => state.failedSent);
  const refreshSummary = useAgentMailStore((state) => state.refreshSummary);
  const refreshMailbox = useAgentMailStore((state) => state.refreshMailbox);
  const refreshInbox = useAgentMailStore((state) => state.refreshInbox);
  const trackSent = useAgentMailStore((state) => state.trackSent);
  const clearFailedSent = useAgentMailStore((state) => state.clearFailedSent);
  const messagingEnabled = useConfigStore(
    (state) => state.config.global.agentMessaging?.enabled === true,
  );
  const allowCrossProject = useConfigStore(
    (state) => state.config.global.agentMessaging?.allowCrossProject === true,
  );
  const unread = useMemo(
    () =>
      Array.from(summary.values()).reduce(
        (total, entry) => total + (entry.userUnseenCount ?? entry.unreadCount),
        0,
      ),
    [summary],
  );
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [directory, setDirectory] = useState<MailboxDescriptor[]>([]);
  const [sent, setSent] = useState<AgentMailMessageSummary[]>([]);
  const [box, setBox] = useState<"inbox" | "sent">("inbox");
  const [expanded, setExpanded] = useState<AgentMailMessage | null>(null);
  const [compose, setCompose] = useState(false);
  const [destination, setDestination] = useState("");
  const [focus, setFocus] = useState<MailboxAddress | null>(null);
  const [focusUnavailable, setFocusUnavailable] = useState(false);
  const [replyToMessageId, setReplyToMessageId] = useState<string>();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "unread" | "retry">("all");
  const [actionError, setActionError] = useState<string>();
  const sendAttempt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const destinationRef = useRef("");
  const focusRef = useRef<MailboxAddress | null>(null);
  const hydrateGeneration = useRef(0);

  const hydrate = useCallback(
    async (requestedFocus?: MailboxAddress | null) => {
      const activeFocus = requestedFocus === undefined ? focusRef.current : requestedFocus;
      const generation = ++hydrateGeneration.current;
      const focusedMailboxId = activeFocus ? mailboxIdOf(activeFocus) : null;
      const cachedFocus = focusedMailboxId
        ? useAgentMailStore.getState().mailboxes.get(focusedMailboxId)
        : undefined;
      setLoading(true);
      setFocusUnavailable(false);
      setActionError(undefined);
      try {
        const [snapshot, sentMessages] = await Promise.all([
          refreshInbox(),
          backend.listAgentMailSent(activeFocus ?? undefined),
        ]);
        const availableById = new Map(
          snapshot.directory
            .filter((mailbox) => mailbox.capabilities.canPull)
            .map((mailbox) => [mailbox.mailboxId, mailbox]),
        );
        // A descriptor can appear between the inbox snapshot and this lookup as
        // pane-layout synchronization completes. Bound historical recipient
        // backfill so opening the global surface cannot scale with all history.
        const missing = new Map<string, MailboxAddress>();
        if (activeFocus && focusedMailboxId && !availableById.has(focusedMailboxId)) {
          missing.set(focusedMailboxId, activeFocus);
        }
        for (const message of (sentMessages ?? []).slice(0, AGENT_MAIL_DEFAULT_LIST_LIMIT)) {
          if (missing.size >= AGENT_MAIL_DEFAULT_LIST_LIMIT) break;
          const recipient = { environmentId: message.toEnvironmentId, tabId: message.toTabId };
          if (!availableById.has(mailboxIdOf(recipient)))
            missing.set(mailboxIdOf(recipient), recipient);
        }
        let inspectedSenders = 0;
        senderBackfill: for (const mailbox of useAgentMailStore.getState().mailboxes.values()) {
          for (const message of mailbox.messages) {
            if (
              missing.size >= AGENT_MAIL_DEFAULT_LIST_LIMIT ||
              inspectedSenders >= AGENT_MAIL_DEFAULT_LIST_LIMIT
            )
              break senderBackfill;
            inspectedSenders += 1;
            if (message.from.kind !== "tab" && message.from.kind !== "coordinator") continue;
            const sender = { environmentId: message.from.environmentId, tabId: message.from.tabId };
            if (!availableById.has(mailboxIdOf(sender))) missing.set(mailboxIdOf(sender), sender);
          }
        }
        if (missing.size > 0) {
          const fetched = await backend.getAgentMailMailboxes(Array.from(missing.values()));
          if (generation !== hydrateGeneration.current) return;
          for (const mailbox of fetched.mailboxes) {
            if (mailbox.descriptor.capabilities.canPull)
              availableById.set(mailbox.descriptor.mailboxId, mailbox.descriptor);
          }
          if (activeFocus && focusedMailboxId) {
            const focused = fetched.mailboxes.filter(
              (mailbox) => mailbox.descriptor.mailboxId === focusedMailboxId,
            );
            if (focused.length > 0) useAgentMailStore.getState().setMailboxes(focused);
          }
        }
        if (generation !== hydrateGeneration.current) return;
        setDirectory(Array.from(availableById.values()));
        setSent(sentMessages ?? []);
        if (activeFocus && focusedMailboxId && !availableById.has(focusedMailboxId)) {
          setFocusUnavailable(true);
          setActionError("This tab's mailbox is not ready yet. Try again in a moment.");
        }
      } catch (error) {
        if (generation !== hydrateGeneration.current) return;
        if (cachedFocus) {
          if (!useAgentMailStore.getState().mailboxes.has(cachedFocus.descriptor.mailboxId))
            useAgentMailStore.getState().setMailbox(cachedFocus);
          setDirectory((current) => [
            cachedFocus.descriptor,
            ...current.filter((mailbox) => mailbox.mailboxId !== cachedFocus.descriptor.mailboxId),
          ]);
        }
        if (activeFocus) {
          setFocusUnavailable(true);
          setActionError(
            cachedFocus
              ? "Could not refresh this mailbox. Showing the last available snapshot."
              : "This tab's mailbox could not be loaded. Try again in a moment.",
          );
        }
        toast.error("Could not load agent messages", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (generation === hydrateGeneration.current) setLoading(false);
      }
    },
    [refreshInbox],
  );

  useEffect(() => {
    const listener = (raw: Event) => {
      const detail = (raw as CustomEvent).detail as
        | { environmentId?: string; tabId?: string; mode?: string }
        | undefined;
      if (!detail?.environmentId || !detail.tabId) return;
      const nextFocus = { environmentId: detail.environmentId, tabId: detail.tabId };
      const nextDestination = mailboxIdOf(nextFocus);
      focusRef.current = nextFocus;
      setFocus(nextFocus);
      setOpen(true);
      if (destinationRef.current !== nextDestination) {
        setSubject("");
        setBody("");
        sendAttempt.current = null;
      }
      destinationRef.current = nextDestination;
      setDestination(nextDestination);
      setReplyToMessageId(undefined);
      setActionError(undefined);
      setFocusUnavailable(false);
      setExpanded(null);
      setBox("inbox");
      setCompose(detail.mode === "compose");
      void hydrate(nextFocus);
    };
    window.addEventListener(OPEN_EVENT, listener);
    return () => window.removeEventListener(OPEN_EVENT, listener);
  }, [hydrate]);

  useEffect(() => {
    if (failedSent.size === 0) return;
    for (const message of failedSent.values())
      toast.error("Agent message delivery failed", {
        description: message.placementReason || "The recipient rejected delivery.",
      });
    clearFailedSent();
  }, [clearFailedSent, failedSent]);

  useEffect(() => {
    if (!expanded) return;
    const authoritative =
      Array.from(mailboxes.values())
        .flatMap((mailbox) => mailbox.messages)
        .find((message) => message.id === expanded.id) ??
      sent.find((message) => message.id === expanded.id);
    if (!authoritative || authoritative.revision > expanded.revision) setExpanded(null);
  }, [expanded, mailboxes, sent]);

  const focusedMailboxId = focus ? mailboxIdOf(focus) : null;
  const inboxRows: MessageRow[] = Array.from(mailboxes.values())
    .filter((mailbox) => !focusedMailboxId || mailbox.descriptor.mailboxId === focusedMailboxId)
    .flatMap((mailbox) =>
      mailbox.messages.map((message) => ({ mailbox: mailbox.descriptor, message, sent: false })),
    );
  const sentRows: MessageRow[] = sent.flatMap((message) => {
    const mailbox = directory.find(
      (candidate) =>
        candidate.environmentId === message.toEnvironmentId && candidate.tabId === message.toTabId,
    );
    return mailbox ? [{ mailbox, message, sent: true }] : [];
  });
  const rows = (box === "sent" ? sentRows : inboxRows)
    .filter(({ mailbox }) => !projectFilter || mailbox.projectId === projectFilter)
    .filter(({ message }) =>
      statusFilter === "unread"
        ? !message.userSeenAt
        : statusFilter === "retry"
          ? message.placement === "inject_failed"
          : true,
    );
  const threads = Array.from(
    rows.reduce((grouped, row) => {
      const current = grouped.get(row.message.threadId) ?? [];
      current.push(row);
      grouped.set(row.message.threadId, current);
      return grouped;
    }, new Map<string, MessageRow[]>()),
    ([threadId, messages]) => ({
      threadId,
      messages: messages.toSorted((a, b) => b.message.createdAt.localeCompare(a.message.createdAt)),
    }),
  ).sort((a, b) =>
    b.messages[0]!.message.createdAt.localeCompare(a.messages[0]!.message.createdAt),
  );
  const projects = Array.from(
    new Map(directory.map((mailbox) => [mailbox.projectId, mailbox.projectName])).entries(),
  );
  const selectedMailbox = directory.find((candidate) => candidate.mailboxId === destination);
  const focusedMailbox = focusedMailboxId
    ? directory.find((candidate) => candidate.mailboxId === focusedMailboxId)
    : undefined;
  const policyMailbox = focus ? focusedMailbox : selectedMailbox;

  const read = async (mailbox: MailboxDescriptor, messageId: string, isSent: boolean) => {
    try {
      const message = await backend.getAgentMailMessage(
        mailbox.environmentId,
        mailbox.tabId,
        messageId,
      );
      setExpanded(message);
      if (!isSent && !message.userSeenAt)
        await backend.markAgentMailSeen(mailbox.environmentId, mailbox.tabId, messageId);
      await Promise.all([refreshMailbox(mailbox.environmentId, mailbox.tabId), refreshSummary()]);
    } catch (error) {
      toast.error("Could not read message", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const updatePolicy = async (updates: {
    inject?: "inherit" | "off" | "idle";
    mutedInbound?: boolean;
    mutedOutbound?: boolean;
  }) => {
    if (!policyMailbox) {
      setActionError("Select an available mailbox before changing its settings.");
      return;
    }
    setActionError(undefined);
    try {
      await backend.updateAgentMailboxPolicy({
        environmentId: policyMailbox.environmentId,
        tabId: policyMailbox.tabId,
        ...updates,
      });
      await hydrate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      toast.error("Could not update inbox settings", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const retryMessage = async (mailbox: MailboxDescriptor, messageId: string) => {
    setActionError(undefined);
    try {
      await backend.retryAgentMailInject(mailbox.environmentId, mailbox.tabId, messageId);
      await hydrate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      toast.error("Could not retry message delivery", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const discardMessage = async (mailbox: MailboxDescriptor, messageId: string) => {
    setActionError(undefined);
    try {
      await backend.discardAgentMailInject(mailbox.environmentId, mailbox.tabId, messageId);
      await hydrate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      toast.error("Could not discard message", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const sendMessage = async () => {
    const mailbox = selectedMailbox;
    if (!mailbox) {
      setActionError("Select an available mailbox before sending this message.");
      toast.error("Message was not sent", {
        description: "The selected mailbox is not available.",
      });
      return;
    }
    if (!body.trim()) return;
    const payload = {
      toEnvironmentId: mailbox.environmentId,
      toTabId: mailbox.tabId,
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      body: body.trim(),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    };
    const fingerprint = JSON.stringify(payload);
    if (sendAttempt.current?.fingerprint !== fingerprint)
      sendAttempt.current = { fingerprint, requestId: crypto.randomUUID() };
    try {
      const message = await backend.sendAgentMail({
        requestId: sendAttempt.current.requestId,
        ...payload,
      });
      trackSent(message);
      if (message.placement === "bounced" || message.placement === "undeliverable") {
        sendAttempt.current = null;
        toast.error("Message was not delivered", {
          description: message.placementReason || message.placement,
        });
        return;
      }
      sendAttempt.current = null;
      setBody("");
      setSubject("");
      setReplyToMessageId(undefined);
      setCompose(false);
      toast.success("Message sent", { description: sendLabel(mailbox).replace("Send · ", "") });
      await hydrate();
    } catch (error) {
      toast.error("Message was not sent", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (!messagingEnabled) return null;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          focusRef.current = null;
          setFocus(null);
          setFocusUnavailable(false);
          void hydrate(null);
        }
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-7 w-7"
          aria-label={unread ? `Agent inbox, ${unread} unseen` : "Agent inbox"}
        >
          <Inbox className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-cyan-400 px-1 font-mono text-[9px] leading-4 text-zinc-950">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(94vw,470px)] border-zinc-700/80 bg-zinc-950 p-0 shadow-2xl"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">
                {focusedMailbox?.displayName || "Agent messages"}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {focusedMailbox
                  ? `${focusedMailbox.environmentName} · ${focusedMailbox.presence.replaceAll("_", " ")}`
                  : "Durable messages across every environment"}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setCompose((value) => !value)}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              New
            </Button>
          </div>
          {policyMailbox && (
            <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
              <select
                aria-label="Automatic delivery policy"
                value={policyMailbox.injectOverride ?? "inherit"}
                onChange={(event) =>
                  void updatePolicy({ inject: event.target.value as "inherit" | "off" | "idle" })
                }
                className="h-8 rounded-md border border-border/70 bg-input-surface px-2"
              >
                <option value="inherit">Inherit global</option>
                <option value="off">Pull only</option>
                {policyMailbox.capabilities.canInject && <option value="idle">Deliver idle</option>}
              </select>
              <Button
                size="sm"
                variant={policyMailbox.mutedInbound ? "secondary" : "outline"}
                onClick={() => void updatePolicy({ mutedInbound: !policyMailbox.mutedInbound })}
              >
                {policyMailbox.mutedInbound ? "Inbound muted" : "Mute inbound"}
              </Button>
              <Button
                size="sm"
                variant={policyMailbox.mutedOutbound ? "secondary" : "outline"}
                onClick={() => void updatePolicy({ mutedOutbound: !policyMailbox.mutedOutbound })}
              >
                {policyMailbox.mutedOutbound ? "Outbound muted" : "Mute outbound"}
              </Button>
              <p className="col-span-3 text-muted-foreground">
                {policyMailbox.injectOverride === "inherit"
                  ? `Inherits global: ${policyMailbox.injectPolicy}`
                  : `Mailbox policy: ${policyLabel(policyMailbox)}`}
              </p>
            </div>
          )}
        </div>
        {actionError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300"
          >
            <span>{actionError}</span>
            {focusUnavailable && (
              <Button size="sm" variant="outline" onClick={() => void hydrate()} disabled={loading}>
                Retry
              </Button>
            )}
          </div>
        )}
        {compose && (
          <div className="space-y-2 border-b border-cyan-400/20 bg-cyan-400/[0.035] p-3">
            <select
              aria-label="Message destination"
              value={destination}
              onChange={(event) => {
                destinationRef.current = event.target.value;
                setDestination(event.target.value);
              }}
              disabled={focus !== null}
              className="h-9 w-full rounded-md border border-border/70 bg-input-surface px-3 text-xs"
            >
              <option value="">Choose a destination…</option>
              {directory
                .filter((mailbox) => !mailbox.tombstonedAt && mailbox.capabilities.canPull)
                .filter((mailbox) => !focusedMailboxId || mailbox.mailboxId === focusedMailboxId)
                .map((mailbox) => (
                  <option key={mailbox.mailboxId} value={mailbox.mailboxId}>
                    {mailbox.displayName} · {mailbox.environmentName} · {policyLabel(mailbox)}
                  </option>
                ))}
            </select>
            <div className="max-h-36 space-y-1 overflow-y-auto">
              {directory
                .filter((mailbox) => !mailbox.tombstonedAt && mailbox.capabilities.canPull)
                .filter((mailbox) => !focusedMailboxId || mailbox.mailboxId === focusedMailboxId)
                .map((mailbox) => (
                  <button
                    key={mailbox.mailboxId}
                    type="button"
                    onClick={() => {
                      destinationRef.current = mailbox.mailboxId;
                      setDestination(mailbox.mailboxId);
                    }}
                    className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left ${
                      destination === mailbox.mailboxId
                        ? "border-cyan-400/40 bg-cyan-400/10"
                        : "border-zinc-800 bg-black/20"
                    }`}
                  >
                    {mailbox.agent && (
                      <AgentPlatformIcon platform={mailbox.agent} accent className="h-3.5 w-3.5" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {mailbox.displayName}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {mailbox.environmentName}
                        {allowCrossProject ? ` · ${mailbox.projectName}` : ""}
                      </span>
                    </span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px]">
                      {mailbox.presence.replaceAll("_", " ")}
                    </span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px]">
                      {policyLabel(mailbox)}
                    </span>
                  </button>
                ))}
            </div>
            <Input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={200}
              placeholder="Subject (optional)"
              className="h-8 text-xs"
            />
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Markdown message"
              className="min-h-20 text-xs"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => void sendMessage()}
                disabled={!selectedMailbox || !body.trim()}
              >
                {sendLabel(selectedMailbox)}
              </Button>
            </div>
          </div>
        )}
        <div className="flex items-center gap-1 border-b border-zinc-800 p-2">
          <Button
            size="sm"
            variant={box === "inbox" ? "secondary" : "ghost"}
            onClick={() => setBox("inbox")}
          >
            Inbox
          </Button>
          <Button
            size="sm"
            variant={box === "sent" ? "secondary" : "ghost"}
            onClick={() => setBox("sent")}
          >
            Sent
          </Button>
          <select
            aria-label="Filter by project"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            className="ml-auto h-8 rounded-md border border-border/70 bg-input-surface px-2 text-xs"
          >
            <option value="">All projects</option>
            {projects.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by message status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
            className="h-8 rounded-md border border-border/70 bg-input-surface px-2 text-xs"
          >
            <option value="all">All</option>
            <option value="unread">Unseen</option>
            <option value="retry">Failed</option>
          </select>
        </div>
        <ScrollArea className="h-[min(62vh,500px)]">
          {loading && threads.length === 0 ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : threads.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <Inbox className="mx-auto mb-3 h-7 w-7 text-zinc-600" />
              <p className="text-sm">No {box} messages yet</p>
            </div>
          ) : (
            threads.map((thread) => {
              const latest = thread.messages[0];
              if (!latest) return null;
              const { mailbox, message, sent: isSent } = latest;
              const active = expanded?.id === message.id;
              return (
                <div key={thread.threadId} className="border-b border-zinc-800/70 p-3">
                  <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Thread · {thread.messages.length} message
                    {thread.messages.length === 1 ? "" : "s"}
                  </p>
                  <div>
                    <button
                      className="w-full text-left"
                      onClick={() => void read(mailbox, message.id, isSent)}
                    >
                      <div className="flex items-start gap-2">
                        {mailbox.agent && (
                          <AgentPlatformIcon
                            platform={mailbox.agent}
                            accent
                            className="mt-0.5 h-3.5 w-3.5"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">
                            {message.subject ||
                              (isSent
                                ? `To ${mailbox.displayName}`
                                : `From ${senderLabel(message)}`)}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {mailbox.environmentName} ·{" "}
                            {messageStatusLabel(mailbox, message, isSent)}
                          </p>
                        </div>
                        {!isSent && !message.userSeenAt && (
                          <span className="mt-1 h-2 w-2 rounded-full bg-cyan-400" />
                        )}
                      </div>
                    </button>
                    {active && expanded && (
                      <div className="mt-2 rounded-md border border-zinc-800 bg-black/30 p-3">
                        <p className="whitespace-pre-wrap text-xs leading-relaxed">
                          {expanded.body}
                        </p>
                        <div className="mt-3 grid gap-1 text-[11px] text-muted-foreground">
                          <p>
                            Seen by you:{" "}
                            {expanded.userSeenAt
                              ? new Date(expanded.userSeenAt).toLocaleString()
                              : "not yet"}
                          </p>
                          <p>
                            Acknowledged by agent:{" "}
                            {expanded.ackedAt
                              ? new Date(expanded.ackedAt).toLocaleString()
                              : "not yet"}
                          </p>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {!isSent &&
                            (expanded.from.kind === "tab" ||
                              expanded.from.kind === "coordinator") &&
                            (() => {
                              const sender = expanded.from;
                              return (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => {
                                    focusRef.current = null;
                                    setFocus(null);
                                    destinationRef.current = `${sender.environmentId}\0${sender.tabId}`;
                                    setDestination(destinationRef.current);
                                    setReplyToMessageId(expanded.id);
                                    setSubject(expanded.subject ? `Re: ${expanded.subject}` : "");
                                    setBody("");
                                    setActionError(undefined);
                                    sendAttempt.current = null;
                                    setCompose(true);
                                    void hydrate(null);
                                  }}
                                >
                                  Reply
                                </Button>
                              );
                            })()}
                          {(message.placement === "inject_failed" ||
                            (message.placement === "inject-held" &&
                              message.placementReason === "loop-budget-exhausted")) && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void retryMessage(mailbox, message.id)}
                            >
                              <RotateCcw className="mr-1 h-3 w-3" />
                              {message.placementReason === "loop-budget-exhausted"
                                ? "Resume"
                                : "Retry"}
                            </Button>
                          )}
                          {(message.placement === "inject_failed" ||
                            message.placement === "pending-inject" ||
                            (message.placement === "inject-held" &&
                              message.placementReason === "loop-budget-exhausted")) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void discardMessage(mailbox, message.id)}
                            >
                              <Trash2 className="mr-1 h-3 w-3" />
                              Discard
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
