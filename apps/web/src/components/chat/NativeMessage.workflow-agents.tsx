import {
  Check,
  Clock,
  Coins,
  Loader2,
  MinusCircle,
  SkipForward,
  Square,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  NativeAgentWorkflowAgent,
  NativeAgentWorkflowAgentStatus,
} from "@orkestrator/protocol/native-agent";
import { cn } from "@/lib/utils";
import { formatTokenCount } from "@/lib/context-usage";
import { formatAgentDurationMs } from "@/lib/chat/native-agent-duration";

/*
 * A workflow's agents, listed inside the workflow's card.
 *
 * They are rows of the workflow rather than tasks: the provider reports them
 * only on the workflow's own progress, they have no task id and no stop of
 * their own, so they are shown as a list rather than as nested task cards.
 */

interface WorkflowAgentStatusStyle {
  label: string;
  icon: LucideIcon;
  spinning?: boolean;
  className: string;
}

const STATUS_STYLES: Record<NativeAgentWorkflowAgentStatus, WorkflowAgentStatusStyle> = {
  queued: { label: "Queued", icon: Clock, className: "bg-muted/40 text-muted-foreground" },
  running: {
    label: "Running",
    icon: Loader2,
    spinning: true,
    className: "bg-cyan-400/10 text-cyan-300",
  },
  completed: { label: "Completed", icon: Check, className: "bg-success/10 text-success" },
  failed: { label: "Failed", icon: X, className: "bg-failure/10 text-failure" },
  stopped: { label: "Stopped", icon: Square, className: "bg-muted/40 text-muted-foreground" },
  skipped: {
    label: "Skipped",
    icon: SkipForward,
    className: "bg-muted/40 text-muted-foreground",
  },
};

function isLiveWorkflowAgent(agent: NativeAgentWorkflowAgent): boolean {
  return agent.status === "running" || agent.status === "queued";
}

/**
 * The collapsed card's line for a live workflow: how far its agents have got,
 * then what the most recent one is. Nothing when it reports no agents.
 */
export function workflowAgentsStatusLine(
  agents: readonly NativeAgentWorkflowAgent[] | undefined,
  latest: string | undefined,
): string | undefined {
  if (!agents || agents.length === 0) return undefined;
  const running = agents.filter((agent) => agent.status === "running").length;
  const queued = agents.filter((agent) => agent.status === "queued").length;
  const finished = agents.filter((agent) => !isLiveWorkflowAgent(agent)).length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const parts = [
    ...(running > 0 ? [`${running} running`] : []),
    ...(queued > 0 ? [`${queued} queued`] : []),
    `${finished}/${agents.length} done`,
    ...(failed > 0 ? [`${failed} failed`] : []),
  ];
  const progress = parts.join(" · ");
  return latest ? `${progress} — ${latest}` : progress;
}

/** What one agent is doing, or how it ended when that says more than its status. */
function workflowAgentDetail(agent: NativeAgentWorkflowAgent): string | undefined {
  if (agent.error && (agent.status === "failed" || agent.status === "stopped")) {
    return agent.error;
  }
  if (agent.status !== "running") return undefined;
  if (agent.activity) return agent.activity;
  return agent.lastToolName ? `Using ${agent.lastToolName}` : undefined;
}

function WorkflowAgentRow({ agent }: { agent: NativeAgentWorkflowAgent }) {
  const style = STATUS_STYLES[agent.status];
  const Icon = style.icon;
  const detail = workflowAgentDetail(agent);
  const role = agent.agentRole;
  return (
    <li
      className="flex items-start gap-2.5 px-2.5 py-2"
      data-workflow-agent-index={agent.index}
      data-workflow-agent-status={agent.status}
    >
      <span
        className={cn(
          "mt-px flex size-5 shrink-0 items-center justify-center rounded-full",
          style.className,
        )}
        title={style.label}
      >
        <Icon
          className={cn(
            "size-3",
            style.spinning && "animate-spin motion-reduce:animate-none",
            agent.status === "stopped" && "fill-current",
          )}
          aria-hidden
        />
        <span className="sr-only">{style.label}</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="min-w-0 truncate font-medium text-foreground">{agent.label}</span>
          {agent.phase ? (
            <span className="hidden max-w-[40%] shrink-0 truncate rounded border border-border/50 px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground sm:inline">
              {agent.phase}
            </span>
          ) : null}
          {role ? (
            <span className="hidden shrink-0 text-[11px] text-muted-foreground/80 sm:inline">
              {role}
            </span>
          ) : null}
          {agent.cached ? (
            <span className="shrink-0 text-[11px] text-muted-foreground/80">cached</span>
          ) : null}
        </div>
        {detail ? (
          <div
            className={cn(
              "mt-0.5 truncate text-[11px]",
              agent.status === "failed" ? "text-failure/90" : "text-muted-foreground/80",
            )}
            title={detail}
          >
            {detail}
          </div>
        ) : null}
      </div>
      <WorkflowAgentUsage agent={agent} />
    </li>
  );
}

function WorkflowAgentUsage({ agent }: { agent: NativeAgentWorkflowAgent }) {
  const toolUses = agent.toolUses ? agent.toolUses : undefined;
  const tokens = agent.totalTokens ? formatTokenCount(agent.totalTokens) : undefined;
  const duration =
    agent.durationMs !== undefined && !isLiveWorkflowAgent(agent)
      ? formatAgentDurationMs(agent.durationMs)
      : undefined;
  if (toolUses === undefined && !tokens && !duration) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap pt-px text-[11px] tabular-nums text-muted-foreground">
      {toolUses !== undefined ? (
        <span className="flex items-center gap-1" title={`${toolUses} tool uses`}>
          <Wrench className="size-3" aria-hidden />
          {toolUses}
        </span>
      ) : null}
      {tokens ? (
        <span className="flex items-center gap-1" title={`${tokens} tokens`}>
          <Coins className="size-3" aria-hidden />
          {tokens}
        </span>
      ) : null}
      {duration ? <span>{duration}</span> : null}
    </div>
  );
}

/** The agents a workflow task reports, in run order. */
export function WorkflowAgentList({
  agents,
  omitted = 0,
}: {
  agents: readonly NativeAgentWorkflowAgent[] | undefined;
  omitted?: number;
}) {
  if (!agents || agents.length === 0) return null;
  const live = agents.filter(isLiveWorkflowAgent).length;
  return (
    <section aria-label={`${agents.length} workflow agents`} className="mb-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Workflow agents</span>
        <span className="font-normal tabular-nums text-muted-foreground">{agents.length}</span>
        {live > 0 ? (
          <span className="ml-auto font-medium normal-case tracking-normal text-amber-600 dark:text-amber-300">
            {live} active
          </span>
        ) : null}
      </div>
      <ol className="divide-y divide-border/50 overflow-hidden rounded-md border border-border/50">
        {agents.map((agent) => (
          <WorkflowAgentRow key={agent.index} agent={agent} />
        ))}
      </ol>
      {omitted > 0 ? (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <MinusCircle className="size-3" aria-hidden />
          {omitted} more {omitted === 1 ? "agent" : "agents"} not shown
        </div>
      ) : null}
    </section>
  );
}
