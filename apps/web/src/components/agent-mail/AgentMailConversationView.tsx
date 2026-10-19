import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, RotateCcw, Send, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AGENT_MAIL_DEFAULT_CONVERSATION_LIMIT,
  AGENT_MAIL_MAX_LIST_LIMIT,
  AGENT_MAIL_USER_PARTICIPANT,
  agentMailParticipantKey,
  agentMailConversationKey,
  isAgentMailBudgetHeld,
  type AgentMailConversation,
  type AgentMailMessage,
  type AgentMailParticipant,
} from "@orkestrator/protocol/agent-mail";
import {
  MAX_BLOCK_MARKDOWN_RENDER_CHARACTERS,
  MessageMarkdown,
} from "@/components/chat/MessageMarkdown";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";
import { EMPTY_AGENT_MAIL_DRAFT, useAgentMailStore } from "@/stores/agentMailStore";
import {
  AGENT_MAIL_STATUS_TONE_CLASS,
  agentMailStatus,
  formatAgentMailTime,
} from "./agent-mail-ui";
import { mailMarkdownComponents } from "./mail-markdown-components";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AgentMailBody({ body }: { body: string }) {
  if (body.length > MAX_BLOCK_MARKDOWN_RENDER_CHARACTERS) {
    return <p className="whitespace-pre-wrap break-words text-xs">{body}</p>;
  }
  return (
    <MessageMarkdown
      content={body}
      components={mailMarkdownComponents}
      className="break-words text-xs prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-pre:my-1 prose-pre:p-2 [&>:first-child]:mt-0 [&>:last-child]:mb-0"
    />
  );
}

export function ParticipantIcon({ participant }: { participant: AgentMailParticipant }) {
  return participant.agent ? (
    <AgentPlatformIcon platform={participant.agent} accent className="h-3.5 w-3.5 shrink-0" />
  ) : null;
}

/**
 * Everything two participants said to each other, oldest first, as a thread.
 * The person, when they are one side, is always on the right; the composer is
 * only offered for their own conversations, since the person sends as "You".
 */
export function AgentMailConversationView({
  a,
  b,
  onBack,
}: {
  a: string;
  b: string;
  onBack: () => void;
}) {
  const revision = useAgentMailStore((state) => state.revision);
  const openPanel = useAgentMailStore((state) => state.openPanel);
  const trackSent = useAgentMailStore((state) => state.trackSent);
  const [limit, setLimit] = useState(AGENT_MAIL_DEFAULT_CONVERSATION_LIMIT);
  const [reload, setReload] = useState(0);
  const [conversation, setConversation] = useState<AgentMailConversation | null>(null);
  const [error, setError] = useState<string>();
  const draftKey = agentMailConversationKey(a, b);
  const draft = useAgentMailStore((state) => state.drafts.get(draftKey) ?? EMPTY_AGENT_MAIL_DRAFT);
  const updateDraft = useAgentMailStore((state) => state.updateDraft);
  const { subject, body, sending } = draft;
  const markedSnapshot = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastMessageId = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    backend
      .getAgentMailConversation(a, b, limit)
      .then((loaded) => {
        if (cancelled) return;
        setConversation(loaded);
        setError(undefined);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [a, b, limit, revision, reload]);

  // Reading the thread is seeing it. One write per displayed window and revision,
  // so earlier history is covered without retrying a failed mark in a loop.
  useEffect(() => {
    if (!conversation || !conversation.messages.some((message) => !message.userSeenAt)) return;
    const snapshotKey = JSON.stringify([
      conversation.revision,
      conversation.messages.map(({ id }) => id),
    ]);
    if (markedSnapshot.current === snapshotKey) return;
    markedSnapshot.current = snapshotKey;
    void backend
      .markAgentMailConversationSeen(
        a,
        b,
        conversation.messages.map(({ id }) => id),
      )
      .catch(() => undefined);
  }, [a, b, conversation]);

  // Follow the newest message; loading earlier history keeps the reader's place.
  useLayoutEffect(() => {
    const last = conversation?.messages.at(-1)?.id;
    if (!last || last === lastMessageId.current) return;
    lastMessageId.current = last;
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [conversation]);

  const [left, right] = conversation?.participants ?? [];
  const person = conversation?.participants.find(({ kind }) => kind === "user");
  const recipient = person
    ? conversation?.participants.find(({ kind }) => kind !== "user")
    : undefined;

  const act = async (
    action: "retry" | "discard",
    message: AgentMailMessage,
    label: string,
  ): Promise<void> => {
    try {
      if (action === "retry")
        await backend.retryAgentMailInject(message.toEnvironmentId, message.toTabId, message.id);
      else
        await backend.discardAgentMailInject(message.toEnvironmentId, message.toTabId, message.id);
      setReload((value) => value + 1);
    } catch (cause) {
      toast.error(`Could not ${label}`, { description: errorMessage(cause) });
    }
  };

  const send = async () => {
    if (
      !recipient?.environmentId ||
      !recipient.tabId ||
      !body.trim() ||
      useAgentMailStore.getState().drafts.get(draftKey)?.sending
    )
      return;
    const payload = {
      toEnvironmentId: recipient.environmentId,
      toTabId: recipient.tabId,
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      body: body.trim(),
    };
    const fingerprint = JSON.stringify(payload);
    const attempts = { ...draft.attempts };
    const requestId = attempts[fingerprint] ?? crypto.randomUUID();
    attempts[fingerprint] = requestId;
    updateDraft(draftKey, { sending: true, attempts });
    try {
      const message = await backend.sendAgentMail({
        requestId,
        ...payload,
      });
      const current = useAgentMailStore.getState().drafts.get(draftKey);
      if (current?.attempts[fingerprint] !== requestId) return;
      const remaining = { ...current.attempts };
      delete remaining[fingerprint];
      updateDraft(draftKey, { attempts: remaining });
      trackSent(message);
      if (message.placement === "bounced" || message.placement === "undeliverable") {
        toast.error("Message was not delivered", {
          description: message.placementReason || message.placement,
        });
        return;
      }
      updateDraft(draftKey, { subject: "", body: "" });
      setReload((value) => value + 1);
    } catch (cause) {
      toast.error("Message was not sent", { description: errorMessage(cause) });
    } finally {
      if (useAgentMailStore.getState().drafts.has(draftKey))
        updateDraft(draftKey, { sending: false });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 py-2.5 pl-2 pr-10">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          aria-label="Back to conversations"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <SheetTitle className="flex items-center gap-1.5">
            {left && <ParticipantIcon participant={left} />}
            <span className="truncate">{left?.displayName ?? "Conversation"}</span>
            {right && (
              <>
                <span className="text-muted-foreground">↔</span>
                <ParticipantIcon participant={right} />
                <span className="truncate">{right.displayName}</span>
              </>
            )}
          </SheetTitle>
          <SheetDescription>
            {conversation
              ? `${conversation.total} message${conversation.total === 1 ? "" : "s"}${
                  left?.closed || right?.closed ? " · a participant's tab is closed" : ""
                }`
              : "Loading…"}
          </SheetDescription>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="border-b border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300"
        >
          {error}
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {!conversation && !error ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {conversation && conversation.total > conversation.messages.length && (
          <div className="flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              className="text-[11px]"
              disabled={limit >= AGENT_MAIL_MAX_LIST_LIMIT}
              onClick={() =>
                setLimit((value) =>
                  Math.min(
                    AGENT_MAIL_MAX_LIST_LIMIT,
                    value + AGENT_MAIL_DEFAULT_CONVERSATION_LIMIT,
                  ),
                )
              }
            >
              {limit >= AGENT_MAIL_MAX_LIST_LIMIT
                ? `Showing the latest ${conversation.messages.length} of ${conversation.total}`
                : "Show earlier messages"}
            </Button>
          </div>
        )}
        {conversation?.messages.length === 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">No messages yet</p>
        )}
        {conversation?.messages.map((message) => {
          const senderKey = agentMailParticipantKey(message.from);
          const sender = conversation.participants.find(({ key }) => key === senderKey);
          const mine = Boolean(right && senderKey === right.key);
          const status = agentMailStatus(message);
          const untrusted = message.trust === "external" || message.trust === "cross-project";
          const failed = !message.discardedAt && message.placement === "inject_failed";
          const held = !message.discardedAt && isAgentMailBudgetHeld(message);
          const waiting =
            !message.discardedAt &&
            !message.ackedAt &&
            !untrusted &&
            (message.placement === "pending-inject" || message.placement === "stored");
          return (
            <div
              key={message.id}
              data-testid="agent-mail-conversation-message"
              className={cn("flex", mine ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "min-w-0 max-w-[88%] rounded-lg border px-3 py-2",
                  untrusted
                    ? "border-amber-400/30 bg-amber-400/[0.05]"
                    : mine
                      ? "border-cyan-400/25 bg-cyan-400/[0.06]"
                      : "border-zinc-700/70 bg-zinc-900/60",
                )}
              >
                <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  {untrusted && <ShieldAlert className="h-3 w-3 text-amber-300" />}
                  <span className="truncate font-medium text-foreground/80">
                    {sender?.displayName ?? "Unknown sender"}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatAgentMailTime(message.createdAt)}
                  </span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 rounded px-1.5 leading-4",
                      AGENT_MAIL_STATUS_TONE_CLASS[status.tone],
                    )}
                  >
                    {status.label}
                  </span>
                </div>
                {message.subject && (
                  <p className="mb-1 break-words text-xs font-medium">{message.subject}</p>
                )}
                <AgentMailBody body={message.body} />
                {(failed || held || waiting) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(failed || held) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={() => void act("retry", message, "retry delivery")}
                      >
                        <RotateCcw className="mr-1 h-3 w-3" />
                        {held ? "Resume" : "Retry"}
                      </Button>
                    )}
                    {waiting && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={() => void act("retry", message, "deliver message")}
                      >
                        Deliver now
                      </Button>
                    )}
                    {(failed || held || message.placement === "pending-inject") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[11px]"
                        onClick={() => void act("discard", message, "discard message")}
                      >
                        <Trash2 className="mr-1 h-3 w-3" />
                        Discard
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {recipient ? (
        recipient.canReceive ? (
          <form
            className="space-y-2 border-t border-zinc-800 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Input
              value={subject}
              disabled={sending}
              onChange={(event) => updateDraft(draftKey, { subject: event.target.value })}
              maxLength={200}
              placeholder="Subject (optional)"
              className="h-8 text-xs"
            />
            <Textarea
              value={body}
              disabled={sending}
              onChange={(event) => updateDraft(draftKey, { body: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={`Message ${recipient.displayName}`}
              aria-label={`Message ${recipient.displayName}`}
              className="min-h-20 text-xs"
            />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={sending || !body.trim()}>
                <Send className="mr-1.5 h-3.5 w-3.5" />
                Send
              </Button>
            </div>
          </form>
        ) : (
          <p className="border-t border-zinc-800 p-3 text-center text-[11px] text-muted-foreground">
            {recipient.displayName} can no longer receive messages.
          </p>
        )
      ) : conversation ? (
        <div className="flex flex-wrap justify-center gap-2 border-t border-zinc-800 p-3">
          {conversation.participants
            .filter((participant) => participant.canReceive)
            .map((participant) => (
              <Button
                key={participant.key}
                size="sm"
                variant="outline"
                className="text-[11px]"
                onClick={() =>
                  openPanel({
                    focus: participant.key,
                    conversation: [participant.key, AGENT_MAIL_USER_PARTICIPANT],
                  })
                }
              >
                Message {participant.displayName}
              </Button>
            ))}
        </div>
      ) : null}
    </div>
  );
}
