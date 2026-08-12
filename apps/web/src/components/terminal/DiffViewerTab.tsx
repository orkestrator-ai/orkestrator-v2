import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { DiffEditor, type BeforeMount } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { cn } from "@/lib/utils";
import * as backend from "@/lib/backend";
import {
  Loader2,
  AlertCircle,
  FileCode,
  FilePlus,
  FileX,
  Columns,
  AlignJustify,
  FileText,
} from "lucide-react";
import { useConfigStore } from "@/stores";
import { DEFAULT_TERMINAL_APPEARANCE } from "@/constants/terminal";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks";
import type { GitFileStatus } from "@/types/paneLayout";
import { ensureMonacoConfigured, isMonacoConfigured } from "@/lib/monaco-loader";

interface DiffViewerTabProps {
  filePath: string;
  /** Container ID (for containerized environments) */
  containerId?: string;
  /** Worktree path (for local environments) */
  worktreePath?: string;
  /** Whether this is a local environment */
  isLocalEnvironment?: boolean;
  baseBranch: string;
  gitStatus: GitFileStatus;
  isActive: boolean;
  language?: string;
  onSwitchToFileView?: () => void;
}

const diffBaseCache = new Map<string, Promise<backend.FileContent | null>>();
const MAX_DIFF_BASE_CACHE_ENTRIES = 128;

/** Clears module-level immutable bases so tests can assert cache boundaries. */
export function clearDiffBaseCacheForTests(): void {
  diffBaseCache.clear();
}

/**
 * Must stay in step with the backend's `isImmutableCommitRef`.
 *
 * The backend only short-circuits a fetch for a *full* object name; anything
 * else it resolves through `origin/<ref>`, which moves. A broader test here
 * would pin a moving branch in a module-level cache that nothing invalidates,
 * so a hex-looking branch name (`defaced`, `1234567`) would render against a
 * stale base for the life of the process.
 */
const IMMUTABLE_COMMIT_REF = /^[0-9a-f]{40}$/i;

function cachedImmutableDiffBase(
  key: string,
  comparisonRef: string,
  load: () => Promise<backend.FileContent | null>,
): Promise<backend.FileContent | null> {
  // Branches move; only commit-addressed bases are safe across tab remounts.
  if (!IMMUTABLE_COMMIT_REF.test(comparisonRef.trim())) return load();
  const existing = diffBaseCache.get(key);
  if (existing) return existing;
  const pending = load().catch((error) => {
    diffBaseCache.delete(key);
    throw error;
  });
  diffBaseCache.set(key, pending);
  while (diffBaseCache.size > MAX_DIFF_BASE_CACHE_ENTRIES) {
    const oldest = diffBaseCache.keys().next().value;
    if (oldest === undefined) break;
    diffBaseCache.delete(oldest);
  }
  return pending;
}

/** Exercises the cache directly without mounting a complete editor per entry. */
export function cacheImmutableDiffBaseForTests(
  key: string,
  comparisonRef: string,
  load: () => Promise<backend.FileContent | null>,
): Promise<backend.FileContent | null> {
  return cachedImmutableDiffBase(key, comparisonRef, load);
}

type DiffMode = "side-by-side" | "inline";

/** Viewports narrower than this get the touch-oriented single-column layout. */
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

/**
 * Cap for the configured terminal font size on a phone. A comfortable desktop size
 * fits too few characters per line to read code on a ~390px screen.
 */
const MOBILE_MAX_FONT_SIZE = 12;

/**
 * A 40-character object name eats the whole header on a phone (and most of it on
 * a desktop), so show the short form and keep the full ref in the tooltip.
 */
export function formatBaseRef(baseBranch: string): string {
  return /^[0-9a-f]{40}$/i.test(baseBranch) ? baseBranch.slice(0, 7) : baseBranch;
}

export function DiffViewerTab({
  filePath,
  containerId,
  worktreePath,
  isLocalEnvironment = false,
  baseBranch,
  gitStatus,
  isActive,
  language,
  onSwitchToFileView,
}: DiffViewerTabProps) {
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ||
    DEFAULT_TERMINAL_APPEARANCE;
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);

  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [modifiedContent, setModifiedContent] = useState<string | null>(null);
  const [detectedLanguage, setDetectedLanguage] = useState<string>(
    language || "plaintext"
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [diffMode, setDiffMode] = useState<DiffMode>("side-by-side");
  const [monacoReady, setMonacoReady] = useState(isMonacoConfigured);
  const [monacoFailed, setMonacoFailed] = useState(false);
  const [monacoAttempt, setMonacoAttempt] = useState(0);

  // Two columns of code cannot fit on a phone, so the mode toggle is hidden there
  // and the view is pinned to inline regardless of the remembered desktop mode.
  const effectiveDiffMode: DiffMode = isMobile ? "inline" : diffMode;

  // Track editor instance for proper cleanup
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  const editorOptions = useMemo<monaco.editor.IDiffEditorConstructionOptions>(() => {
    const shared = {
      readOnly: true,
      renderSideBySide: effectiveDiffMode === "side-by-side",
      fontFamily: `"${terminalAppearance.fontFamily}", "Fira Code", monospace`,
      automaticLayout: true,
      ignoreTrimWhitespace: false,
    };

    if (!isMobile) {
      return {
        ...shared,
        fontSize: terminalAppearance.fontSize,
        enableSplitViewResizing: true,
        useInlineViewWhenSpaceIsLimited: false,
      };
    }

    // Every pixel of width is code on a phone: no minimap, no ruler, no folding or
    // revert gutter, and wrapping instead of a horizontal scroll nobody can aim at.
    return {
      ...shared,
      fontSize: Math.min(terminalAppearance.fontSize, MOBILE_MAX_FONT_SIZE),
      enableSplitViewResizing: false,
      compactMode: true,
      wordWrap: "on",
      diffWordWrap: "on",
      minimap: { enabled: false },
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      glyphMargin: false,
      folding: false,
      // Just enough margin for the +/- indicators: colour alone should not be the
      // only thing distinguishing an addition from a deletion.
      lineDecorationsWidth: 12,
      lineNumbersMinChars: 2,
      scrollBeyondLastLine: false,
      // Long files are mostly untouched context; collapse it so the changes are
      // reachable without a lot of scrolling.
      hideUnchangedRegions: {
        enabled: true,
        contextLineCount: 2,
        minimumLineCount: 4,
        revealLineCount: 10,
      },
      scrollbar: {
        verticalScrollbarSize: 6,
        horizontalScrollbarSize: 6,
        useShadows: false,
      },
      padding: { top: 4, bottom: 24 },
    };
  }, [
    effectiveDiffMode,
    isMobile,
    terminalAppearance.fontFamily,
    terminalAppearance.fontSize,
  ]);

  // Disable linting/diagnostics before editor mounts
  const handleEditorWillMount: BeforeMount = useCallback((monacoInstance) => {
    // Disable TypeScript/JavaScript diagnostics
    monacoInstance.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    monacoInstance.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    // Disable JSON validation
    monacoInstance.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: false,
    });
  }, []);

  // Handle editor mount - capture the editor instance
  const handleEditorMount = useCallback((editor: monaco.editor.IStandaloneDiffEditor) => {
    editorRef.current = editor;
  }, []);

  // Cleanup effect - dispose editor before unmount to prevent errors
  useEffect(() => {
    return () => {
      if (editorRef.current) {
        try {
          // Dispose the editor instance before React unmounts the component
          editorRef.current.dispose();
        } catch {
          // Ignore disposal errors - the editor may already be disposed
        }
        editorRef.current = null;
      }
    };
  }, []);

  // Determine file state
  const isNewFile = gitStatus === "?" || gitStatus === "A";
  const isDeletedFile = gitStatus === "D";

  useEffect(() => {
    if (monacoReady) return;
    let cancelled = false;
    setMonacoFailed(false);
    void ensureMonacoConfigured().then(
      () => {
        if (!cancelled) setMonacoReady(true);
      },
      () => {
        if (!cancelled) setMonacoFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [monacoAttempt, monacoReady]);

  // Fetch both original and modified content
  useEffect(() => {
    let cancelled = false;

    async function loadDiffContent() {
      setIsLoading(true);
      setError(null);

      try {
        let nextDetectedLanguage = language || "plaintext";

        // Fetch current (modified) file content
        let modified: string | null = null;
        if (!isDeletedFile) {
          let modifiedResult: backend.FileContent;
          if (isLocalEnvironment && worktreePath) {
            modifiedResult = await backend.readLocalFile(worktreePath, filePath);
          } else if (containerId) {
            modifiedResult = await backend.readContainerFile(containerId, filePath);
          } else {
            throw new Error("No container ID or worktree path available");
          }
          if (cancelled) return;
          modified = modifiedResult.content;
          nextDetectedLanguage =
            modifiedResult.language || language || "plaintext";
        }

        // Fetch original file content from base branch
        let original: string | null = null;
        if (!isNewFile) {
          let originalResult: backend.FileContent | null;
          if (isLocalEnvironment && worktreePath) {
            originalResult = await cachedImmutableDiffBase(
              `local\0${worktreePath}\0${baseBranch}\0${filePath}`,
              baseBranch,
              () => backend.readLocalFileAtBranch(worktreePath, filePath, baseBranch),
            );
          } else if (containerId) {
            originalResult = await cachedImmutableDiffBase(
              `container\0${containerId}\0${baseBranch}\0${filePath}`,
              baseBranch,
              () => backend.readFileAtBranch(containerId, filePath, baseBranch),
            );
          } else {
            throw new Error("No container ID or worktree path available");
          }
          original = originalResult?.content ?? null;
          if (isDeletedFile) {
            nextDetectedLanguage =
              originalResult?.language || language || "plaintext";
          }
        }

        if (!cancelled) {
          setOriginalContent(original ?? "");
          setModifiedContent(modified ?? "");
          setDetectedLanguage(nextDetectedLanguage);
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

    loadDiffContent();
    return () => {
      cancelled = true;
    };
  }, [
    containerId,
    worktreePath,
    isLocalEnvironment,
    filePath,
    baseBranch,
    gitStatus,
    language,
    isNewFile,
    isDeletedFile,
  ]);

  if (monacoFailed) {
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
          <p className="text-sm text-red-400">Failed to load diff editor</p>
          <p className="max-w-md text-xs text-muted-foreground">
            The diff editor resources could not be loaded.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMonacoAttempt((attempt) => attempt + 1)}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading || !monacoReady) {
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
          <p className="text-sm">Loading diff...</p>
        </div>
      </div>
    );
  }

  // Error state
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
          <p className="text-sm text-red-400">Failed to load diff</p>
          <p className="max-w-md text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  // Deleted file - show diff with original content vs empty
  // This properly visualizes what was removed
  if (isDeletedFile) {
    return (
      <div
        className={cn(
          "absolute inset-0 flex flex-col",
          !isActive && "pointer-events-none opacity-0"
        )}
        style={{ backgroundColor: terminalAppearance.backgroundColor }}
      >
        <DiffHeader
          filePath={filePath}
          baseBranch={baseBranch}
          diffMode={diffMode}
          onDiffModeChange={setDiffMode}
          isMobile={isMobile}
          // Don't show "View file" button for deleted files - the file doesn't exist
          onSwitchToFileView={undefined}
          statusIcon={<FileX className="h-3 w-3 text-red-500" />}
          statusText="Deleted"
        />
        <div className="min-h-0 flex-1">
          <DiffEditor
            key={isMobile ? "mobile" : "desktop"}
            height="100%"
            language={detectedLanguage}
            original={originalContent ?? ""}
            modified=""
            theme="vs-dark"
            beforeMount={handleEditorWillMount}
            onMount={handleEditorMount}
            options={editorOptions}
          />
        </div>
      </div>
    );
  }

  // Normal diff view (including new files)
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col",
        !isActive && "pointer-events-none opacity-0"
      )}
      style={{ backgroundColor: terminalAppearance.backgroundColor }}
    >
      <DiffHeader
        filePath={filePath}
        baseBranch={baseBranch}
        diffMode={diffMode}
        onDiffModeChange={setDiffMode}
        isMobile={isMobile}
        onSwitchToFileView={onSwitchToFileView}
        statusIcon={
          isNewFile ? (
            <FilePlus className="h-3 w-3 text-green-500" />
          ) : (
            <FileCode className="h-3 w-3" />
          )
        }
        statusText={isNewFile ? "New file" : "Modified"}
      />
      <div className="min-h-0 flex-1">
        <DiffEditor
          key={isMobile ? "mobile" : "desktop"}
          height="100%"
          language={detectedLanguage}
          original={originalContent ?? ""}
          modified={modifiedContent ?? ""}
          theme="vs-dark"
          beforeMount={handleEditorWillMount}
          onMount={handleEditorMount}
          options={editorOptions}
        />
      </div>
    </div>
  );
}

// Header component for the diff view
interface DiffHeaderProps {
  filePath: string;
  baseBranch: string;
  diffMode: DiffMode;
  onDiffModeChange: (mode: DiffMode) => void;
  isMobile: boolean;
  onSwitchToFileView?: () => void;
  statusIcon: React.ReactNode;
  statusText: string;
}

function DiffHeader({
  filePath,
  baseBranch,
  diffMode,
  onDiffModeChange,
  isMobile,
  onSwitchToFileView,
  statusIcon,
  statusText,
}: DiffHeaderProps) {
  const separatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const directory = separatorIndex >= 0 ? filePath.slice(0, separatorIndex) : "";
  const separator = separatorIndex >= 0 ? filePath[separatorIndex] : "";
  const filename = separatorIndex >= 0 ? filePath.slice(separatorIndex + 1) : filePath;
  const baseRef = formatBaseRef(baseBranch);

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border bg-background py-2",
        isMobile ? "px-2" : "px-4",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0">{statusIcon}</span>
        <span
          className="relative min-w-0 flex-1 overflow-hidden font-mono"
          title={filePath}
        >
          <span className="sr-only">{filePath}</span>
          {/* On a phone the directory is dropped entirely: the basename is the only
              part that fits, and the full path is still on the title/sr-only node. */}
          <span aria-hidden="true" className="flex min-w-0 overflow-hidden">
            {directory && !isMobile && (
              <span className="min-w-0 shrink truncate text-left [direction:rtl]">
                {directory}
              </span>
            )}
            <span className="max-w-full min-w-0 shrink-0 truncate">
              {isMobile ? filename : `${separator}${filename}`}
            </span>
          </span>
        </span>
        <span
          className={cn(
            "min-w-0 truncate text-xs opacity-60",
            isMobile ? "max-w-[35vw] shrink" : "shrink-0",
          )}
          title={`vs ${baseBranch}`}
        >
          vs {baseRef}
        </span>
        {/* Keep the status in the accessibility tree when the visual badge is hidden. */}
        <span
          className={cn(
            isMobile
              ? "sr-only"
              : "shrink-0 rounded px-1.5 py-0.5 text-xs",
            !isMobile && statusText === "New file" && "bg-green-500/20 text-green-400",
            !isMobile && statusText === "Modified" && "bg-yellow-500/20 text-yellow-400",
            !isMobile && statusText === "Deleted" && "bg-red-500/20 text-red-400"
          )}
        >
          {statusText}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* Diff mode toggle - inline is forced on mobile, so the toggle is hidden there */}
        {!isMobile && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 px-2",
                diffMode === "side-by-side" &&
                  "bg-primary/15 text-blue-300 ring-1 ring-inset ring-primary/50 hover:bg-primary/20 hover:text-blue-200",
              )}
              onClick={() => onDiffModeChange("side-by-side")}
              title="Side by side"
              aria-label="Side by side"
              aria-pressed={diffMode === "side-by-side"}
            >
              <Columns className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 px-2",
                diffMode === "inline" &&
                  "bg-primary/15 text-blue-300 ring-1 ring-inset ring-primary/50 hover:bg-primary/20 hover:text-blue-200",
              )}
              onClick={() => onDiffModeChange("inline")}
              title="Inline"
              aria-label="Inline"
              aria-pressed={diffMode === "inline"}
            >
              <AlignJustify className="h-3.5 w-3.5" />
            </Button>
            <div className="mx-1 h-4 w-px bg-border" />
          </>
        )}
        {/* Switch to file view toggle */}
        {onSwitchToFileView && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("px-2", isMobile ? "h-8" : "h-7")}
            onClick={onSwitchToFileView}
            title="View file"
          >
            <FileText className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
