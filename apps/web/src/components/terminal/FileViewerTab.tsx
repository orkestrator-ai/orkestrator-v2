import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import * as backend from "@/lib/backend";
import { Loader2, AlertCircle, FileCode, Image as ImageIcon } from "lucide-react";
import { useConfigStore, useFileDirtyStore } from "@/stores";
import { DEFAULT_TERMINAL_APPEARANCE } from "@/constants/terminal";
import { useFileSave } from "@/hooks/useFileSave";
import { MarkdownEditorTab } from "@/components/markdown/MarkdownEditorTab";
import { DiffViewerTab } from "./DiffViewerTab";
import { MonacoFileEditor } from "./MonacoFileEditor";
import type { GitFileStatus } from "@/types/paneLayout";

/** Image file extensions that should be rendered as images */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/** Get the file extension from a path */
function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filePath.slice(lastDot + 1).toLowerCase();
}

/** Check if a file is an image based on extension */
function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(getFileExtension(filePath));
}

/** Check if a file should use the rich Markdown editor. */
export function isMarkdownFile(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(getFileExtension(filePath));
}

export type FileViewerKind = "diff" | "image" | "markdown" | "text";

export function getFileViewerKind(
  filePath: string,
  options: { showDiff: boolean; hasDiffData: boolean },
): FileViewerKind {
  const isImage = isImageFile(filePath);
  if (options.showDiff && options.hasDiffData && !isImage) return "diff";
  if (isImage) return "image";
  if (isMarkdownFile(filePath)) return "markdown";
  return "text";
}

/** Get the MIME type for an image extension, or undefined if not a known image type */
function getImageMimeType(filePath: string): string | undefined {
  const ext = getFileExtension(filePath);
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    bmp: "image/bmp",
  };
  return mimeMap[ext];
}

interface FileViewerTabProps {
  tabId: string;
  filePath: string;
  /** Container ID (for containerized environments) */
  containerId?: string;
  /** Worktree path (for local environments) */
  worktreePath?: string;
  /** Whether this is a local environment */
  isLocalEnvironment?: boolean;
  isActive: boolean;
  language?: string;
  // Diff-related props
  isDiff?: boolean;
  gitStatus?: GitFileStatus;
  baseBranch?: string;
}

export function FileViewerTab({
  tabId,
  filePath,
  containerId,
  worktreePath,
  isLocalEnvironment = false,
  isActive,
  language,
  isDiff,
  gitStatus,
  baseBranch,
}: FileViewerTabProps) {
  // ALL HOOKS MUST BE CALLED BEFORE ANY CONDITIONAL RETURNS
  // This is required by React's rules of hooks

  // Get terminal appearance settings from config
  const terminalAppearance = useConfigStore(
    (state) => state.config.global.terminalAppearance
  ) || DEFAULT_TERMINAL_APPEARANCE;

  // Internal state to allow switching between diff and file view
  const [showDiff, setShowDiff] = useState(isDiff ?? false);

  // File content state
  const [content, setContent] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [detectedLanguage, setDetectedLanguage] = useState<string>(
    language || "plaintext"
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Dirty file tracking
  const setOriginalContent = useFileDirtyStore((state) => state.setOriginalContent);
  const setDirtyContent = useFileDirtyStore((state) => state.setContent);
  const clearDirty = useFileDirtyStore((state) => state.clearDirty);
  const dirtyContent = useFileDirtyStore(
    (state) => state.dirtyFiles.get(tabId)?.content,
  );

  const isImage = isImageFile(filePath);
  const isMarkdown = isMarkdownFile(filePath);
  const viewerKind = getFileViewerKind(filePath, {
    showDiff,
    hasDiffData: Boolean(gitStatus && baseBranch),
  });
  const { saveFile, isSaving } = useFileSave({
    tabId,
    filePath,
    containerId,
    worktreePath,
    isLocalEnvironment,
  });

  // Clean up dirty state when tab is unmounted
  useEffect(() => {
    return () => {
      clearDirty(tabId);
    };
  }, [tabId, clearDirty]);

  // Reset showDiff when isDiff prop changes (e.g., when switching tabs)
  useEffect(() => {
    setShowDiff(isDiff ?? false);
  }, [isDiff]);

  // Fetch file content (runs even if showing diff, to have content ready when switching)
  useEffect(() => {
    // Skip loading if we're showing diff view (but not for images, which bypass the diff viewer)
    if (showDiff && !isImage) {
      return;
    }

    let cancelled = false;

    async function loadFile() {
      setIsLoading(true);
      setError(null);
      setContent(null);
      setImageDataUrl(null);

      try {
        if (isImage) {
          // Load image as base64
          const mimeType = getImageMimeType(filePath);
          if (!mimeType) {
            throw new Error(`Unsupported image format: ${getFileExtension(filePath)}`);
          }
          let base64Content: string;
          if (isLocalEnvironment && worktreePath) {
            // Build full path for local filesystem read
            const fullPath = filePath.startsWith("/")
              ? filePath
              : `${worktreePath}/${filePath}`;
            base64Content = await backend.readFileBase64(fullPath);
          } else if (containerId) {
            base64Content = await backend.readContainerFileBase64(containerId, filePath);
          } else {
            throw new Error("No container ID or worktree path available for image viewing");
          }
          if (!cancelled) {
            setImageDataUrl(`data:${mimeType};base64,${base64Content}`);
          }
        } else {
          // Load text file - use appropriate command based on environment type
          let fileContent: backend.FileContent;
          if (isLocalEnvironment && worktreePath) {
            fileContent = await backend.readLocalFile(worktreePath, filePath);
          } else if (containerId) {
            fileContent = await backend.readContainerFile(containerId, filePath);
          } else {
            throw new Error("No container ID or worktree path available");
          }
          if (!cancelled) {
            setContent(fileContent.content);
            setDetectedLanguage(fileContent.language || language || "plaintext");
            // Set original content for dirty tracking
            setOriginalContent(tabId, fileContent.content);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadFile();
    return () => {
      cancelled = true;
    };
  // Note: isImage is derived from filePath, so it doesn't need to be in the dependency array
  }, [containerId, worktreePath, isLocalEnvironment, filePath, language, showDiff, tabId, setOriginalContent]);

  // If in diff mode and we have the required data, render DiffViewerTab
  // Image files can't be diffed in Monaco, so they fall through to the image preview
  if (viewerKind === "diff" && gitStatus && baseBranch) {
    return (
      <DiffViewerTab
        filePath={filePath}
        containerId={containerId}
        worktreePath={worktreePath}
        isLocalEnvironment={isLocalEnvironment}
        baseBranch={baseBranch}
        gitStatus={gitStatus}
        isActive={isActive}
        language={language}
        onSwitchToFileView={() => setShowDiff(false)}
      />
    );
  }

  if (isLoading) {
    return (
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center",
          !isActive && "pointer-events-none opacity-0"
        )}
        style={{ backgroundColor: terminalAppearance.backgroundColor }}
      >
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="text-sm">Loading file...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center",
          !isActive && "pointer-events-none opacity-0"
        )}
        style={{ backgroundColor: terminalAppearance.backgroundColor }}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-sm text-red-400">Failed to load file</p>
          <p className="max-w-md text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (isMarkdown && content !== null) {
    return (
      <MarkdownEditorTab
        tabId={tabId}
        filePath={filePath}
        initialContent={content}
        language={detectedLanguage}
        isActive={isActive}
        isSaving={isSaving}
        onSave={saveFile}
      />
    );
  }

  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col",
        !isActive && "pointer-events-none opacity-0"
      )}
      style={{ backgroundColor: terminalAppearance.backgroundColor }}
    >
      {/* File path header - shows which file is being viewed */}
      <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2 text-xs text-muted-foreground">
        {isImage ? <ImageIcon className="h-3 w-3" /> : <FileCode className="h-3 w-3" />}
        <span className="font-mono truncate">{filePath}</span>
        {isSaving && (
          <span className="ml-auto flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving...
          </span>
        )}
      </div>

      {/* Image Viewer for image files */}
      {isImage && imageDataUrl && (
        <div className="min-h-0 flex-1 flex items-center justify-center overflow-auto p-4">
          <img
            src={imageDataUrl}
            alt={filePath}
            className="max-w-full max-h-full object-contain"
            style={{
              imageRendering: "auto",
            }}
          />
        </div>
      )}

      {/* Monaco Editor for text files */}
      {!isImage && (
        <div className="min-h-0 flex-1">
          <MonacoFileEditor
            language={detectedLanguage}
            value={dirtyContent ?? content ?? ""}
            onChange={(nextContent) => setDirtyContent(tabId, nextContent)}
            onSave={saveFile}
          />
        </div>
      )}
    </div>
  );
}
