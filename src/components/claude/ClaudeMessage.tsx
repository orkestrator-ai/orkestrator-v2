import { memo, useCallback, useState, useMemo, useEffect, type AnchorHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Brain, FileText, ChevronRight, Wrench, AlertCircle, Pencil, ExternalLink as ExternalLinkIcon, Layers, Image as ImageIcon, X, Plug, FileCode } from "lucide-react";
import { type Components } from "react-markdown";
import { cn } from "@/lib/utils";
import { openInBrowser, readContainerFileBase64, readFileBase64 } from "@/lib/tauri";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { useOptionalTerminalContext, useTerminalContext } from "@/contexts/TerminalContext";
import { useFilesPanelStore } from "@/stores";
import { ERROR_MESSAGE_PREFIX, type ClaudeMessage as ClaudeMessageType, type ClaudeMessagePart, type ToolDiffMetadata } from "@/lib/claude-client";
import { toast } from "sonner";
import { processPartsInOrder } from "@/lib/claude-task-utils";
import { isEditTool } from "@/lib/tool-names";
import { CLAUDE_AUTH_LOGIN_COMMAND, isClaudeAuthenticationError } from "@/lib/claude-auth";
import { TodoToolPart, TOOL_STATE_COLORS } from "@/components/todo/TodoToolPart";
import { isTodoTool } from "@/lib/todo-tool";
import { MessageErrorAlert, MessageShell } from "@/components/chat/MessageShell";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { MessageCopyButton } from "@/components/chat/MessageCopyButton";

/** Parsed attachment from XML tags */
interface ParsedAttachment {
  type: string;
  path: string;
  filename: string;
}

/** Parse a single attachment tag with flexible attribute ordering */
function parseAttachmentTag(tagContent: string): ParsedAttachment | null {
  // Extract attributes from the tag content regardless of order
  const typeMatch = tagContent.match(/type="([^"]*)"/);
  const pathMatch = tagContent.match(/path="([^"]*)"/);
  const filenameMatch = tagContent.match(/filename="([^"]*)"/);

  const type = typeMatch?.[1];
  const path = pathMatch?.[1];
  const filename = filenameMatch?.[1] || "";

  if (type && path) {
    return { type, path, filename };
  }
  return null;
}

/** Parse attached-files XML block from message content */
function parseAttachmentsFromContent(content: string): { cleanContent: string; attachments: ParsedAttachment[] } {
  const attachments: ParsedAttachment[] = [];

  // Match the entire <attached-files>...</attached-files> block
  const attachedFilesRegex = /<attached-files>\s*([\s\S]*?)\s*<\/attached-files>/g;
  let cleanContent = content;

  let match;
  while ((match = attachedFilesRegex.exec(content)) !== null) {
    const block = match[0];
    const innerContent = match[1] || "";

    // Parse individual attachment tags - flexible regex that captures all attributes
    const attachmentRegex = /<attachment\s+([^>]*)\s*\/>/g;
    let attachmentMatch;
    while ((attachmentMatch = attachmentRegex.exec(innerContent)) !== null) {
      const tagContent = attachmentMatch[1] || "";
      const parsed = parseAttachmentTag(tagContent);
      if (parsed) {
        attachments.push(parsed);
      }
    }

    // Remove the block from content
    cleanContent = cleanContent.replace(block, "").trim();
  }

  return { cleanContent, attachments };
}

/** Check if a href is a URL (vs a file path) */
function isUrl(href: string): boolean {
  return href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:");
}

/** Check if a link is a file mention (starts with @ in display text) */
function isFileMention(children: React.ReactNode): boolean {
  if (typeof children === "string") {
    return children.startsWith("@");
  }
  if (Array.isArray(children) && children.length > 0) {
    const first = children[0];
    return typeof first === "string" && first.startsWith("@");
  }
  return false;
}

/** Extract display text without @ prefix */
function getDisplayText(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string" && children.startsWith("@")) {
    return children.slice(1); // Remove @ prefix
  }
  if (Array.isArray(children) && children.length > 0) {
    const first = children[0];
    if (typeof first === "string" && first.startsWith("@")) {
      return [first.slice(1), ...children.slice(1)];
    }
  }
  return children;
}

/** Custom link component that handles both URLs and file paths */
function SmartLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { createFileTab } = useTerminalContext();
  const changes = useFilesPanelStore((state) => state.changes);

  const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement | HTMLSpanElement>) => {
    e.preventDefault();
    if (!href) return;

    if (isUrl(href)) {
      // External URL - open in browser
      openInBrowser(href).catch((err) => {
        console.error("[ClaudeMessage] Failed to open link:", err);
      });
    } else {
      // File path - open in file viewer
      if (createFileTab) {
        // Check if this file has changes (should open in diff mode)
        const fileChange = changes.find((c) => c.path === href);
        if (fileChange) {
          // Open in diff mode
          createFileTab(href, { isDiff: true, gitStatus: fileChange.status });
        } else {
          // Open in normal mode
          createFileTab(href);
        }
      } else {
        // Fallback: copy to clipboard if createFileTab not available
        navigator.clipboard.writeText(href).then(() => {
          toast.success("Copied file path", {
            description: href,
            duration: 2000,
          });
        }).catch((err) => {
          console.error("[ClaudeMessage] Failed to copy path:", err);
          toast.error("Failed to copy path");
        });
      }
    }
  }, [href, createFileTab, changes]);

  // Determine if this is a file mention based on the display text
  const isFile = href && !isUrl(href) && isFileMention(children);

  if (isFile) {
    // File mention - render with file styling (without @ prefix)
    const displayText = getDisplayText(children);
    return (
      <span
        onClick={handleClick}
        className="text-blue-500 hover:text-blue-400 cursor-pointer font-medium whitespace-nowrap"
        title={`Open file: ${href}`}
        {...props}
      >
        <FileCode className="w-3.5 h-3.5 inline align-text-bottom mr-0.5" />
        {displayText}
      </span>
    );
  }

  // Regular link (URL or other)
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

/** Markdown components config with smart link handling */
const markdownComponents: Components = {
  a: SmartLink,
};

interface ClaudeMessageProps {
  message: ClaudeMessageType;
  previousMessage?: ClaudeMessageType | null;
  /** Whether the session is still actively streaming (turn in progress) */
  isStreaming?: boolean;
  /** Container ID for Docker-backed sessions, used to preview attachments stored under /workspace. */
  containerId?: string;
}

const TOOL_ROW_CLASS =
  "flex h-9 w-full items-center gap-2 rounded-md px-3 text-xs leading-none text-muted-foreground transition-colors";
const TOOL_ROW_ICON_CLASS = "h-3.5 w-3.5 shrink-0";
const TOOL_ROW_CHEVRON_CLASS = "h-3 w-3 shrink-0 transition-transform";

/** Render a thinking/reasoning part */
function ThinkingPart({ content }: { content: string }) {
  const [isOpen, setIsOpen] = useState(false);

  // Get truncated preview of thinking content for collapsed state
  const thinkingPreview = useMemo(() => {
    if (!content) return "";
    // Strip markdown formatting and get first line/portion
    const cleaned = content
      .replace(/[#*_`~\[\]]/g, "")
      .replace(/\n+/g, " ")
      .trim();
    return cleaned;
  }, [content]);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mb-3">
      <CollapsibleTrigger
        className={cn(
          TOOL_ROW_CLASS,
          "bg-muted/30 hover:bg-muted/50 cursor-pointer",
        )}
      >
        <ChevronRight
          className={cn(
            TOOL_ROW_CHEVRON_CLASS,
            isOpen && "rotate-90"
          )}
        />
        <Brain className={TOOL_ROW_ICON_CLASS} />
        <span className="font-medium shrink-0 leading-none">Thinking</span>
        {!isOpen && thinkingPreview && (
          <span className="text-muted-foreground/60 truncate flex-1 text-left leading-none">
            {thinkingPreview}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 rounded-md bg-muted/20 p-3 border border-border/30">
          <MessageMarkdown
            content={content}
            components={markdownComponents}
            className="text-muted-foreground/80 prose-invert prose-p:my-1 prose-headings:my-2 prose-headings:text-muted-foreground prose-ul:my-1 prose-ol:my-1 prose-pre:my-1 prose-pre:p-2"
            enableBreaks={false}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Render a tool invocation part - expandable to show input/output */
function ToolPart({
  toolName,
  toolState,
  toolTitle,
  toolArgs,
  toolOutput,
  toolError,
  isMcpTool,
  mcpServerName,
}: {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  isMcpTool?: boolean;
  mcpServerName?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  // Determine if there's content to show when expanded
  const hasExpandableContent = toolOutput || toolError || (toolArgs && Object.keys(toolArgs).length > 0);

  // Extract display info from toolArgs based on tool type
  const getDisplayInfo = (): string | null => {
    if (!toolArgs) return null;

    // For Task tool - show description
    const description = toolArgs.description as string | undefined;
    if (description) {
      return description;
    }

    // For Bash tool - show command
    const command = toolArgs.command as string | undefined;
    if (command) {
      // Truncate long commands and remove newlines for display
      const cleanedCommand = command.replace(/\n/g, " ").trim();
      return cleanedCommand;
    }

    // For Read tool - show filename
    const filePath = toolArgs.file_path as string | undefined;
    if (filePath) {
      return filePath.split("/").pop() || null;
    }

    // For Glob tool - show pattern
    const pattern = toolArgs.pattern as string | undefined;
    if (pattern) {
      return pattern;
    }

    // For Grep tool - show search pattern
    const grepPattern = toolArgs.regex as string | undefined;
    if (grepPattern) {
      return grepPattern;
    }

    // For WebFetch tool - show hostname from URL
    const url = toolArgs.url as string | undefined;
    if (url) {
      try {
        const hostname = new URL(url).hostname;
        return hostname;
      } catch {
        return url;
      }
    }

    // For WebSearch tool - show search query
    const query = toolArgs.query as string | undefined;
    if (query) {
      return query;
    }

    return null;
  };

  const displayInfo = getDisplayInfo();

  // Detect Agent tool by name or by required args (prompt + description)
  const isAgentTool =
    toolName === "Agent" ||
    (toolArgs && typeof toolArgs.prompt === "string" && typeof toolArgs.description === "string");

  // Format the command input for shell-like display
  const formatInput = () => {
    if (!toolArgs) return null;
    // For Agent tools, don't format as JSON - we render prompt as markdown separately
    if (isAgentTool) return null;
    // For shell commands, show the command
    if (toolArgs.command && typeof toolArgs.command === "string") {
      return `$ ${toolArgs.command}`;
    }
    // For other tools, show a JSON representation of args
    return JSON.stringify(toolArgs, null, 2);
  };

  const formattedInput = formatInput();

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-1.5">
      <CollapsibleTrigger
        className={cn(
          TOOL_ROW_CLASS,
          isMcpTool ? "bg-violet-500/10 hover:bg-violet-500/20" : "bg-muted/50 hover:bg-muted/70",
          hasExpandableContent && "cursor-pointer",
          !hasExpandableContent && "cursor-default"
        )}
        disabled={!hasExpandableContent}
      >
        <ChevronRight
          className={cn(
            TOOL_ROW_CHEVRON_CLASS,
            isOpen && "rotate-90",
            !hasExpandableContent && "opacity-0"
          )}
        />
        {isMcpTool ? (
          <Plug className={cn(TOOL_ROW_ICON_CLASS, "text-violet-500")} />
        ) : (
          <Wrench className={TOOL_ROW_ICON_CLASS} />
        )}
        <span className={cn("font-medium leading-none", isMcpTool && "text-violet-400")}>{toolName || "Unknown tool"}</span>
        {isMcpTool && mcpServerName && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 shrink-0 leading-none" title={`MCP server: ${mcpServerName}`}>
            MCP
          </span>
        )}
        {displayInfo && (
          <span className="font-mono text-muted-foreground/80 truncate flex-1 text-left leading-none">
            {displayInfo}
          </span>
        )}
        {toolTitle && !displayInfo && (
          <span className="text-muted-foreground/70 truncate flex-1 text-left leading-none">
            {toolTitle}
          </span>
        )}
        {toolState && (
          <span className={cn("ml-auto shrink-0 leading-none", TOOL_STATE_COLORS[toolState] || "")}>
            {toolState === "pending" ? "running..." : toolState}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="rounded-md bg-muted/30 border border-border/50 overflow-hidden">
            {/* Agent tool prompt rendered as markdown */}
            {isAgentTool && !!toolArgs?.prompt && (
              <div className={cn(
                "px-3 py-2 border-b border-border/30",
                "prose prose-sm prose-invert max-w-none text-xs",
                "[&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_p]:text-xs [&_li]:text-xs",
                "[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_h1]:my-2 [&_h2]:my-1.5 [&_h3]:my-1",
              )}>
                <MessageMarkdown content={toolArgs.prompt as string} components={markdownComponents} />
              </div>
            )}

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
              <div className="px-3 py-2 bg-destructive/10">
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
function parseDiffLines(output: string): Array<{ type: "add" | "remove" | "context" | "header"; content: string }> {
  if (!output) return [];
  const lines = output.split("\n");
  return lines.map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
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
  after?: string
): Array<{ type: "add" | "remove" | "context" | "header"; content: string }> {
  const result: Array<{ type: "add" | "remove" | "context" | "header"; content: string }> = [];

  // If we have both before and after, show the diff
  if (before !== undefined && after !== undefined) {
    // Add removed lines
    const beforeLines = before.split("\n");
    for (const line of beforeLines) {
      result.push({ type: "remove", content: `-${line}` });
    }
    // Add added lines
    const afterLines = after.split("\n");
    for (const line of afterLines) {
      result.push({ type: "add", content: `+${line}` });
    }
  } else if (after !== undefined) {
    // Only additions (write/new content)
    const afterLines = after.split("\n");
    for (const line of afterLines) {
      result.push({ type: "add", content: `+${line}` });
    }
  } else if (before !== undefined) {
    // Only deletions
    const beforeLines = before.split("\n");
    for (const line of beforeLines) {
      result.push({ type: "remove", content: `-${line}` });
    }
  }

  return result;
}

/** Count additions and deletions from diff output or metadata */
function countDiffStats(output?: string, metadata?: ToolDiffMetadata): { additions: number; deletions: number } {
  // First try to use pre-calculated metadata if available
  if (metadata?.additions !== undefined || metadata?.deletions !== undefined) {
    return {
      additions: metadata.additions ?? 0,
      deletions: metadata.deletions ?? 0,
    };
  }

  // Try to calculate from before/after content
  if (metadata?.before !== undefined || metadata?.after !== undefined) {
    const beforeLines = metadata.before ? metadata.before.split("\n").length : 0;
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

  // Get file path from diff metadata
  const filePath = toolDiff?.filePath;
  const fileName = filePath ? filePath.split("/").pop() : null;

  // Calculate diff stats
  const { additions, deletions } = useMemo(
    () => countDiffStats(toolOutput, toolDiff),
    [toolOutput, toolDiff]
  );

  // Parse diff lines for display - try unified diff first, then output, then generate from before/after
  const diffLines = useMemo(() => {
    // First try the unified diff from metadata (most accurate)
    if (toolDiff?.diff) {
      const diffLines = parseDiffLines(toolDiff.diff);
      const hasActualDiffContent = diffLines.some(
        (line) => line.type === "add" || line.type === "remove"
      );
      if (hasActualDiffContent) {
        return diffLines;
      }
    }

    // Then try parsing from output (if it's in diff format)
    const outputLines = parseDiffLines(toolOutput || "");
    const hasActualDiffContent = outputLines.some(
      (line) => line.type === "add" || line.type === "remove"
    );
    if (hasActualDiffContent) {
      return outputLines;
    }

    // Finally generate from before/after content
    if (toolDiff?.before !== undefined || toolDiff?.after !== undefined) {
      return generateDiffFromBeforeAfter(toolDiff.before, toolDiff.after);
    }

    return [];
  }, [toolOutput, toolDiff]);

  // Determine if there's content to show when expanded
  const hasExpandableContent = toolOutput || toolError || diffLines.length > 0 || toolDiff?.diff || toolDiff?.before || toolDiff?.after;

  // Handle pop-out to open diff in new tab
  const handlePopOut = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (createFileTab && filePath) {
        createFileTab(filePath, { isDiff: true, gitStatus: "M" });
      }
    },
    [createFileTab, filePath]
  );

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-1.5">
      <CollapsibleTrigger
        className={cn(
          TOOL_ROW_CLASS,
          "bg-muted/50 hover:bg-muted/70",
          hasExpandableContent && "cursor-pointer",
          !hasExpandableContent && "cursor-default"
        )}
        disabled={!hasExpandableContent}
      >
        <ChevronRight
          className={cn(
            TOOL_ROW_CHEVRON_CLASS,
            isOpen && "rotate-90",
            !hasExpandableContent && "opacity-0"
          )}
        />
        <Pencil className={TOOL_ROW_ICON_CLASS} />
        <span className="font-medium leading-none">{toolName || "edit"}</span>
        {fileName && (
          <span className="font-mono text-muted-foreground/80 truncate flex-1 text-left leading-none">
            {fileName}
          </span>
        )}
        {toolTitle && !fileName && (
          <span className="text-muted-foreground/70 truncate flex-1 text-left leading-none">
            {toolTitle}
          </span>
        )}
        {/* Line count stats - shown after filename */}
        {(additions > 0 || deletions > 0) && (
          <span className="flex items-center gap-1 shrink-0 leading-none">
            {additions > 0 && (
              <span className="text-green-500 font-mono">+{additions}</span>
            )}
            {deletions > 0 && (
              <span className="text-red-500 font-mono">-{deletions}</span>
            )}
          </span>
        )}
        {toolState && (
          <span className={cn("ml-auto shrink-0 leading-none", TOOL_STATE_COLORS[toolState] || "")}>
            {toolState === "pending" ? "running..." : toolState}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="rounded-md bg-muted/30 border border-border/50 overflow-hidden">
            {/* Header with file path and pop-out button */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30 bg-muted/20">
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
                        line.type === "header" && "bg-blue-500/10 text-blue-400",
                        line.type === "context" && "text-foreground/60"
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
              <div className="px-3 py-2 bg-destructive/10">
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

/** Render a Task tool with collapsible child tools */
function TaskToolPart({
  toolName,
  toolState,
  toolArgs,
  toolOutput,
  toolError,
  childTools,
}: {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  childTools: ClaudeMessagePart[];
}) {
  const [isOpen, setIsOpen] = useState(false);

  // Get description from toolArgs
  const description = (toolArgs?.description as string) || "";

  // Count child tools
  const toolCount = childTools.length;

  // Determine if there's content to show when expanded
  const hasExpandableContent = toolCount > 0 || toolOutput || toolError;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-1.5">
      <CollapsibleTrigger
        className={cn(
          TOOL_ROW_CLASS,
          "bg-muted/50 hover:bg-muted/70",
          hasExpandableContent && "cursor-pointer",
          !hasExpandableContent && "cursor-default"
        )}
        disabled={!hasExpandableContent}
      >
        <ChevronRight
          className={cn(
            TOOL_ROW_CHEVRON_CLASS,
            isOpen && "rotate-90",
            !hasExpandableContent && "opacity-0"
          )}
        />
        <Layers className={TOOL_ROW_ICON_CLASS} />
        <span className="font-medium shrink-0 leading-none">{toolName || "Task"}</span>
        {description && (
          <span className="text-muted-foreground/80 truncate flex-1 text-left leading-none">
            {description}
          </span>
        )}
        {/* Tool count badge */}
        {toolCount > 0 && (
          <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 font-mono text-[10px] leading-none">
            {toolCount} tool{toolCount !== 1 ? "s" : ""}
          </span>
        )}
        {toolState && (
          <span className={cn("shrink-0 leading-none", TOOL_STATE_COLORS[toolState] || "")}>
            {toolState === "pending" ? "running..." : toolState}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="ml-4 pl-3 border-l-2 border-border/50 space-y-1">
            {/* Child tool invocations */}
            {childTools.map((part, i) => (
              <ChildToolPart key={`child-tool-${i}`} part={part} />
            ))}

            {/* Task output if no child tools */}
            {toolCount === 0 && toolOutput && (
              <div className="rounded-md bg-muted/30 border border-border/50 px-3 py-2">
                <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all">
                  {toolOutput}
                </pre>
              </div>
            )}

            {/* Error section */}
            {toolError && (
              <div className="rounded-md bg-destructive/10 px-3 py-2">
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

/** Render a child tool under a Task - simplified version */
function ChildToolPart({ part }: { part: ClaudeMessagePart }) {
  const [isOpen, setIsOpen] = useState(false);

  const toolName = part.toolName;
  const toolArgs = part.toolArgs;
  const toolState = part.toolState;
  const toolOutput = part.toolOutput;
  const toolError = part.toolError;
  const isMcpTool = part.isMcpTool;
  const mcpServerName = part.mcpServerName;

  // Get display info based on tool type
  const getDisplayInfo = (): string | null => {
    if (!toolArgs) return null;

    // Bash - show command
    const command = toolArgs.command as string | undefined;
    if (command) {
      return command.replace(/\n/g, " ").trim();
    }

    // Read - show filename
    const filePath = toolArgs.file_path as string | undefined;
    if (filePath) {
      return filePath.split("/").pop() || null;
    }

    // Glob - show pattern
    const pattern = toolArgs.pattern as string | undefined;
    if (pattern) return pattern;

    // Grep - show regex
    const regex = toolArgs.regex as string | undefined;
    if (regex) return regex;

    // WebFetch - show hostname
    const url = toolArgs.url as string | undefined;
    if (url) {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    }

    // WebSearch - show query
    const query = toolArgs.query as string | undefined;
    if (query) return query;

    return null;
  };

  const displayInfo = getDisplayInfo();
  const hasExpandableContent = toolOutput || toolError || (toolArgs && Object.keys(toolArgs).length > 0);

  // For Edit tools, use different icon
  const isEdit = toolName?.toLowerCase() === "edit" || toolName?.toLowerCase() === "write";
  // Use Plug icon for MCP tools
  const ToolIcon = isMcpTool ? Plug : (isEdit ? Pencil : Wrench);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-0.5">
      <CollapsibleTrigger
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded px-2 text-xs leading-none text-muted-foreground transition-colors",
          isMcpTool ? "bg-violet-500/10 hover:bg-violet-500/20" : "bg-muted/30 hover:bg-muted/50",
          hasExpandableContent && "cursor-pointer",
          !hasExpandableContent && "cursor-default"
        )}
        disabled={!hasExpandableContent}
      >
        <ChevronRight
          className={cn(
            "h-2.5 w-2.5 shrink-0 transition-transform",
            isOpen && "rotate-90",
            !hasExpandableContent && "opacity-0"
          )}
        />
        <ToolIcon className={cn("h-3 w-3 shrink-0", isMcpTool && "text-violet-500")} />
        <span className={cn("font-medium shrink-0 leading-none", isMcpTool && "text-violet-400")}>{toolName || "Unknown"}</span>
        {isMcpTool && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-violet-500/20 text-violet-400 shrink-0 leading-none" title={mcpServerName ? `MCP server: ${mcpServerName}` : "MCP tool"}>
            MCP
          </span>
        )}
        {displayInfo && (
          <span className="font-mono text-muted-foreground/70 truncate flex-1 text-left text-[11px] leading-none">
            {displayInfo}
          </span>
        )}
        {toolState && (
          <span className={cn("ml-auto shrink-0 leading-none", TOOL_STATE_COLORS[toolState] || "")}>
            {toolState === "pending" ? "..." : toolState}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-0.5">
          <div className="rounded bg-muted/20 border border-border/30 overflow-hidden ml-5">
            {/* Output */}
            {toolOutput && (
              <div className="px-2 py-1.5 max-h-48 overflow-auto">
                <pre className="text-[11px] font-mono text-foreground/70 whitespace-pre-wrap break-all">
                  {toolOutput}
                </pre>
              </div>
            )}
            {/* Error */}
            {toolError && (
              <div className="px-2 py-1.5 bg-destructive/10">
                <pre className="text-[11px] font-mono text-destructive whitespace-pre-wrap break-all">
                  {toolError}
                </pre>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/** Render a file attachment part */
function FilePart({ path }: { path: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground my-1.5 py-1 px-2 bg-muted/50 rounded">
      <FileText className="w-3 h-3" />
      <span className="font-mono truncate">{path}</span>
    </div>
  );
}

/** Image preview overlay - rendered via portal to avoid stacking context issues */
function ImagePreviewOverlay({
  imageSrc,
  filename,
  onClose,
}: {
  imageSrc: string;
  filename: string;
  onClose: () => void;
}) {
  // Memoize the keydown handler to ensure stable reference for cleanup
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  // Close on escape key
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Use portal to render at document.body level, avoiding overflow/stacking context issues
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div className="relative max-w-full max-h-full" onClick={(e) => e.stopPropagation()}>
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
    document.body
  );
}

/** Get MIME type from file path extension */
function getMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    tiff: 'image/tiff',
    tif: 'image/tiff',
  };
  return mimeTypes[ext || ''] || 'image/png';
}

function hasUnsafePathSegments(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .some((segment) => segment === "..");
}

function isPreviewableAttachmentPath(path: string, isContainerPath: boolean): boolean {
  if (!path || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    return false;
  }
  if (hasUnsafePathSegments(path)) {
    return false;
  }

  if (isContainerPath) {
    return !path.startsWith("/") || path === "/workspace" || path.startsWith("/workspace/");
  }

  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Clickable attachment thumbnail for user messages */
function AttachmentPart({
  attachment,
  containerId,
}: {
  attachment: ParsedAttachment;
  containerId?: string;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const isImage = attachment.type === "image";
  const canPreview = isImage && isPreviewableAttachmentPath(attachment.path, Boolean(containerId));
  const displayName = attachment.filename || attachment.path.split("/").pop() || "file";

  const handleClick = useCallback(async () => {
    if (!canPreview) return;

    // If already loaded, just open preview
    if (imageSrc) {
      setPreviewOpen(true);
      return;
    }

    // Try to load the image
    setLoading(true);
    setLoadError(false);
    try {
      const base64 = containerId
        ? await readContainerFileBase64(containerId, attachment.path)
        : await readFileBase64(attachment.path);
      const mimeType = getMimeType(attachment.path);
      const dataUrl = `data:${mimeType};base64,${base64}`;
      setImageSrc(dataUrl);
      setPreviewOpen(true);
    } catch (err) {
      console.error("[AttachmentPart] Failed to load image:", err, { path: attachment.path });
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [canPreview, imageSrc, attachment.path, containerId]);

  return (
    <>
      <button
        onClick={handleClick}
        disabled={!canPreview || loading}
        className={cn(
          "inline-flex items-center gap-1.5 text-xs py-1.5 px-2.5 rounded-md border transition-colors",
          canPreview
            ? "bg-muted/50 border-border hover:bg-muted hover:border-border/80 cursor-pointer"
            : "bg-muted/30 border-border/50 cursor-default",
          loading && "opacity-50"
        )}
      >
        {isImage ? (
          <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <FileText className="w-3.5 h-3.5 text-muted-foreground" />
        )}
        <span className="font-medium text-foreground/80 truncate max-w-[200px]">
          {displayName}
        </span>
        {loading && <span className="text-muted-foreground">(loading...)</span>}
        {loadError && <span className="text-destructive text-[10px]">(error)</span>}
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

/** Render attachments row for user messages */
function AttachmentsList({
  attachments,
  containerId,
}: {
  attachments: ParsedAttachment[];
  containerId?: string;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {attachments.map((att, i) => (
        <AttachmentPart key={`attachment-${i}`} attachment={att} containerId={containerId} />
      ))}
    </div>
  );
}

/** Render a text content part with markdown support */
function TextPart({ content }: { content: string }) {
  return (
    <div>
      <MessageMarkdown content={content} components={markdownComponents} />
      <MessageCopyButton content={content} />
    </div>
  );
}

// isEditTool imported from @/lib/tool-names




export const ClaudeMessage = memo(function ClaudeMessage({
  message,
  previousMessage = null,
  containerId,
}: ClaudeMessageProps) {
  const terminalContext = useOptionalTerminalContext();
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isError = message.id.startsWith(ERROR_MESSAGE_PREFIX);
  const isAuthError = isError && isClaudeAuthenticationError(message.content);
  const isContinuation =
    !isUser &&
    !isSystem &&
    !isError &&
    previousMessage?.role === "assistant" &&
    !previousMessage.id.startsWith(ERROR_MESSAGE_PREFIX) &&
    isSameMinute(previousMessage.timestamp, message.timestamp);

  // For user messages, parse out attachment XML tags
  const { cleanContent, attachments } = useMemo(() => {
    if (isUser && message.content) {
      return parseAttachmentsFromContent(message.content);
    }
    return { cleanContent: message.content, attachments: [] };
  }, [isUser, message.content]);

  // Process parts in order, grouping tools under Tasks
  const processedParts = useMemo(
    () => processPartsInOrder(message.parts),
    [message.parts]
  );

  // Render error messages with special styling
  if (isError) {
    const authLoginButton = isAuthError ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="border-destructive/30 bg-background/70 text-foreground hover:bg-background"
        disabled={!terminalContext?.createTab}
        onClick={() => terminalContext?.createTab?.("plain", { initialCommands: [CLAUDE_AUTH_LOGIN_COMMAND] })}
      >
        Run {CLAUDE_AUTH_LOGIN_COMMAND}
      </Button>
    ) : undefined;

    return (
      <MessageErrorAlert
        content={isAuthError ? "Claude is not authenticated. Run claude auth login to continue." : message.content}
        details={isAuthError ? message.content : undefined}
        action={authLoginButton}
        timestampLabel={formatTime(message.timestamp)}
      />
    );
  }

  // Render system messages with distinct info styling
  if (isSystem) {
    return (
      <div className="px-2 @sm:px-4 py-2">
        <div className="max-w-3xl mx-auto min-w-0">
          <div className="text-xs text-muted-foreground italic text-center py-1 break-words">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <MessageShell
      isUser={isUser}
      authorLabel={isUser ? "You" : "Claude"}
      timestampLabel={formatTime(message.timestamp)}
      showHeader={!isContinuation}
      className={cn(!isUser && isContinuation ? "pt-0 pb-3" : undefined)}
    >
      {isUser ? (
        <>
          {cleanContent && <TextPart content={cleanContent} />}
        </>
      ) : (
        <>
          {processedParts.map((processed, i) => {
            switch (processed.type) {
              case "thinking":
                return (
                  <ThinkingPart
                    key={`thinking-${i}`}
                    content={processed.part?.content || ""}
                  />
                );
              case "text":
                return <TextPart key={`text-${i}`} content={processed.part?.content || ""} />;
              case "file":
                return <FilePart key={`file-${i}`} path={processed.part?.content || ""} />;
              case "task-group":
                return (
                  <TaskToolPart
                    key={`task-${i}`}
                    toolName={processed.part?.toolName}
                    toolState={processed.part?.toolState}
                    toolArgs={processed.part?.toolArgs}
                    toolOutput={processed.part?.toolOutput}
                    toolError={processed.part?.toolError}
                    childTools={processed.childTools || []}
                  />
                );
              case "tool-group":
                if (isEditTool(processed.part?.toolName)) {
                  return (
                    <EditToolPart
                      key={`edit-${i}`}
                      toolName={processed.part?.toolName}
                      toolState={processed.part?.toolState}
                      toolTitle={processed.part?.toolTitle}
                      toolOutput={processed.part?.toolOutput}
                      toolError={processed.part?.toolError}
                      toolDiff={processed.part?.toolDiff}
                    />
                  );
                }
                if (isTodoTool(processed.part?.toolName)) {
                  return (
                    <TodoToolPart
                      key={`todo-${i}`}
                      toolName={processed.part?.toolName}
                      toolState={processed.part?.toolState}
                      toolArgs={processed.part?.toolArgs}
                      toolOutput={processed.part?.toolOutput}
                      toolError={processed.part?.toolError}
                    />
                  );
                }
                return (
                  <ToolPart
                    key={`tool-${i}`}
                    toolName={processed.part?.toolName}
                    toolState={processed.part?.toolState}
                    toolTitle={processed.part?.toolTitle}
                    toolArgs={processed.part?.toolArgs}
                    toolOutput={processed.part?.toolOutput}
                    toolError={processed.part?.toolError}
                    isMcpTool={processed.part?.isMcpTool}
                    mcpServerName={processed.part?.mcpServerName}
                  />
                );
              default:
                return null;
            }
          })}

          {processedParts.length === 0 && message.content && (
            <TextPart content={message.content} />
          )}
        </>
      )}

      {isUser && attachments.length > 0 && (
        <AttachmentsList attachments={attachments} containerId={containerId} />
      )}
    </MessageShell>
  );
});

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
