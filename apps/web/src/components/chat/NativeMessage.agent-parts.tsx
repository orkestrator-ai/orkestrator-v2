import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  Check,
  ChevronRight,
  Coins,
  Copy,
  FolderOpen,
  Layers,
  Loader2,
  Square,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";
import { revealInFileManager } from "@/lib/backend";
import { formatTokenCount } from "@/lib/context-usage";
import { writeText } from "@/lib/native/clipboard";
import { parseBackendTurnStartedAt } from "@/lib/session-timer";
import { formatAgentDurationMs, formatNativeAgentElapsed } from "@/lib/chat/native-agent-duration";
import { getToolDisplayName, getToolTitleDisplayName } from "@/lib/tool-names";
import { getNativeAgentStatus, type NativeAgentStatus } from "@/lib/chat/native-agent-status";
import { nativeAgentLatestActivity } from "@/lib/chat/native-agent-preview";
import { isTaskTool } from "@/lib/chat/native-message-adapters";
import {
  type NativeAgentGroupPart,
  type NativeBackgroundTask,
  type NativeBackgroundTaskStatus,
  type NativeMessagePart,
  type NativeTaskGroupPart,
  type NativeToolGroupPart,
} from "@/lib/chat/native-message-types";
import { shouldFoldToolGroup, summarizeToolGroup } from "@/lib/chat/tool-group-summary";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import {
  AgentExpansionScopeContext,
  AgentPlatformContext,
  BackgroundTaskChildrenContext,
  BackgroundTaskStopContext,
  MessageExpansionScopeContext,
  ModelLabelResolverContext,
  NativeMessagePartRenderer,
  getToolExpansionKey,
  markdownComponents,
  useAgentExpansion,
  useDeferredToolResult,
} from "./NativeMessage.shared";
import { toolRowPreview } from "./NativeMessage.basic-parts";

function getSubagentStatusLabel(status: NativeAgentStatus): string {
  switch (status) {
    case "finished":
      return "Finished";
    case "failed":
      return "Failed";
    default:
      return "Active";
  }
}

function getSubagentStatusClasses(status: NativeAgentStatus): string {
  switch (status) {
    case "finished":
      return "border-success/30 bg-success/10 text-success";
    case "failed":
      return "border-failure/30 bg-failure/10 text-failure";
    default:
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

function isTerminalAgentStatus(status: NativeAgentStatus): boolean {
  return status === "finished" || status === "failed";
}

interface SubagentPreview {
  text: string;
  /** True when the text is the spawn prompt rather than live activity. */
  isTask: boolean;
}

/**
 * The spawn prompt identifies a child that has not reported anything yet, and it
 * is the useful record for one that has already finished. While the child is
 * actively working the latest action is what the collapsed row is for, so the
 * prompt stays in the expanded body only — otherwise a running agent shows the
 * same static line for its entire lifetime.
 */
function getSubagentPreview(
  part: Extract<NativeMessagePart, { type: "subagent" }>,
  status: NativeAgentStatus,
): SubagentPreview {
  const task = part.subagentPrompt?.trim();
  const actions = part.subagentActions ?? [];

  if (task && (isTerminalAgentStatus(status) || actions.length === 0)) {
    return { text: task, isTask: true };
  }

  const latestActivity = nativeAgentLatestActivity(part);
  if (!latestActivity) {
    return {
      text: isTerminalAgentStatus(status) ? "No activity captured." : "Waiting for activity.",
      isTask: false,
    };
  }

  return { text: latestActivity, isTask: false };
}

function stringToolArg(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function numberToolArg(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

/**
 * Live elapsed label for an agent card. The start clock is the backend launch
 * timestamp; vendor spawn-echo `durationMs` is ignored while the child is
 * still running. Settled cards use the duration the backend stamped at settle.
 */
function useAgentRuntimeLabel(
  status: NativeAgentStatus,
  startedAt: string | undefined,
  settledDurationMs: number | undefined,
  tickKey: string,
): string | undefined {
  const isActive = status === "active";
  const { elapsedSeconds } = useElapsedTimer(
    isActive,
    tickKey,
    parseBackendTurnStartedAt(startedAt),
  );
  return formatNativeAgentElapsed({
    status,
    elapsedMs: isActive
      ? elapsedSeconds === null
        ? undefined
        : elapsedSeconds * 1000
      : settledDurationMs,
  });
}

/** Wall time, matching the live clock; paused time is shown as a separate detail. */
function backgroundTaskDurationMs(
  startedAt: string | undefined,
  settledAt: string | undefined,
): number | undefined {
  const startedAtMs = parseBackendTurnStartedAt(startedAt);
  const settledAtMs = parseBackendTurnStartedAt(settledAt);
  if (startedAtMs === undefined || settledAtMs === undefined || settledAtMs < startedAtMs) {
    return undefined;
  }
  return Math.max(0, settledAtMs - startedAtMs);
}

function RuntimeLabel({ value, className }: { value?: string; className?: string }) {
  if (!value) return null;
  return (
    <div className={cn("shrink-0 tabular-nums text-[11px] text-muted-foreground/70", className)}>
      {value}
    </div>
  );
}

function usefulAgentOutput(output?: string): string | undefined {
  const trimmed = output?.trim();
  if (!trimmed) return undefined;
  if (/^sub-?agents? launched\.?$/i.test(trimmed)) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      if (
        keys.length > 0 &&
        keys.every((key) => key === "durationMs" || key === "isBackground" || key === "status")
      ) {
        return undefined;
      }
    }
  } catch {
    // Plain text from the child is worth showing.
  }
  return trimmed;
}

function buildAgentDisplayLabel(name: string, role?: string): string {
  if (!role || role.localeCompare(name, undefined, { sensitivity: "accent" }) === 0) {
    return name;
  }
  return `${name} (${role})`;
}

function shouldShowTokenOnlyAgentUsage(part: NativeMessagePart): boolean {
  return part.agentUsageDisplay === "token-only" && Boolean(part.tokenCountText);
}

/**
 * The model and effort a child ran on, from the neutral sub-agent fields.
 *
 * Every provider that names them fills the same two part fields, so this is
 * the one place they become labels; a launch argument naming a model is only
 * the fallback for providers that report nothing better.
 */
function useAgentModelOptions(part: NativeMessagePart): {
  modelId?: string;
  reasoningEffort?: string;
  resolveModelLabel?: (modelId: string) => string;
} {
  // Typed as strings, but read off provider JSON: a drifted value must cost a
  // meta row, not the card.
  const text = (value: unknown) =>
    typeof value === "string" ? value.trim() || undefined : undefined;
  return {
    modelId: text(part.subagentModelId),
    reasoningEffort: text(part.subagentReasoningEffort),
    resolveModelLabel: useContext(ModelLabelResolverContext),
  };
}

function agentMetaEntries(
  toolArgs: Record<string, unknown> | undefined,
  displayName: string,
  options: {
    includeDuration?: boolean;
    modelId?: string;
    reasoningEffort?: string;
    resolveModelLabel?: (modelId: string) => string;
  } = {},
): Array<{ label: string; value: string }> {
  const role = stringToolArg(toolArgs, "subagent_type", "subagentType", "role");
  const modelId = options.modelId ?? stringToolArg(toolArgs, "model");
  const model = modelId ? options.resolveModelLabel?.(modelId).trim() || modelId : undefined;
  const reasoningEffort = options.reasoningEffort;
  const durationMs =
    options.includeDuration === false ? undefined : numberToolArg(toolArgs, "durationMs");
  const agentId = stringToolArg(toolArgs, "agentId", "agent_id");
  return [
    ...(role && role !== displayName ? [{ label: "Type", value: role }] : []),
    ...(model ? [{ label: "Model", value: model }] : []),
    ...(reasoningEffort ? [{ label: "Effort", value: reasoningEffort }] : []),
    ...(durationMs !== undefined
      ? [{ label: "Duration", value: formatAgentDurationMs(durationMs) }]
      : []),
    ...(agentId ? [{ label: "Agent ID", value: agentId }] : []),
  ];
}

function AgentMetaRows({ entries }: { entries: Array<{ label: string; value: string }> }) {
  if (entries.length === 0) return null;
  return (
    <dl className="mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {entries.map((entry) => (
        <Fragment key={entry.label}>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {entry.label}
          </dt>
          <dd className="min-w-0 truncate text-muted-foreground/90">{entry.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * A sub-agent's result runs to the bridge's 512 KiB tool-output cap, so it gets
 * the same bounded, scrollable frame every other tool output on this transcript
 * uses rather than expanding the row to an arbitrary height.
 */
function AgentResultBlock({ result }: { result?: string }) {
  if (!result) return null;
  return (
    <div className="mb-3 border-l border-border/30 pl-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        Result
      </div>
      <div className="max-h-64 overflow-auto">
        <MessageMarkdown
          content={result}
          components={markdownComponents}
          className="text-xs text-muted-foreground/90 prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-pre:my-1 prose-pre:p-2"
          enableBreaks={false}
        />
      </div>
    </div>
  );
}

function formatUpdateCount(count: number): string {
  return `${count} ${count === 1 ? "update" : "updates"}`;
}

/**
 * One usage figure as icon + number. The full phrase stays available to
 * assistive tech and as a hover tooltip, so the compact form loses nothing.
 */
function UsageStat({
  icon: Icon,
  value,
  label,
}: {
  icon: LucideIcon;
  value: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={label}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span aria-hidden="true">{value}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** "122k tokens" reads as "122k" beside the token icon. */
function compactTokenCount(text: string): string {
  return text.replace(/\s*tokens?$/i, "") || text;
}

/** Tools, tokens and updates side by side on a single line. */
function UsageStatsRow({
  toolUses,
  toolLabel,
  tokenCountText,
  updates,
}: {
  toolUses?: number;
  toolLabel?: string;
  tokenCountText?: string;
  updates?: number;
}) {
  if (toolUses === undefined && !tokenCountText && updates === undefined) return null;
  return (
    <div className="flex items-center justify-end gap-2.5 whitespace-nowrap text-[11px] text-muted-foreground/70">
      {toolUses !== undefined ? (
        <UsageStat
          icon={Wrench}
          value={String(toolUses)}
          label={toolLabel ?? formatToolUseCount(toolUses)}
        />
      ) : null}
      {tokenCountText ? (
        <UsageStat icon={Coins} value={compactTokenCount(tokenCountText)} label={tokenCountText} />
      ) : null}
      {updates !== undefined ? (
        <UsageStat icon={Activity} value={String(updates)} label={formatUpdateCount(updates)} />
      ) : null}
    </div>
  );
}

function AgentUsageStats({
  hasExternalUsage,
  tokenOnlyUsage,
  tokenCountText,
  toolCount,
  updateCount,
  durationLabel,
}: {
  hasExternalUsage: boolean;
  tokenOnlyUsage: boolean;
  tokenCountText?: string;
  toolCount: number;
  updateCount: number;
  durationLabel?: string;
}) {
  const hideCounts = useContext(AgentPlatformContext) === "cursor";
  if (hideCounts || tokenOnlyUsage) {
    if (!durationLabel && !tokenCountText) return null;
    return (
      <div className="flex shrink-0 self-end flex-col items-end gap-1">
        <UsageStatsRow tokenCountText={tokenCountText} />
        <RuntimeLabel value={durationLabel} />
      </div>
    );
  }

  const showTools = hasExternalUsage || toolCount > 0;
  const showUpdates = Boolean(tokenCountText) || updateCount > 0;
  if (!showTools && !showUpdates && !durationLabel) return null;

  const toolCountLabel = hasExternalUsage
    ? formatToolUseCount(toolCount)
    : `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;

  return (
    <div className="flex shrink-0 self-end flex-col items-end gap-1">
      <UsageStatsRow
        toolUses={showTools ? toolCount : undefined}
        toolLabel={toolCountLabel}
        tokenCountText={showUpdates ? tokenCountText : undefined}
        updates={showUpdates && !tokenCountText ? updateCount : undefined}
      />
      <RuntimeLabel value={durationLabel} />
    </div>
  );
}

function AgentActivityIcon({
  status,
  spinning = status === "active",
}: {
  status: NativeAgentStatus;
  /** Paused work is live but not progressing, so it must not appear to be. */
  spinning?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full",
        status === "active" && "bg-cyan-400/10 text-cyan-300",
        status === "finished" && "bg-success/10 text-success",
        status === "failed" && "bg-failure/10 text-failure",
      )}
      aria-hidden="true"
    >
      {spinning ? (
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      ) : (
        <Layers className="size-4" />
      )}
    </span>
  );
}

const agentCardClassName =
  "my-0 overflow-hidden rounded-lg border border-border/70 bg-zinc-900/90 shadow-sm shadow-black/15";

interface BackgroundTaskPresentation {
  label: string;
  /** Whether the provider will still accept a stop request for this task. */
  live: boolean;
  spinning: boolean;
  status: NativeAgentStatus;
  pillClassName: string;
}

const NEUTRAL_STATUS_PILL = "border-border/60 bg-muted/40 text-muted-foreground";

const BACKGROUND_TASK_PRESENTATION: Record<NativeBackgroundTaskStatus, BackgroundTaskPresentation> =
  {
    pending: {
      label: "Starting",
      live: true,
      spinning: true,
      status: "active",
      pillClassName: getSubagentStatusClasses("active"),
    },
    running: {
      label: "Running",
      live: true,
      spinning: true,
      status: "active",
      pillClassName: getSubagentStatusClasses("active"),
    },
    paused: {
      label: "Paused",
      live: true,
      spinning: false,
      status: "active",
      pillClassName: getSubagentStatusClasses("active"),
    },
    completed: {
      label: "Completed",
      live: false,
      spinning: false,
      status: "finished",
      pillClassName: getSubagentStatusClasses("finished"),
    },
    failed: {
      label: "Failed",
      live: false,
      spinning: false,
      status: "failed",
      pillClassName: getSubagentStatusClasses("failed"),
    },
    /*
     * A task the user stopped did what they asked, so it is not painted as a
     * failure. It is still terminal, which is what removes the stop control.
     */
    killed: {
      label: "Stopped",
      live: false,
      spinning: false,
      status: "finished",
      pillClassName: NEUTRAL_STATUS_PILL,
    },
  };

/**
 * A launch this transcript recovered without a live snapshot behind it.
 *
 * The provider's bounded task history has forgotten it, so its outcome is
 * genuinely unknown and no stop control may be offered: the id may name work
 * that ended long ago, or nothing at all.
 */
const UNKNOWN_BACKGROUND_TASK: BackgroundTaskPresentation = {
  label: "Launched",
  live: false,
  spinning: false,
  status: "finished",
  pillClassName: NEUTRAL_STATUS_PILL,
};

function backgroundTaskPresentation(task: NativeBackgroundTask): BackgroundTaskPresentation {
  return task.status ? BACKGROUND_TASK_PRESENTATION[task.status] : UNKNOWN_BACKGROUND_TASK;
}

/** The provider-neutral role naming the conversation's own backgrounded agent. */
const MAIN_SESSION_AGENT_ROLE = "main-session";

/**
 * The delegated agent's role, for display. The conversation's own agent is not
 * a delegate, so it has none here; the kicker names it instead.
 */
function backgroundTaskAgentType(task: NativeBackgroundTask): string | undefined {
  const role = task.agentRole?.trim();
  return role && role !== MAIN_SESSION_AGENT_ROLE ? role : undefined;
}

const BACKGROUND_TASK_KIND_LABELS: Record<NonNullable<NativeBackgroundTask["kind"]>, string> = {
  shell: "Shell",
  agent: "Agent",
  workflow: "Workflow",
  "remote-agent": "Remote agent",
  mcp: "MCP",
  teammate: "Teammate",
  other: "Task",
};

function backgroundTaskKind(task: NativeBackgroundTask): string {
  const role = task.agentRole?.trim();
  if (role) return role === MAIN_SESSION_AGENT_ROLE ? "Main session" : "Agent";
  return (task.kind && BACKGROUND_TASK_KIND_LABELS[task.kind]) ?? "Task";
}

/*
 * A card with no launch row may have no description either. The agent's role
 * is then the most specific name the snapshot carries, and still better than
 * an opaque id.
 */
function backgroundTaskLabel(task: NativeBackgroundTask): string {
  return (
    task.description?.trim() ||
    task.workflowName?.trim() ||
    backgroundTaskAgentType(task) ||
    (task.agentRole?.trim() === MAIN_SESSION_AGENT_ROLE ? "Backgrounded conversation" : "") ||
    `Background task ${task.id}`
  );
}

interface BackgroundTaskOutcomeLine {
  label: "Error" | "Summary" | "Ended";
  text: string;
}

/**
 * How the task ended, in the provider's words.
 *
 * A failed task's error is usually its terminal summary verbatim, and a
 * summary that only repeats the header says nothing, so each line is shown at
 * most once.
 */
function backgroundTaskOutcome(task: NativeBackgroundTask): BackgroundTaskOutcomeLine[] {
  const lines: BackgroundTaskOutcomeLine[] = [];
  const error = task.error?.trim();
  const summary = task.summary?.trim();
  if (error) lines.push({ label: "Error", text: error });
  if (summary && summary !== error && summary !== task.description?.trim()) {
    lines.push({ label: "Summary", text: summary });
  }
  if (task.endReason === "process-restart") {
    lines.push({
      label: "Ended",
      text: "The agent process restarted while this task was running, so it was stopped.",
    });
  }
  return lines;
}

/**
 * What a live task is doing right now, in the provider's words: its own status
 * line, else the tool its agent last ran. Nothing once it has settled, when
 * its outcome says more.
 */
function backgroundTaskLiveStatus(task: NativeBackgroundTask): string | undefined {
  if (!backgroundTaskPresentation(task).live) return undefined;
  const summary = task.progressSummary?.trim();
  if (summary) return summary;
  const tool = task.lastToolName?.trim();
  return tool ? `Using ${tool}` : undefined;
}

/** The command a live child is running, for an agent card with nothing newer to say. */
function liveChildTaskStatus(children: readonly NativeBackgroundTask[]): string | undefined {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    if (!backgroundTaskPresentation(child).live) continue;
    const doing = child.command?.trim() || child.description?.trim();
    if (doing) return `${backgroundTaskKind(child)} · ${doing}`;
  }
  return undefined;
}

interface BackgroundTaskUsageCounts {
  toolUses?: number;
  tokenCountText?: string;
  updates?: number;
}

/** Usage worth showing: a shell task reports zeros, which would only be noise. */
function backgroundTaskUsageCounts(task: NativeBackgroundTask): BackgroundTaskUsageCounts {
  const usage = task.usage;
  if (!usage) return {};
  return {
    ...(usage.toolUses > 0 ? { toolUses: usage.toolUses } : {}),
    ...(usage.totalTokens > 0
      ? { tokenCountText: `${formatTokenCount(usage.totalTokens)} tokens` }
      : {}),
  };
}

/**
 * A background Agent's snapshot usage, falling back to whatever the launch row
 * itself reported, then captured child activity. Cursor reports no activity
 * counts, so none is invented for it.
 */
function backgroundAgentUsageCounts(
  task: NativeBackgroundTask,
  launch: NativeMessagePart,
  hideToolCount: boolean,
  capturedToolCount: number,
  childCount: number,
): BackgroundTaskUsageCounts {
  const counts = backgroundTaskUsageCounts(task);
  const toolUses = task.usage?.toolUses ?? launch.toolUseCount ?? capturedToolCount;
  const tokenCountText = counts.tokenCountText ?? launch.tokenCountText;
  return {
    ...(toolUses > 0 && !hideToolCount ? { toolUses } : {}),
    ...(tokenCountText ? { tokenCountText } : {}),
    ...(!tokenCountText && childCount > 0 && !hideToolCount ? { updates: childCount } : {}),
  };
}

function formatToolUseCount(count: number): string {
  return `${count} ${count === 1 ? "tool use" : "tool uses"}`;
}

/**
 * The header's right rail: usage on top, runtime below. Usage lives here
 * rather than in the expanded body so a task whose only details are its counts
 * never needs expanding to read them.
 */
function BackgroundTaskRail({
  usage,
  durationLabel,
}: {
  usage: BackgroundTaskUsageCounts;
  durationLabel?: string;
}) {
  const hasUsage =
    usage.toolUses !== undefined ||
    usage.tokenCountText !== undefined ||
    usage.updates !== undefined;
  if (!hasUsage && !durationLabel) return null;
  return (
    <div className="flex shrink-0 self-stretch flex-col items-end justify-between gap-1">
      <UsageStatsRow
        toolUses={usage.toolUses}
        tokenCountText={usage.tokenCountText}
        updates={usage.updates}
      />
      {/* A lone timer still sits bottom-right, where it does beside usage. */}
      <RuntimeLabel value={durationLabel} className="mt-auto" />
    </div>
  );
}

function backgroundTaskMetaEntries(
  task: NativeBackgroundTask,
): Array<{ label: string; value: string }> {
  const agentType = backgroundTaskAgentType(task);
  const workflow = task.workflowName?.trim();
  return [
    ...(agentType ? [{ label: "Agent type", value: agentType }] : []),
    ...(workflow && workflow !== task.description?.trim()
      ? [{ label: "Workflow", value: workflow }]
      : []),
    ...(task.pausedMs && task.pausedMs > 0
      ? [{ label: "Paused", value: formatAgentDurationMs(task.pausedMs) }]
      : []),
  ];
}

/** A labelled, bounded block of verbatim text: a command, a prompt, output. */
function BackgroundTaskTextBlock({
  label,
  text,
  mono = false,
}: {
  label: string;
  text: string;
  mono?: boolean;
}) {
  return (
    <div className="mb-3 border-l border-border/30 pl-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      <pre
        className={cn(
          "max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground/90",
          mono ? "font-mono" : "font-sans",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

/** The tasks a task's agent launched, which the provider reports as their own. */
function useBackgroundTaskChildren(taskId: string | undefined): readonly NativeBackgroundTask[] {
  const children = useContext(BackgroundTaskChildrenContext);
  return (taskId && children.get(taskId)) || NO_CHILD_TASKS;
}

const NO_CHILD_TASKS: readonly NativeBackgroundTask[] = [];

function ChildBackgroundTask({
  task,
  containerId,
}: {
  task: NativeBackgroundTask;
  containerId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <BackgroundTaskCard
      task={task}
      containerId={containerId}
      open={open}
      onOpenChange={setOpen}
      embedded
    />
  );
}

/**
 * An agent's own tasks — the commands it ran long enough to be tracked, and the
 * agents it delegated to — inside its card, where they belong.
 */
function BackgroundTaskChildList({
  tasks,
  containerId,
}: {
  tasks: readonly NativeBackgroundTask[];
  containerId?: string;
}) {
  if (tasks.length === 0) return null;
  const live = tasks.filter((task) => backgroundTaskPresentation(task).live).length;
  return (
    <section aria-label={`${tasks.length} launched tasks`} className="mb-3">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        <span>Launched tasks</span>
        <span className="font-normal tabular-nums text-muted-foreground/50">{tasks.length}</span>
        {live > 0 ? (
          <span className="ml-auto font-medium normal-case tracking-normal text-amber-600 dark:text-amber-300">
            {live} active
          </span>
        ) : null}
      </div>
      <div className="divide-y divide-border/50 overflow-hidden rounded-md border border-border/50">
        {tasks.map((task) => (
          <ChildBackgroundTask key={task.id} task={task} containerId={containerId} />
        ))}
      </div>
    </section>
  );
}

function BackgroundTaskOutputFile({ path, containerId }: { path: string; containerId?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const reveal = useCallback(() => {
    void revealInFileManager(path).catch((error) => {
      toast.error("Could not reveal the output file", {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, [path]);
  const copy = useCallback(async () => {
    try {
      await writeText(path);
      setCopied(true);
    } catch {
      toast.error("Could not copy the output file path");
    }
  }, [path]);

  return (
    <div className="mb-3 border-l border-border/30 pl-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        Output file
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/90"
          title={path}
        >
          {path}
        </span>
        {!containerId ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6 shrink-0 p-0 text-muted-foreground/70 hover:text-foreground"
            onClick={reveal}
            aria-label="Reveal output file"
            title="Reveal in file manager"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="h-6 w-6 shrink-0 p-0 text-muted-foreground/70 hover:text-foreground"
          onClick={() => void copy()}
          aria-label={copied ? "Copied output file path" : "Copy output file path"}
          title={copied ? "Copied" : "Copy path"}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

/** Snapshot outcome details shared by synthesized tasks and loaded Agent launches. */
function BackgroundTaskDetails({
  task,
  containerId,
}: {
  task: NativeBackgroundTask;
  containerId?: string;
}) {
  return (
    <>
      {backgroundTaskOutcome(task).map((line) => (
        <div key={line.label} className="mb-3 border-l border-border/30 pl-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {line.label}
          </div>
          <pre
            className={cn(
              "max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans text-xs",
              line.label === "Error" ? "text-destructive/90" : "text-muted-foreground/90",
            )}
          >
            {line.text}
          </pre>
        </div>
      ))}
      {task.outputTail ? (
        <BackgroundTaskTextBlock label="Output" text={task.outputTail} mono />
      ) : null}
      <AgentMetaRows
        entries={[...backgroundTaskMetaEntries(task), { label: "Task ID", value: task.id }]}
      />
      {task.outputFile ? (
        <BackgroundTaskOutputFile path={task.outputFile} containerId={containerId} />
      ) : null}
    </>
  );
}

/** Hover group for a card whose activity icon turns into its stop control. */
const STOPPABLE_CARD_GROUP = "group/stoppable";

/**
 * The card's activity icon, which becomes its stop control while the task is
 * live. Both occupy the same 28px circle, so revealing the control on hover
 * never moves the rest of the row.
 *
 * The control is revealed on hover only where a precise hover pointer exists;
 * a touch screen has no hover, so there the control simply replaces the icon.
 */
function BackgroundTaskActivitySlot({
  task,
  presentation,
  onStop,
  onStopped,
  onFailed,
}: {
  task: NativeBackgroundTask;
  presentation: BackgroundTaskPresentation;
  onStop?: (taskId: string) => Promise<boolean>;
  onStopped: () => void;
  onFailed: (message: string) => void;
}) {
  const contextStop = useContext(BackgroundTaskStopContext);
  const stopBackgroundTask = onStop ?? contextStop;
  const [stopping, setStopping] = useState(false);
  const taskId = task.id;
  const status = task.status;

  /*
   * A stop that succeeded leaves the button disabled until the task's own
   * lifecycle moves, which normally means a terminal status that unmounts this
   * control. Releasing on *any* status change is what stops a request the
   * provider accepted but did not honour from disabling the only way to ask
   * again. A tab remounted mid-stop starts from the snapshot, never this flag.
   */
  useEffect(() => {
    setStopping(false);
  }, [status, taskId]);

  const label = backgroundTaskLabel(task);
  const stop = useCallback(async () => {
    if (!stopBackgroundTask || stopping) return;
    setStopping(true);
    let stopped = false;
    try {
      stopped = await stopBackgroundTask(taskId);
    } catch {
      stopped = false;
    }
    if (stopped) {
      onStopped();
      return;
    }
    setStopping(false);
    onFailed(`Could not stop “${label}”. Try again or use the main Stop control.`);
  }, [label, onFailed, onStopped, stopBackgroundTask, stopping, taskId]);

  const icon = <AgentActivityIcon status={presentation.status} spinning={presentation.spinning} />;
  if (!presentation.live || !stopBackgroundTask) return icon;

  return (
    <span className="group/stop-slot relative flex size-7 shrink-0">
      {/* While a stop is in flight the control stays up, showing its progress. */}
      <span
        className={cn(
          "flex transition-opacity duration-150",
          stopping
            ? "opacity-0"
            : "opacity-0 md:hover-fine:opacity-100 md:hover-fine:group-hover/stoppable:opacity-0 md:hover-fine:group-focus-within/stop-slot:opacity-0",
        )}
      >
        {icon}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(
          "absolute inset-0 size-7 rounded-full bg-cyan-400/10 p-0 text-cyan-300 transition-opacity duration-150 hover:bg-destructive/15 hover:text-destructive",
          !stopping &&
            "opacity-100 md:hover-fine:opacity-0 md:hover-fine:group-hover/stoppable:opacity-100 md:hover-fine:focus-visible:opacity-100",
        )}
        disabled={stopping}
        aria-label={`Stop ${label}`}
        title={stopping ? "Stopping…" : "Stop task"}
        onClick={() => void stop()}
      >
        {stopping ? (
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : (
          <Square className="size-3 fill-current" aria-hidden />
        )}
      </Button>
    </span>
  );
}

/**
 * A provider-owned background task, rendered as the agent card every other
 * long-running child uses.
 *
 * It is named for the work the provider says it is ("Shell", "Agent", …), else
 * "Task". A live task's activity icon doubles as its stop control, whatever
 * usage the task reports sits in the header's right rail rather than behind an
 * expansion, and the tasks its own agent launched are listed inside it.
 */
export function BackgroundTaskCard({
  task,
  containerId,
  launchStartedAt,
  command,
  result,
  resultPending = false,
  open,
  onOpenChange,
  onStop,
  embedded = false,
}: {
  task: NativeBackgroundTask;
  containerId?: string;
  /** Transcript launch clock used when an older snapshot has no `startedAt`. */
  launchStartedAt?: string;
  /** The command or prompt that launched the task, shown collapsed. */
  command?: string;
  /** Launch output, shown in the expanded body. */
  result?: string;
  /**
   * True while the launch output is still behind a detail reference. The row
   * has to be expandable before it is in hand, or it could never be fetched.
   */
  resultPending?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Overrides `BackgroundTaskStopContext` for cards rendered outside a message. */
  onStop?: (taskId: string) => Promise<boolean>;
  embedded?: boolean;
}) {
  const [stopError, setStopError] = useState<string | null>(null);
  const presentation = backgroundTaskPresentation(task);
  const startedAt = task.startedAt ?? launchStartedAt;
  const durationLabel = useAgentRuntimeLabel(
    presentation.status,
    startedAt,
    backgroundTaskDurationMs(startedAt, task.settledAt),
    task.id,
  );
  const children = useBackgroundTaskChildren(task.id);
  // The launch row's own arguments win; the snapshot's copy is what a command
  // that has no row here (one a delegated agent ran) is known by.
  const shownCommand = command ?? task.command?.trim();
  const prompt = shownCommand ? undefined : task.prompt?.trim();
  const description = task.description?.trim();
  const outcome = backgroundTaskOutcome(task);
  const usage = backgroundTaskUsageCounts(task);
  const metaEntries = backgroundTaskMetaEntries(task);
  // The header already carries the description, so the collapsed second line is
  // for what it does not say: the command actually running, what a live task is
  // doing now, or — when nothing else is known — how the task ended.
  const preview = shownCommand && shownCommand !== description ? shownCommand : undefined;
  const statusPreview = preview
    ? undefined
    : (backgroundTaskLiveStatus(task) ?? liveChildTaskStatus(children));
  const outcomePreview = preview || statusPreview ? undefined : outcome[0];
  const hasPreview = Boolean(preview || statusPreview || outcomePreview);
  const hasBody = Boolean(
    shownCommand ||
    prompt ||
    result ||
    resultPending ||
    outcome.length > 0 ||
    task.outputTail ||
    task.outputFile ||
    metaEntries.length > 0 ||
    children.length > 0,
  );

  // The failure belongs to the attempt, not the task: a later status change
  // means the question the message answered is no longer being asked.
  useEffect(() => {
    setStopError(null);
  }, [task.status]);

  return (
    <Collapsible
      open={open && hasBody}
      onOpenChange={onOpenChange}
      className={cn(STOPPABLE_CARD_GROUP, !embedded && agentCardClassName)}
      data-background-task-id={task.id}
      data-background-task-status={task.status}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <BackgroundTaskActivitySlot
          task={task}
          presentation={presentation}
          onStop={onStop}
          onStopped={() => setStopError(null)}
          onFailed={setStopError}
        />
        <CollapsibleTrigger
          className={cn(
            "flex min-h-7 min-w-0 flex-1 gap-3 rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            hasPreview ? "items-start" : "items-center",
            hasBody ? "cursor-pointer hover:bg-white/[0.025]" : "cursor-default",
          )}
          disabled={!hasBody}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="shrink-0 font-medium uppercase tracking-wide text-muted-foreground/80">
                {backgroundTaskKind(task)}
              </span>
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {backgroundTaskLabel(task)}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  presentation.pillClassName,
                )}
              >
                {presentation.label}
              </span>
            </div>
            {preview ? (
              <div className="mt-1 truncate font-mono text-xs text-muted-foreground/80">
                {preview}
              </div>
            ) : statusPreview ? (
              <div className="mt-1 truncate text-xs text-muted-foreground/80">{statusPreview}</div>
            ) : outcomePreview ? (
              <div
                className={cn(
                  "mt-1 truncate text-xs",
                  outcomePreview.label === "Error"
                    ? "text-destructive/90"
                    : "text-muted-foreground/80",
                )}
              >
                {outcomePreview.text}
              </div>
            ) : null}
          </div>
          {/* The rail sits before the chevron so every card's chevron lines up at the edge. */}
          <BackgroundTaskRail usage={usage} durationLabel={durationLabel} />
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              hasPreview && "mt-1",
              open && hasBody && "rotate-90",
              !hasBody && "opacity-0",
            )}
          />
        </CollapsibleTrigger>
      </div>

      {stopError ? (
        <div role="alert" className="px-3 pb-2 text-xs text-destructive">
          {stopError}
        </div>
      ) : null}

      <CollapsibleContent>
        <div className="border-t border-border/40 px-3 py-3">
          {shownCommand ? (
            <BackgroundTaskTextBlock label="Command" text={shownCommand} mono />
          ) : null}
          {prompt ? <BackgroundTaskTextBlock label="Prompt" text={prompt} /> : null}
          <BackgroundTaskDetails task={task} containerId={containerId} />
          <AgentResultBlock result={result} />
          <BackgroundTaskChildList tasks={children} containerId={containerId} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SubagentPart({
  part,
  containerId,
  partKey,
  embedded = false,
}: {
  part: Extract<NativeMessagePart, { type: "subagent" }>;
  containerId?: string;
  partKey: string;
  embedded?: boolean;
}) {
  const [isOpen, setIsOpen] = useAgentExpansion(part, partKey);
  const subagentActions = part.subagentActions ?? [];
  const hasExternalUsage = typeof part.toolUseCount === "number";
  const tokenOnlyUsage = shouldShowTokenOnlyAgentUsage(part);
  const toolCount = part.toolUseCount ?? part.subagentActionCount ?? 0;
  const displayName = part.subagentName || part.subagentRole || part.content || "subagent";
  const displayLabel = buildAgentDisplayLabel(displayName, part.subagentRole);
  const status = getNativeAgentStatus(part);
  const statusLabel = getSubagentStatusLabel(status);
  const hideCounts = useContext(AgentPlatformContext) === "cursor";
  const modelOptions = useAgentModelOptions(part);
  const durationLabel = useAgentRuntimeLabel(
    status,
    part.createdAt,
    numberToolArg(part.toolArgs, "durationMs"),
    part.toolUseId ?? part.subagentId ?? partKey,
  );
  // Agent output runs to the bridge's 512 KiB cap and `usefulAgentOutput`
  // parses it, so keep that off every unrelated re-render.
  const result = useMemo(() => usefulAgentOutput(part.toolOutput), [part.toolOutput]);
  const prompt = part.subagentPrompt?.trim() || stringToolArg(part.toolArgs, "prompt");
  const preview = useMemo(() => {
    const next = getSubagentPreview(part, status);
    if (hideCounts && next.text === "No activity captured.") {
      if (prompt) return { text: prompt, isTask: true };
      return { text: "", isTask: false };
    }
    return next;
  }, [hideCounts, part, prompt, status]);

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(!embedded && agentCardClassName)}
    >
      <CollapsibleTrigger className="w-full px-3 py-2.5 text-left transition-colors hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 cursor-pointer">
        <div className={cn("flex gap-3", preview.text ? "items-start" : "items-center")}>
          <AgentActivityIcon status={status} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="shrink-0 font-medium uppercase tracking-wide text-muted-foreground/80">
                Agent
              </span>
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {displayLabel}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  getSubagentStatusClasses(status),
                )}
              >
                {statusLabel}
              </span>
            </div>
            {preview.text ? (
              <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground/80">
                {preview.isTask ? (
                  <span className="shrink-0 font-medium text-muted-foreground">Task ·</span>
                ) : null}
                <span className="truncate">{preview.text}</span>
              </div>
            ) : null}
          </div>
          <AgentUsageStats
            hasExternalUsage={hasExternalUsage}
            tokenOnlyUsage={tokenOnlyUsage}
            tokenCountText={part.tokenCountText}
            toolCount={toolCount}
            updateCount={subagentActions.length}
            durationLabel={durationLabel}
          />
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              preview.text && "mt-1",
              isOpen && "rotate-90",
            )}
          />
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="border-t border-border/40 px-3 py-3">
          {prompt ? (
            <div className="mb-3 border-l border-border/30 pl-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Task
              </div>
              <MessageMarkdown
                content={prompt}
                components={markdownComponents}
                className="text-xs text-muted-foreground/90 prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-pre:my-1 prose-pre:p-2"
                enableBreaks={false}
              />
            </div>
          ) : null}
          <AgentMetaRows
            entries={agentMetaEntries(part.toolArgs, displayName, {
              includeDuration: isTerminalAgentStatus(status),
              ...modelOptions,
            })}
          />
          <AgentResultBlock result={result} />

          <div className="space-y-1">
            {subagentActions.map((childPart, index) => (
              <NativeMessagePartRenderer
                key={`${part.subagentId || part.content}-subagent-part-${index}-${childPart.type}`}
                part={childPart}
                containerId={containerId}
                partKey={`${partKey}/subagent-${index}`}
              />
            ))}
            {subagentActions.length === 0 && !hideCounts ? (
              <div className="px-3 py-2 text-xs text-muted-foreground/70">
                No child actions yet.
              </div>
            ) : null}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AgentGroupPart({
  part,
  containerId,
  partKey,
}: {
  part: NativeAgentGroupPart;
  containerId?: string;
  partKey: string;
}) {
  if (part.parts.length === 0) {
    return null;
  }

  const activeCount = part.parts.filter((child) => {
    return getNativeAgentStatus(child) === "active";
  }).length;

  return (
    <section aria-label={`${part.parts.length} agents`} className="relative my-1">
      <div className="flex h-6 items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
        <Layers className="h-3 w-3" />
        <span>Agents</span>
        <span className="font-normal tabular-nums text-muted-foreground/50">
          {part.parts.length}
        </span>
        {activeCount > 0 ? (
          <span className="ml-auto font-medium normal-case tracking-normal text-amber-600 dark:text-amber-300">
            {activeCount} active
          </span>
        ) : null}
      </div>
      <div className={cn(agentCardClassName, "divide-y divide-border/70")}>
        {part.parts.map((child, index) => (
          <NativeMessagePartRenderer
            key={`agent-group-part-${index}-${child.type}`}
            part={child}
            containerId={containerId}
            partKey={`${partKey}/agent-${index}`}
            embedded
          />
        ))}
      </div>
    </section>
  );
}

export function ToolGroupPart({
  part,
  containerId,
  partKey,
}: {
  part: NativeToolGroupPart;
  containerId?: string;
  partKey: string;
}) {
  const folds = shouldFoldToolGroup(part.parts);
  // A group that was on screen unfolded animates into its folded line; one that
  // arrives already long (history, paging) just renders folded.
  const [shownUnfolded, setShownUnfolded] = useState(!folds);
  if (!folds && !shownUnfolded) setShownUnfolded(true);

  // An empty group would still paint its border and padding.
  if (part.parts.length === 0) {
    return null;
  }

  const rows = part.parts.map((child, index) => (
    <div key={`tool-group-part-${index}-${child.type}`} className="px-2 py-0.5">
      <NativeMessagePartRenderer
        part={child}
        containerId={containerId}
        partKey={`${partKey}/tool-${index}`}
      />
    </div>
  ));

  if (folds) {
    return (
      <FoldedToolGroup part={part} partKey={partKey} rows={rows} animateFold={shownUnfolded} />
    );
  }

  return (
    /*
      Padding lives on the rows, not the card, so the separators run the full
      width of the block rather than stopping short of its outline.

      Only the horizontal padding is the wrapper's to give: each row's own
      trigger already carries `py-1.5`, so anything more than a hairline here
      is added to that rather than replacing it.
    */
    <div className="my-0 divide-y divide-divider overflow-hidden rounded-lg border border-divider bg-sidebar">
      {rows}
    </div>
  );
}

/**
 * A long run of tool calls, folded to one line until the reader opens it.
 *
 * The folded line previews the newest call, so a running turn still shows what
 * the agent is doing now, and carries the group's size and how long it took
 * from the first call's start to the last call's end. Opened, the same line
 * heads the full list and folds it again.
 *
 * With `animateFold`, the group mounts open and folds on the next frame, so a
 * live group crossing the fold threshold visibly collapses its rows instead of
 * snapping to one line.
 */
function FoldedToolGroup({
  part,
  partKey,
  rows,
  animateFold = false,
}: {
  part: NativeToolGroupPart;
  partKey: string;
  rows: ReactNode[];
  animateFold?: boolean;
}) {
  const messageScope = useContext(MessageExpansionScopeContext);
  const transcriptScope = useContext(AgentExpansionScopeContext);
  const toolKeys = part.parts.flatMap((child, index) =>
    child.type === "tool-invocation"
      ? [getToolExpansionKey(child, `${partKey}/tool-${index}`)]
      : [],
  );
  // A provider call id is unique within its conversation, so it is scoped to
  // the transcript rather than to the row: coalescing renames the row that
  // holds a group whenever earlier rows merge in front of it.
  const groupKey = (toolKey = `part:${partKey}`) =>
    `native-tool-group:${toolKey.startsWith("id:") ? JSON.stringify([transcriptScope]) : messageScope}:${toolKey}`;
  /*
   * Remember every member: paging and streaming can change both ends in one
   * update. The message-local fallback also bridges calls acquiring provider
   * ids. All aliases are cleared together when the reader folds the group.
   */
  const [isOpen, setIsOpen] = useMessagePartExpansion([groupKey(), ...toolKeys.map(groupKey)]);
  const [holdingOpenToFold, setHoldingOpenToFold] = useState(animateFold);
  useEffect(() => {
    if (!holdingOpenToFold) return;
    const frame = requestAnimationFrame(() => setHoldingOpenToFold(false));
    return () => cancelAnimationFrame(frame);
  }, [holdingOpenToFold]);
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setHoldingOpenToFold(false);
      setIsOpen(open);
    },
    [setIsOpen],
  );
  const summary = summarizeToolGroup(part.parts);
  if (!summary) return null;

  const { latestTool, toolCount, pendingCount, failureCount, spanMs } = summary;
  const latestPartId = latestTool.toolUseId ?? latestTool.sourcePartId;
  const latestName = getToolDisplayName(latestTool.toolName);
  const latestPreview = toolRowPreview(latestTool);
  const latestDetail =
    latestPreview?.text ??
    latestTool.toolDiff?.filePath?.split("/").pop() ??
    getToolTitleDisplayName(latestTool.toolTitle, latestTool.toolName);
  const latestDetailMonospace = latestPreview ? latestPreview.monospace : true;
  const countLabel = `${toolCount} tool calls`;
  const spanLabel = spanMs === undefined ? undefined : formatAgentDurationMs(spanMs);

  return (
    <Collapsible
      open={isOpen || holdingOpenToFold}
      onOpenChange={handleOpenChange}
      className="my-0 divide-y divide-divider overflow-hidden rounded-lg border border-divider bg-sidebar"
    >
      {/*
        Folded, the line stands in for its newest call, so it carries that
        call's transcript id: a held scroll position still finds its tool.
        Open, the call's own row carries it instead.
      */}
      <div className="px-2 py-0.5" data-transcript-part-id={isOpen ? undefined : latestPartId}>
        <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <span className="sr-only">
            {isOpen ? "Fold" : "Show"} {countLabel}:{" "}
          </span>
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 transition-transform", isOpen && "rotate-90")}
          />
          <Layers className="h-3.5 w-3.5 shrink-0" />
          {isOpen ? (
            <span className="flex-1 truncate text-left font-medium">Tool calls</span>
          ) : (
            <>
              <span className="shrink-0 font-medium">{latestName}</span>
              <span
                className={cn(
                  "flex-1 truncate text-left text-muted-foreground/80",
                  latestDetailMonospace && "font-mono",
                )}
              >
                {latestDetail}
              </span>
            </>
          )}
          {pendingCount > 0 ? (
            <span className="shrink-0 animate-pulse text-yellow-600">running...</span>
          ) : null}
          {failureCount > 0 ? (
            <span className="shrink-0 text-failure">{failureCount} failed</span>
          ) : null}
          <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
            {countLabel}
          </span>
          {spanLabel ? (
            <span
              className="shrink-0 tabular-nums text-[10px] text-muted-foreground/60"
              title={`First call started to last call finished: ${spanLabel}`}
            >
              {spanLabel}
            </span>
          ) : null}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="tool-group-fold-content divide-y divide-divider">
        {rows}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function TaskGroupPart({
  part,
  containerId,
  partKey,
  embedded = false,
}: {
  part: NativeTaskGroupPart;
  containerId?: string;
  partKey: string;
  embedded?: boolean;
}) {
  const [isOpen, setIsOpen] = useAgentExpansion(part, partKey);
  const [stopError, setStopError] = useState<string | null>(null);
  const backgroundTask = part.task.backgroundTask;
  const backgroundAgentTask =
    backgroundTask && isTaskTool(part.task.toolName) ? backgroundTask : undefined;
  const standaloneBackgroundTask =
    backgroundTask && !backgroundAgentTask ? backgroundTask : undefined;
  useEffect(() => {
    setStopError(null);
  }, [backgroundTask?.status]);
  const toolLabel =
    getToolTitleDisplayName(part.task.toolTitle, part.task.toolName, part.task.content) ||
    getToolDisplayName(part.task.toolName, "Agent");
  const description = stringToolArg(part.task.toolArgs, "description");
  const prompt = stringToolArg(part.task.toolArgs, "prompt");
  const role = stringToolArg(part.task.toolArgs, "subagent_type", "subagentType", "role");
  const explicitName = stringToolArg(part.task.toolArgs, "agent_name", "agentName", "name");
  const hasExternalUsage = typeof part.task.toolUseCount === "number";
  const tokenOnlyUsage = shouldShowTokenOnlyAgentUsage(part.task);
  const genericToolLabel = /^(agent|task)$/i.test(toolLabel);
  const displayName = explicitName ?? description ?? (genericToolLabel ? "Subagent" : toolLabel);
  const headerDescription = explicitName ? description : undefined;
  const displayLabel = buildAgentDisplayLabel(displayName, role);
  const backgroundPresentation = backgroundAgentTask
    ? backgroundTaskPresentation(backgroundAgentTask)
    : undefined;
  const status = backgroundPresentation?.status ?? getNativeAgentStatus(part);
  const statusLabel = backgroundPresentation?.label ?? getSubagentStatusLabel(status);
  const childCount = part.childTools.length;
  const capturedToolCount = part.childTools.filter(
    (child) => child.type === "tool-invocation",
  ).length;
  const toolCount = part.task.toolUseCount ?? capturedToolCount;
  const hideCounts = useContext(AgentPlatformContext) === "cursor";
  const modelOptions = useAgentModelOptions(part.task);
  const durationLabel = useAgentRuntimeLabel(
    status,
    backgroundAgentTask?.startedAt ?? part.task.createdAt ?? part.createdAt,
    backgroundAgentTask
      ? backgroundTaskDurationMs(
          backgroundAgentTask.startedAt ?? part.task.createdAt ?? part.createdAt,
          backgroundAgentTask.settledAt,
        )
      : numberToolArg(part.task.toolArgs, "durationMs"),
    part.task.toolUseId ?? partKey,
  );
  // See `SubagentPart`: the parse is proportional to the 512 KiB output cap.
  // The projection defers every tool result, so the launch output an agent card
  // shows is fetched on first expansion rather than read off the part.
  const deferredResult = useDeferredToolResult(part.task, isOpen);
  const result = useMemo(
    () => usefulAgentOutput(deferredResult.toolOutput) ?? deferredResult.toolError,
    [deferredResult.toolError, deferredResult.toolOutput],
  );
  const childTasks = useBackgroundTaskChildren(backgroundAgentTask?.id);
  const preview = useMemo(() => {
    const latest = nativeAgentLatestActivity(part);
    if (latest) return latest;
    // A background agent streams none of its own activity here; the provider's
    // status line, or the command it is running, is all there is to say.
    const live =
      (backgroundAgentTask && backgroundTaskLiveStatus(backgroundAgentTask)) ??
      liveChildTaskStatus(childTasks);
    if (live) return live;
    if (hideCounts) {
      if (prompt && prompt !== displayName && prompt !== description) return prompt;
      if (description && description !== displayName) return description;
      return isTerminalAgentStatus(status) ? undefined : "Waiting for activity.";
    }
    return (
      description ??
      (isTerminalAgentStatus(status)
        ? (prompt ?? "No activity captured.")
        : "Waiting for activity.")
    );
  }, [backgroundAgentTask, childTasks, description, displayName, hideCounts, part, prompt, status]);
  const metaEntries = agentMetaEntries(part.task.toolArgs, displayName, {
    includeDuration: isTerminalAgentStatus(status),
    ...modelOptions,
  });
  const backgroundUsage = backgroundAgentTask
    ? backgroundAgentUsageCounts(
        backgroundAgentTask,
        part.task,
        hideCounts,
        capturedToolCount,
        childCount,
      )
    : undefined;

  if (standaloneBackgroundTask) {
    return (
      <BackgroundTaskCard
        task={standaloneBackgroundTask}
        containerId={containerId}
        launchStartedAt={part.task.createdAt ?? part.createdAt}
        command={stringToolArg(part.task.toolArgs, "command") ?? prompt}
        result={result}
        resultPending={Boolean(part.task.detailRef) && result === undefined}
        open={isOpen}
        onOpenChange={setIsOpen}
        embedded={embedded}
      />
    );
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(backgroundAgentTask && STOPPABLE_CARD_GROUP, !embedded && agentCardClassName)}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        {backgroundAgentTask && backgroundPresentation ? (
          <BackgroundTaskActivitySlot
            task={backgroundAgentTask}
            presentation={backgroundPresentation}
            onStopped={() => setStopError(null)}
            onFailed={setStopError}
          />
        ) : (
          <AgentActivityIcon status={status} />
        )}
        <CollapsibleTrigger className="min-w-0 flex-1 text-left transition-colors hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 cursor-pointer">
          <div className={cn("flex min-h-7 gap-3", preview ? "items-start" : "items-center")}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="shrink-0 font-medium uppercase tracking-wide text-muted-foreground/80">
                  Agent
                </span>
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {displayLabel}
                </span>
                {headerDescription ? (
                  <span className="min-w-0 truncate text-sm text-muted-foreground/75">
                    {headerDescription}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    backgroundPresentation?.pillClassName ?? getSubagentStatusClasses(status),
                  )}
                >
                  {statusLabel}
                </span>
              </div>
              {preview ? (
                <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground/80">
                  {hideCounts && prompt && preview === prompt ? (
                    <span className="shrink-0 font-medium text-muted-foreground">Task ·</span>
                  ) : null}
                  <span className="truncate">{preview}</span>
                </div>
              ) : null}
            </div>
            {backgroundUsage ? (
              <BackgroundTaskRail usage={backgroundUsage} durationLabel={durationLabel} />
            ) : (
              <AgentUsageStats
                hasExternalUsage={hasExternalUsage}
                tokenOnlyUsage={tokenOnlyUsage}
                tokenCountText={part.task.tokenCountText}
                toolCount={toolCount}
                updateCount={childCount}
                durationLabel={durationLabel}
              />
            )}
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                preview && "mt-1",
                isOpen && "rotate-90",
              )}
            />
          </div>
        </CollapsibleTrigger>
      </div>
      {stopError ? (
        <div role="alert" className="px-3 pb-2 text-xs text-destructive">
          {stopError}
        </div>
      ) : null}
      <CollapsibleContent>
        <div className="border-t border-border/40 px-3 py-3">
          {prompt ? (
            <div className="mb-3 border-l border-border/30 pl-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Task
              </div>
              <MessageMarkdown
                content={prompt}
                components={markdownComponents}
                className="text-xs text-muted-foreground/90 prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-pre:my-1 prose-pre:p-2"
                enableBreaks={false}
              />
            </div>
          ) : null}
          <AgentMetaRows entries={metaEntries} />
          {backgroundAgentTask ? (
            <BackgroundTaskDetails task={backgroundAgentTask} containerId={containerId} />
          ) : null}
          <AgentResultBlock result={result} />
          <BackgroundTaskChildList tasks={childTasks} containerId={containerId} />
          <div className="space-y-1">
            {part.childTools.map((child, index) => (
              <NativeMessagePartRenderer
                key={`task-child-${index}-${child.toolUseId ?? child.sourcePartId ?? child.toolName ?? child.type}`}
                part={child}
                containerId={containerId}
                partKey={`${partKey}/task-child-${index}`}
              />
            ))}
            {part.childTools.length === 0 && childTasks.length === 0 && !hideCounts ? (
              <div className="px-3 py-2 text-xs text-muted-foreground/70">
                No child actions yet.
              </div>
            ) : null}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
