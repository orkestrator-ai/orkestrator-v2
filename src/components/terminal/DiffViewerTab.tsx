import { useEffect, useState, useRef, useCallback } from "react";
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
import type { GitFileStatus } from "@/types/paneLayout";

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

type DiffMode = "side-by-side" | "inline";

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

  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [modifiedContent, setModifiedContent] = useState<string | null>(null);
  const [detectedLanguage, setDetectedLanguage] = useState<string>(
    language || "plaintext"
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [diffMode, setDiffMode] = useState<DiffMode>("side-by-side");

  // Track editor instance for proper cleanup
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

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

  // Fetch both original and modified content
  useEffect(() => {
    let cancelled = false;

    async function loadDiffContent() {
      setIsLoading(true);
      setError(null);

      try {
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
          modified = modifiedResult.content;
          setDetectedLanguage(
            modifiedResult.language || language || "plaintext"
          );
        }

        // Fetch original file content from base branch
        let original: string | null = null;
        if (!isNewFile) {
          let originalResult: backend.FileContent | null;
          if (isLocalEnvironment && worktreePath) {
            originalResult = await backend.readLocalFileAtBranch(worktreePath, filePath, baseBranch);
          } else if (containerId) {
            originalResult = await backend.readFileAtBranch(containerId, filePath, baseBranch);
          } else {
            throw new Error("No container ID or worktree path available");
          }
          original = originalResult?.content ?? null;
        }

        if (!cancelled) {
          setOriginalContent(original ?? "");
          setModifiedContent(modified ?? "");
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

  // Loading state
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
          // Don't show "View file" button for deleted files - the file doesn't exist
          onSwitchToFileView={undefined}
          statusIcon={<FileX className="h-3 w-3 text-red-500" />}
          statusText="Deleted"
        />
        <div className="min-h-0 flex-1">
          <DiffEditor
            height="100%"
            language={detectedLanguage}
            original={originalContent ?? ""}
            modified=""
            theme="vs-dark"
            beforeMount={handleEditorWillMount}
            onMount={handleEditorMount}
            options={{
              readOnly: true,
              renderSideBySide: diffMode === "side-by-side",
              fontSize: terminalAppearance.fontSize,
              fontFamily: `"${terminalAppearance.fontFamily}", "Fira Code", monospace`,
              automaticLayout: true,
              enableSplitViewResizing: true,
              ignoreTrimWhitespace: false,
            }}
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
          height="100%"
          language={detectedLanguage}
          original={originalContent ?? ""}
          modified={modifiedContent ?? ""}
          theme="vs-dark"
          beforeMount={handleEditorWillMount}
          onMount={handleEditorMount}
          options={{
            readOnly: true,
            renderSideBySide: diffMode === "side-by-side",
            fontSize: terminalAppearance.fontSize,
            fontFamily: `"${terminalAppearance.fontFamily}", "Fira Code", monospace`,
            automaticLayout: true,
            enableSplitViewResizing: true,
            ignoreTrimWhitespace: false,
          }}
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
  onSwitchToFileView?: () => void;
  statusIcon: React.ReactNode;
  statusText: string;
}

function DiffHeader({
  filePath,
  baseBranch,
  diffMode,
  onDiffModeChange,
  onSwitchToFileView,
  statusIcon,
  statusText,
}: DiffHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-[#252526] px-4 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {statusIcon}
        <span className="truncate font-mono">{filePath}</span>
        <span className="text-xs opacity-60">vs {baseBranch}</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-xs",
            statusText === "New file" && "bg-green-500/20 text-green-400",
            statusText === "Modified" && "bg-yellow-500/20 text-yellow-400",
            statusText === "Deleted" && "bg-red-500/20 text-red-400"
          )}
        >
          {statusText}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {/* Diff mode toggle */}
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-7 px-2", diffMode === "side-by-side" && "bg-accent")}
          onClick={() => onDiffModeChange("side-by-side")}
          title="Side by side"
        >
          <Columns className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-7 px-2", diffMode === "inline" && "bg-accent")}
          onClick={() => onDiffModeChange("inline")}
          title="Inline"
        >
          <AlignJustify className="h-3.5 w-3.5" />
        </Button>
        <div className="mx-1 h-4 w-px bg-border" />
        {/* Switch to file view toggle */}
        {onSwitchToFileView && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
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
