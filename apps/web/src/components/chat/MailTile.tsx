import {
  memo,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  Bell,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Info,
  Mail,
  MessagesSquare,
  Network,
  Send,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import type { Components } from "react-markdown";
import type { AgentMailKind, AgentMailNoticeTone } from "@orkestrator/protocol/agent-mail";
import { mailMarkdownComponents } from "@/components/agent-mail/mail-markdown-components";
import {
  AGENT_MAIL_STATUS_TONE_CLASS,
  openAgentMailConversation,
} from "@/components/agent-mail/agent-mail-ui";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import type { PeerMailPresentation } from "@/lib/chat/native-message-types";
import { cn } from "@/lib/utils";
import { ChatFindActiveContext } from "./chat-find-context";
import { MessageMarkdown } from "./MessageMarkdown";

/**
 * How a tile is drawn: by who sent it, and for a workflow notice by what it
 * reports. A notice without structured facts (written before they existed)
 * reads as plain news.
 */
export type MailTileTone = Exclude<AgentMailKind, "notice"> | AgentMailNoticeTone | "sent";

export function mailTileTone(
  mail: Pick<PeerMailPresentation, "kind" | "notice" | "direction">,
): MailTileTone {
  if (mail.direction === "out") return "sent";
  if (mail.kind !== "notice") return mail.kind;
  return mail.notice?.tone ?? "info";
}

const TONES: Record<
  MailTileTone,
  { icon: ComponentType<{ className?: string }>; label: string; frame: string; accent: string }
> = {
  sent: {
    icon: Send,
    label: "Message sent",
    frame: "border-border/60 bg-muted/20",
    accent: "text-foreground/80",
  },
  message: {
    icon: Mail,
    label: "Agent message",
    frame: "border-cyan-400/20 bg-cyan-400/[0.035]",
    accent: "text-cyan-300",
  },
  coordinator: {
    icon: Network,
    label: "Coordinator request",
    frame: "border-violet-400/25 bg-violet-400/[0.04]",
    accent: "text-violet-300",
  },
  user: {
    icon: UserRound,
    label: "Message from you",
    frame: "border-border/70 bg-muted/30",
    accent: "text-foreground/80",
  },
  external: {
    icon: ShieldAlert,
    label: "Untrusted message",
    frame: "border-amber-400/30 bg-amber-400/[0.05]",
    accent: "text-amber-300",
  },
  success: {
    icon: CircleCheck,
    label: "Status: finished",
    frame: "border-emerald-400/25 bg-emerald-400/[0.04]",
    accent: "text-emerald-300",
  },
  failure: {
    icon: CircleX,
    label: "Status: failed",
    frame: "border-red-400/30 bg-red-400/[0.05]",
    accent: "text-red-300",
  },
  attention: {
    icon: CircleAlert,
    label: "Status: needs attention",
    frame: "border-amber-400/30 bg-amber-400/[0.05]",
    accent: "text-amber-300",
  },
  info: {
    icon: Info,
    label: "Status update",
    frame: "border-sky-400/20 bg-sky-400/[0.035]",
    accent: "text-sky-300",
  },
};

/**
 * Use the inbox's link policy for untrusted peer mail: sender paths remain
 * copyable text. Keep the inline card's image text aligned with search.
 */
const peerMailMarkdownComponents: Components = {
  ...mailMarkdownComponents,
  img: ({ alt, src }) => (
    <span data-peer-mail-image="true">{alt || (typeof src === "string" ? src : "")}</span>
  ),
};

/**
 * Collapsed, the body is a preview: one small size, no block margins, so the
 * three visible lines carry three lines of the message rather than a heading
 * and its spacing.
 */
const COLLAPSED_BODY_CLASS =
  "text-xs text-foreground/80 prose-p:my-0 prose-ul:my-0 prose-ol:my-0 prose-pre:my-0 prose-pre:p-1 prose-headings:my-0 prose-headings:text-xs prose-headings:font-semibold";

export interface MailTileProps {
  mail: PeerMailPresentation;
  /**
   * Where the open/closed choice is remembered. It includes the transcript and
   * the message id, so a virtualized row that unmounts while scrolled away, or
   * a history page that reloads, comes back the way the reader left it.
   */
  expansionKey: string;
  timestampLabel?: string;
}

/**
 * One delivered mail message as a compact tile.
 *
 * Collapsed, it shows the sender, the subject and the first few lines of the
 * body; the header is a button that expands the full Markdown body in place.
 * Long worker reports used to take over a coordinator's transcript, so the
 * default is collapsed and the reader opens what they want to read.
 */
export const MailTile = memo(function MailTile({
  mail,
  expansionKey,
  timestampLabel,
}: MailTileProps) {
  const [preferredOpen, setOpen] = useMessagePartExpansion(expansionKey);
  const findActive = useContext(ChatFindActiveContext);
  const open = preferredOpen || findActive;
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const tone = mailTileTone(mail);
  const style = TONES[tone];
  // A notice that predates structured facts keeps a neutral bell rather than
  // claiming an outcome it cannot know.
  const Icon = mail.kind === "notice" && !mail.notice ? Bell : style.icon;
  const participants = mail.participants;

  // Fade the clipped edge only when the clamp actually hides something; a
  // one-line message should read as complete, not cut off.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || open || typeof ResizeObserver === "undefined") return;
    // The first callback arrives once the body has been laid out.
    const observer = new ResizeObserver(() =>
      setOverflows(body.scrollHeight > body.clientHeight + 1),
    );
    observer.observe(body);
    return () => observer.disconnect();
  }, [open, mail.body]);

  return (
    <div
      className="px-2 py-1.5 @sm:px-4"
      data-mail-tile="true"
      data-mail-kind={mail.kind}
      data-mail-tone={tone}
      data-mail-state={mail.notice?.state}
      data-expanded={open ? "true" : "false"}
    >
      <div className={cn("mx-auto min-w-0 max-w-3xl rounded-lg border", style.frame)}>
        <div className="flex min-w-0 items-start">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2.5 pt-2 pb-1.5 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon className={cn("mt-0.5 size-4 shrink-0", style.accent)} aria-hidden="true" />
            <span className="sr-only">{style.label}: </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 @sm:flex-row @sm:items-baseline @sm:gap-1.5">
              <span className={cn("truncate text-xs font-medium", style.accent)}>
                {mail.sender}
              </span>
              {mail.subject ? (
                <span className="min-w-0 truncate text-xs text-foreground/85">{mail.subject}</span>
              ) : null}
            </span>
            {mail.status ? (
              <span
                data-mail-status={mail.status.tone}
                className={cn(
                  "mt-px shrink-0 rounded px-1.5 text-[10px] leading-4",
                  AGENT_MAIL_STATUS_TONE_CLASS[mail.status.tone],
                )}
              >
                {mail.status.label}
              </span>
            ) : null}
            {timestampLabel ? (
              <span className="mt-px shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {timestampLabel}
              </span>
            ) : null}
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
          </button>
          {participants ? (
            <button
              type="button"
              aria-label="Open conversation"
              title="Open conversation"
              onClick={() => openAgentMailConversation(participants[0], participants[1])}
              className="mt-1 mr-1.5 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MessagesSquare className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {/*
          Collapsed, the clipped body is a pointer target for expanding and is
          inert: its links cannot be reached by Tab or a stray click while most
          of the message is hidden. The header button stays the one control.
        */}
        <div
          className={cn("px-3 pb-2.5 pl-[2.125rem]", !open && "cursor-pointer")}
          onClick={open ? undefined : () => setOpen(true)}
        >
          {open ? <p className="mb-2 text-[11px] text-muted-foreground">{mail.warning}</p> : null}
          <div
            ref={bodyRef}
            id={bodyId}
            inert={!open}
            data-mail-body="true"
            data-clamped={open ? undefined : "true"}
            className={cn(
              "min-w-0 break-words [&_.prose>:first-child]:mt-0 [&_.prose>:last-child]:mb-0",
              // Three lines of the collapsed `text-xs` body.
              !open && "max-h-[3.75rem] overflow-hidden",
              !open && overflows && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
            )}
          >
            <div data-agent-chat-search-content="true">
              <MessageMarkdown
                content={mail.body}
                components={peerMailMarkdownComponents}
                className={open ? undefined : COLLAPSED_BODY_CLASS}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
