import { AlertCircle, CheckCircle2, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import type { AgentPendingInteractionSummary } from "@orkestrator/protocol/agent-registry";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { cn } from "@/lib/utils";
import { LOCAL_AGENT_SUMMARY_SOURCE, type AgentSummarySource } from "./EnvironmentAgentSummary";
import { environmentAttentionParts, type EnvironmentRowAttention } from "./environment-row-model";
import { useAgentRegistryRead, type RegistryRead } from "./useAgentRegistryRead";

/** The tab a waiting environment waits in, and what it waits on there. */
export interface EnvironmentPendingTarget {
  tabId: string;
  pending: AgentPendingInteractionSummary;
  /** Pending requests across every tab of the environment. */
  total: number;
}

/**
 * The environment's oldest pending request (blocking order is the backend's,
 * per tab) and the number pending across its tabs, or `null` when its machine
 * reported none: an older machine, a terminal agent, or nothing pending yet.
 */
export function pendingTarget(
  snapshot: RegistryRead | null,
  environmentId: string,
): EnvironmentPendingTarget | null {
  const waiting = (snapshot?.entries ?? []).flatMap((entry) =>
    entry.environmentId === environmentId && entry.ownerKind === "environment" && entry.pending
      ? [{ tabId: entry.tabId, tabOrdinal: entry.tabOrdinal, pending: entry.pending }]
      : [],
  );
  if (waiting.length === 0) return null;
  const [first] = [...waiting].sort(
    (a, b) => a.pending.since - b.pending.since || a.tabOrdinal - b.tabOrdinal,
  );
  if (!first) return null;
  return {
    tabId: first.tabId,
    pending: first.pending,
    total: waiting.reduce((sum, entry) => sum + Math.max(1, entry.pending.count), 0),
  };
}

export function useEnvironmentPendingTarget(
  environmentId: string,
  source: AgentSummarySource | null,
) {
  const snapshot = useAgentRegistryRead(
    environmentId,
    source !== null,
    source ?? LOCAL_AGENT_SUMMARY_SOURCE,
    { includePending: true },
  );
  return pendingTarget(snapshot, environmentId);
}

const TONE_CLASS: Record<EnvironmentRowAttention["tone"], string> = {
  waiting: "text-amber-500",
  setup: "text-amber-500",
  failed: "text-failure",
  unread: "text-zinc-400",
};

function AttentionIcon({
  attention,
  pending,
}: {
  attention: EnvironmentRowAttention;
  pending: AgentPendingInteractionSummary | null;
}) {
  const className = "h-3 w-3 shrink-0";
  if (attention.tone === "failed") return <AlertCircle className={className} aria-hidden="true" />;
  if (attention.tone === "unread") return <CheckCircle2 className={className} aria-hidden="true" />;
  if (attention.tone === "setup") return <ShieldAlert className={className} aria-hidden="true" />;
  const question = pending
    ? pending.kind === "question" || pending.kind === "elicitation" || pending.kind === "mcp-form"
    : attention.text === "Question for you";
  return question ? (
    <MessageCircleQuestion className={className} aria-hidden="true" />
  ) : (
    <ShieldAlert className={className} aria-hidden="true" />
  );
}

/**
 * The second line of an environment row that needs the user: what a waiting
 * agent waits on ("Needs approval: Run bun install · 8 min"), or finished work
 * nobody has opened ("Finished · result unread"). Clicking it opens the tab
 * holding the request, or the environment when no tab is known.
 *
 * The request is read from the owning machine's agent registry only while the
 * agent waits (`attention.readsPending`), and kept current by the same events
 * the hover card's agent summary uses. `source` is `null` while the machine is
 * unreachable; the line then keeps its generic wording.
 */
export function EnvironmentAttentionLine({
  environmentId,
  attention,
  source,
  onOpen,
  describedBy,
}: {
  environmentId: string;
  attention: EnvironmentRowAttention;
  source: AgentSummarySource | null;
  onOpen: (tabId: string | null, interactionId?: string) => void;
  /** The row name's id, so the button reads "<text>, <environment>". */
  describedBy?: string;
}) {
  const target = useEnvironmentPendingTarget(environmentId, attention.readsPending ? source : null);
  const now = useMinuteClock();
  const { head, tail } = environmentAttentionParts(
    attention,
    target?.pending ?? null,
    now.getTime(),
    target?.total,
  );
  const text = tail ? `${head} · ${tail}` : head;
  return (
    <button
      type="button"
      data-testid="environment-attention-line"
      data-tone={attention.tone}
      onClick={(event) => {
        // The row's own click selects; this opens the request inside it.
        event.stopPropagation();
        if (target) onOpen(target.tabId, target.pending.interactionId);
        else onOpen(null);
      }}
      title={text}
      aria-describedby={describedBy}
      className={cn(
        "flex w-full min-w-0 items-center gap-1 rounded pb-1 pl-6 pr-2 text-left text-[11px] leading-4 transition-colors hover:text-foreground focus-hairline",
        TONE_CLASS[attention.tone],
      )}
    >
      <AttentionIcon attention={attention} pending={target?.pending ?? null} />
      {/* Only what is needed is cut short; how long it has waited stays. */}
      <span className="flex min-w-0">
        <span className="min-w-0 truncate">{head}</span>
        {tail && <span className="shrink-0 whitespace-pre">{` · ${tail}`}</span>}
      </span>
    </button>
  );
}
