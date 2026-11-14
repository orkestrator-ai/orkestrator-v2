import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FileCode, Info, Link2 } from "lucide-react";
import { useFileDirtyStore } from "@/stores";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import type { SaveFile } from "@/hooks/useFileSave";
import {
  RenderedRawFileShell,
  type RenderedRawMode,
} from "@/components/terminal/RenderedRawFileShell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  buildHtmlPreviewDocument,
  findSiblingPageLinks,
  findSiblingStylesheetPaths,
  HTML_PREVIEW_SANDBOX,
  MAX_SIBLING_STYLESHEET_BYTES,
} from "./html-preview-document";

/** The stylesheets read for the page, and the set of paths they were read for. */
interface LoadedStylesheets {
  key: string;
  sheets: ReadonlyMap<string, string>;
}

const NO_STYLESHEETS: LoadedStylesheets = { key: "", sheets: new Map() };

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
  /**
   * Reads a text file of this workspace by workspace-relative path; rejects when
   * it cannot. Without it the page renders as before, with its stylesheets refused.
   */
  readSiblingFile?: (path: string) => Promise<string>;
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
  readSiblingFile,
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

  // Stylesheets from the page's own folder are read here and inlined, so the
  // frame itself still loads nothing. Only the Rendered view needs them.
  // Keyed by the joined paths (a path never holds a newline), so typing that
  // leaves the set unchanged does not read the files again.
  const stylesheetKey = useMemo(
    () =>
      mode === "rendered" && readSiblingFile
        ? findSiblingStylesheetPaths(html, filePath).join("\n")
        : "",
    [html, filePath, mode, readSiblingFile],
  );
  const stylesheetPaths = useMemo(
    () => (stylesheetKey ? stylesheetKey.split("\n") : []),
    [stylesheetKey],
  );
  const [loaded, setLoaded] = useState(NO_STYLESHEETS);
  useEffect(() => {
    if (!readSiblingFile || !isActive || stylesheetPaths.length === 0) return;
    let cancelled = false;
    void Promise.all(
      stylesheetPaths.map(async (path): Promise<[string, string] | null> => {
        try {
          const text = await readSiblingFile(path);
          // The backend caps what it reads; this bounds what is inlined per page.
          return text.length <= MAX_SIBLING_STYLESHEET_BYTES ? [path, text] : null;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setLoaded({
        key: stylesheetKey,
        sheets: new Map(entries.filter((entry): entry is [string, string] => entry !== null)),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [readSiblingFile, isActive, stylesheetKey, stylesheetPaths]);
  // Hold the frame until the stylesheets are in, so the page never flashes unstyled.
  const awaitingStylesheets = stylesheetPaths.length > 0 && loaded.key !== stylesheetKey;

  // Only the Rendered view reads this, so typing in Raw never reparses the file.
  const preview = useMemo(
    () =>
      mode === "rendered"
        ? buildHtmlPreviewDocument(
            html,
            readSiblingFile ? { filePath, stylesheets: loaded.sheets } : undefined,
          )
        : null,
    [html, mode, filePath, readSiblingFile, loaded.sheets],
  );

  // Links to other pages cannot be followed inside the script-free frame, so
  // they are listed here and opened as tabs.
  const openFile = useOptionalTerminalContext()?.createFileTab ?? null;
  const pageLinks = useMemo(
    () => (mode === "rendered" && openFile ? findSiblingPageLinks(html, filePath) : []),
    [html, filePath, mode, openFile],
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
        headerActions={
          pageLinks.length > 0 && openFile ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="focus-hairline flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted"
                >
                  <Link2 className="h-3 w-3" aria-hidden="true" />
                  Linked pages ({pageLinks.length})
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-80 overflow-y-auto">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Open in a tab
                </DropdownMenuLabel>
                {pageLinks.map((link) => (
                  <DropdownMenuItem
                    key={link.path}
                    onSelect={() => openFile(link.path)}
                    className="flex-col items-start gap-0"
                  >
                    <span className="w-full truncate text-xs">{link.label}</span>
                    <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                      {link.path}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
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
        {preview && !awaitingStylesheets && (
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
