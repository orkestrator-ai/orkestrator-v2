import { Loader2 } from "lucide-react";
import { nativeAgentLatestActivity } from "@/lib/chat/native-agent-preview";
import type { NativeAgentActivityPart } from "@/lib/chat/native-message-types";

interface ActiveSubagentRailProps {
  agents: readonly NativeAgentActivityPart[];
}

/**
 * Every active agent shares one truncated line, and a child action can be a
 * whole shell command or an entire response body. Left unbounded, the first
 * agent's activity pushes every other agent's name out of view — the opposite
 * of what the rail exists to show.
 */
const MAX_ACTIVITY_DETAIL_CHARS = 60;

function boundActivityDetail(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_ACTIVITY_DETAIL_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_ACTIVITY_DETAIL_CHARS - 1).trimEnd()}…`;
}

function stringArgument(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function trimTaskPrefix(value: string): string {
  return value.replace(/^task\s*:\s*/i, "").trim();
}

export function activeSubagentLabel(part: NativeAgentActivityPart): string {
  if (part.type === "subagent") {
    return part.subagentName?.trim()
      || part.subagentRole?.trim()
      || part.subagentPrompt?.trim()
      || trimTaskPrefix(part.toolTitle?.trim() || part.content.trim())
      || "Sub-agent";
  }

  const task = part.task;
  return stringArgument(
    task.toolArgs,
    "name",
    "agentName",
    "agent_name",
    "description",
    "task",
    "prompt",
  )
    || trimTaskPrefix(task.toolTitle?.trim() || task.content.trim())
    || "Sub-agent";
}

export function activeSubagentDetail(part: NativeAgentActivityPart): string {
  const label = activeSubagentLabel(part);
  const activity = nativeAgentLatestActivity(part);
  if (!activity || activity === label) return label;
  const bounded = boundActivityDetail(activity);
  if (!bounded || bounded === label) return label;
  return `${label}: ${bounded}`;
}

/** A compact, composer-themed indication that child work remains active. */
export function ActiveSubagentRail({ agents }: ActiveSubagentRailProps) {
  if (agents.length === 0) return null;

  const noun = agents.length === 1 ? "sub-agent" : "sub-agents";
  const details = agents.map(activeSubagentDetail);
  return (
    <section
      data-testid="active-subagent-rail"
      role="status"
      aria-live="polite"
      aria-label={`${agents.length} ${noun} working`}
      className="mx-auto w-[calc(100%_-_0.75rem)] overflow-hidden rounded-2xl border border-border/70 bg-zinc-900/90 shadow-xl shadow-black/20 sm:w-full"
    >
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-cyan-400/10 text-cyan-300">
          <Loader2
            data-testid="active-subagent-spinner"
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">
            {agents.length} {noun} working
          </p>
          {/*
            The count above is the announcement worth making. This line changes
            on every child tool call, so it opts out of the surrounding polite
            region rather than re-reading the rail aloud several times a second.
            It stays readable on navigation because it is not `aria-hidden`.
          */}
          <p
            data-testid="active-subagent-detail"
            aria-live="off"
            className="truncate text-xs text-muted-foreground"
            title={details.join(", ")}
          >
            {details.join(" · ")}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-cyan-400/20 bg-cyan-400/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cyan-200/80">
          Active
        </span>
      </div>
    </section>
  );
}
