import {
  useCallback,
  useMemo,
} from "react";
import { countTextLines, splitTextLines } from "@orkestrator/protocol/tool-diff";
import {
  Brain,
  ChevronRight,
  Wrench,
  AlertCircle,
  Pencil,
  ExternalLink as ExternalLinkIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { useTerminalContext } from "@/contexts/TerminalContext";
import {
  type ToolDiffMetadata,
} from "@/lib/opencode-client";
import {
  getToolDisplayName,
  getToolTitleDisplayName,
} from "@/lib/tool-names";
import {
  isBackgroundTaskActionTool,
  isBackgroundTaskStopTool,
} from "@/lib/chat/native-message-adapters";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import {
  type NativeBackgroundTask,
} from "@/lib/chat/native-message-types";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import {
  markdownComponents,
  TASK_LIST_SYNTAX_PATTERN,
  stringToolArg,
} from "./NativeMessage.shared";

export function ThinkingPart({
  content,
  expansionKey,
}: {
  content: string;
  expansionKey: string;
}) {
  const hasTaskList = useMemo(
    () => TASK_LIST_SYNTAX_PATTERN.test(content),
    [content],
  );
  // Backed by the shared store using the stable key supplied by MessagePart,
  // so an expanded block survives the virtualized list unmounting it while
  // off-screen.
  const [isOpen, setIsOpen] = useMessagePartExpansion(expansionKey);
  // The collapsed row is a single line, so flatten whitespace for the preview.
  const preview = useMemo(
    () => (hasTaskList ? "task list" : content.trim().replace(/\s+/g, " ")),
    [content, hasTaskList],
  );

  // Reasoning with no text has nothing to preview and nothing to expand into,
  // so it must not render a control that promises hidden content.
  if (!preview) {
    return null;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-0">
      <CollapsibleTrigger
        className="flex items-center gap-2 w-full text-xs text-muted-foreground py-1.5 px-2 rounded-md transition-colors hover:text-foreground cursor-pointer"
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 transition-transform shrink-0",
            isOpen && "rotate-90",
          )}
        />
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium shrink-0">Thinking</span>
        {!isOpen && (
          <span className="font-mono text-muted-foreground/80 truncate min-w-0 text-left">
            {preview}
          </span>
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

  const messageMatch = output.match(
    /Successfully stopped task:\s*\S+\s+\(([\s\S]+)\)\s*$/,
  );
  return messageMatch?.[1]?.trim() || undefined;
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
        className: "text-emerald-600 dark:text-emerald-300",
      };
    case "failed":
      return { label: "failed", className: "text-red-400" };
    case "killed":
      return { label: "stopped", className: "text-muted-foreground/80" };
    default:
      return undefined;
  }
}

/** Render a tool invocation part - expandable to show input/output */
export function ToolPart({
  expansionKey,
  toolName,
  toolState,
  toolTitle,
  toolArgs,
  toolOutput,
  toolError,
  backgroundTask,
  deferredDetails = false,
}: {
  expansionKey: string;
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  backgroundTask?: NativeBackgroundTask;
  /** Output exists but is fetched on expand, so the row must stay expandable. */
  deferredDetails?: boolean;
}) {
  const [isOpen, setIsOpen] = useMessagePartExpansion(expansionKey);
  const displayToolName = getToolDisplayName(toolName);
  const displayToolTitle = getToolTitleDisplayName(toolTitle, toolName);
  const isTaskStop = isBackgroundTaskStopTool(toolName);
  const isTaskAction = isBackgroundTaskActionTool(toolName);
  const isBackgroundLaunch = toolArgs?.run_in_background === true;
  const taskId =
    backgroundTask?.id
    ?? stringToolArg(toolArgs, "task_id", "taskId");
  const taskDescription =
    backgroundTask?.description
    ?? (isBackgroundLaunch
      ? stringToolArg(toolArgs, "description")
      : undefined);

  const stateColors = {
    success: "text-green-600",
    failure: "text-red-400",
    pending: "text-yellow-600 animate-pulse",
  };

  // Determine if there's content to show when expanded. A deferred part counts:
  // its output only loads *because* the row was expanded, so gating the trigger
  // on already-present output would make it permanently unreachable.
  const hasExpandableContent =
    toolOutput || toolError || deferredDetails
    || (toolArgs && Object.keys(toolArgs).length > 0);

  // The collapsed row is a single truncating line, so anything shown there is
  // flattened and capped rather than relying on CSS alone — the accessible name
  // and the DOM string are otherwise unbounded.
  const toSingleLinePreview = (value: string): string => {
    const preview = value.trim().replace(/\s+/g, " ");
    return preview.length > 180 ? `${preview.slice(0, 179)}…` : preview;
  };

  // Extract display info from toolArgs based on tool type. `generic` marks a
  // fallback preview of raw input, which is not specific enough to justify
  // hiding a descriptive tool title the way a real command or path does.
  const getDisplayInfo = (): {
    text: string;
    generic: boolean;
    monospace: boolean;
  } | null => {
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
  };

  const displayInfo = getDisplayInfo();
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
              ? (toolState === "pending" ? "stopping…" : "stopped")
              : (toolState === "pending" ? "running..." : toolState),
        className: stateColors[toolState],
      }
    : undefined;
  /*
   * A failed tool result outranks the task's lifecycle badge. Stopping a task
   * that already finished is rejected by the tool ("Task <id> is not running"),
   * and the task itself is still `completed` — so deferring to the lifecycle
   * here would paint a green "completed" over an action that failed.
   */
  const displayedState = toolState === "failure"
    ? toolResultState
    : lifecycleState ?? toolResultState;

  // Format the command input for shell-like display
  const formatInput = () => {
    if (!toolArgs) return null;
    // For shell commands, show the command
    if (toolArgs.command && typeof toolArgs.command === "string") {
      // `command` may be a derived, length-capped label rather than the literal
      // arguments, so keep the authoritative source visible alongside it.
      const input = typeof toolArgs.input === "string" ? toolArgs.input.trim() : "";
      return input
        ? `$ ${toolArgs.command}\n\n${input}`
        : `$ ${toolArgs.command}`;
    }
    // For other tools, show a JSON representation of args
    return JSON.stringify(toolArgs, null, 2);
  };

  const formattedInput = formatInput();

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
        {displayedState && (
          <span
            className={cn("ml-auto shrink-0", displayedState.className)}
          >
            {displayedState.label}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="overflow-hidden border-l border-border/40 pl-3">
            {/* Input/Command section */}
            {formattedInput && (
              <div className="px-3 py-2 border-b border-border/30">
                <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
                  {formattedInput}
                </pre>
              </div>
            )}

            {/* Output section */}
            {toolOutput && (
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

/**
 * True when `toolDiff` carries diff content worth rendering with the edit
 * treatment.
 *
 * A present-but-empty `diff` string carries no information — a provider that
 * surfaces an unfilled patch field emits one — so it must not count, and must
 * not suppress the before/after fallback the way a real diff does.
 */
export function hasRenderableDiff(toolDiff?: ToolDiffMetadata): boolean {
  return Boolean(toolDiff?.diff)
    || toolDiff?.before !== undefined
    || toolDiff?.after !== undefined
    // A deferred diff has a body waiting behind `detailRef`; routing it to the
    // generic tool row would drop the edit treatment for the whole collapsed
    // lifetime of the part.
    || toolDiff?.deferred === true;
}

/** Parse unified diff output into lines with +/- indicators */
function parseDiffLines(
  output: string,
): Array<{ type: "add" | "remove" | "context" | "header"; content: string }> {
  if (!output) return [];
  const lines = output.split("\n");
  return lines.map((line) => {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@")
    ) {
      return { type: "header" as const, content: line };
    } else if (line.startsWith("+")) {
      return { type: "add" as const, content: line };
    } else if (line.startsWith("-")) {
      return { type: "remove" as const, content: line };
    } else {
      return { type: "context" as const, content: line };
    }
  });
}

/** Generate diff lines from before/after content */
function generateDiffFromBeforeAfter(
  before?: string,
  after?: string,
): Array<{ type: "add" | "remove" | "context" | "header"; content: string }> {
  const result: Array<{
    type: "add" | "remove" | "context" | "header";
    content: string;
  }> = [];

  // Logical lines, not String#split: a trailing newline terminates the last
  // line rather than creating an empty `+`/`-` row that disagrees with the
  // collapsed badge. An empty file is zero lines, not one empty line.
  const contentLines = (content: string): string[] => splitTextLines(content);

  // If we have both before and after, show the diff
  if (before !== undefined && after !== undefined) {
    // Add removed lines
    const beforeLines = contentLines(before);
    for (const line of beforeLines) {
      result.push({ type: "remove", content: `-${line}` });
    }
    // Add added lines
    const afterLines = contentLines(after);
    for (const line of afterLines) {
      result.push({ type: "add", content: `+${line}` });
    }
  } else if (after !== undefined) {
    // Only additions (write/new content)
    const afterLines = contentLines(after);
    for (const line of afterLines) {
      result.push({ type: "add", content: `+${line}` });
    }
  } else if (before !== undefined) {
    // Only deletions
    const beforeLines = contentLines(before);
    for (const line of beforeLines) {
      result.push({ type: "remove", content: `-${line}` });
    }
  }

  return result;
}

/** Count additions and deletions from diff output or metadata */
function countDiffStats(
  output?: string,
  metadata?: ToolDiffMetadata,
): { additions: number; deletions: number } {
  // First try to use pre-calculated metadata if available
  if (metadata?.additions !== undefined || metadata?.deletions !== undefined) {
    return {
      additions: metadata.additions ?? 0,
      deletions: metadata.deletions ?? 0,
    };
  }

  // Try to calculate from before/after content
  if (metadata?.before !== undefined || metadata?.after !== undefined) {
    const beforeLines = countTextLines(metadata.before);
    const afterLines = countTextLines(metadata.after);
    return {
      additions: afterLines,
      deletions: beforeLines,
    };
  }

  // Otherwise parse from diff-formatted output
  if (!output) return { additions: 0, deletions: 0 };

  let additions = 0;
  let deletions = 0;
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }
  return { additions, deletions };
}

/** Render an edit tool invocation with diff view */
export function EditToolPart({
  expansionKey,
  toolName,
  toolState,
  toolTitle,
  toolOutput,
  toolError,
  toolDiff,
  deferredDetails = false,
}: {
  expansionKey: string;
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
  /** Diff body exists but is fetched on expand, so the row must stay expandable. */
  deferredDetails?: boolean;
}) {
  const [isOpen, setIsOpen] = useMessagePartExpansion(expansionKey);
  const { createFileTab } = useTerminalContext();
  const displayToolName = getToolDisplayName(toolName, "Edit");
  const displayToolTitle = getToolTitleDisplayName(toolTitle, toolName);

  const stateColors = {
    success: "text-green-600",
    failure: "text-red-400",
    pending: "text-yellow-600 animate-pulse",
  };

  // Get file path from diff metadata
  const filePath = toolDiff?.filePath;
  const fileName = filePath ? filePath.split("/").pop() : null;
  const shouldShowToolTitle =
    Boolean(displayToolTitle) &&
    !fileName &&
    displayToolTitle !== displayToolName;

  // Diff work is keyed on the *values* it reads, not on `toolDiff`'s identity.
  // Normalization rebuilds every part object on each streaming frame, so an
  // identity dependency would re-derive a completed edit's diff ten times a
  // second for the rest of the turn — and generating a diff from before/after
  // is whole-file work.
  const diffSource = toolDiff?.diff;
  const diffBefore = toolDiff?.before;
  const diffAfter = toolDiff?.after;
  const diffAdditions = toolDiff?.additions;
  const diffDeletions = toolDiff?.deletions;

  // Calculate diff stats
  const { additions, deletions } = useMemo(
    () => countDiffStats(toolOutput, toolDiff),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value deps, see above
    [toolOutput, diffSource, diffBefore, diffAfter, diffAdditions, diffDeletions],
  );

  // Parse diff lines for display - try unified diff first, then output, then generate from before/after
  const diffLines = useMemo(() => {
    // A provider-supplied diff is authoritative even when it contains no
    // additions or removals. Falling through to before/after in that case would
    // turn an unchanged whole-file state into a synthetic full replacement. An
    // empty diff string is not such a case — it says nothing at all.
    if (diffSource) {
      return parseDiffLines(diffSource);
    }

    // Then try parsing from output (if it's in diff format)
    const outputLines = parseDiffLines(toolOutput || "");
    const hasActualDiffContent = outputLines.some(
      (line) => line.type === "add" || line.type === "remove",
    );
    if (hasActualDiffContent) {
      return outputLines;
    }

    // Finally generate from before/after content
    if (toolDiff?.before !== undefined || toolDiff?.after !== undefined) {
      return generateDiffFromBeforeAfter(toolDiff.before, toolDiff.after);
    }

    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value deps, see above
  }, [toolOutput, diffSource, diffBefore, diffAfter]);

  // Determine if there's content to show when expanded. A deferred part counts:
  // its diff only loads *because* the row was expanded, so gating the trigger
  // on already-present content would make it permanently unreachable.
  const hasExpandableContent =
    toolOutput ||
    toolError ||
    diffLines.length > 0 ||
    toolDiff?.diff ||
    toolDiff?.before ||
    toolDiff?.after ||
    deferredDetails;

  // Handle pop-out to open diff in new tab
  const handlePopOut = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (createFileTab && filePath) {
        createFileTab(filePath, { isDiff: true, gitStatus: "M" });
      }
    },
    [createFileTab, filePath],
  );

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
        {/* Line count stats - shown after filename */}
        {(additions > 0 || deletions > 0) && (
          <span className="flex items-center gap-1 shrink-0">
            {additions > 0 && (
              <span className="text-green-500 font-mono">+{additions}</span>
            )}
            {deletions > 0 && (
              <span className="text-red-400 font-mono">-{deletions}</span>
            )}
          </span>
        )}
        {toolState && (
          <span
            className={cn("ml-auto shrink-0", stateColors[toolState] || "")}
          >
            {toolState === "pending" ? "running..." : toolState}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="overflow-hidden border-l border-border/40 pl-3">
            {/* Header with file path and pop-out button */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
              <span className="text-xs font-mono text-muted-foreground truncate">
                {filePath || "Unknown file"}
              </span>
              {createFileTab && filePath && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 hover:bg-muted"
                  onClick={handlePopOut}
                  title="Open diff in new tab"
                >
                  <ExternalLinkIcon className="w-3 h-3" />
                </Button>
              )}
            </div>

            {/* Unified diff view */}
            {diffLines.length > 0 && (
              <div className="max-h-64 overflow-auto">
                <pre className="text-xs font-mono">
                  {diffLines.map((line, i) => (
                    <div
                      key={i}
                      className={cn(
                        "px-3 py-0.5",
                        line.type === "add" && "bg-green-500/20 text-green-400",
                        line.type === "remove" && "bg-red-500/20 text-red-400",
                        line.type === "header" &&
                          "bg-blue-500/10 text-blue-400",
                        line.type === "context" && "text-foreground/60",
                      )}
                    >
                      {line.content}
                    </div>
                  ))}
                </pre>
              </div>
            )}

            {/* Fallback to raw output if no diff lines parsed */}
            {diffLines.length === 0 && toolOutput && (
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
