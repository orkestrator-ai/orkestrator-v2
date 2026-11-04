import { useEffect, useMemo, useRef, useState } from "react";
import { FileCode, Info } from "lucide-react";
import { useFileDirtyStore } from "@/stores";
import type { SaveFile } from "@/hooks/useFileSave";
import {
  RenderedRawFileShell,
  type RenderedRawMode,
} from "@/components/terminal/RenderedRawFileShell";
import { buildHtmlPreviewDocument, HTML_PREVIEW_SANDBOX } from "./html-preview-document";

interface HtmlFileTabProps {
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

export function HtmlFileTab({
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
}: HtmlFileTabProps) {
  const html = useFileDirtyStore((state) => state.dirtyFiles.get(tabId)?.content ?? initialContent);
  const setContent = useFileDirtyStore((state) => state.setContent);
  // A line number only means something in the source.
  const [mode, setMode] = useState<RenderedRawMode>(lineNumber ? "raw" : "rendered");
  const [handledNavigationRequestId, setHandledNavigationRequestId] = useState(navigationRequestId);
  if (navigationRequestId !== handledNavigationRequestId) {
    setHandledNavigationRequestId(navigationRequestId);
    if (navigationRequestId !== undefined && lineNumber) setMode("raw");
  }

  // Only the Rendered view reads this, so typing in Raw never reparses the file.
  const preview = useMemo(
    () => (mode === "rendered" ? buildHtmlPreviewDocument(html) : null),
    [html, mode],
  );

  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isActive || mode !== "rendered") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Opaque, script-free frames cannot forward keyboard events. Return keyboard
    // focus to the host after a pointer interaction; native scrolling and links
    // still work without granting the repository scripts or same-origin access.
    const recoverFocus = () => {
      timer = setTimeout(() => {
        if (
          hostRef.current?.contains(document.activeElement) &&
          document.activeElement?.tagName === "IFRAME"
        ) {
          hostRef.current.focus({ preventScroll: true });
        }
      }, 0);
    };
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void onSave();
      }
    };
    window.addEventListener("blur", recoverFocus);
    window.addEventListener("keydown", save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("blur", recoverFocus);
      window.removeEventListener("keydown", save);
    };
  }, [isActive, mode, onSave]);

  return (
    <div ref={hostRef} tabIndex={-1} className="absolute inset-0 outline-none">
      <RenderedRawFileShell
        mode={mode}
        onModeChange={setMode}
        icon={FileCode}
        filePath={filePath}
        language={language}
        value={html}
        lineNumber={lineNumber}
        columnNumber={columnNumber}
        navigationRequestId={navigationRequestId}
        isActive={isActive}
        isSaving={isSaving}
        onChange={(nextHtml) => setContent(tabId, nextHtml)}
        onSave={onSave}
        notice={
          preview?.hasRefusedContent ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-4 py-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0" />
              <span>
                This page may look incomplete: Rendered view does not run scripts or load external
                files.
              </span>
            </div>
          ) : null
        }
      >
        {preview && (
          <iframe
            title={`Rendered view of ${filePath}`}
            sandbox={HTML_PREVIEW_SANDBOX}
            tabIndex={-1}
            referrerPolicy="no-referrer"
            srcDoc={preview.srcDoc}
            className="block h-full w-full border-0 bg-white"
          />
        )}
      </RenderedRawFileShell>
    </div>
  );
}
