import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ChevronRight,
  Layers,
  Loader2,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  getToolDisplayName,
  getToolTitleDisplayName,
} from "@/lib/tool-names";
import {
  getNativeAgentStatus,
  type NativeAgentStatus,
} from "@/lib/chat/native-agent-status";
import { nativeAgentLatestActivity } from "@/lib/chat/native-agent-preview";
import {
  type NativeAgentGroupPart,
  type NativeBackgroundTask,
  type NativeBackgroundTaskStatus,
  type NativeMessagePart,
  type NativeTaskGroupPart,
  type NativeToolGroupPart,
} from "@/lib/chat/native-message-types";
import {
  AgentPlatformContext,
  BackgroundTaskStopContext,
  NativeMessagePartRenderer,
  markdownComponents,
  useAgentExpansion,
} from "./NativeMessage.shared";

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
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "failed":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
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
      text: isTerminalAgentStatus(status)
        ? "No activity captured."
        : "Waiting for activity.",
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

function formatAgentDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  return formatElapsed(Math.round(seconds));
}

function usefulAgentOutput(output?: string): string | undefined {
  const trimmed = output?.trim();
  if (!trimmed) return undefined;
  if (/^sub-?agents? launched\.?$/i.test(trimmed)) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      if (keys.length > 0 && keys.every((key) => (
        key === "durationMs" || key === "isBackground" || key === "status"
      ))) {
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

function agentMetaEntries(
  toolArgs: Record<string, unknown> | undefined,
  displayName: string,
): Array<{ label: string; value: string }> {
  const role = stringToolArg(toolArgs, "subagent_type", "subagentType", "role");
  const model = stringToolArg(toolArgs, "model");
  const durationMs = numberToolArg(toolArgs, "durationMs");
  const agentId = stringToolArg(toolArgs, "agentId", "agent_id");
  return [
    ...(role && role !== displayName ? [{ label: "Type", value: role }] : []),
    ...(model ? [{ label: "Model", value: model }] : []),
    ...(durationMs !== undefined
      ? [{ label: "Duration", value: formatAgentDurationMs(durationMs) }]
      : []),
    ...(agentId ? [{ label: "Agent ID", value: agentId }] : []),
  ];
}

function AgentMetaRows({
  entries,
}: {
  entries: Array<{ label: string; value: string }>;
}) {
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

function AgentUsageStats({
  hasExternalUsage,
  tokenOnlyUsage,
  tokenCountText,
  toolCount,
  updateCount,
  durationMs,
}: {
  hasExternalUsage: boolean;
  tokenOnlyUsage: boolean;
  tokenCountText?: string;
  toolCount: number;
  updateCount: number;
  durationMs?: number;
}) {
  const hideCounts = useContext(AgentPlatformContext) === "cursor";
  if (hideCounts) {
    const durationLabel = durationMs === undefined
      ? undefined
      : formatAgentDurationMs(durationMs);
    if (!durationLabel && !tokenCountText) return null;
    return (
      <div className="shrink-0 text-right text-[11px] text-muted-foreground/70">
        {durationLabel ? <div>{durationLabel}</div> : null}
        {tokenCountText ? <div>{tokenCountText}</div> : null}
      </div>
    );
  }

  if (tokenOnlyUsage && tokenCountText) {
    return (
      <div className="shrink-0 text-right text-[11px] text-muted-foreground/70">
        <div>{tokenCountText}</div>
      </div>
    );
  }

  const showTools = hasExternalUsage || toolCount > 0;
  const showUpdates = Boolean(tokenCountText) || updateCount > 0;
  if (!showTools && !showUpdates) return null;

  const toolCountLabel = hasExternalUsage
    ? `${toolCount} ${toolCount === 1 ? "tool use" : "tool uses"}`
    : `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;

  return (
    <div className="shrink-0 text-right text-[11px] text-muted-foreground/70">
      {showTools ? <div>{toolCountLabel}</div> : null}
      {showUpdates ? (
        <div>
          {tokenCountText ??
            `${updateCount} ${updateCount === 1 ? "update" : "updates"}`}
        </div>
      ) : null}
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
        status === "finished" && "bg-emerald-400/10 text-emerald-300",
        status === "failed" && "bg-red-400/10 text-red-300",
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

const NEUTRAL_STATUS_PILL =
  "border-border/60 bg-muted/40 text-muted-foreground";

const BACKGROUND_TASK_PRESENTATION: Record<
  NativeBackgroundTaskStatus,
  BackgroundTaskPresentation
> = {
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

function backgroundTaskPresentation(
  task: NativeBackgroundTask,
): BackgroundTaskPresentation {
  return task.status
    ? BACKGROUND_TASK_PRESENTATION[task.status]
    : UNKNOWN_BACKGROUND_TASK;
}

function backgroundTaskLabel(task: NativeBackgroundTask): string {
  return task.description?.trim() || `Background task ${task.id}`;
}

function StopBackgroundTaskButton({
  task,
  onStop,
  onStopped,
  onFailed,
}: {
  task: NativeBackgroundTask;
  onStop?: (taskId: string) => Promise<boolean>;
  onStopped: () => void;
  onFailed: (message: string) => void;
}) {
  const contextStop = useContext(BackgroundTaskStopContext);
  const stopBackgroundTask = onStop ?? contextStop;
  const [stopping, setStopping] = useState(false);
  const taskId = task.id;

  // A stop that succeeded leaves the button disabled until the authoritative
  // snapshot reports a terminal status, which is what unmounts this control.
  // A tab remounted mid-stop starts from the snapshot, never from this flag.
  useEffect(() => { setStopping(false); }, [taskId]);

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
    onFailed(
      `Could not stop “${label}”. Try again or use the main Stop control.`,
    );
  }, [label, onFailed, onStopped, stopBackgroundTask, stopping, taskId]);

  if (!stopBackgroundTask) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      disabled={stopping}
      aria-label={`Stop ${label}`}
      onClick={() => void stop()}
    >
      {stopping ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Square className="h-3 w-3 fill-current" aria-hidden />
      )}
      {stopping ? "Stopping" : "Stop"}
    </Button>
  );
}

/**
 * A provider-owned background task, rendered as the agent card every other
 * long-running child uses.
 *
 * It says "Task" rather than "Agent" and carries a stop control where an agent
 * carries its tool and update counts: a background shell command reports
 * neither, so those slots would always read zero.
 */
export function BackgroundTaskCard({
  task,
  command,
  result,
  open,
  onOpenChange,
  onStop,
  embedded = false,
}: {
  task: NativeBackgroundTask;
  /** The command or prompt that launched the task, shown collapsed. */
  command?: string;
  /** Launch output, shown in the expanded body. */
  result?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Overrides `BackgroundTaskStopContext` for cards rendered outside a message. */
  onStop?: (taskId: string) => Promise<boolean>;
  embedded?: boolean;
}) {
  const [stopError, setStopError] = useState<string | null>(null);
  const presentation = backgroundTaskPresentation(task);
  const description = task.description?.trim();
  // The header already carries the description, so the collapsed second line is
  // for what it does not say: the command actually running.
  const preview = command && command !== description ? command : undefined;
  const hasBody = Boolean(command || result);

  // The failure belongs to the attempt, not the task: a later status change
  // means the question the message answered is no longer being asked.
  useEffect(() => { setStopError(null); }, [task.status]);

  return (
    <Collapsible
      open={open && hasBody}
      onOpenChange={onOpenChange}
      className={cn(!embedded && agentCardClassName)}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <CollapsibleTrigger
          className={cn(
            "flex min-w-0 flex-1 items-start gap-3 rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            hasBody ? "cursor-pointer hover:bg-white/[0.025]" : "cursor-default",
          )}
          disabled={!hasBody}
        >
          <AgentActivityIcon
            status={presentation.status}
            spinning={presentation.spinning}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="shrink-0 font-medium uppercase tracking-wide text-muted-foreground/80">
                Task
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
            ) : null}
          </div>
          <ChevronRight
            className={cn(
              "mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              open && hasBody && "rotate-90",
              !hasBody && "opacity-0",
            )}
          />
        </CollapsibleTrigger>
        {presentation.live ? (
          <StopBackgroundTaskButton
            task={task}
            onStop={onStop}
            onStopped={() => setStopError(null)}
            onFailed={setStopError}
          />
        ) : null}
      </div>

      {stopError ? (
        <div role="alert" className="px-3 pb-2 text-xs text-destructive">
          {stopError}
        </div>
      ) : null}

      <CollapsibleContent>
        <div className="border-t border-border/40 px-3 py-3">
          {command ? (
            <div className="mb-3 border-l border-border/30 pl-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Command
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground/90">
                {command}
              </pre>
            </div>
          ) : null}
          <AgentMetaRows entries={[{ label: "Task ID", value: task.id }]} />
          <AgentResultBlock result={result} />
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
  const durationMs = numberToolArg(part.toolArgs, "durationMs");
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
      <CollapsibleTrigger
        className="w-full px-3 py-2.5 text-left transition-colors hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 cursor-pointer"
      >
        <div className="flex items-start gap-3">
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
            durationMs={durationMs}
          />
          <ChevronRight
            className={cn(
              "mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
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
          <AgentMetaRows entries={agentMetaEntries(part.toolArgs, displayName)} />
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
    <section
      aria-label={`${part.parts.length} agents`}
      className="relative my-1"
    >
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
  // An empty group would still paint its border and padding.
  if (part.parts.length === 0) {
    return null;
  }

  return (
    <div className="my-0 rounded-lg border border-zinc-700/70 bg-zinc-800/35 p-2">
      {part.parts.map((child, index) => (
        <NativeMessagePartRenderer
          key={`tool-group-part-${index}-${child.type}`}
          part={child}
          containerId={containerId}
          partKey={`${partKey}/tool-${index}`}
        />
      ))}
    </div>
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
  const backgroundTask = part.task.toolArgs?.run_in_background === true
    ? part.task.backgroundTask
    : undefined;
  const toolLabel =
    getToolTitleDisplayName(
      part.task.toolTitle,
      part.task.toolName,
      part.task.content,
    ) || getToolDisplayName(part.task.toolName, "Agent");
  const description = stringToolArg(part.task.toolArgs, "description");
  const prompt = stringToolArg(part.task.toolArgs, "prompt");
  const role = stringToolArg(
    part.task.toolArgs,
    "subagent_type",
    "subagentType",
    "role",
  );
  const explicitName = stringToolArg(
    part.task.toolArgs,
    "agent_name",
    "agentName",
    "name",
  );
  const hasExternalUsage = typeof part.task.toolUseCount === "number";
  const tokenOnlyUsage = shouldShowTokenOnlyAgentUsage(part.task);
  const genericToolLabel = /^(agent|task)$/i.test(toolLabel);
  const displayName =
    explicitName ?? description ?? (genericToolLabel ? "Subagent" : toolLabel);
  const headerDescription = explicitName ? description : undefined;
  const displayLabel = buildAgentDisplayLabel(displayName, role);
  const status = getNativeAgentStatus(part);
  const statusLabel = getSubagentStatusLabel(status);
  const childCount = part.childTools.length;
  const capturedToolCount = part.childTools.filter(
    (child) => child.type === "tool-invocation",
  ).length;
  const toolCount = part.task.toolUseCount ?? capturedToolCount;
  const hideCounts = useContext(AgentPlatformContext) === "cursor";
  const durationMs = numberToolArg(part.task.toolArgs, "durationMs");
  // See `SubagentPart`: the parse is proportional to the 512 KiB output cap.
  const result = useMemo(
    () => usefulAgentOutput(part.task.toolOutput),
    [part.task.toolOutput],
  );
  const preview = useMemo(() => {
    const latest = nativeAgentLatestActivity(part);
    if (latest) return latest;
    if (hideCounts) {
      if (prompt && prompt !== displayName && prompt !== description) return prompt;
      if (description && description !== displayName) return description;
      return isTerminalAgentStatus(status) ? undefined : "Waiting for activity.";
    }
    return description ?? (
      isTerminalAgentStatus(status)
        ? prompt ?? "No activity captured."
        : "Waiting for activity."
    );
  }, [description, displayName, hideCounts, part, prompt, status]);
  const metaEntries = agentMetaEntries(part.task.toolArgs, displayName);

  if (backgroundTask) {
    return (
      <BackgroundTaskCard
        task={backgroundTask}
        command={stringToolArg(part.task.toolArgs, "command") ?? prompt}
        result={result}
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
      className={cn(!embedded && agentCardClassName)}
    >
      <CollapsibleTrigger className="w-full px-3 py-2.5 text-left transition-colors hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 cursor-pointer">
        <div className="flex items-start gap-3">
          <AgentActivityIcon status={status} />
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
                  getSubagentStatusClasses(status),
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
          <AgentUsageStats
            hasExternalUsage={hasExternalUsage}
            tokenOnlyUsage={tokenOnlyUsage}
            tokenCountText={part.task.tokenCountText}
            toolCount={toolCount}
            updateCount={childCount}
            durationMs={durationMs}
          />
          <ChevronRight
            className={cn(
              "mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
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
          <AgentMetaRows entries={metaEntries} />
          <AgentResultBlock result={result} />
          <div className="space-y-1">
            {part.childTools.map((child, index) => (
              <NativeMessagePartRenderer
                key={`task-child-${index}-${child.toolUseId ?? child.sourcePartId ?? child.toolName ?? child.type}`}
                part={child}
                containerId={containerId}
                partKey={`${partKey}/task-child-${index}`}
              />
            ))}
            {part.childTools.length === 0 && !hideCounts ? (
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
