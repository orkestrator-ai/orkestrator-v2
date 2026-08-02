import {
  createContext,
  memo,
  useCallback,
  useContext,
  useState,
  useMemo,
  useEffect,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  Brain,
  FileText,
  Image as ImageIcon,
  X,
  ChevronRight,
  Wrench,
  AlertCircle,
  Pencil,
  ExternalLink as ExternalLinkIcon,
  Layers,
} from "lucide-react";
import { type Components } from "react-markdown";
import { cn } from "@/lib/utils";
import { openInBrowser, readContainerFileBase64, readFileBase64 } from "@/lib/backend";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { useTerminalContext } from "@/contexts/TerminalContext";
import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  type ToolDiffMetadata,
} from "@/lib/opencode-client";
import {
  getToolDisplayName,
  getToolTitleDisplayName,
  isEditTool,
} from "@/lib/tool-names";
import { isTodoTool } from "@/lib/todo-tool";
import { TodoToolPart } from "@/components/todo/TodoToolPart";
import { MessageErrorAlert, MessageShell } from "@/components/chat/MessageShell";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { JsonPayloadPart } from "@/components/chat/JsonPayloadPart";
import { parseJsonPayload } from "@/lib/chat/json-payload";
import { MessageCopyButton } from "@/components/chat/MessageCopyButton";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  type NativeAgentActivityPart,
  type NativeMessage as NativeMessageType,
  type NativeAgentGroupPart,
  type NativeBackgroundTask,
  type NativeMessagePart,
  type NativeTaskGroupPart,
  type NativeToolGroupPart,
} from "@/lib/chat/native-message-types";
import {
  getNativeAgentStatus,
  type NativeAgentStatus,
} from "@/lib/chat/native-agent-status";
import {
  isBackgroundTaskActionTool,
  isBackgroundTaskStopTool,
  normalizeNativeMessage,
} from "@/lib/chat/native-message-adapters";
import { writeText } from "@/lib/native/clipboard";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";

/** Custom link component that opens URLs in the system browser */
function ExternalLink({
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      if (href) {
        openInBrowser(href).catch((err) => {
          console.error("[NativeMessage] Failed to open link:", err);
        });
      }
    },
    [href],
  );

  return (
    <a
      href={href}
      onClick={handleClick}
      className="text-primary hover:underline cursor-pointer"
      {...props}
    >
      {children}
    </a>
  );
}

/** Markdown components config with external link handling */
const markdownComponents: Components = {
  a: ExternalLink,
};

const TASK_LIST_SYNTAX_PATTERN = /(^|\n)\s*(?:[-*+]|\d+\.)\s+\[(?: |x|X)\]\s+/m;
const USER_PROMPT_COLLAPSED_LINE_COUNT = 12;

interface NativeMessageProps {
  message: NativeMessageType;
  previousMessage?: NativeMessageType | null;
  assistantLabel?: string;
  containerId?: string;
  /** Stable transcript/environment identity used to isolate persisted disclosures. */
  agentExpansionScope?: string;
  actions?: ReactNode;
  resolveModelLabel?: (modelId: string) => string;
}

const AgentExpansionScopeContext = createContext("native-message");

function getAgentExpansionKey(
  part: NativeAgentActivityPart,
  partKey: string,
): string {
  if (part.type === "task-group") {
    const durableId = part.task.toolUseId?.trim() || part.task.subagentId?.trim();
    return durableId ? `task:id:${durableId}` : `task:part:${partKey}`;
  }

  const durableId = part.subagentId?.trim() || part.toolUseId?.trim();
  return durableId ? `subagent:id:${durableId}` : `subagent:part:${partKey}`;
}

function useAgentExpansion(part: NativeAgentActivityPart, partKey: string) {
  const expansionScope = useContext(AgentExpansionScopeContext);
  const expansionKey = getAgentExpansionKey(part, partKey);
  // Active agents live in a virtualized row that can be unmounted while Claude
  // streams or while the reader scrolls. Persist the user's explicit toggle in
  // the same bounded store used by thinking/JSON disclosures so those routine
  // remounts cannot silently collapse the agent again.
  return useMessagePartExpansion(
    `native-agent:${expansionScope}:${expansionKey}`,
  );
}

/** Render a thinking/reasoning part inline - expandable to show the full text */
function ThinkingPart({
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
function ToolPart({
  toolName,
  toolState,
  toolTitle,
  toolArgs,
  toolOutput,
  toolError,
  backgroundTask,
}: {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  backgroundTask?: NativeBackgroundTask;
}) {
  const [isOpen, setIsOpen] = useState(false);
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

  // Determine if there's content to show when expanded
  const hasExpandableContent =
    toolOutput || toolError || (toolArgs && Object.keys(toolArgs).length > 0);

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

  // An empty file has zero lines. String#split would otherwise turn it into a
  // single empty line and render a synthetic `-` or `+` that disagrees with the
  // zero-line statistics shown in the collapsed row.
  const contentLines = (content: string): string[] =>
    content.length === 0 ? [] : content.split("\n");

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
    const beforeLines = metadata.before
      ? metadata.before.split("\n").length
      : 0;
    const afterLines = metadata.after ? metadata.after.split("\n").length : 0;
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
function EditToolPart({
  toolName,
  toolState,
  toolTitle,
  toolOutput,
  toolError,
  toolDiff,
}: {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
}) {
  const [isOpen, setIsOpen] = useState(false);
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
    // First try the unified diff from metadata (most accurate)
    if (toolDiff?.diff) {
      const diffLines = parseDiffLines(toolDiff.diff);
      const hasActualDiffContent = diffLines.some(
        (line) => line.type === "add" || line.type === "remove",
      );
      if (hasActualDiffContent) {
        return diffLines;
      }
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

  // Determine if there's content to show when expanded
  const hasExpandableContent =
    toolOutput ||
    toolError ||
    diffLines.length > 0 ||
    toolDiff?.diff ||
    toolDiff?.before ||
    toolDiff?.after;

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

/** Render a file attachment part */
function ImagePreviewOverlay({
  imageSrc,
  filename,
  onClose,
}: {
  imageSrc: string;
  filename: string;
  onClose: () => void;
}) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        className="relative max-w-full max-h-full"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 p-2 text-white/70 hover:text-white transition-colors"
        >
          <X className="w-6 h-6" />
        </button>
        <div className="text-white/70 text-sm mb-2 text-center">{filename}</div>
        <img
          src={imageSrc}
          alt={filename}
          className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
        />
      </div>
    </div>,
    document.body,
  );
}

function getMimeType(path: string): string {
  const ext = path
    .split("?")[0]
    ?.split("#")[0]
    ?.split(".")
    .pop()
    ?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    tiff: "image/tiff",
    tif: "image/tiff",
  };
  return mimeTypes[ext || ""] || "image/png";
}

function isImageReference(pathOrUrl?: string): boolean {
  if (!pathOrUrl) return false;
  if (pathOrUrl.startsWith("data:image/")) return true;
  const lower = pathOrUrl.toLowerCase();
  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".bmp",
    ".ico",
    ".tif",
    ".tiff",
  ].some((ext) => lower.includes(ext));
}

function parseLocalFilePathFromUrl(fileUrl: string): string | null {
  if (!fileUrl.startsWith("file://")) return null;

  try {
    const parsed = new URL(fileUrl);
    const pathname = decodeURIComponent(parsed.pathname);

    // UNC paths (e.g. file://server/share/path)
    if (parsed.host) {
      return `//${parsed.host}${pathname}`;
    }

    // Windows absolute paths are represented as /C:/path in file URLs.
    if (/^\/[a-z]:\//i.test(pathname)) {
      return pathname.slice(1);
    }

    return pathname;
  } catch {
    return null;
  }
}

function getSafeContainerRelativePath(path: string): string | null {
  if (!path || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    return null;
  }
  if (path.split(/[\\/]+/).some((segment) => segment === "..")) {
    return null;
  }
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith("\\")) {
    return null;
  }
  if (path.startsWith("/workspace/")) {
    const relativePath = path.slice("/workspace/".length);
    if (
      !relativePath ||
      relativePath.startsWith("/") ||
      relativePath.startsWith("\\") ||
      /^[a-z]:[\\/]/i.test(relativePath)
    ) {
      return null;
    }
    return relativePath;
  }
  if (path.startsWith("/")) {
    return null;
  }
  return path;
}

function FilePart({
  path,
  fileUrl,
  containerId,
}: {
  path: string;
  fileUrl?: string;
  containerId?: string;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const displayName = path.split("/").pop() || path || "file";
  const isImage = isImageReference(fileUrl) || isImageReference(path);

  const handleClick = useCallback(async () => {
    if (!isImage) return;

    if (imageSrc) {
      setPreviewOpen(true);
      return;
    }

    setLoading(true);
    setLoadError(false);
    try {
      if (fileUrl?.startsWith("data:image/")) {
        setImageSrc(fileUrl);
        setPreviewOpen(true);
        return;
      }

      if (fileUrl?.startsWith("http://") || fileUrl?.startsWith("https://")) {
        setImageSrc(fileUrl);
        setPreviewOpen(true);
        return;
      }

      const localFilePath = fileUrl?.startsWith("file://")
        ? parseLocalFilePathFromUrl(fileUrl)
        : null;

      if (containerId) {
        const containerPath = localFilePath ?? path;
        const relativePath = getSafeContainerRelativePath(containerPath);
        if (!relativePath) {
          throw new Error("Unsafe container image path");
        }

        const base64 = await readContainerFileBase64(containerId, relativePath);
        const mimeType = getMimeType(containerPath);
        setImageSrc(`data:${mimeType};base64,${base64}`);
        setPreviewOpen(true);
        return;
      }

      const filePath = localFilePath ?? (path.startsWith("/") ? path : null);

      if (!filePath) {
        throw new Error("No readable local image path available");
      }

      const base64 = await readFileBase64(filePath);
      const mimeType = getMimeType(filePath);
      setImageSrc(`data:${mimeType};base64,${base64}`);
      setPreviewOpen(true);
    } catch (err) {
      console.error("[NativeMessage] Failed to load image preview:", err, {
        path,
        fileUrl,
      });
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [isImage, imageSrc, path, fileUrl, containerId]);

  return (
    <>
      <button
        onClick={handleClick}
        disabled={!isImage || loading}
        className={cn(
          "inline-flex items-center gap-1.5 text-xs my-0 py-1.5 px-2.5 rounded-md border transition-colors",
          isImage
            ? "bg-muted/50 border-border hover:bg-muted hover:border-border/80 cursor-pointer"
            : "bg-muted/30 border-border/50 cursor-default",
          loading && "opacity-50",
        )}
      >
        {isImage ? (
          <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <FileText className="w-3.5 h-3.5 text-muted-foreground" />
        )}
        <span className="font-mono truncate max-w-[240px] text-muted-foreground">
          {displayName}
        </span>
        {loading && <span className="text-muted-foreground">(loading...)</span>}
        {loadError && (
          <span className="text-destructive text-[10px]">(error)</span>
        )}
      </button>

      {previewOpen && imageSrc && (
        <ImagePreviewOverlay
          imageSrc={imageSrc}
          filename={displayName}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
}

/** Render a text content part with markdown support */
function TextPart({
  content,
  showCopy = true,
  truncateUserPrompt = false,
  renderJsonPayload = true,
  expansionKey,
}: {
  content: string;
  showCopy?: boolean;
  truncateUserPrompt?: boolean;
  /**
   * Fold a block that is nothing but JSON into a structured view. Off for the
   * user's own messages, which are shown back as written.
   */
  renderJsonPayload?: boolean;
  /** Stable identity used to persist the folded payload's expansion state. */
  expansionKey: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lineCount = useMemo(
    () => content.split(/\r\n|\r|\n/).length,
    [content],
  );
  const shouldTruncate =
    truncateUserPrompt && lineCount > USER_PROMPT_COLLAPSED_LINE_COUNT;
  const jsonPayload = useMemo(
    () => (renderJsonPayload ? parseJsonPayload(content) : null),
    [content, renderJsonPayload],
  );

  if (jsonPayload) {
    return (
      <div className="group py-1.5">
        {/*
          Find draws its highlights from mounted DOM text, and a closed
          disclosure has unmounted everything below its trigger. So the find
          index is fed `jsonPayloadSearchText` — the collapsed row's own text —
          rather than the raw document, which would count matches that could
          never be highlighted and shift every sibling part's occurrence
          numbering. See `getNativeMessageSearchText`.
        */}
        <div>
          <JsonPayloadPart payload={jsonPayload} expansionKey={expansionKey} />
        </div>
        {showCopy ? (
          <MessageCopyButton
            content={content}
            wrapperClassName="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("group", !truncateUserPrompt && "py-1.5")}>
      <div
        data-agent-chat-search-content="true"
        className={cn(
          "[&_.prose>:first-child]:mt-0 [&_.prose>:last-child]:mb-0",
          shouldTruncate && !isExpanded && "overflow-hidden",
        )}
        style={
          shouldTruncate && !isExpanded
            ? {
                maxHeight: `calc(${USER_PROMPT_COLLAPSED_LINE_COUNT} * 1.625rem)`,
              }
            : undefined
        }
      >
        <MessageMarkdown content={content} components={markdownComponents} />
      </div>
      {shouldTruncate ? (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((current) => !current)}
        >
          {isExpanded ? "show less" : "show more"}
        </button>
      ) : null}
      {showCopy ? (
        <MessageCopyButton
          content={content}
          wrapperClassName="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
        />
      ) : null}
    </div>
  );
}

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

function getSubagentPreview(
  part: Extract<NativeMessagePart, { type: "subagent" }>,
  status: NativeAgentStatus,
): string {
  const actions = part.subagentActions ?? [];
  const latestAction = actions.at(-1);

  if (!latestAction) {
    return isTerminalAgentStatus(status)
      ? "No activity captured."
      : "Waiting for activity.";
  }

  if (latestAction.type === "text") {
    return latestAction.content.trim() || "Response";
  }
  if (latestAction.type === "thinking") {
    return "Thinking";
  }
  if (latestAction.type === "file") {
    return latestAction.content.trim() || "File";
  }

  const command =
    typeof latestAction.toolArgs?.command === "string"
      ? latestAction.toolArgs.command
      : null;
  if (command) {
    return command;
  }

  return (
    getToolTitleDisplayName(
      latestAction.toolTitle,
      latestAction.toolName,
      latestAction.content,
    ) || getToolDisplayName(latestAction.toolName, latestAction.content)
  );
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

function buildAgentDisplayLabel(name: string, role?: string): string {
  return role ? `${name} (${role})` : name;
}

function shouldShowTokenOnlyAgentUsage(part: NativeMessagePart): boolean {
  return part.agentUsageDisplay === "token-only" && Boolean(part.tokenCountText);
}

function SubagentPart({
  part,
  containerId,
  partKey,
}: {
  part: Extract<NativeMessagePart, { type: "subagent" }>;
  containerId?: string;
  partKey: string;
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
  const preview = useMemo(() => getSubagentPreview(part, status), [part, status]);
  const toolCountLabel = hasExternalUsage
    ? `${toolCount} ${toolCount === 1 ? "tool use" : "tool uses"}`
    : `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-0">
      <CollapsibleTrigger
        className="w-full rounded-md px-2 py-2 text-left transition-colors hover:text-foreground cursor-pointer"
      >
        <div className="flex items-start gap-3">
          <ChevronRight
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform",
              isOpen && "rotate-90",
            )}
          />
          <Layers className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
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
            <div className="mt-1 truncate text-xs text-muted-foreground/80">
              {preview}
            </div>
          </div>
          <div className="shrink-0 text-right text-[11px] text-muted-foreground/70">
            {tokenOnlyUsage ? (
              <div>{part.tokenCountText}</div>
            ) : (
              <>
                <div>{toolCountLabel}</div>
                <div>
                  {part.tokenCountText ??
                    `${subagentActions.length} ${subagentActions.length === 1 ? "update" : "updates"}`}
                </div>
              </>
            )}
          </div>
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-1">
        <div className="border-l border-border/40 pl-3">
          {part.subagentPrompt?.trim() ? (
            <div className="mb-3 border-l border-border/30 pl-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Task
              </div>
              <MessageMarkdown
                content={part.subagentPrompt}
                components={markdownComponents}
                className="text-xs text-muted-foreground/90 prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-pre:my-1 prose-pre:p-2"
                enableBreaks={false}
              />
            </div>
          ) : null}

          <div className="space-y-1">
            {subagentActions.map((childPart, index) => (
              <MessagePart
                key={`${part.subagentId || part.content}-subagent-part-${index}-${childPart.type}`}
                part={childPart}
                containerId={containerId}
                partKey={`${partKey}/subagent-${index}`}
              />
            ))}
            {subagentActions.length === 0 ? (
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

function AgentGroupPart({
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
      className="relative my-1 border-l border-primary/30 pl-2"
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
      <div className="divide-y divide-border/30 rounded-r-md bg-muted/[0.08]">
        {part.parts.map((child, index) => (
          <MessagePart
            key={`agent-group-part-${index}-${child.type}`}
            part={child}
            containerId={containerId}
            partKey={`${partKey}/agent-${index}`}
          />
        ))}
      </div>
    </section>
  );
}

function ToolGroupPart({
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
        <MessagePart
          key={`tool-group-part-${index}-${child.type}`}
          part={child}
          containerId={containerId}
          partKey={`${partKey}/tool-${index}`}
        />
      ))}
    </div>
  );
}

function TaskGroupPart({
  part,
  containerId,
  partKey,
}: {
  part: NativeTaskGroupPart;
  containerId?: string;
  partKey: string;
}) {
  const [isOpen, setIsOpen] = useAgentExpansion(part, partKey);
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
  const toolCountLabel = hasExternalUsage
    ? `${toolCount} ${toolCount === 1 ? "tool use" : "tool uses"}`
    : `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
  const preview = useMemo(() => {
    const latestChild = part.childTools.at(-1);
    if (!latestChild) {
      return description ?? (
        isTerminalAgentStatus(status)
          ? "No activity captured."
          : "Waiting for activity."
      );
    }

    if (latestChild.type === "thinking") return "Thinking";
    if (latestChild.type === "text") {
      return latestChild.content.trim() || "Response";
    }
    if (latestChild.type === "file") return latestChild.content;

    const command =
      typeof latestChild.toolArgs?.command === "string"
        ? latestChild.toolArgs.command
        : null;
    if (command) return command;

    return (
      getToolTitleDisplayName(
        latestChild.toolTitle,
        latestChild.toolName,
        latestChild.content,
      ) ||
      getToolDisplayName(latestChild.toolName, latestChild.content)
    );
  }, [description, part.childTools, status]);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-0">
      <CollapsibleTrigger className="w-full rounded-md px-2 py-2 text-left transition-colors hover:text-foreground cursor-pointer">
        <div className="flex items-start gap-3">
          <ChevronRight
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform",
              isOpen && "rotate-90",
            )}
          />
          <Layers className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
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
            <div className="mt-1 truncate text-xs text-muted-foreground/80">
              {preview}
            </div>
          </div>
          <div className="shrink-0 text-right text-[11px] text-muted-foreground/70">
            {tokenOnlyUsage ? (
              <div>{part.task.tokenCountText}</div>
            ) : (
              <>
                <div>{toolCountLabel}</div>
                <div>
                  {part.task.tokenCountText ??
                    `${childCount} ${childCount === 1 ? "update" : "updates"}`}
                </div>
              </>
            )}
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">
        <div className="border-l border-border/40 pl-3">
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
          <div className="space-y-1">
            {part.childTools.map((child, index) => (
              <MessagePart
                key={`task-child-${index}-${child.toolUseId ?? child.sourcePartId ?? child.toolName ?? child.type}`}
                part={child}
                containerId={containerId}
                partKey={`${partKey}/task-child-${index}`}
              />
            ))}
            {part.childTools.length === 0 ? (
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

/** Render a single message part based on its type */
function MessagePart({
  part,
  showTextCopy = true,
  truncateUserPrompt = false,
  renderJsonPayload = true,
  containerId,
  partKey,
}: {
  part: NativeMessagePart;
  showTextCopy?: boolean;
  truncateUserPrompt?: boolean;
  renderJsonPayload?: boolean;
  containerId?: string;
  /** Stable identity for this part's position, used to persist expansion state. */
  partKey: string;
}) {
  switch (part.type) {
    case "thinking":
      // Thinking parts are typically rendered directly in NativeMessage with isComplete
      // If rendered through MessagePart, assume complete (collapsed by default)
      return <ThinkingPart content={part.content} expansionKey={partKey} />;
    case "text":
      return (
        <TextPart
          content={part.content}
          showCopy={showTextCopy}
          truncateUserPrompt={truncateUserPrompt}
          renderJsonPayload={renderJsonPayload}
          expansionKey={`${partKey}/json`}
        />
      );
    case "tool-invocation":
      // Use specialized EditToolPart for edit/write tools
      if (isEditTool(part.toolName)) {
        return (
          <EditToolPart
            toolName={part.toolName}
            toolState={part.toolState}
            toolTitle={part.toolTitle}
            toolOutput={part.toolOutput}
            toolError={part.toolError}
            toolDiff={part.toolDiff}
          />
        );
      }
      // Use specialized TodoToolPart for TodoWrite tools
      if (isTodoTool(part.toolName)) {
        return (
          <TodoToolPart
            toolName={part.toolName}
            toolState={part.toolState}
            toolArgs={part.toolArgs}
            toolOutput={part.toolOutput}
            toolError={part.toolError}
            taskSnapshot={part.taskSnapshot}
          />
        );
      }
      // Use generic ToolPart for other tools
      return (
        <ToolPart
          toolName={part.toolName}
          toolState={part.toolState}
          toolTitle={part.toolTitle}
          toolArgs={part.toolArgs}
          toolOutput={part.toolOutput}
          toolError={part.toolError}
          backgroundTask={part.backgroundTask}
        />
      );
    case "tool-result":
      // Tool results are typically shown inline with tool invocations
      return null;
    case "file":
      return <FilePart path={part.content} fileUrl={part.fileUrl} containerId={containerId} />;
    case "subagent":
      return (
        <SubagentPart part={part} containerId={containerId} partKey={partKey} />
      );
    case "agent-group":
      return (
        <AgentGroupPart
          part={part}
          containerId={containerId}
          partKey={partKey}
        />
      );
    case "tool-group":
      return (
        <ToolGroupPart part={part} containerId={containerId} partKey={partKey} />
      );
    case "task-group":
      return (
        <TaskGroupPart part={part} containerId={containerId} partKey={partKey} />
      );
    default:
      return null;
  }
}

export const NativeMessage = memo(function NativeMessage({
  message,
  previousMessage = null,
  assistantLabel = "Assistant",
  containerId,
  agentExpansionScope,
  actions: messageActions,
  resolveModelLabel,
}: NativeMessageProps) {
  const normalizedMessage = useMemo(() => normalizeNativeMessage(message), [message]);
  const normalizedPreviousMessage = useMemo(
    () => previousMessage ? normalizeNativeMessage(previousMessage) : null,
    [previousMessage],
  );
  message = normalizedMessage;
  previousMessage = normalizedPreviousMessage;

  // A container id can legitimately appear after this row mounts (notably in
  // build-pipeline tabs) or change when a container is recreated. Freeze the
  // namespace at mount so such lifecycle updates do not silently collapse an
  // open disclosure. Production transcript owners pass their stable
  // environment/session identity; the initial container remains a safe fallback
  // for direct callers.
  const [stableAgentExpansionScope] = useState(
    () => agentExpansionScope ?? containerId ?? "host",
  );
  const messageAgentExpansionScope = JSON.stringify([
    stableAgentExpansionScope,
    message.id,
  ]);

  const isUser = message.role === "user";
  const isError = message.id.startsWith(ERROR_MESSAGE_PREFIX);
  const isSystem = message.role === "system" || message.id.startsWith(SYSTEM_MESSAGE_PREFIX);
  const isContinuation =
    !isUser &&
    !isSystem &&
    !isError &&
    previousMessage?.role === "assistant" &&
    !previousMessage.id.startsWith(ERROR_MESSAGE_PREFIX) &&
    isSameMinute(previousMessage.createdAt, message.createdAt);
  const confirmedModelId = message.modelId?.trim();
  const assistantAuthorLabel = confirmedModelId
    ? resolveModelLabel?.(confirmedModelId).trim() || confirmedModelId
    : assistantLabel;

  const hasTextParts = message.parts.some((part) => part.type === "text");
  const userCopyContent = isUser
    ? (
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.content)
          .join("\n\n")
          .trim() || message.content
      )
    : "";
  const assistantCopyContent = !isUser
    ? (
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.content)
          .join("\n\n")
          .trim() || message.content
      )
    : "";
  const handleUserLongPress = useCallback(async () => {
    if (!userCopyContent) return;

    try {
      await writeText(userCopyContent);
      toast.success("copied");
    } catch (error) {
      console.error("[NativeMessage] Failed to copy user prompt:", error);
      toast.error("Failed to copy message text");
    }
  }, [userCopyContent]);
  const durationLabel = useMemo(() => {
    if (isUser || isError || isSystem || previousMessage?.role !== "user") {
      return null;
    }

    return formatResponseDuration(previousMessage.createdAt, message.createdAt);
  }, [isUser, isError, isSystem, previousMessage, message.createdAt]);

  // Render error messages with special styling
  if (isError) {
    return (
      <MessageErrorAlert
        content={message.content}
        timestampLabel={formatTime(message.createdAt)}
      />
    );
  }

  // Render system messages with distinct info styling
  if (isSystem) {
    return (
      <div className="px-2 @sm:px-4 py-2">
        <div className="max-w-3xl mx-auto min-w-0">
          <div
            data-agent-chat-search-content="true"
            // Most system messages are one-line markers, for which
            // `whitespace-pre-line` changes nothing. Multi-paragraph ones — the
            // build pipeline's auto-decline record — would otherwise collapse
            // into a single centred run of text.
            className="text-xs text-muted-foreground italic text-center py-1 break-words whitespace-pre-line"
          >
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <AgentExpansionScopeContext.Provider value={messageAgentExpansionScope}>
      <MessageShell
        isUser={isUser}
        authorLabel={
          isUser
            ? "You"
            : assistantAuthorLabel
        }
        timestampLabel={formatTime(message.createdAt)}
        durationLabel={durationLabel}
        showHeader={!isContinuation}
        className={cn(!isUser && (isContinuation ? "pt-0 pb-3" : "py-3"))}
        onUserLongPress={isUser && userCopyContent ? handleUserLongPress : undefined}
        actions={(isUser ? userCopyContent : assistantCopyContent) || messageActions ? (
          <>
            {messageActions}
            {(isUser ? userCopyContent : assistantCopyContent) ? (
              <MessageCopyButton
                content={isUser ? userCopyContent : assistantCopyContent}
                wrapperClassName="mt-0 pr-0"
              />
            ) : null}
          </>
        ) : undefined}
      >
        {renderMessageParts(message, { showTextCopy: false, containerId })}

        {!hasTextParts && message.content && (
          <TextPart
            content={message.content}
            showCopy={false}
            truncateUserPrompt={isUser}
            renderJsonPayload={!isUser}
            expansionKey={`${message.id}-content/json`}
          />
        )}
      </MessageShell>
    </AgentExpansionScopeContext.Provider>
  );
});

function renderMessageParts(
  message: NativeMessageType,
  options: { showTextCopy?: boolean; containerId?: string } = {},
) {
  return message.parts.map((part, index) => (
      <MessagePart
        key={`${message.id}-part-${index}-${part.type}`}
        part={part}
        showTextCopy={options.showTextCopy ?? true}
        truncateUserPrompt={message.role === "user"}
        renderJsonPayload={message.role !== "user"}
        containerId={options.containerId}
        partKey={`${message.id}-part-${index}`}
      />
  ));
}

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatResponseDuration(startIso: string, endIso: string): string | null {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  const seconds = Math.max(1, Math.round((end - start) / 1000));
  return `responded in ${formatElapsed(seconds)}`;
}

function isSameMinute(a: string, b: string): boolean {
  try {
    const first = new Date(a);
    const second = new Date(b);

    if (Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) {
      return false;
    }

    return (
      first.getFullYear() === second.getFullYear() &&
      first.getMonth() === second.getMonth() &&
      first.getDate() === second.getDate() &&
      first.getHours() === second.getHours() &&
      first.getMinutes() === second.getMinutes()
    );
  } catch {
    return false;
  }
}
