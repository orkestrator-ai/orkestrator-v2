import { useMemo } from "react";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import {
  Brain,
  ChevronRight,
  Wrench,
  AlertCircle,
  Pencil,
  ExternalLink as ExternalLinkIcon,
  FileClock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { ChangeCountBadge } from "@/components/changes/ChangeCountBadge";
import {
  ChangeRoleSection,
  LegacyPayloadBadge,
  LegacyPayloadBody,
  liveFileTarget,
  projectionFirstPath,
  projectionHasContent,
  useLegacyPayloadMeasurement,
  useToolChangeRow,
  type LegacyPayloadInput,
} from "./NativeMessage.change-parts";
import { useNativeChangeScope } from "./NativeMessage.change-scope";
import type { NativeToolDiffMetadata as ToolDiffMetadata } from "@/lib/chat/native-message-types";
import { getToolDisplayName, getToolTitleDisplayName } from "@/lib/tool-names";
import {
  isBackgroundTaskActionTool,
  isBackgroundTaskStopTool,
} from "@/lib/chat/native-message-adapters";
import { InlineMessageMarkdown, MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { type NativeBackgroundTask } from "@/lib/chat/native-message-types";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import { formatSettledToolDuration } from "@/lib/chat/native-agent-duration";
import {
  parseQuestionToolArgs,
  questionToolPreview,
  resolveQuestionToolAnswers,
} from "@/lib/question-tool";
import { QuestionToolDetails } from "./QuestionToolDetails";
import {
  parseScheduleWakeupArgs,
  parseScheduleWakeupResult,
  scheduleWakeupPreview,
} from "@/lib/schedule-wakeup-tool";
import { ScheduleWakeupToolDetails } from "./ScheduleWakeupToolDetails";
import { ArtifactDraftInspectorAction, draftInspectorTool } from "./rich/ArtifactDraftInspector";
import {
  markdownComponents,
  TASK_LIST_SYNTAX_PATTERN,
  stringToolArg,
} from "./NativeMessage.shared";

/**
 * The collapsed row shows roughly one line — about a hundred characters at the
 * widest. Reasoning arrives as text deltas, so the preview is re-rendered on
 * every chunk of a streaming turn, and it is now parsed as Markdown rather
 * than dropped into a text node. Parsing the whole block each time would make
 * that cost grow with reasoning nobody can see; this budget is several times
 * the visible width, so the rendered line is unchanged.
 */
const THINKING_PREVIEW_MAX_CHARS = 400;

function truncateThinkingPreview(content: string): string {
  const end = Math.min(content.length, THINKING_PREVIEW_MAX_CHARS);
  // `slice` counts UTF-16 code units. If the budget lands on the high
  // surrogate of a supplementary code point, include its low surrogate too
  // rather than handing React an ill-formed string that renders as U+FFFD.
  const safeEnd =
    end < content.length && (content.codePointAt(end - 1) ?? 0) > 0xffff ? end + 1 : end;
  return content.slice(0, safeEnd);
}

export function ThinkingPart({ content, expansionKey }: { content: string; expansionKey: string }) {
  const hasTaskList = useMemo(() => TASK_LIST_SYNTAX_PATTERN.test(content), [content]);
  // Backed by the shared store using the stable key supplied by MessagePart,
  // so an expanded block survives the virtualized list unmounting it while
  // off-screen.
  const [isOpen, setIsOpen] = useMessagePartExpansion(expansionKey);
  // The collapsed row is a single line, so flatten whitespace for the preview.
  const preview = useMemo(
    () =>
      hasTaskList ? "task list" : truncateThinkingPreview(content.trim().replace(/\s+/g, " ")),
    [content, hasTaskList],
  );

  // Reasoning with no text has nothing to preview and nothing to expand into,
  // so it must not render a control that promises hidden content.
  if (!preview) {
    return null;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-0">
      <CollapsibleTrigger className="flex items-center gap-2 w-full text-xs text-muted-foreground py-1.5 px-2 rounded-md transition-colors hover:text-foreground cursor-pointer">
        <ChevronRight
          className={cn("w-3 h-3 transition-transform shrink-0", isOpen && "rotate-90")}
        />
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium shrink-0">Thinking</span>
        {!isOpen && (
          <InlineMessageMarkdown
            content={preview}
            className="font-mono text-muted-foreground/80 truncate min-w-0 text-left"
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 border-l border-border/40 pl-3">
          <MessageMarkdown
            content={content}
            components={markdownComponents}
            className="text-muted-foreground/80 prose-invert prose-p:my-1 prose-headings:my-2 prose-headings:text-muted-foreground prose-ul:my-1 prose-ol:my-1 prose-pre:my-1 prose-pre:p-2"
            enableBreaks={!hasTaskList}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function taskCommandFromOutput(output?: string): string | undefined {
  if (!output) return undefined;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const command = stringToolArg(parsed, "command");
    if (command) return command;
  } catch {
    // Older Claude transcripts store the TaskStop result as plain text.
  }

  const messageMatch = output.match(/Successfully stopped task:\s*\S+\s+\(([\s\S]+)\)\s*$/);
  return messageMatch?.[1]?.trim() || undefined;
}

/**
 * The collapsed row is a single truncating line, so anything shown there is
 * flattened and capped rather than relying on CSS alone — the accessible name
 * and the DOM string are otherwise unbounded.
 */
function toSingleLinePreview(value: string): string {
  const preview = value.trim().replace(/\s+/g, " ");
  return preview.length > 180 ? `${preview.slice(0, 179)}…` : preview;
}

export interface ToolRowPreview {
  text: string;
  /**
   * A fallback preview of raw input, which is not specific enough to justify
   * hiding a descriptive tool title the way a real command or path does.
   */
  generic: boolean;
  monospace: boolean;
}

/**
 * The one-line summary a collapsed tool row shows beside the tool's name: the
 * command, file, pattern or query that identifies the call. Shared by the row
 * itself and by a folded tool group, which previews its latest call.
 */
export function toolRowPreview(
  {
    toolName,
    toolArgs,
    toolOutput,
    toolState,
    toolDenied,
    toolError,
    backgroundTask,
  }: {
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolOutput?: string;
    toolState?: "success" | "failure" | "pending";
    toolDenied?: { reason?: string; source?: string };
    toolError?: string;
    backgroundTask?: NativeBackgroundTask;
  },
  questions = parseQuestionToolArgs(toolArgs),
): ToolRowPreview | null {
  const isTaskAction = isBackgroundTaskActionTool(toolName);
  const isBackgroundLaunch = toolArgs?.run_in_background === true;
  const taskId = backgroundTask?.id ?? stringToolArg(toolArgs, "task_id", "taskId");
  const taskDescription =
    backgroundTask?.description ??
    (isBackgroundLaunch ? stringToolArg(toolArgs, "description") : undefined);

  if (!toolArgs) return null;

  // Background task actions are meaningful only in relation to their task.
  // Prefer the human-authored launch description, then a command recovered
  // from TaskStop output, and leave the opaque id as the final fallback.
  if (isTaskAction) {
    if (taskDescription) {
      return {
        text: toSingleLinePreview(taskDescription),
        generic: false,
        monospace: false,
      };
    }
    const resultCommand = taskCommandFromOutput(toolOutput);
    if (resultCommand) {
      return {
        text: toSingleLinePreview(resultCommand),
        generic: false,
        monospace: true,
      };
    }
    if (taskId) {
      return {
        text: toSingleLinePreview(taskId),
        generic: false,
        monospace: true,
      };
    }
  }

  if (isBackgroundLaunch && taskDescription) {
    return {
      text: toSingleLinePreview(taskDescription),
      generic: false,
      monospace: false,
    };
  }

  // For shell commands, show the command in the collapsed row.
  const command = toolArgs.command as string | undefined;
  if (command) {
    return {
      text: toSingleLinePreview(command),
      generic: false,
      monospace: true,
    };
  }

  // For Read tool - show filename
  const filePath = toolArgs.file_path as string | undefined;
  if (filePath) {
    const name = filePath.split("/").pop();
    return name ? { text: name, generic: false, monospace: true } : null;
  }

  // For Glob tool - show pattern
  const pattern = toolArgs.pattern as string | undefined;
  if (pattern) {
    return {
      text: toSingleLinePreview(pattern),
      generic: false,
      monospace: true,
    };
  }

  // For Grep tool - show search pattern
  const grepPattern = toolArgs.regex as string | undefined;
  if (grepPattern) {
    return {
      text: toSingleLinePreview(grepPattern),
      generic: false,
      monospace: true,
    };
  }

  // Cursor child JSONL names its read argument `path` where Claude-style
  // tools use `file_path`. It ranks below `pattern`/`regex` on purpose:
  // Glob and Grep carry `path` as the *search root* alongside the pattern
  // that actually identifies the call, so reading it first would label them
  // with a directory instead.
  const genericPath = toolArgs.path;
  if (typeof genericPath === "string" && genericPath) {
    const name = genericPath.split("/").pop();
    return name ? { text: name, generic: false, monospace: true } : null;
  }

  // For WebFetch tool - show hostname from URL
  const url = toolArgs.url as string | undefined;
  if (url) {
    try {
      return {
        text: new URL(url).hostname,
        generic: false,
        monospace: true,
      };
    } catch {
      return {
        text: toSingleLinePreview(url),
        generic: false,
        monospace: true,
      };
    }
  }

  // For WebSearch tool - show search query
  const query = toolArgs.query as string | undefined;
  if (query) {
    return {
      text: toSingleLinePreview(query),
      generic: false,
      monospace: true,
    };
  }

  if (questions) {
    return {
      text: toSingleLinePreview(questionToolPreview(questions)),
      generic: false,
      monospace: false,
    };
  }

  const wakeup = parseScheduleWakeupArgs(toolName, toolArgs);
  const wakeupPreview = wakeup
    ? scheduleWakeupPreview(wakeup, toolState === "success" && !toolDenied && !toolError)
    : "";
  if (wakeupPreview) {
    return {
      text: toSingleLinePreview(wakeupPreview),
      generic: false,
      monospace: false,
    };
  }

  // Custom tools such as Codex's `exec` carry raw input rather than a
  // provider-standard argument shape. Keep the collapsed row informative
  // even when the bridge cannot safely derive a more specific command.
  const input = toolArgs.input;
  if (typeof input === "string" && input.trim()) {
    return {
      text: toSingleLinePreview(input),
      generic: true,
      monospace: true,
    };
  }

  return null;
}

function backgroundTaskState(
  task: NativeBackgroundTask | undefined,
): { label: string; className: string } | undefined {
  switch (task?.status) {
    case "pending":
    case "running":
      return {
        label: "running…",
        className: "text-amber-600 dark:text-amber-300 animate-pulse",
      };
    case "paused":
      return {
        label: "paused",
        className: "text-amber-600 dark:text-amber-300",
      };
    case "completed":
      return {
        label: "completed",
        className: "text-success",
      };
    case "failed":
      return { label: "failed", className: "text-failure" };
    case "killed":
      return { label: "stopped", className: "text-muted-foreground/80" };
    default:
      return undefined;
  }
}

/** Render a tool invocation part - expandable to show input/output */
/** Human-readable elapsed time for a running tool's progress sub-line. */
function formatElapsed(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  const seconds = Math.round(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * How long a settled call ran, at the trailing edge of its header row.
 *
 * Every tool card variant renders it the same way and from the same neutral
 * part field, so a provider that reports durations gets them on every card and
 * one that does not simply shows nothing.
 */
export function ToolDurationLabel({ label }: { label?: string }) {
  if (!label) return null;
  return (
    <span
      className="shrink-0 tabular-nums text-[10px] text-muted-foreground/60"
      title={`Ran for ${label}`}
    >
      {label}
    </span>
  );
}

export function ToolPart({
  expansionKey,
  callId,
  occurrenceId,
  toolName,
  toolState,
  toolTitle,
  toolArgs,
  toolOutput,
  toolError,
  backgroundTask,
  progress,
  denied,
  commandChanges,
  durationMs,
  deferredDetails = false,
  mcpServerName,
}: {
  expansionKey: string;
  /** Provider call id; keys the backend's change presentation for this row. */
  callId?: string;
  occurrenceId?: string;
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  backgroundTask?: NativeBackgroundTask;
  /**
   * The newest progress report for this call, attached at projection time.
   *
   * A hint over `toolState`, never a substitute: it is shown only while the
   * call is still pending, so a missed final progress event cannot leave a
   * settled row claiming to be busy.
   */
  progress?: { content: string; elapsedMs?: number };
  /**
   * The permission layer refused this call. Shown as its own state because
   * "failure" reads as the tool breaking, and the fix is a permission change,
   * not a retry.
   */
  denied?: { reason?: string; source?: string };
  /**
   * Legacy bridge measurement of the files this shell call changed. Shown only
   * when the backend has no change presentation for the call.
   */
  commandChanges?: MeasuredWorkspaceChange;
  /** Provider-reported runtime of the settled call (`toolDurationMs`). */
  durationMs?: number;
  /** Output exists but is fetched on expand, so the row must stay expandable. */
  deferredDetails?: boolean;
  /** Reported MCP server, so a same-named tool of another server is not taken for Orkestrator's. */
  mcpServerName?: string;
}) {
  const [isOpen, setIsOpen] = useMessagePartExpansion(expansionKey);
  const changeScope = useNativeChangeScope();
  // The backend's effect/observation projections for this call. They replace
  // the legacy bridge measurement whenever a presentation exists.
  const { presentation, roles } = useToolChangeRow(callId, toolState, occurrenceId);
  const changeRoles = roles.filter((entry) => projectionHasContent(entry.projection));
  const primaryChange = roles[0]?.projection;
  const legacyChanges = presentation ? undefined : commandChanges;
  // Canonical artifact authoring rows get a host-owned "Inspect draft" action.
  const inspectsArtifactDraft = draftInspectorTool(toolName, { toolTitle, mcpServerName }) !== null;
  const displayToolName = getToolDisplayName(toolName);
  const displayToolTitle = getToolTitleDisplayName(toolTitle, toolName);
  const isTaskStop = isBackgroundTaskStopTool(toolName);
  const isTaskAction = isBackgroundTaskActionTool(toolName);
  const taskId = backgroundTask?.id ?? stringToolArg(toolArgs, "task_id", "taskId");

  const questions = useMemo(() => parseQuestionToolArgs(toolArgs), [toolArgs]);
  const answeredQuestions = useMemo(
    () => (questions ? resolveQuestionToolAnswers(questions, toolArgs, toolOutput) : null),
    [questions, toolArgs, toolOutput],
  );
  const wakeup = useMemo(() => parseScheduleWakeupArgs(toolName, toolArgs), [toolName, toolArgs]);
  const wakeupResult = useMemo(
    () => (wakeup ? parseScheduleWakeupResult(toolOutput) : null),
    [wakeup, toolOutput],
  );
  // Answer recovery is lossy: results may also contain notes, previews, or
  // provider-specific context. Keep the original result below the questions.
  const showToolOutput = Boolean(toolOutput);

  const stateColors = {
    success: "text-success",
    failure: "text-failure",
    pending: "text-yellow-600 animate-pulse",
  };

  // Determine if there's content to show when expanded. A deferred part counts:
  // its output only loads *because* the row was expanded, so gating the trigger
  // on already-present output would make it permanently unreachable.
  const hasExpandableContent =
    toolOutput ||
    toolError ||
    deferredDetails ||
    changeRoles.length > 0 ||
    (legacyChanges && legacyChanges.files.length > 0) ||
    (toolArgs && Object.keys(toolArgs).length > 0);

  const displayInfo = toolRowPreview(
    { toolName, toolArgs, toolOutput, toolState, toolDenied: denied, toolError, backgroundTask },
    questions,
  );
  const shouldShowToolTitle =
    Boolean(displayToolTitle) &&
    (!displayInfo || displayInfo.generic) &&
    displayToolTitle !== displayToolName;
  const lifecycleState = backgroundTaskState(backgroundTask);
  const toolResultState = toolState
    ? {
        label:
          toolState === "failure"
            ? "failure"
            : isTaskStop
              ? toolState === "pending"
                ? "stopping…"
                : "stopped"
              : toolState === "pending"
                ? "running..."
                : toolState,
        className: stateColors[toolState],
      }
    : undefined;
  /*
   * A failed tool result outranks the task's lifecycle badge. Stopping a task
   * that already finished is rejected by the tool ("Task <id> is not running"),
   * and the task itself is still `completed` — so deferring to the lifecycle
   * here would paint a green "completed" over an action that failed.
   */
  const displayedState = denied
    ? { label: "denied", className: stateColors.failure }
    : toolState === "failure"
      ? toolResultState
      : (lifecycleState ?? toolResultState);
  // The call's own runtime, so only beside the call's own result: a refused
  // call never ran, and a background launch returns at once while the badge
  // reports the task's lifecycle, which the launch time would misdescribe.
  const durationLabel =
    denied || displayedState !== toolResultState
      ? undefined
      : formatSettledToolDuration(toolState, durationMs);
  const deniedLine = denied
    ? [denied.source ? `Denied (${denied.source.replaceAll("_", " ")})` : "Denied", denied.reason]
        .filter(Boolean)
        .join(": ")
    : undefined;

  // Format the command input for shell-like display
  const formatInput = () => {
    if (!toolArgs) return null;
    // For shell commands, show the command
    if (toolArgs.command && typeof toolArgs.command === "string") {
      // `command` may be a derived, length-capped label rather than the literal
      // arguments, so keep the authoritative source visible alongside it.
      const input = typeof toolArgs.input === "string" ? toolArgs.input.trim() : "";
      return input ? `$ ${toolArgs.command}\n\n${input}` : `$ ${toolArgs.command}`;
    }
    // For other tools, show a JSON representation of args
    return JSON.stringify(toolArgs, null, 2);
  };

  const formattedInput = formatInput();
  // Only while the call is actually running. A settled row showing a progress
  // line would report work that has already stopped.
  const livingProgress = toolState === "pending" ? progress : undefined;

  const trigger = (
    <CollapsibleTrigger
      className={cn(
        "flex items-center gap-2 w-full text-xs text-muted-foreground py-1.5 px-2 rounded-md transition-colors hover:text-foreground",
        hasExpandableContent && "cursor-pointer",
        !hasExpandableContent && "cursor-default",
      )}
      disabled={!hasExpandableContent}
    >
      <ChevronRight
        className={cn(
          "w-3 h-3 transition-transform shrink-0",
          isOpen && "rotate-90",
          !hasExpandableContent && "opacity-0",
        )}
      />
      <Wrench className="w-3.5 h-3.5 shrink-0" />
      <span className="font-medium">{displayToolName}</span>
      {displayInfo && (
        <span
          className={cn(
            "text-muted-foreground/80 truncate flex-1 text-left",
            displayInfo.monospace && "font-mono",
          )}
        >
          {displayInfo.text}
        </span>
      )}
      {isTaskAction && taskId && displayInfo?.text !== taskId && (
        <span
          className="max-w-28 shrink-0 truncate font-mono text-[10px] text-muted-foreground/50"
          title={taskId}
        >
          {taskId}
        </span>
      )}
      {shouldShowToolTitle && (
        <span className="text-muted-foreground/70 truncate flex-1 text-left">
          {displayToolTitle}
        </span>
      )}
      {presentation ? (
        <ChangeCountBadge projection={primaryChange} />
      ) : (
        legacyChanges && <CommandChangeStats change={legacyChanges} />
      )}
      {displayedState && (
        <span className={cn("ml-auto shrink-0", displayedState.className)}>
          {displayedState.label}
        </span>
      )}
      <ToolDurationLabel label={durationLabel} />
    </CollapsibleTrigger>
  );

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-0">
      {inspectsArtifactDraft ? (
        // Beside the trigger, never inside it: no nested buttons.
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">{trigger}</div>
          <ArtifactDraftInspectorAction
            toolName={toolName}
            toolTitle={toolTitle}
            mcpServerName={mcpServerName}
            toolArgs={toolArgs}
            toolOutput={toolOutput}
          />
        </div>
      ) : (
        trigger
      )}

      {deniedLine ? (
        <div
          className="min-w-0 truncate pl-9 pr-2 pb-1 text-[10px] text-failure/80"
          title={deniedLine}
        >
          {deniedLine}
        </div>
      ) : null}

      {livingProgress ? (
        <div className="flex min-w-0 items-center gap-2 pl-9 pr-2 pb-1 text-[10px] text-muted-foreground/70">
          <span className="truncate">{livingProgress.content}</span>
          {livingProgress.elapsedMs !== undefined ? (
            <span className="shrink-0 tabular-nums">{formatElapsed(livingProgress.elapsedMs)}</span>
          ) : null}
        </div>
      ) : null}

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="overflow-hidden border-l border-border/40 pl-3">
            {/* Input/Command section */}
            {answeredQuestions ? (
              <QuestionToolDetails questions={answeredQuestions} />
            ) : wakeup ? (
              <ScheduleWakeupToolDetails
                call={wakeup}
                result={wakeupResult}
                succeeded={toolState === "success" && !denied && !toolError}
              />
            ) : (
              formattedInput && (
                <div className="px-3 py-2 border-b border-border/30">
                  <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
                    {formattedInput}
                  </pre>
                </div>
              )
            )}

            {changeRoles.map((entry) => (
              <ChangeRoleSection
                key={entry.role}
                role={entry.role}
                projection={entry.projection}
                environmentId={changeScope?.environmentId}
                body={false}
              />
            ))}

            {legacyChanges && legacyChanges.files.length > 0 && (
              <CommandChangedFiles
                change={legacyChanges}
                environmentId={changeScope?.environmentId}
              />
            )}

            {/* Output section */}
            {showToolOutput && (
              <div className="px-3 py-2 max-h-64 overflow-auto">
                <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all">
                  {toolOutput}
                </pre>
              </div>
            )}

            {/* Error section */}
            {toolError && (
              <div className="px-3 py-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                  <pre className="text-xs font-mono text-destructive whitespace-pre-wrap break-all">
                    {toolError}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

const APPROXIMATE_CHANGES_TITLE =
  "Approximate: other changes were made in this worktree while the command ran";

/**
 * The +N −M a legacy shell row shows for the files the command changed, as
 * the bridge measured them (rows recorded before backend change tracking). A
 * measured no-op shows nothing; a change git cannot count in lines (a binary
 * file, a pure rename) shows its file count instead.
 */
export function CommandChangeStats({ change }: { change: MeasuredWorkspaceChange }) {
  const { additions, deletions, files, approximate } = change;
  const fileCount = files.length;
  if (additions === 0 && deletions === 0 && fileCount === 0) return null;
  return (
    <span
      className={cn("flex items-center gap-1 shrink-0 font-mono", approximate && "opacity-60")}
      title={approximate ? APPROXIMATE_CHANGES_TITLE : undefined}
      data-testid="command-change-stats"
    >
      {approximate && <span className="text-muted-foreground">~</span>}
      {additions > 0 && <span className="text-success">+{additions}</span>}
      {deletions > 0 && <span className="text-failure">-{deletions}</span>}
      {additions === 0 && deletions === 0 && (
        <span className="text-muted-foreground">
          {fileCount}
          {change.filesTruncated ? "+" : ""} {fileCount === 1 ? "file" : "files"}
        </span>
      )}
    </span>
  );
}

/**
 * Expanded list of the files a legacy shell call changed. The bridge kept no
 * contents for these, so a file opens as it is now — labelled as such — and
 * only when the environment is known.
 */
function CommandChangedFiles({
  change,
  environmentId,
}: {
  change: MeasuredWorkspaceChange;
  environmentId: string | undefined;
}) {
  // Optional: shell rows also render outside a terminal (pipeline transcripts),
  // where the paths are shown but cannot be opened.
  const createFileTab = useOptionalTerminalContext()?.createFileTab;
  const canOpen = Boolean(createFileTab && environmentId);
  return (
    <div className="px-3 py-2 border-b border-border/30 text-xs">
      <div className="mb-1 text-muted-foreground">
        {change.approximate ? "Changed files (approximate)" : "Changed files"}
      </div>
      <ul className="space-y-0.5">
        {change.files.map((file) => (
          <li key={file.path} className="flex items-center gap-2 font-mono">
            {canOpen && createFileTab && environmentId ? (
              <button
                type="button"
                className="truncate text-left text-foreground/80 hover:text-foreground hover:underline"
                title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                onClick={() =>
                  createFileTab(file.path, {
                    isDiff: true,
                    changeDiff: liveFileTarget(
                      environmentId,
                      { path: file.path },
                      `${file.path} (current)`,
                    ),
                  })
                }
              >
                {file.path}
              </button>
            ) : (
              <span className="truncate text-foreground/80" title={file.path}>
                {file.path}
              </span>
            )}
            <span className="ml-auto flex shrink-0 gap-1">
              {file.binary && <span className="text-muted-foreground">binary</span>}
              {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
              {file.deletions > 0 && <span className="text-failure">-{file.deletions}</span>}
            </span>
          </li>
        ))}
      </ul>
      {change.filesTruncated && (
        <div className="mt-1 text-muted-foreground">
          More files changed; totals include them all.
        </div>
      )}
      {canOpen && (
        <div className="mt-1 text-muted-foreground">
          Contents were not kept; files open in their current state.
        </div>
      )}
    </div>
  );
}

/**
 * True when `toolDiff` structurally carries a diff payload worth the edit
 * treatment. Routing on payload shape, not on provider tool names.
 *
 * A present-but-empty `diff` string carries no information — a provider that
 * surfaces an unfilled patch field emits one — so it must not count.
 */
export function hasRenderableDiff(toolDiff?: ToolDiffMetadata): boolean {
  return (
    Boolean(toolDiff?.diff) ||
    toolDiff?.before !== undefined ||
    toolDiff?.after !== undefined ||
    // A deferred diff has a body waiting behind `detailRef`; routing it to the
    // generic tool row would drop the edit treatment for the whole collapsed
    // lifetime of the part.
    toolDiff?.deferred === true
  );
}

const EDIT_STATE_COLORS = {
  success: "text-success",
  failure: "text-failure",
  pending: "text-yellow-600 animate-pulse",
};

/**
 * A file tool's change card.
 *
 * With a backend presentation, the collapsed badge is the primary role's
 * projection and the expanded body shows every role (payload, effect,
 * observation) with its own label, badge and backend hunks. Without one
 * (history recorded before change tracking, or a transcript outside a native
 * agent tab) the recorded payload is measured by the backend once and shown
 * with that provenance; if that fails, the row shows its path and raw output
 * only.
 */
export function EditToolPart({
  expansionKey,
  callId,
  occurrenceId,
  toolName,
  toolState,
  toolTitle,
  toolOutput,
  toolError,
  toolDiff,
  durationMs,
  deferredDetails = false,
}: {
  expansionKey: string;
  /** Provider call id; keys the backend's change presentation for this row. */
  callId?: string;
  occurrenceId?: string;
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
  /** Provider-reported runtime of the settled call (`toolDurationMs`). */
  durationMs?: number;
  /** Diff body exists but is fetched on expand, so the row must stay expandable. */
  deferredDetails?: boolean;
}) {
  const [isOpen, setIsOpen] = useMessagePartExpansion(expansionKey);
  const createFileTab = useOptionalTerminalContext()?.createFileTab ?? null;
  const changeScope = useNativeChangeScope();
  const environmentId = changeScope?.environmentId;
  const displayToolName = getToolDisplayName(toolName, "Edit");
  const displayToolTitle = getToolTitleDisplayName(toolTitle, toolName);

  const { presentation, roles, legacy } = useToolChangeRow(callId, toolState, occurrenceId);
  const primary = roles[0]?.projection;

  const filePath = toolDiff?.filePath || projectionFirstPath(primary);
  const fileName = filePath ? filePath.split("/").pop() : null;
  const shouldShowToolTitle =
    Boolean(displayToolTitle) && !fileName && displayToolTitle !== displayToolName;

  // Legacy rows send their recorded payload to the backend once it is in hand
  // (a deferred row's body arrives when it is expanded).
  const legacyDiff = toolDiff?.diff || undefined;
  const legacyBefore = toolDiff?.before;
  const legacyAfter = toolDiff?.after;
  const legacyPath = toolDiff?.filePath;
  // Counts an old row recorded without a body are passed through untouched;
  // the backend labels them provider-reported and never infers a missing side.
  // A deferred row's counts are the old bridge's whole-side totals; wait for
  // its body instead of presenting them.
  const legacyAdditions = toolDiff?.deferred ? undefined : toolDiff?.additions;
  const legacyDeletions = toolDiff?.deferred ? undefined : toolDiff?.deletions;
  const legacyInput = useMemo<LegacyPayloadInput | null>(
    () =>
      legacy &&
      (legacyDiff !== undefined ||
        legacyBefore !== undefined ||
        legacyAfter !== undefined ||
        legacyAdditions !== undefined ||
        legacyDeletions !== undefined)
        ? {
            toolName,
            filePath: legacyPath,
            before: legacyBefore,
            after: legacyAfter,
            diff: legacyDiff,
            additions: legacyAdditions,
            deletions: legacyDeletions,
          }
        : null,
    [
      legacy,
      toolName,
      legacyPath,
      legacyBefore,
      legacyAfter,
      legacyDiff,
      legacyAdditions,
      legacyDeletions,
    ],
  );
  const legacyMeasurement = useLegacyPayloadMeasurement(expansionKey, legacyInput);
  const legacySummary =
    legacyMeasurement.status === "ready" ? legacyMeasurement.summary : undefined;

  const historicalId = primary?.detail?.diffIdentityId;
  const showsBody = presentation
    ? Boolean(primary?.detail)
    : Boolean(legacySummary && legacySummary.files.length > 0);

  // A deferred part counts: its diff only loads *because* the row was
  // expanded, so gating the trigger on present content would make it
  // permanently unreachable.
  const hasExpandableContent = Boolean(
    toolOutput || toolError || deferredDetails || legacyInput || roles.length > 0,
  );

  const openHistorical = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!createFileTab || !historicalId) return;
    createFileTab(filePath ?? fileName ?? displayToolName, {
      isDiff: true,
      changeDiff: {
        kind: "historical",
        diffIdentityId: historicalId,
        title: fileName ?? displayToolName,
      },
    });
  };
  const openCurrent = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!createFileTab || !environmentId || !filePath) return;
    createFileTab(filePath, {
      isDiff: true,
      changeDiff: liveFileTarget(
        environmentId,
        { path: filePath },
        `${fileName ?? filePath} (current)`,
      ),
    });
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-0">
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-2 w-full text-xs text-muted-foreground py-1.5 px-2 rounded-md transition-colors hover:text-foreground",
          hasExpandableContent && "cursor-pointer",
          !hasExpandableContent && "cursor-default",
        )}
        disabled={!hasExpandableContent}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 transition-transform shrink-0",
            isOpen && "rotate-90",
            !hasExpandableContent && "opacity-0",
          )}
        />
        <Pencil className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">{displayToolName}</span>
        {fileName && (
          <span className="font-mono text-muted-foreground/80 truncate flex-1 text-left">
            {fileName}
          </span>
        )}
        {shouldShowToolTitle && (
          <span className="text-muted-foreground/70 truncate flex-1 text-left">
            {displayToolTitle}
          </span>
        )}
        {presentation ? (
          <ChangeCountBadge projection={primary} />
        ) : (
          legacySummary && <LegacyPayloadBadge summary={legacySummary} />
        )}
        {toolState && (
          <span className={cn("ml-auto shrink-0", EDIT_STATE_COLORS[toolState] || "")}>
            {toolState === "pending" ? "running..." : toolState}
          </span>
        )}
        <ToolDurationLabel label={formatSettledToolDuration(toolState, durationMs)} />
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="overflow-hidden border-l border-border/40 pl-3">
            {/* Header with the file path, the historical pop-out and the explicit current-file action */}
            <div className="flex items-center justify-between gap-1 px-3 py-1.5 border-b border-border/30">
              <span className="text-xs font-mono text-muted-foreground truncate">
                {filePath || "Unknown file"}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {createFileTab && historicalId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 hover:bg-muted"
                    onClick={openHistorical}
                    title="Open diff in new tab"
                  >
                    <ExternalLinkIcon className="w-3 h-3" />
                  </Button>
                )}
                {createFileTab && environmentId && filePath && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 hover:bg-muted"
                    onClick={openCurrent}
                    title="Open current file diff"
                  >
                    <FileClock className="w-3 h-3" />
                  </Button>
                )}
              </span>
            </div>

            {/* Backend presentation: each role separately, primary first */}
            {roles.map((entry) => (
              <ChangeRoleSection
                key={entry.role}
                role={entry.role}
                projection={entry.projection}
                environmentId={environmentId}
                body
              />
            ))}

            {/* Legacy payload measured by the backend */}
            {!presentation && legacyMeasurement.status === "loading" && (
              <div className="px-3 py-1.5 text-xs text-muted-foreground">Measuring change…</div>
            )}
            {!presentation && legacySummary && <LegacyPayloadBody summary={legacySummary} />}

            {/* Raw tool output, as plain text, when no change body is shown */}
            {!showsBody && toolOutput && (
              <div className="px-3 py-2 max-h-64 overflow-auto">
                <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all">
                  {toolOutput}
                </pre>
              </div>
            )}

            {/* Error section */}
            {toolError && (
              <div className="px-3 py-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                  <pre className="text-xs font-mono text-destructive whitespace-pre-wrap break-all">
                    {toolError}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
