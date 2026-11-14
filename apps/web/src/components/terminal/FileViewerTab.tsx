import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import * as backend from "@/lib/backend";
import { backendForScope } from "@/lib/backend/scope-backend";
import { Loader2, AlertCircle, FileCode, Image as ImageIcon } from "lucide-react";
import { useConfigStore, useFileDirtyStore } from "@/stores";
import { fileDirtyStore, fileSaveBaseline } from "@/stores/fileDirtyStore";
import { useNodeScope } from "@/lib/node-scope/providers";
import { DEFAULT_TERMINAL_APPEARANCE } from "@/constants/terminal";
import { useFileSave } from "@/hooks/useFileSave";
import { useChangeContentGeneration, useChangeProjection } from "@/hooks/useChangeProjection";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";
import {
  discardFileDraft,
  getFileDraftRevisionState,
  loadFileDraft,
  persistFileDraft,
  resolveFileDraftDiscardConflict,
  resolveFileDraftSaveConflict,
} from "@/lib/file-draft-persistence";
import { DraftRevisionConflictError } from "@/lib/draft-conflict";
import { loadEnvironmentImage } from "@/lib/environment-image-source";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import {
  LazyLoadBoundary,
  LazyLoadInlineErrorFallback,
  type LazyLoadErrorDetails,
} from "@/components/LazyLoadBoundary";

const log = createLogger("web.files");

const LazyMarkdownEditorTab = lazy(async () => ({
  default: (await import("@/components/markdown/MarkdownEditorTab")).MarkdownEditorTab,
}));

const LazyHtmlFileTab = lazy(async () => ({
  default: (await import("@/components/html/HtmlFileTab")).HtmlFileTab,
}));

const LazyDiffViewerTab = lazy(async () => ({
  default: (await import("./DiffViewerTab")).DiffViewerTab,
}));

const LazyMonacoFileEditor = lazy(async () => ({
  default: (await import("./MonacoFileEditor")).MonacoFileEditor,
}));

/** Image file extensions that should be rendered as images */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "ico",
  "bmp",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

const HTML_EXTENSIONS = new Set(["html", "htm"]);

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

/** Check if a file opens on a rendered preview of its markup. */
export function isHtmlFile(filePath: string): boolean {
  return HTML_EXTENSIONS.has(getFileExtension(filePath));
}

export type FileViewerKind = "diff" | "image" | "markdown" | "html" | "text";

export function getFileViewerKind(
  filePath: string,
  options: { showDiff: boolean; hasDiffData: boolean },
): FileViewerKind {
  // A diff target names backend hunks (binary files included). The diff route
  // may explicitly preview a live image, but never reads a historical file.
  if (options.showDiff && options.hasDiffData) return "diff";
  if (isImageFile(filePath)) return "image";
  if (isMarkdownFile(filePath)) return "markdown";
  if (isHtmlFile(filePath)) return "html";
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
    avif: "image/avif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    bmp: "image/bmp",
  };
  return mimeMap[ext];
}

interface FileViewerTabProps {
  tabId: string;
  /** Owning environment; required by production callers for draft recovery. */
  environmentId?: string;
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
  navigationRequestId?: number;
  /** Container ID (for containerized environments) */
  containerId?: string;
  /** Worktree path (for local environments) */
  worktreePath?: string;
  /** Whether this is a local environment */
  isLocalEnvironment?: boolean;
  isActive: boolean;
  language?: string;
  /** Backend change-diff target; when set the tab opens on its diff view. */
  changeDiff?: ChangeDiffTarget;
}

type LiveImageState =
  | { key: string; kind: "image"; url: string; request: number; signal: AbortSignal }
  | { key: string; kind: "failed" };

/** Keep subscribing after fallback so a replaced or restored image can recover. */
function LiveImageDiffPreview({
  target,
  filePath,
  environmentId,
  containerId,
  worktreePath,
  isLocalEnvironment,
  isActive,
  backgroundColor,
  loadingFallback,
  diffFallback,
}: Pick<
  FileViewerTabProps,
  "filePath" | "environmentId" | "containerId" | "worktreePath" | "isLocalEnvironment" | "isActive"
> & {
  target: Extract<ChangeDiffTarget, { kind: "live" }>;
  backgroundColor: string;
  loadingFallback: ReactNode;
  diffFallback: ReactNode;
}) {
  const projection = useChangeProjection(target.resourceKey);
  const contentGeneration = useChangeContentGeneration(target.resourceKey);
  const transportRevision = useChangeProjectionStore((state) => state.transportRevision);
  // Path-only targets cannot filter opaque path ids safely. Refresh on every
  // content generation for this resource, including when counts stay the same.
  const key = JSON.stringify([
    target.resourceKey,
    target.pathId,
    target.path,
    target.rowId,
    target.revision,
    filePath,
    environmentId,
    containerId,
    worktreePath,
    isLocalEnvironment,
    contentGeneration?.generation,
    contentGeneration?.ownerGeneration ?? projection?.ownerGeneration,
    transportRevision,
  ]);
  const [image, setImage] = useState<LiveImageState | null>(null);
  // The environment's node: the image is read there (plan item 4007).
  const imageScope = useNodeScope();
  const requestRef = useRef(0);

  useEffect(() => {
    if (!isActive) return;
    const request = ++requestRef.current;
    const controller = new AbortController();
    let release: (() => void) | null = null;
    void (async () => {
      try {
        const mimeType = getImageMimeType(filePath);
        if (!mimeType) throw new Error("Unsupported image format");
        const loaded = await loadEnvironmentImage(
          {
            environmentId,
            containerId,
            isLocalEnvironment,
            worktreePath,
            filePath,
            mimeType,
          },
          controller.signal,
          imageScope,
        );
        if (controller.signal.aborted) {
          loaded.release();
          return;
        }
        release = loaded.release;
        setImage({
          key,
          kind: "image",
          url: loaded.url,
          request,
          signal: controller.signal,
        });
      } catch {
        if (!controller.signal.aborted) setImage({ key, kind: "failed" });
      }
    })();
    return () => {
      // Fence decode errors from the old DOM node as well as pending reads.
      controller.abort();
      release?.();
    };
  }, [
    key,
    isActive,
    filePath,
    environmentId,
    containerId,
    worktreePath,
    isLocalEnvironment,
    imageScope,
  ]);

  if (image?.key !== key) return loadingFallback;
  if (image.kind === "failed") return diffFallback;
  return (
    <div
      className={cn("absolute inset-0 flex flex-col", !isActive && "pointer-events-none opacity-0")}
      style={{ backgroundColor }}
    >
      <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2 text-xs text-muted-foreground">
        <ImageIcon className="h-3 w-3" />
        <span className="font-mono truncate">{filePath}</span>
      </div>
      <div className="min-h-0 flex-1 flex items-center justify-center overflow-auto p-4">
        <img
          key={image.request}
          src={image.url}
          alt={filePath}
          className="max-w-full max-h-full object-contain"
          onError={() => {
            if (!image.signal.aborted) setImage({ key, kind: "failed" });
          }}
        />
      </div>
    </div>
  );
}

export function FileViewerTab({
  tabId,
  environmentId,
  filePath,
  lineNumber,
  columnNumber,
  navigationRequestId,
  containerId,
  worktreePath,
  isLocalEnvironment = false,
  isActive,
  language,
  changeDiff,
}: FileViewerTabProps) {
  // ALL HOOKS MUST BE CALLED BEFORE ANY CONDITIONAL RETURNS
  // This is required by React's rules of hooks

  // Get terminal appearance settings from config
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ||
    DEFAULT_TERMINAL_APPEARANCE;

  // Internal state to allow switching between diff and file view
  const hasDiffTarget = Boolean(changeDiff);
  const [showDiff, setShowDiff] = useState(hasDiffTarget);
  // Reset showDiff when the tab gains or loses a diff target (adjusting state
  // during render, so the file view never loads for a frame first).
  const [diffTargetSeen, setDiffTargetSeen] = useState(hasDiffTarget);
  if (diffTargetSeen !== hasDiffTarget) {
    setDiffTargetSeen(hasDiffTarget);
    setShowDiff(hasDiffTarget);
  }

  // SVG can have textual hunks, so keep its source diff accessible by default.
  // Historical targets always render their recorded diff, never today's image.
  const isImage = isImageFile(filePath);
  const prefersImagePreview = isImage && getFileExtension(filePath) !== "svg";

  // File content state
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [detectedLanguage, setDetectedLanguage] = useState<string>(language || "plaintext");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const draftFlushContextRef = useRef<{
    environmentId: string;
    filePath: string;
    tabId: string;
    draftHydrated: boolean;
  } | null>(null);
  const lastDraftFlushRef = useRef<string | null>(null);
  // Dirty file tracking, and the node the buffer's drafts are kept on.
  const draftScope = useNodeScope();
  const setOriginalContent = useFileDirtyStore((state) => state.setOriginalContent);
  const setDirtyContent = useFileDirtyStore((state) => state.setContent);
  const observeDiskContent = useFileDirtyStore((state) => state.observeDiskContent);
  const hydrateDraft = useFileDirtyStore((state) => state.hydrateDraft);
  const dirtyEntry = useFileDirtyStore((state) => state.dirtyFiles.get(tabId));
  const dirtyContent = useFileDirtyStore((state) => state.dirtyFiles.get(tabId)?.content);

  // An HTML page's own stylesheets are read through the same file reads as the
  // editor, which keep to the workspace and refuse symlinked folders. Stable, so
  // the page does not read them again on every render.
  const readSiblingFile = useMemo(() => {
    if (isLocalEnvironment && worktreePath) {
      return async (path: string) =>
        (await backendForScope(draftScope).readLocalFile(worktreePath, path)).content;
    }
    if (containerId) {
      return async (path: string) =>
        (await backendForScope(draftScope).readContainerFile(containerId, path)).content;
    }
    return undefined;
  }, [draftScope, isLocalEnvironment, worktreePath, containerId]);

  const isMarkdown = isMarkdownFile(filePath);
  const isHtml = isHtmlFile(filePath);
  const viewerKind = getFileViewerKind(filePath, {
    showDiff,
    hasDiffData: hasDiffTarget,
  });
  // Bumped to re-read the file after the user chose to drop their edits.
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const reloadFromDisk = useCallback(() => {
    void (async () => {
      // Discard the persisted draft first, or the reload would restore it.
      if (environmentId) {
        await discardFileDraft(
          environmentId,
          filePath,
          getFileDraftRevisionState(tabId, draftScope),
          draftScope,
        ).catch((draftError: unknown) => {
          log.warn("draft.discard-failed", { tabId, error: formatLogError(draftError) });
        });
      }
      lastDraftFlushRef.current = null;
      draftScope.store(fileDirtyStore).getState().clearDirty(tabId);
      setReloadGeneration((generation) => generation + 1);
    })();
  }, [draftScope, environmentId, filePath, tabId]);
  const { saveFile, isSaving } = useFileSave({
    tabId,
    filePath,
    containerId,
    worktreePath,
    isLocalEnvironment,
    onReloadFromDisk: reloadFromDisk,
  });

  const reportFileDraftError = useCallback(
    function reportFileDraftError(
      draftError: unknown,
      context: {
        environmentId: string;
        filePath: string;
        tabId: string;
      },
    ): void {
      if (!(draftError instanceof DraftRevisionConflictError)) {
        log.warn("draft.persist-failed", {
          tabId: context.tabId,
          error: formatLogError(draftError),
        });
        return;
      }
      const currentEntry = draftScope
        .store(fileDirtyStore)
        .getState()
        .dirtyFiles.get(context.tabId);
      const discarding = !currentEntry || currentEntry.content === currentEntry.originalContent;
      toast.error("File draft changed in another window", {
        id: `file-draft-conflict:${context.tabId}`,
        description: discarding
          ? "A newer saved draft was preserved. Discard it explicitly to finish clearing this editor."
          : "Your editor buffer is unchanged. Choose Save mine to replace the other saved draft.",
        action: {
          label: discarding ? "Discard saved draft" : "Save mine",
          onClick: () => {
            const entry = draftScope.store(fileDirtyStore).getState().dirtyFiles.get(context.tabId);
            const state = getFileDraftRevisionState(context.tabId, draftScope);
            const hasLocalEdit = Boolean(entry && entry.content !== entry.originalContent);
            const operation =
              entry && hasLocalEdit
                ? resolveFileDraftSaveConflict(
                    context.environmentId,
                    context.filePath,
                    entry.content,
                    fileSaveBaseline(entry),
                    state,
                    draftScope,
                  )
                : resolveFileDraftDiscardConflict(
                    context.environmentId,
                    context.filePath,
                    state,
                    draftScope,
                  );
            void operation.catch((retryError) => {
              reportFileDraftError(retryError, context);
            });
          },
        },
      });
    },
    [draftScope],
  );

  const flushFileDraft = useCallback(() => {
    const context = draftFlushContextRef.current;
    if (!context) return;
    const entry = draftScope.store(fileDirtyStore).getState().dirtyFiles.get(context.tabId);
    const hasLocalEdit = Boolean(entry && entry.content !== entry.originalContent);
    if (!context.draftHydrated && !hasLocalEdit) return;
    const fingerprint =
      hasLocalEdit && entry
        ? JSON.stringify([
            context.environmentId,
            context.filePath,
            entry.content,
            fileSaveBaseline(entry),
          ])
        : JSON.stringify([context.environmentId, context.filePath, "discard"]);
    if (lastDraftFlushRef.current === fingerprint) return;
    lastDraftFlushRef.current = fingerprint;
    const operation =
      entry && hasLocalEdit
        ? persistFileDraft(
            context.environmentId,
            context.filePath,
            entry.content,
            fileSaveBaseline(entry),
            getFileDraftRevisionState(context.tabId, draftScope),
            draftScope,
          )
        : discardFileDraft(
            context.environmentId,
            context.filePath,
            getFileDraftRevisionState(context.tabId, draftScope),
            draftScope,
          );
    void operation.catch((draftError) => {
      if (lastDraftFlushRef.current === fingerprint) {
        lastDraftFlushRef.current = null;
      }
      reportFileDraftError(draftError, context);
    });
  }, [draftScope, reportFileDraftError]);

  const renderEditorFallback = useCallback(
    (message: string) => (
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center",
          !isActive && "pointer-events-none opacity-0",
        )}
        style={{ backgroundColor: terminalAppearance.backgroundColor }}
      >
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="text-sm">{message}</p>
        </div>
      </div>
    ),
    [isActive, terminalAppearance.backgroundColor],
  );

  // This tab may be off screen while still mounted, so its editor chunks fail
  // into the tab's own box rather than over the whole application.
  const renderEditorError = useCallback(
    (details: LazyLoadErrorDetails) => (
      <LazyLoadInlineErrorFallback {...details} isVisible={isActive} />
    ),
    [isActive],
  );

  // An environment switch commonly unmounts this component while the tab and
  // its editor buffer are still real. Do not clear on unmount; explicit tab
  // closure owns discarding the buffer.

  // Fetch file content only for the file view; the diff view renders backend
  // hunks and never reads the current file.
  useEffect(() => {
    if (showDiff && hasDiffTarget) {
      return;
    }

    let cancelled = false;
    const imageController = new AbortController();
    let releaseImage: (() => void) | null = null;

    async function loadFile() {
      setIsLoading(true);
      setDraftHydrated(false);
      setError(null);
      setContent(null);
      setImageUrl(null);

      try {
        if (isImage) {
          // A stream capability when the content origin is reachable, else base64.
          const mimeType = getImageMimeType(filePath);
          if (!mimeType) {
            throw new Error(`Unsupported image format: ${getFileExtension(filePath)}`);
          }
          if (!(isLocalEnvironment && worktreePath) && !containerId) {
            throw new Error("No container ID or worktree path available for image viewing");
          }
          const loaded = await loadEnvironmentImage(
            {
              environmentId,
              containerId,
              isLocalEnvironment,
              worktreePath,
              filePath,
              mimeType,
            },
            imageController.signal,
            draftScope,
          );
          if (cancelled) {
            loaded.release();
          } else {
            releaseImage = loaded.release;
            setImageUrl(loaded.url);
          }
        } else {
          // Load text file - use appropriate command based on environment type
          let fileContent: backend.FileContent;
          if (isLocalEnvironment && worktreePath) {
            fileContent = await backendForScope(draftScope).readLocalFile(worktreePath, filePath);
          } else if (containerId) {
            fileContent = await backendForScope(draftScope).readContainerFile(
              containerId,
              filePath,
            );
          } else {
            throw new Error("No container ID or worktree path available");
          }
          if (!cancelled) {
            setContent(fileContent.content);
            setDetectedLanguage(fileContent.language || language || "plaintext");
            const liveEntry = draftScope.store(fileDirtyStore).getState().dirtyFiles.get(tabId);
            let draftReadSucceeded = !environmentId || Boolean(liveEntry);
            let persistedDraft: Awaited<ReturnType<typeof loadFileDraft>> = null;
            if (environmentId && !liveEntry) {
              try {
                persistedDraft = await loadFileDraft(
                  environmentId,
                  filePath,
                  getFileDraftRevisionState(tabId, draftScope),
                  draftScope,
                );
                draftReadSucceeded = true;
              } catch (draftError) {
                log.warn("draft.restore-failed", { tabId, error: formatLogError(draftError) });
              }
            }
            if (cancelled) return;
            if (liveEntry) {
              // Visibility changes may unmount the editor before its debounce
              // fires. Its in-memory buffer is newer than any backend snapshot.
              // The buffer's own baseline stays, so disk moving meanwhile is a
              // conflict at save rather than an overwrite.
              observeDiskContent(tabId, fileContent.content);
            } else if (
              persistedDraft &&
              persistedDraft.environmentId === environmentId &&
              persistedDraft.filePath === filePath
            ) {
              // Disk may have changed while the app was closed. Preserve the
              // user's buffer but compare it with the current disk content so
              // the editor never silently treats an externally changed file as
              // saved. A save still checks against what the draft was edited from.
              hydrateDraft(
                tabId,
                persistedDraft.content,
                fileContent.content,
                persistedDraft.originalContent,
              );
            } else {
              setOriginalContent(tabId, fileContent.content);
            }
            setDraftHydrated(draftReadSucceeded);
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadFile();
    return () => {
      cancelled = true;
      imageController.abort();
      releaseImage?.();
    };
  }, [
    containerId,
    worktreePath,
    isLocalEnvironment,
    filePath,
    isImage,
    language,
    showDiff,
    hasDiffTarget,
    tabId,
    environmentId,
    draftScope,
    hydrateDraft,
    observeDiskContent,
    setOriginalContent,
    reloadGeneration,
  ]);

  // Write through after a short debounce. The persistence helper serializes
  // save/delete operations per file, preventing an older in-flight save from
  // resurrecting a draft after the user saves or discards it.
  useEffect(() => {
    if (!environmentId || isImage || !dirtyEntry) {
      draftFlushContextRef.current = null;
      return;
    }
    const hasLocalEdit = dirtyEntry.content !== dirtyEntry.originalContent;
    if (!draftHydrated && !hasLocalEdit) {
      draftFlushContextRef.current = null;
      return;
    }
    draftFlushContextRef.current = {
      environmentId,
      filePath,
      tabId,
      draftHydrated,
    };
    const timer = setTimeout(flushFileDraft, 400);
    return () => clearTimeout(timer);
  }, [
    dirtyEntry,
    dirtyEntry?.content,
    dirtyEntry?.originalContent,
    draftHydrated,
    environmentId,
    filePath,
    flushFileDraft,
    isImage,
    tabId,
  ]);

  // A visibility switch can unmount the editor before its debounce expires,
  // and a page close may not leave time for another React render. Flush the
  // current store buffer directly in both cases.
  useEffect(() => {
    const handlePageHide = () => flushFileDraft();
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      flushFileDraft();
    };
  }, [environmentId, filePath, flushFileDraft]);

  // A diff tab renders the backend's hunks for its target. Only a live
  // (current workspace file) target offers switching to the editor.
  if (viewerKind === "diff" && changeDiff) {
    const diff = (
      <LazyLoadBoundary
        loadingFallback={renderEditorFallback("Loading diff viewer...")}
        renderError={renderEditorError}
      >
        <LazyDiffViewerTab
          target={changeDiff}
          filePath={filePath}
          isActive={isActive}
          onSwitchToFileView={() => setShowDiff(false)}
        />
      </LazyLoadBoundary>
    );
    if (prefersImagePreview && changeDiff.kind === "live") {
      return (
        <LiveImageDiffPreview
          target={changeDiff}
          filePath={filePath}
          environmentId={environmentId}
          containerId={containerId}
          worktreePath={worktreePath}
          isLocalEnvironment={isLocalEnvironment}
          isActive={isActive}
          backgroundColor={terminalAppearance.backgroundColor}
          loadingFallback={renderEditorFallback("Loading file...")}
          diffFallback={diff}
        />
      );
    }
    return diff;
  }

  if (isLoading) {
    return (
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center",
          !isActive && "pointer-events-none opacity-0",
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
          !isActive && "pointer-events-none opacity-0",
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
      <LazyLoadBoundary
        loadingFallback={renderEditorFallback("Loading Markdown editor...")}
        renderError={renderEditorError}
      >
        <LazyMarkdownEditorTab
          tabId={tabId}
          filePath={filePath}
          initialContent={content}
          language={detectedLanguage}
          lineNumber={lineNumber}
          columnNumber={columnNumber}
          navigationRequestId={navigationRequestId}
          isActive={isActive}
          isSaving={isSaving}
          onSave={saveFile}
        />
      </LazyLoadBoundary>
    );
  }

  if (isHtml && content !== null) {
    return (
      <LazyLoadBoundary
        loadingFallback={renderEditorFallback("Loading HTML view...")}
        renderError={renderEditorError}
      >
        <LazyHtmlFileTab
          tabId={tabId}
          filePath={filePath}
          initialContent={content}
          language={detectedLanguage}
          lineNumber={lineNumber}
          columnNumber={columnNumber}
          navigationRequestId={navigationRequestId}
          isActive={isActive}
          isSaving={isSaving}
          onSave={saveFile}
          readSiblingFile={readSiblingFile}
        />
      </LazyLoadBoundary>
    );
  }

  return (
    <div
      className={cn("absolute inset-0 flex flex-col", !isActive && "pointer-events-none opacity-0")}
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
      {isImage && imageUrl && (
        <div className="min-h-0 flex-1 flex items-center justify-center overflow-auto p-4">
          <img
            src={imageUrl}
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
          <LazyLoadBoundary
            loadingFallback={renderEditorFallback("Loading editor...")}
            renderError={renderEditorError}
          >
            <LazyMonacoFileEditor
              language={detectedLanguage}
              value={dirtyContent ?? content ?? ""}
              lineNumber={lineNumber}
              columnNumber={columnNumber}
              navigationRequestId={navigationRequestId}
              isActive={isActive}
              onChange={(nextContent) => setDirtyContent(tabId, nextContent)}
              onSave={saveFile}
            />
          </LazyLoadBoundary>
        </div>
      )}
    </div>
  );
}
