import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ClipboardCheck,
  Loader2,
  PauseCircle,
  RotateCcw,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  formatStageSpan,
  type PipelineStageGroup,
  type PipelineStageGroupStatus,
  type PipelineStageItem,
  type PipelineStageTimeline,
} from "./pipeline-stage-groups";

export type PipelineStageRowStatus = "running" | "error" | "done" | "cancelled" | "incomplete";

/** What one stage tab shows. Built by the tab, which owns the model catalog and reports. */
export interface PipelineStageRowView {
  /**
   * The tab's accessible name. Rows show a shorter title inside their group,
   * so the full stage label lives here: "Review Iteration 1 (A), GPT 5.6 Sol".
   */
  accessibleName: string;
  title: string;
  /** Short qualifier after the title, e.g. "previous" for a superseded reviewer. */
  tag?: string;
  /** Right-aligned mono text: "running", or how long the stage took. */
  meta?: string | null;
  /** Second line. `label` names it for assistive technology when it is terse. */
  detail?: { text: string; label?: string; mono?: boolean } | null;
  autoDeclineCount: number;
  reportIssueCount?: number;
  status: PipelineStageRowStatus;
}

interface PipelineStageRailProps {
  timeline: PipelineStageTimeline;
  rows: ReadonlyMap<string, PipelineStageRowView>;
  now: number;
  selectedStageId: string | null;
  isGroupExpanded: (groupKey: string) => boolean;
  onToggleGroup: (groupKey: string) => void;
  stageTabId: (stageKey: string) => string;
  groupPanelId: (groupKey: string) => string;
  transcriptPanelId: string;
  onSelectStage: (stageId: string) => void;
  onRestartStage: (stageId: string) => void;
  restartDisabled: boolean;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

interface ExpansionState {
  scope: string;
  selectedStageId: string | null;
  selectedGroupKey: string | undefined;
  overrides: Record<string, boolean>;
}

/**
 * Which phase groups are open.
 *
 * By default the group holding the selected stage and the group the pipeline is
 * working in are open, and everything else is folded to its summary. A manual
 * toggle wins until the pipeline moves on to another group, which returns
 * every group to that default. Selecting a stage inside a folded group — from
 * the keyboard, the report hint, or by following the pipeline — opens it,
 * because a selected tab has to be visible. A group left by a user's selection
 * stays open; an automatic advance resets to the new default.
 */
export function useStageGroupExpansion(
  pipelineId: string,
  currentGroupKey: string | undefined,
  selectedStageId: string | null,
  selectedGroupKey: string | undefined,
  selectionIsPinned: boolean,
) {
  const scope = `${pipelineId}\n${currentGroupKey ?? ""}`;
  const [state, setState] = useState<ExpansionState>(() => ({
    scope,
    selectedStageId,
    selectedGroupKey,
    overrides: {},
  }));

  let current = state;
  if (state.scope !== scope) {
    current = { scope, selectedStageId, selectedGroupKey, overrides: {} };
  } else if (state.selectedStageId !== selectedStageId) {
    const overrides = { ...state.overrides };
    if (selectedGroupKey) overrides[selectedGroupKey] = true;
    // Keep a group left by a user's selection on screen. Folding it would
    // shift the rows below it — including, often, the one just clicked.
    if (
      selectionIsPinned &&
      state.selectedGroupKey &&
      overrides[state.selectedGroupKey] === undefined
    ) {
      overrides[state.selectedGroupKey] = true;
    }
    current = { scope, selectedStageId, selectedGroupKey, overrides };
  }
  // Adjusting state while rendering, not in an effect: an effect would paint
  // one frame with the selected tab still folded away, and the arrow-key
  // handler needs the tab mounted before it can move focus onto it.
  if (current !== state) setState(current);

  const defaultExpanded = (groupKey: string) =>
    groupKey === selectedGroupKey || groupKey === currentGroupKey;
  const isGroupExpanded = (groupKey: string) =>
    groupKey === selectedGroupKey || (current.overrides[groupKey] ?? defaultExpanded(groupKey));
  const toggleGroup = (groupKey: string) =>
    setState((previous) => ({
      ...previous,
      overrides: {
        ...previous.overrides,
        [groupKey]:
          groupKey === selectedGroupKey
            ? true
            : !(previous.overrides[groupKey] ?? defaultExpanded(groupKey)),
      },
    }));
  return { isGroupExpanded, toggleGroup };
}

function issueCountLabel(count: number): string {
  return `${count} issue${count === 1 ? "" : "s"}`;
}

const GROUP_STATUS_TEXT: Record<PipelineStageGroupStatus, string> = {
  running: "in progress",
  paused: "paused",
  error: "failed",
  done: "done",
  incomplete: "incomplete",
  cancelled: "cancelled",
};

function GroupNode({ status }: { status: PipelineStageGroupStatus | "upcoming" }) {
  const className = "h-4 w-4";
  if (status === "running") {
    return <Loader2 className={cn(className, "animate-spin text-primary")} />;
  }
  if (status === "error") return <AlertCircle className={cn(className, "text-destructive")} />;
  if (status === "paused") {
    return <PauseCircle className={cn(className, "text-muted-foreground")} />;
  }
  if (status === "incomplete") {
    return <AlertCircle className={cn(className, "text-muted-foreground")} />;
  }
  if (status === "cancelled") {
    return <Circle className={cn(className, "text-muted-foreground")} />;
  }
  if (status === "upcoming") {
    return (
      <span className="block h-3.5 w-3.5 rounded-full border-[1.5px] border-dashed border-muted-foreground/50" />
    );
  }
  return <CheckCircle2 className={cn(className, "text-success")} />;
}

function StageStatusIcon({ status }: { status: PipelineStageRowStatus }) {
  const className = "h-3.5 w-3.5 shrink-0";
  switch (status) {
    case "running":
      return <Loader2 className={cn(className, "animate-spin text-primary")} />;
    case "error":
      return <AlertCircle className={cn(className, "text-destructive")} />;
    case "cancelled":
      return <Circle className={cn(className, "text-muted-foreground")} />;
    case "incomplete":
      return <AlertCircle className={cn(className, "text-muted-foreground")} />;
    default:
      return <CheckCircle2 className={cn(className, "text-success")} />;
  }
}

/** The vertical line from one phase node down to the next. */
function Connector({ status }: { status: PipelineStageGroupStatus | "upcoming" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute top-[26px] -bottom-1 left-[14px] w-0.5 rounded-full",
        status === "done" && "bg-success/25",
        status === "running" && "bg-gradient-to-b from-primary to-primary/0",
        status === "error" && "bg-destructive/25",
        (status === "paused" ||
          status === "incomplete" ||
          status === "cancelled" ||
          status === "upcoming") &&
          "bg-border/60",
      )}
    />
  );
}

/**
 * The build's stages as a timeline of phases.
 *
 * Each phase is a disclosure button over its stage tabs. The separate tablist
 * owns only the mounted tabs through aria-owns, keeping disclosure buttons and
 * pending rows out of its accessibility tree.
 */
export function PipelineStageRail({
  timeline,
  rows,
  now,
  selectedStageId,
  isGroupExpanded,
  onToggleGroup,
  stageTabId,
  groupPanelId,
  transcriptPanelId,
  onSelectStage,
  onRestartStage,
  restartDisabled,
  onKeyDown,
}: PipelineStageRailProps) {
  const visibleItems = timeline.groups.flatMap((group) =>
    isGroupExpanded(group.key) ? group.items : [],
  );
  // One stop for the whole list, then arrow keys within it — otherwise Tab
  // walks every stage before reaching the transcript.
  const tabStopId = visibleItems.some((item) => item.id === selectedStageId)
    ? selectedStageId
    : (visibleItems[0]?.id ?? null);
  const progress =
    timeline.phaseTotal > 0 ? Math.round((timeline.phasesReached / timeline.phaseTotal) * 100) : 0;
  const elapsed = formatStageSpan(timeline.startMs, timeline.endMs, timeline.running, now);
  const lastGroupKey = timeline.groups.at(-1)?.key;

  const renderStage = (item: PipelineStageItem) => {
    const row = rows.get(item.id);
    if (!row) return null;
    const isSelected = selectedStageId === item.id;
    return (
      <ContextMenu key={item.key}>
        <ContextMenuTrigger asChild>
          <button
            id={stageTabId(item.key)}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={transcriptPanelId}
            aria-label={row.accessibleName}
            tabIndex={item.id === tabStopId ? 0 : -1}
            className={cn(
              "flex w-full flex-col rounded-md border px-2 py-1.5 text-left transition-colors",
              isSelected
                ? "border-zinc-700/70 bg-zinc-800/85"
                : "border-transparent hover:bg-zinc-800/55",
            )}
            onClick={() => onSelectStage(item.id)}
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              <StageStatusIcon status={row.status} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  isSelected ? "text-foreground" : "text-foreground/80",
                )}
              >
                {row.title}
              </span>
              {row.tag && (
                <span className="shrink-0 text-[10px] text-muted-foreground">{row.tag}</span>
              )}
              {row.reportIssueCount !== undefined ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-1.5 text-[10px] font-medium text-cyan-200/90">
                  <ClipboardCheck className="h-2.5 w-2.5" />
                  <span className="sr-only">Report · </span>
                  {issueCountLabel(row.reportIssueCount)}
                </span>
              ) : (
                row.meta && (
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                    {row.meta}
                  </span>
                )
              )}
            </span>
            {row.detail && (
              <span
                className={cn(
                  "mt-0.5 block w-full truncate pl-[22px] text-muted-foreground",
                  row.detail.mono ? "font-mono text-[10px] tabular-nums" : "text-[11px]",
                )}
                aria-label={row.detail.label}
              >
                {row.detail.text}
              </span>
            )}
            {row.autoDeclineCount > 0 && (
              <span className="mt-0.5 block pl-[22px] text-[10px] text-muted-foreground">
                {row.autoDeclineCount} input request
                {row.autoDeclineCount === 1 ? "" : "s"} auto-declined
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          <ContextMenuItem disabled={restartDisabled} onSelect={() => onRestartStage(item.id)}>
            <RotateCcw />
            Restart
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const renderGroup = (group: PipelineStageGroup) => {
    const expanded = group.items.length > 0 && isGroupExpanded(group.key);
    const duration = formatStageSpan(group.startMs, group.endMs, group.status === "running", now);
    const isLast = group.key === lastGroupKey && timeline.upcoming.length === 0;
    const heading = (
      <span className="flex w-full min-w-0 items-center gap-2">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12.5px] font-semibold",
            group.current && group.status === "running" && "text-primary",
          )}
        >
          {group.name}
        </span>
        {group.issueCount !== undefined && (
          <span className="shrink-0 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-1.5 text-[10px] font-medium text-cyan-200/90">
            {issueCountLabel(group.issueCount)}
          </span>
        )}
        {duration && (
          <span
            className={cn(
              "shrink-0 font-mono text-[10.5px] text-muted-foreground",
              group.current && group.status === "running" && "text-primary/80",
            )}
          >
            {duration}
          </span>
        )}
        {group.items.length > 0 &&
          (expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70" />
          ))}
      </span>
    );
    // Setup has no stage of its own; the only thing to say about it is that
    // the backend is still getting the environment ready.
    const summary =
      group.kind === "setup"
        ? group.current && group.status === "running"
          ? "The backend is preparing the first stage."
          : null
        : expanded
          ? null
          : group.summary;
    const headerClass = cn(
      "flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left",
      group.current && group.status === "running" && "bg-primary/10",
    );
    return (
      <div key={group.key} className="relative pl-[26px]">
        {!isLast && <Connector status={group.status} />}
        <span
          aria-hidden="true"
          className="absolute top-[9px] left-[7px] flex h-4 w-4 items-center justify-center rounded-full bg-background"
        >
          <GroupNode status={group.status} />
        </span>
        {group.items.length > 0 ? (
          <button
            type="button"
            data-stage-group={group.key}
            aria-expanded={expanded}
            aria-controls={groupPanelId(group.key)}
            disabled={group.items.some((item) => item.id === selectedStageId)}
            aria-label={`${group.name}, ${GROUP_STATUS_TEXT[group.status]}${duration ? `, ${duration}` : ""}${group.issueCount !== undefined ? `, ${issueCountLabel(group.issueCount)}` : ""}${summary ? `, ${summary}` : ""}`}
            className={cn(
              headerClass,
              "transition-colors",
              group.current && group.status === "running"
                ? "hover:bg-primary/15"
                : "hover:bg-zinc-800/55",
            )}
            onClick={() => onToggleGroup(group.key)}
          >
            {heading}
            {summary && (
              <span className="block w-full truncate text-[11px] text-muted-foreground">
                {summary}
              </span>
            )}
          </button>
        ) : (
          <div className={headerClass}>
            {heading}
            {summary && <span className="block text-[11px] text-muted-foreground">{summary}</span>}
          </div>
        )}
        <div id={groupPanelId(group.key)} hidden={!expanded} className="space-y-px pt-0.5 pb-1.5">
          {expanded && (
            <>
              {group.items.map(renderStage)}
              {group.pending.map((pending) => (
                <div
                  key={pending.key}
                  className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground/60"
                >
                  <span
                    aria-hidden="true"
                    className="block h-3 w-3 shrink-0 rounded-full border-[1.5px] border-dashed border-current"
                  />
                  <span className="min-w-0 flex-1 truncate">{pending.label}</span>
                  {pending.meta && <span className="shrink-0 text-[10.5px]">{pending.meta}</span>}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-3.5 pt-3 pb-2.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="font-semibold tracking-[0.08em] uppercase">Pipeline</span>
          <span>
            {timeline.phasesReached} of {timeline.phaseTotal} phases
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Pipeline progress"
          aria-valuemin={0}
          aria-valuemax={timeline.phaseTotal}
          aria-valuenow={timeline.phasesReached}
          className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-success to-primary"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-2" onKeyDown={onKeyDown}>
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label="Build stages"
            aria-owns={visibleItems.map((item) => stageTabId(item.key)).join(" ") || undefined}
          />
          {timeline.groups.map(renderGroup)}
          {timeline.upcoming.map((group, index) => (
            <div
              key={`upcoming-${group.kind}`}
              className="relative pl-[26px] text-muted-foreground/60"
            >
              {index < timeline.upcoming.length - 1 && <Connector status="upcoming" />}
              <span
                aria-hidden="true"
                className="absolute top-[9px] left-[7px] flex h-4 w-4 items-center justify-center rounded-full bg-background"
              >
                <GroupNode status="upcoming" />
              </span>
              <div className="flex items-center gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                  {group.name}
                </span>
                {group.conditional && <span className="text-[10.5px]">if needed</span>}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
      {elapsed && (
        <div className="border-t border-border/40 px-3.5 py-2.5 text-[11px] text-muted-foreground">
          {elapsed} elapsed
        </div>
      )}
    </div>
  );
}
