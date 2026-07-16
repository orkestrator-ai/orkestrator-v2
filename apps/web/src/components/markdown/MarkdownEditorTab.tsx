import { useCallback, useRef, useState } from "react";
import { AlertTriangle, FileText, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConfigStore, useFileDirtyStore } from "@/stores";
import { DEFAULT_TERMINAL_APPEARANCE } from "@/constants/terminal";
import type { SaveFile } from "@/hooks/useFileSave";
import { MonacoFileEditor } from "@/components/terminal/MonacoFileEditor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TiptapMarkdownEditor,
  type TiptapMarkdownEditorHandle,
} from "./TiptapMarkdownEditor";
import { assessMarkdownForRichEditing } from "./tiptap-extensions";

type MarkdownEditorMode = "rendered" | "raw";

interface MarkdownEditorTabProps {
  tabId: string;
  filePath: string;
  initialContent: string;
  language: string;
  isActive: boolean;
  isSaving: boolean;
  onSave: SaveFile;
}

export function MarkdownEditorTab({
  tabId,
  filePath,
  initialContent,
  language,
  isActive,
  isSaving,
  onSave,
}: MarkdownEditorTabProps) {
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ||
    DEFAULT_TERMINAL_APPEARANCE;
  const markdown = useFileDirtyStore(
    (state) => state.dirtyFiles.get(tabId)?.content ?? initialContent,
  );
  const setContent = useFileDirtyStore((state) => state.setContent);
  const [initialAssessment] = useState(() =>
    assessMarkdownForRichEditing(markdown),
  );
  const [mode, setMode] = useState<MarkdownEditorMode>(
    initialAssessment.safe ? "rendered" : "raw",
  );
  const [parseError, setParseError] = useState<string | null>(
    initialAssessment.reason,
  );
  const editorRef = useRef<TiptapMarkdownEditorHandle>(null);

  const handleModeChange = useCallback((nextMode: string) => {
    if (nextMode !== "rendered" && nextMode !== "raw") return;

    if (mode === "rendered" && nextMode === "raw") {
      editorRef.current?.flushPendingChanges();
    }

    if (mode === "raw" && nextMode === "rendered") {
      const assessment = assessMarkdownForRichEditing(markdown);
      if (!assessment.safe) {
        setParseError(assessment.reason);
        return;
      }
      setParseError(null);
    }

    setMode(nextMode);
  }, [markdown, mode]);

  const handleParseError = useCallback((error: Error) => {
    setParseError(error.message || "This document could not be rendered safely.");
    setMode("raw");
  }, []);

  return (
    <Tabs
      value={mode}
      onValueChange={handleModeChange}
      className={cn(
        "absolute inset-0 gap-0",
        !isActive && "pointer-events-none opacity-0",
      )}
      style={{ backgroundColor: terminalAppearance.backgroundColor }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-4 text-xs text-muted-foreground">
        <FileText className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate font-mono">{filePath}</span>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {isSaving && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving...
            </span>
          )}
          <TabsList className="h-7 rounded-md p-0.5">
            <TabsTrigger className="h-6 px-2 text-xs" value="rendered">
              Rendered
            </TabsTrigger>
            <TabsTrigger className="h-6 px-2 text-xs" value="raw">
              Raw
            </TabsTrigger>
          </TabsList>
        </div>
      </div>

      {parseError && mode === "raw" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>Rendered mode is unavailable for this file: {parseError}</span>
        </div>
      )}

      <TabsContent value="rendered" className="min-h-0 overflow-auto">
        <TiptapMarkdownEditor
          ref={editorRef}
          markdown={markdown}
          fontFamily={terminalAppearance.fontFamily}
          fontSize={terminalAppearance.fontSize}
          onChange={(nextMarkdown) => setContent(tabId, nextMarkdown)}
          onSave={onSave}
          onParseError={handleParseError}
        />
      </TabsContent>

      <TabsContent value="raw" className="min-h-0">
        <MonacoFileEditor
          language={language}
          value={markdown}
          onChange={(nextMarkdown) => setContent(tabId, nextMarkdown)}
          onSave={onSave}
        />
      </TabsContent>
    </Tabs>
  );
}
