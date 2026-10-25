import { useEffect, useState } from "react";
import { ArrowLeft, Inbox, Loader2, Send } from "lucide-react";
import {
  AGENT_MAIL_USER_PARTICIPANT,
  AGENT_MAIL_MAX_MAILBOXES,
  type AgentMailConversationSummary,
  type MailboxDescriptor,
} from "@orkestrator/protocol/agent-mail";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useConfigStore } from "@/stores/configStore";
import { AgentMailConversationView, ParticipantIcon } from "./AgentMailConversationView";
import { formatAgentMailTime } from "./agent-mail-ui";
import { MailboxDeliverySettings } from "./MailboxDeliverySettings";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function splitMailbox(key: string | undefined): { environmentId: string; tabId: string } | null {
  const separator = key?.indexOf("\0") ?? -1;
  if (!key || separator <= 0) return null;
  return { environmentId: key.slice(0, separator), tabId: key.slice(separator + 1) };
}

/**
 * The one agent-mail surface: a panel at the window's right edge. It lists
 * conversations — every pair that has exchanged mail, or one tab's — and opens
 * any of them as a thread. The title-bar button, the tab menu and the
 * transcript's mail tiles all open it through `useAgentMailStore.openPanel`.
 */
export function AgentMailPanel() {
  const panel = useAgentMailStore((state) => state.panel);
  const openPanel = useAgentMailStore((state) => state.openPanel);
  const closePanel = useAgentMailStore((state) => state.closePanel);
  const messagingEnabled = useConfigStore(
    (state) => state.config.global.agentMessaging?.enabled === true,
  );
  if (!messagingEnabled) return null;
  const conversation = panel?.conversation;
  return (
    <Sheet
      open={panel !== null}
      onOpenChange={(open) => {
        if (!open) closePanel();
      }}
    >
      <SheetContent data-testid="agent-mail-panel">
        {conversation ? (
          <AgentMailConversationView
            key={`${conversation[0]}\n${conversation[1]}`}
            a={conversation[0]}
            b={conversation[1]}
            onBack={() => openPanel(panel?.focus ? { focus: panel.focus } : {})}
          />
        ) : panel ? (
          <AgentMailConversationList key={panel.focus ?? ""} focus={panel.focus} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function AgentMailConversationList({ focus }: { focus?: string }) {
  const revision = useAgentMailStore((state) => state.revision);
  const openPanel = useAgentMailStore((state) => state.openPanel);
  const refreshMailbox = useAgentMailStore((state) => state.refreshMailbox);
  const focusedMailbox = useAgentMailStore((state) =>
    focus ? state.mailboxes.get(focus)?.descriptor : undefined,
  );
  const [conversations, setConversations] = useState<AgentMailConversationSummary[] | null>(null);
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [mailboxError, setMailboxError] = useState<string>();
  const [mailboxReload, setMailboxReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    backend
      .listAgentMailConversations(focus)
      .then((list) => {
        if (cancelled) return;
        setConversations(list.conversations);
        setError(undefined);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [focus, revision]);

  useEffect(() => {
    const address = splitMailbox(focus);
    let cancelled = false;
    if (address)
      void refreshMailbox(address.environmentId, address.tabId)
        .then(() => {
          if (!cancelled) setMailboxError(undefined);
        })
        .catch((cause) => {
          if (!cancelled) setMailboxError(errorMessage(cause));
        });
    return () => {
      cancelled = true;
    };
  }, [focus, refreshMailbox, mailboxReload]);

  if (picking) {
    return (
      <RecipientPicker
        onBack={() => setPicking(false)}
        onPick={(mailbox) =>
          openPanel({ conversation: [mailbox.mailboxId, AGENT_MAIL_USER_PARTICIPANT] })
        }
      />
    );
  }

  const canMessageFocus =
    focusedMailbox && !focusedMailbox.tombstonedAt && focusedMailbox.capabilities.canPull;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 border-b border-zinc-800 py-3 pl-4 pr-10">
        <div className="flex items-center gap-3">
          {focus && (
            <Button
              size="icon"
              variant="ghost"
              className="-ml-2 h-7 w-7 shrink-0"
              aria-label="All conversations"
              onClick={() => openPanel({})}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <SheetTitle>
              {focus ? (focusedMailbox?.displayName ?? "Agent") : "Agent messages"}
            </SheetTitle>
            <SheetDescription>
              {focus
                ? (focusedMailbox?.environmentName ?? "Conversations with this tab")
                : "Conversations between your agents"}
            </SheetDescription>
          </div>
          {focus ? (
            canMessageFocus && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  openPanel({ focus, conversation: [focus, AGENT_MAIL_USER_PARTICIPANT] })
                }
              >
                <Send className="mr-1.5 h-3.5 w-3.5" />
                Message
              </Button>
            )
          ) : (
            <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              New
            </Button>
          )}
        </div>
        {focusedMailbox && !focusedMailbox.tombstonedAt && (
          <MailboxDeliverySettings mailbox={focusedMailbox} />
        )}
      </div>
      {mailboxError && (
        <div role="alert" className="border-b border-red-400/20 px-3 py-2 text-xs text-red-300">
          Could not load this agent: {mailboxError}
          <Button size="sm" variant="ghost" onClick={() => setMailboxReload((value) => value + 1)}>
            Retry mailbox
          </Button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="border-b border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300"
        >
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversations === null && !error ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : conversations?.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Inbox className="mx-auto mb-3 h-7 w-7 text-zinc-600" />
            <p className="text-sm">No messages yet</p>
          </div>
        ) : (
          conversations?.map((conversation) => (
            <ConversationRow
              key={conversation.key}
              conversation={conversation}
              onOpen={() =>
                openPanel({
                  ...(focus ? { focus } : {}),
                  conversation: [
                    conversation.participants[0].key,
                    conversation.participants[1].key,
                  ],
                })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

function ConversationRow({
  conversation,
  onOpen,
}: {
  conversation: AgentMailConversationSummary;
  onOpen: () => void;
}) {
  const [first, second] = conversation.participants;
  const { lastMessage, attentionCount } = conversation;
  return (
    <button
      type="button"
      data-testid="agent-mail-conversation-row"
      onClick={onOpen}
      className="block w-full border-b border-zinc-800/70 px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.05] focus-visible:outline-none"
    >
      <div className="flex items-center gap-1.5 text-xs">
        <ParticipantIcon participant={first} />
        <span className={cn("truncate font-medium", first.closed && "text-muted-foreground")}>
          {first.displayName}
        </span>
        <span className="shrink-0 text-muted-foreground">↔</span>
        <ParticipantIcon participant={second} />
        <span className={cn("truncate font-medium", second.closed && "text-muted-foreground")}>
          {second.displayName}
        </span>
        <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground">
          {formatAgentMailTime(lastMessage.createdAt)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {lastMessage.subject && (
            <span className="text-foreground/85">{lastMessage.subject} · </span>
          )}
          {conversation.lastPreview}
        </p>
        {attentionCount > 0 ? (
          <span className="shrink-0 rounded bg-amber-400/15 px-1.5 text-[10px] leading-4 text-amber-300">
            {attentionCount} need{attentionCount === 1 ? "s" : ""} you
          </span>
        ) : (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {conversation.messageCount}
          </span>
        )}
      </div>
    </button>
  );
}

function RecipientPicker({
  onBack,
  onPick,
}: {
  onBack: () => void;
  onPick: (mailbox: MailboxDescriptor) => void;
}) {
  const [mailboxes, setMailboxes] = useState<MailboxDescriptor[] | null>(null);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    // The directory is bounded by the backend's mailbox cap. Page before
    // filtering eligibility: a whole page may contain only closed agents.
    const load = async () => {
      const all: MailboxDescriptor[] = [];
      let offset = 0;
      while (offset < AGENT_MAIL_MAX_MAILBOXES && !cancelled) {
        const page = await backend.listAgentMailboxes({ offset, limit: 200 });
        all.push(...page.mailboxes);
        offset += page.limit;
        if (offset >= page.total || page.limit <= 0) break;
      }
      if (!cancelled)
        setMailboxes(
          all.filter((mailbox) => !mailbox.tombstonedAt && mailbox.capabilities.canPull),
        );
    };
    void load().catch((cause) => {
      if (!cancelled) setError(errorMessage(cause));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const needle = query.trim().toLocaleLowerCase();
  const visible = (mailboxes ?? []).filter(
    (mailbox) =>
      !needle ||
      `${mailbox.displayName} ${mailbox.environmentName} ${mailbox.projectName}`
        .toLocaleLowerCase()
        .includes(needle),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-zinc-800 py-3 pl-2 pr-10">
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            aria-label="Back to conversations"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <SheetTitle>New message</SheetTitle>
            <SheetDescription>Choose an agent to message</SheetDescription>
          </div>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter agents"
          aria-label="Filter agents"
          className="ml-2 h-8 w-[calc(100%-0.5rem)] rounded-md border border-border/70 bg-input-surface px-2 text-xs"
        />
      </div>
      {error && (
        <div role="alert" className="px-4 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {mailboxes === null && !error ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : visible.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No agents to message</p>
        ) : (
          visible.map((mailbox) => (
            <button
              key={mailbox.mailboxId}
              type="button"
              onClick={() => onPick(mailbox)}
              className="flex w-full items-center gap-2 border-b border-zinc-800/70 px-4 py-2 text-left hover:bg-foreground/[0.03]"
            >
              {mailbox.agent && (
                <AgentPlatformIcon platform={mailbox.agent} accent className="h-3.5 w-3.5" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{mailbox.displayName}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {mailbox.environmentName} · {mailbox.projectName}
                </span>
              </span>
              <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[9px]">
                {mailbox.presence.replaceAll("_", " ")}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
