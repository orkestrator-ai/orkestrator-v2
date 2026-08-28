import { useEffect, useMemo, useRef, useState } from "react";
import { Inbox, Loader2, RotateCcw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import type { AgentMailMessage, MailboxDescriptor } from "@orkestrator/protocol/agent-mail";

function senderLabel(message: Pick<AgentMailMessage, "from">): string {
  if (message.from.kind === "user") return "You";
  if (message.from.kind === "external") return "External client";
  return message.from.title || `${message.from.environmentId} / ${message.from.tabId}`;
}

interface AgentMailButtonProps {
  environmentId?: string;
  tabId?: string;
  variant?: "global" | "tab";
}

export function AgentMailButton({
  environmentId,
  tabId,
  variant = "global",
}: AgentMailButtonProps = {}) {
  const summary = useAgentMailStore((state) => state.summary);
  const mailboxes = useAgentMailStore((state) => state.mailboxes);
  const refreshSummary = useAgentMailStore((state) => state.refreshSummary);
  const refreshMailbox = useAgentMailStore((state) => state.refreshMailbox);
  const refreshInbox = useAgentMailStore((state) => state.refreshInbox);
  const messagingEnabled = useConfigStore(
    (state) => state.config.global.agentMessaging?.enabled === true,
  );
  const tabMailboxId = environmentId && tabId ? `${environmentId}\0${tabId}` : null;
  const hasTabMailbox =
    variant !== "tab" ||
    (tabMailboxId !== null && (summary.has(tabMailboxId) || mailboxes.has(tabMailboxId)));
  const unread = useMemo(
    () =>
      Array.from(summary.values())
        .filter(
          (entry) =>
            variant === "global" ||
            (entry.environmentId === environmentId && entry.tabId === tabId),
        )
        .reduce((total, entry) => total + entry.unreadCount, 0),
    [environmentId, summary, tabId, variant],
  );
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [directory, setDirectory] = useState<MailboxDescriptor[]>([]);
  const [expanded, setExpanded] = useState<AgentMailMessage | null>(null);
  const [compose, setCompose] = useState(false);
  const [destination, setDestination] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "unread" | "retry">("all");
  const sendAttempt = useRef<{ fingerprint: string; requestId: string } | null>(null);

  const hydrate = async () => {
    setLoading(true);
    try {
      if (variant === "tab" && environmentId && tabId) {
        await refreshMailbox(environmentId, tabId);
        const mailbox = useAgentMailStore
          .getState()
          .mailboxes.get(`${environmentId}\0${tabId}`)?.descriptor;
        setDirectory(mailbox ? [mailbox] : []);
        return;
      }
      const snapshot = await refreshInbox();
      setDirectory(snapshot.directory);
    } catch (error) {
      toast.error("Could not load agent messages", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = (next: boolean) => {
    setOpen(next);
    if (next) void hydrate();
  };

  const messages = Array.from(mailboxes.values())
    .flatMap((mailbox) =>
      mailbox.messages.map((message) => ({ mailbox: mailbox.descriptor, message })),
    )
    .filter(
      ({ mailbox }) =>
        variant === "global" ||
        (mailbox.environmentId === environmentId && mailbox.tabId === tabId),
    )
    .filter(({ mailbox }) => !projectFilter || mailbox.projectId === projectFilter)
    .filter(({ message }) =>
      statusFilter === "unread"
        ? !message.userSeenAt
        : statusFilter === "retry"
          ? message.placement === "inject_failed"
          : true,
    )
    .sort((left, right) => right.message.createdAt.localeCompare(left.message.createdAt));
  const projects = Array.from(
    new Map(directory.map((mailbox) => [mailbox.projectId, mailbox.projectName])).entries(),
  );

  useEffect(() => {
    if (!expanded) return;
    const summary = Array.from(mailboxes.values())
      .flatMap((mailbox) => mailbox.messages)
      .find((message) => message.id === expanded.id);
    if (!summary || summary.revision > expanded.revision) setExpanded(null);
  }, [expanded, mailboxes]);

  const read = async (mailbox: MailboxDescriptor, messageId: string) => {
    try {
      const message = await backend.getAgentMailMessage(
        mailbox.environmentId,
        mailbox.tabId,
        messageId,
      );
      setExpanded(message);
      if (!message.userSeenAt)
        await backend.markAgentMailSeen(mailbox.environmentId, mailbox.tabId, messageId);
      await Promise.all([refreshMailbox(mailbox.environmentId, mailbox.tabId), refreshSummary()]);
    } catch (error) {
      toast.error("Could not read message", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const acknowledge = async (mailbox: MailboxDescriptor, messageId: string) => {
    await backend.ackAgentMail(mailbox.environmentId, mailbox.tabId, messageId);
    await Promise.all([refreshMailbox(mailbox.environmentId, mailbox.tabId), refreshSummary()]);
  };

  const send = async () => {
    const mailbox = directory.find((candidate) => candidate.mailboxId === destination);
    if (!mailbox || !body.trim()) return;
    const payload = {
      toEnvironmentId: mailbox.environmentId,
      toTabId: mailbox.tabId,
      subject: subject.trim(),
      body: body.trim(),
    };
    const fingerprint = JSON.stringify(payload);
    if (sendAttempt.current?.fingerprint !== fingerprint) {
      sendAttempt.current = { fingerprint, requestId: crypto.randomUUID() };
    }
    try {
      const message = await backend.sendAgentMail({
        requestId: sendAttempt.current.requestId,
        toEnvironmentId: mailbox.environmentId,
        toTabId: mailbox.tabId,
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        body: body.trim(),
      });
      if (message.placement === "bounced" || message.placement === "undeliverable") {
        // This is a definitive backend outcome, not an ambiguous transport failure.
        // A later retry (for example after unmuting the recipient) must use a new key.
        sendAttempt.current = null;
        toast.error("Message was not delivered", {
          description: message.placementReason || message.placement,
        });
        return;
      }
      sendAttempt.current = null;
      setBody("");
      setSubject("");
      setCompose(false);
      toast.success("Message sent");
      await hydrate();
    } catch (error) {
      toast.error("Message was not sent", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (!messagingEnabled || !hasTabMailbox) return null;

  return (
    <DropdownMenu open={open} onOpenChange={handleOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        {variant === "tab" ? (
          <button
            type="button"
            aria-label={
              unread ? `${unread} unread agent messages; open inbox` : "Open tab agent inbox"
            }
            className={
              unread
                ? "min-w-4 rounded-full bg-cyan-400/90 px-1 text-center font-mono text-[9px] leading-4 text-zinc-950"
                : "hidden rounded-sm p-0.5 text-muted-foreground hover:text-cyan-300 group-hover:inline-flex"
            }
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {unread ? unread > 99 ? "99+" : unread : <Inbox className="h-3 w-3" />}
          </button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="relative h-7 w-7"
            aria-label={unread ? `Agent inbox, ${unread} unread` : "Agent inbox"}
          >
            <Inbox className="h-4 w-4" />
            {unread > 0 && (
              <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-cyan-400 px-1 font-mono text-[9px] leading-4 text-zinc-950">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(92vw,430px)] border-zinc-700/80 bg-zinc-950 p-0 shadow-2xl"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <p className="text-sm font-medium">Agent inbox</p>
            <p className="text-[11px] text-muted-foreground">
              {variant === "tab"
                ? "Durable messages for this tab"
                : "Durable messages across every environment"}
            </p>
          </div>
          {variant === "global" && (
            <Button size="sm" variant="outline" onClick={() => setCompose((value) => !value)}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              New
            </Button>
          )}
        </div>
        {compose && (
          <div className="space-y-2 border-b border-cyan-400/20 bg-cyan-400/[0.035] p-3">
            <select
              aria-label="Message destination"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
            >
              <option value="">Choose a destination…</option>
              {directory
                .filter((mailbox) => !mailbox.tombstonedAt)
                .map((mailbox) => (
                  <option key={mailbox.mailboxId} value={mailbox.mailboxId}>
                    {mailbox.projectName} · {mailbox.environmentName} ·{" "}
                    {mailbox.title || mailbox.tabId}
                  </option>
                ))}
            </select>
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
              <Button size="sm" onClick={() => void send()} disabled={!destination || !body.trim()}>
                {directory.find((mailbox) => mailbox.mailboxId === destination)?.injectPolicy ===
                "idle"
                  ? "Send · deliver when idle"
                  : "Send message"}
              </Button>
            </div>
          </div>
        )}
        {variant === "global" && (
          <div className="grid grid-cols-2 gap-2 border-b border-zinc-800 p-2">
            <select
              aria-label="Filter by project"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
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
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="all">All messages</option>
              <option value="unread">Unread</option>
              <option value="retry">Awaiting retry</option>
            </select>
          </div>
        )}
        <ScrollArea className="h-[min(62vh,480px)]">
          {loading && messages.length === 0 ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <Inbox className="mx-auto mb-3 h-7 w-7 text-zinc-600" />
              <p className="text-sm">No messages yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Messages sent to agent tabs appear here even while their environments are inactive.
              </p>
            </div>
          ) : (
            messages.map(({ mailbox, message }) => {
              const active = expanded?.id === message.id;
              return (
                <div key={message.id} className="border-b border-zinc-800/70 p-3">
                  <button
                    className="w-full text-left"
                    onClick={() => void read(mailbox, message.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="truncate text-xs font-medium">
                        {message.subject || `Message from ${senderLabel(message)}`}
                      </p>
                      {!message.userSeenAt && (
                        <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-cyan-400" />
                      )}
                    </div>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      {mailbox.projectName} / {mailbox.environmentName} · {message.trust}
                    </p>
                  </button>
                  {active && expanded && (
                    <div className="mt-3 rounded-md border border-zinc-800 bg-black/30 p-3">
                      <p className="whitespace-pre-wrap text-xs leading-relaxed">{expanded.body}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {!message.ackedAt && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void acknowledge(mailbox, message.id)}
                          >
                            Acknowledge
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void backend
                              .updateAgentMailboxPolicy({
                                environmentId: mailbox.environmentId,
                                tabId: mailbox.tabId,
                                mutedInbound: !mailbox.mutedInbound,
                              })
                              .then(hydrate)
                          }
                        >
                          {mailbox.mutedInbound ? "Unmute inbox" : "Mute inbox"}
                        </Button>
                        <select
                          aria-label="Automatic delivery policy"
                          value={mailbox.injectPolicy}
                          onChange={(event) =>
                            void backend
                              .updateAgentMailboxPolicy({
                                environmentId: mailbox.environmentId,
                                tabId: mailbox.tabId,
                                inject: event.target.value as "off" | "idle",
                              })
                              .then(hydrate)
                          }
                          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                        >
                          <option value="off">Pull only</option>
                          {mailbox.capabilities.canInject && (
                            <option value="idle">Deliver when idle</option>
                          )}
                        </select>
                        {message.placement === "inject_failed" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void backend
                                .retryAgentMailInject(
                                  mailbox.environmentId,
                                  mailbox.tabId,
                                  message.id,
                                )
                                .then(hydrate)
                            }
                          >
                            <RotateCcw className="mr-1 h-3 w-3" />
                            Retry delivery
                          </Button>
                        )}
                        {(message.placement === "inject_failed" ||
                          message.placement === "pending-inject") && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void backend
                                .discardAgentMailInject(
                                  mailbox.environmentId,
                                  mailbox.tabId,
                                  message.id,
                                )
                                .then(hydrate)
                            }
                          >
                            <Trash2 className="mr-1 h-3 w-3" />
                            Discard
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
