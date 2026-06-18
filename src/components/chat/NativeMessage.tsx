import {
  memo,
  useCallback,
  useState,
  useMemo,
  useEffect,
  type AnchorHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
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
import { openInBrowser, readContainerFileBase64, readFileBase64 } from "@/lib/tauri";
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
import { isEditTool } from "@/lib/tool-names";
import { isTodoTool } from "@/lib/todo-tool";
import { TodoToolPart } from "@/components/todo/TodoToolPart";
import { MessageErrorAlert, MessageShell } from "@/components/chat/MessageShell";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { MessageCopyButton } from "@/components/chat/MessageCopyButton";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  type NativeMessage as NativeMessageType,
  type NativeMessagePart,
  type NativeTaskGroupPart,
  type NativeToolGroupPart,
} from "@/lib/chat/native-message-types";
import { normalizeNativeMessage } from "@/lib/chat/native-message-adapters";

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

interface NativeMessageProps {
  message: NativeMessageType;
  previousMessage?: NativeMessageType | null;
  assistantLabel?: string;
  containerId?: string;
}

/** Render a thinking/reasoning part inline */
function ThinkingPart({ content }: { content: string }) {
  const hasTaskList = useMemo(
    () => TASK_LIST_SYNTAX_PATTERN.test(content),
    [content],
  );
  const [isOpen, setIsOpen] = useState(false);

  if (hasTaskList) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-1.5">
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
          <span className="font-medium shrink-0">thinking</span>
          {!isOpen && (
            <span className="font-mono text-muted-foreground/80 truncate min-w-0">
              task list
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 border-l border-border/40 pl-3">
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

  return (
    <div className="my-1 flex items-center gap-2 w-full text-xs text-muted-foreground py-1.5 px-2 rounded-md">
      <Brain className="w-3.5 h-3.5 shrink-0" />
      <span className="font-medium shrink-0">thinking</span>
      <span className="font-mono text-muted-foreground/80 truncate min-w-0">
        {content}
      </span>
    </div>
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
}: {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const stateColors = {
    success: "text-green-600",
    failure: "text-red-400",
    pending: "text-yellow-600 animate-pulse",
  };

  // Determine if there's content to show when expanded
  const hasExpandableContent =
    toolOutput || toolError || (toolArgs && Object.keys(toolArgs).length > 0);

  // Extract display info from toolArgs based on tool type
  const getDisplayInfo = (): string | null => {
    if (!toolArgs) return null;

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

  // Format the command input for shell-like display
  const formatInput = () => {
    if (!toolArgs) return null;
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
        <span className="font-medium">{toolName || "Unknown tool"}</span>
        {displayInfo && (
          <span className="font-mono text-muted-foreground/80 truncate flex-1 text-left">
            {displayInfo}
          </span>
        )}
        {toolTitle && !displayInfo && (
          <span className="text-muted-foreground/70 truncate flex-1 text-left">
            {toolTitle}
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

  const stateColors = {
    success: "text-green-600",
    failure: "text-red-400",
    pending: "text-yellow-600 animate-pulse",
  };

  // Get file path from diff metadata
  const filePath = toolDiff?.filePath;
  const fileName = filePath ? filePath.split("/").pop() : null;

  // Calculate diff stats
  const { additions, deletions } = useMemo(
    () => countDiffStats(toolOutput, toolDiff),
    [toolOutput, toolDiff],
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
  }, [toolOutput, toolDiff]);

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
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-1.5">
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
        <span className="font-medium">{toolName || "edit"}</span>
        {fileName && (
          <span className="font-mono text-muted-foreground/80 truncate flex-1 text-left">
            {fileName}
          </span>
        )}
        {toolTitle && !fileName && (
          <span className="text-muted-foreground/70 truncate flex-1 text-left">
            {toolTitle}
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

function isSafeContainerPath(path: string): boolean {
  if (!path || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    return false;
  }
  if (path.split(/[\\/]+/).some((segment) => segment === "..")) {
    return false;
  }
  return !path.startsWith("/") || path === "/workspace" || path.startsWith("/workspace/");
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

      const filePath = fileUrl?.startsWith("file://")
        ? parseLocalFilePathFromUrl(fileUrl)
        : path.startsWith("/")
          ? path
          : null;

      if (containerId && isSafeContainerPath(path)) {
        const base64 = await readContainerFileBase64(containerId, path);
        const mimeType = getMimeType(path);
        setImageSrc(`data:${mimeType};base64,${base64}`);
        setPreviewOpen(true);
        return;
      }

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
          "inline-flex items-center gap-1.5 text-xs my-1.5 py-1.5 px-2.5 rounded-md border transition-colors",
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

function shouldAddTextLeadIn(previousPart?: NativeMessagePart | null): boolean {
  return (
    previousPart?.type === "tool-invocation" ||
    previousPart?.type === "subagent" ||
    previousPart?.type === "tool-group" ||
    previousPart?.type === "task-group"
  );
}

function getPreviousRenderedPart(
  parts: NativeMessagePart[],
  index: number,
): NativeMessagePart | null {
  for (let i = index - 1; i >= 0; i--) {
    const part = parts[i];
    if (part && part.type !== "tool-result") {
      return part;
    }
  }
  return null;
}

/** Render a text content part with markdown support */
function TextPart({
  content,
  followsToolActivity = false,
  showCopy = true,
}: {
  content: string;
  followsToolActivity?: boolean;
  showCopy?: boolean;
}) {
  return (
    <div className={cn("group", followsToolActivity && "pt-2")}>
      <MessageMarkdown content={content} components={markdownComponents} />
      {showCopy ? (
        <MessageCopyButton
          content={content}
          wrapperClassName="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
        />
      ) : null}
    </div>
  );
}

function getSubagentStatusLabel(state: NativeMessagePart["toolState"]): string {
  switch (state) {
    case "success":
      return "Success";
    case "failure":
      return "Failed";
    default:
      return "Running";
  }
}

function getSubagentStatusClasses(state: NativeMessagePart["toolState"]): string {
  switch (state) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "failure":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    default:
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

function getSubagentPreview(part: NativeMessagePart): string {
  const actions = part.subagentActions ?? [];
  const latestAction = actions.at(-1);

  if (!latestAction) {
    return part.toolState === "pending" ? "Waiting for activity." : "No activity captured.";
  }

  if (latestAction.type === "text") {
    return latestAction.content;
  }

  const command =
    typeof latestAction.toolArgs?.command === "string"
      ? latestAction.toolArgs.command
      : null;
  if (command) {
    return command;
  }

  return latestAction.toolTitle || latestAction.toolName || latestAction.content;
}

function SubagentPart({ part }: { part: NativeMessagePart }) {
  const [isOpen, setIsOpen] = useState(false);
  const subagentActions = part.subagentActions ?? [];
  const toolCount = part.subagentActionCount ?? 0;
  const displayName = part.subagentName || part.subagentRole || part.content || "subagent";
  const displayLabel = part.subagentRole
    ? `${displayName} (${part.subagentRole})`
    : displayName;
  const statusLabel = getSubagentStatusLabel(part.toolState);
  const preview = useMemo(() => getSubagentPreview(part), [part]);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-1.5">
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
              <span className="truncate text-sm font-medium text-foreground">
                {displayLabel}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  getSubagentStatusClasses(part.toolState),
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
            <div>{toolCount} {toolCount === 1 ? "tool" : "tools"}</div>
            <div>{subagentActions.length} {subagentActions.length === 1 ? "update" : "updates"}</div>
          </div>
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-1">
        <div className="border-l border-border/40 pl-3">
          {part.subagentPrompt ? (
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
                previousPart={getPreviousRenderedPart(subagentActions, index)}
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

function ToolGroupPart({
  part,
  containerId,
}: {
  part: NativeToolGroupPart;
  containerId?: string;
}) {
  return (
    <div className="my-2 rounded-lg border border-zinc-700/70 bg-zinc-800/35 p-2">
      {part.parts.map((child, index) => (
        <MessagePart
          key={`tool-group-part-${index}-${child.type}`}
          part={child}
          previousPart={index > 0 ? part.parts[index - 1] : null}
          containerId={containerId}
        />
      ))}
    </div>
  );
}

function TaskGroupPart({
  part,
  containerId,
}: {
  part: NativeTaskGroupPart;
  containerId?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const taskName = part.task.toolTitle || part.task.toolName || "Task";
  const childCount = part.childTools.length;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-1.5">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <Layers className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{taskName}</span>
        <span className="truncate text-muted-foreground/70">
          {childCount === 0 ? "No child tools" : `${childCount} child tool${childCount === 1 ? "" : "s"}`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-1 border-l border-border/40 pl-3">
          <MessagePart
            part={part.task}
            previousPart={null}
            containerId={containerId}
          />
          {part.childTools.map((child, index) => (
            <MessagePart
              key={`task-child-${index}-${child.toolUseId ?? child.toolName ?? child.type}`}
              part={child}
              previousPart={index > 0 ? part.childTools[index - 1] : part.task}
              containerId={containerId}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Render a single message part based on its type */
function MessagePart({
  part,
  previousPart,
  showTextCopy = true,
  containerId,
}: {
  part: NativeMessagePart;
  previousPart?: NativeMessagePart | null;
  showTextCopy?: boolean;
  containerId?: string;
}) {
  switch (part.type) {
    case "thinking":
      // Thinking parts are typically rendered directly in NativeMessage with isComplete
      // If rendered through MessagePart, assume complete (collapsed by default)
      return <ThinkingPart content={part.content} />;
    case "text":
      return (
        <TextPart
          content={part.content}
          followsToolActivity={shouldAddTextLeadIn(previousPart)}
          showCopy={showTextCopy}
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
        />
      );
    case "tool-result":
      // Tool results are typically shown inline with tool invocations
      return null;
    case "file":
      return <FilePart path={part.content} fileUrl={part.fileUrl} containerId={containerId} />;
    case "subagent":
      return <SubagentPart part={part} />;
    case "tool-group":
      return <ToolGroupPart part={part} containerId={containerId} />;
    case "task-group":
      return <TaskGroupPart part={part} containerId={containerId} />;
    default:
      return null;
  }
}

export const NativeMessage = memo(function NativeMessage({
  message,
  previousMessage = null,
  assistantLabel = "Assistant",
  containerId,
}: NativeMessageProps) {
  const normalizedMessage = useMemo(() => normalizeNativeMessage(message), [message]);
  const normalizedPreviousMessage = useMemo(
    () => previousMessage ? normalizeNativeMessage(previousMessage) : null,
    [previousMessage],
  );
  message = normalizedMessage;
  previousMessage = normalizedPreviousMessage;

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
      authorLabel={isUser ? "You" : assistantLabel}
      timestampLabel={formatTime(message.createdAt)}
      durationLabel={durationLabel}
      showHeader={!isContinuation}
      className={cn(!isUser && (isContinuation ? "pt-0 pb-3" : "py-3"))}
      actions={
        (isUser ? userCopyContent : assistantCopyContent) ? (
          <MessageCopyButton
            content={isUser ? userCopyContent : assistantCopyContent}
            wrapperClassName="mt-0 pr-0"
          />
        ) : undefined
      }
    >
      {renderMessageParts(message, { showTextCopy: false, containerId })}

      {!hasTextParts && message.content && (
        <TextPart
          content={message.content}
          followsToolActivity={shouldAddTextLeadIn(
            getPreviousRenderedPart(message.parts, message.parts.length),
          )}
          showCopy={false}
        />
      )}
    </MessageShell>
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
        previousPart={getPreviousRenderedPart(message.parts, index)}
        showTextCopy={options.showTextCopy ?? true}
        containerId={options.containerId}
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
