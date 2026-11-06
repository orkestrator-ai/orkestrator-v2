import { useCallback, useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { useConfigStore, useFileDirtyStore } from "@/stores";
import { DEFAULT_TERMINAL_APPEARANCE } from "@/constants/terminal";
import type { SaveFile } from "@/hooks/useFileSave";
import {
  RenderedRawFileShell,
  type RenderedRawMode,
} from "@/components/terminal/RenderedRawFileShell";
import { TiptapMarkdownEditor, type TiptapMarkdownEditorHandle } from "./TiptapMarkdownEditor";
import { assessMarkdownForRichEditing } from "./tiptap-extensions";
import { FloatingNotice } from "@/components/ui/floating-notice";

interface MarkdownEditorTabProps {
  tabId: string;
  filePath: string;
  initialContent: string;
  language: string;
  lineNumber?: number;
  columnNumber?: number;
  navigationRequestId?: number;
  isActive: boolean;
  isSaving: boolean;
  onSave: SaveFile;
}

export function MarkdownEditorTab({
  tabId,
  filePath,
  initialContent,
  language,
  lineNumber,
  columnNumber,
  navigationRequestId,
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
  const [initialAssessment] = useState(() => assessMarkdownForRichEditing(markdown));
  const [mode, setMode] = useState<RenderedRawMode>(
    lineNumber ? "raw" : initialAssessment.safe ? "rendered" : "raw",
  );
  const [parseError, setParseError] = useState<string | null>(initialAssessment.reason);
  const editorRef = useRef<TiptapMarkdownEditorHandle>(null);
  const handledNavigationRequestIdRef = useRef(navigationRequestId);

  useEffect(() => {
    if (navigationRequestId === undefined) {
      handledNavigationRequestIdRef.current = undefined;
      return;
    }
    if (navigationRequestId === handledNavigationRequestIdRef.current) return;
    handledNavigationRequestIdRef.current = navigationRequestId;
    if (!lineNumber || mode === "raw") return;
    editorRef.current?.flushPendingChanges();
    // The switch must follow the flush above, which pushes the rich editor's
    // pending edit into the store while that editor is still mounted. Switching
    // while rendering would unmount it first, so the raw editor would open on
    // stale text and navigate before the late flush replaced it.
    // oxlint-disable-next-line react/set-state-in-effect
    setMode("raw");
  }, [lineNumber, mode, navigationRequestId]);

  const handleModeChange = useCallback(
    (nextMode: RenderedRawMode) => {
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
    },
    [markdown, mode],
  );

  const handleParseError = useCallback((error: Error) => {
    setParseError(error.message || "This document could not be rendered safely.");
    setMode("raw");
  }, []);

  return (
    <RenderedRawFileShell
      mode={mode}
      onModeChange={handleModeChange}
      icon={FileText}
      filePath={filePath}
      language={language}
      value={markdown}
      lineNumber={lineNumber}
      columnNumber={columnNumber}
      navigationRequestId={navigationRequestId}
      isActive={isActive}
      isSaving={isSaving}
      onChange={(nextMarkdown) => setContent(tabId, nextMarkdown)}
      onSave={onSave}
      notice={
        parseError && mode === "raw" ? (
          <FloatingNotice
            tone="warning"
            label="Raw mode only"
            summary="Rendered mode is unavailable for this file."
          >
            Rendered mode is unavailable for this file: {parseError}
          </FloatingNotice>
        ) : null
      }
    >
      <TiptapMarkdownEditor
        ref={editorRef}
        markdown={markdown}
        fontFamily={terminalAppearance.fontFamily}
        fontSize={terminalAppearance.fontSize}
        onChange={(nextMarkdown) => setContent(tabId, nextMarkdown)}
        onSave={onSave}
        onParseError={handleParseError}
      />
    </RenderedRawFileShell>
  );
}
