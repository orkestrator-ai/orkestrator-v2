import { lazy, type ComponentType, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores";
import { DEFAULT_TERMINAL_APPEARANCE } from "@/constants/terminal";
import type { SaveFile } from "@/hooks/useFileSave";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { FloatingNoticeLayer } from "@/components/ui/floating-notice";

const LazyMonacoFileEditor = lazy(async () => ({
  default: (await import("./MonacoFileEditor")).MonacoFileEditor,
}));

export type RenderedRawMode = "rendered" | "raw";

interface RenderedRawFileShellProps {
  mode: RenderedRawMode;
  onModeChange: (mode: RenderedRawMode) => void;
  icon: ComponentType<{ className?: string }>;
  filePath: string;
  language: string;
  /** The current buffer, shown in the Raw editor. */
  value: string;
  lineNumber?: number;
  columnNumber?: number;
  navigationRequestId?: number;
  isActive: boolean;
  isSaving: boolean;
  onChange: (value: string) => void;
  onSave: SaveFile;
  /** Shown between the header and the content, in whichever mode the caller chooses. */
  notice?: ReactNode;
  /** Controls shown in the header, left of the Rendered/Raw switch. */
  headerActions?: ReactNode;
  /** The Rendered view. Unmounted while the tab shows Raw. */
  children: ReactNode;
}

/** The file header, Rendered/Raw switch and Raw editor shared by previewable file types. */
export function RenderedRawFileShell({
  mode,
  onModeChange,
  icon: Icon,
  filePath,
  language,
  value,
  lineNumber,
  columnNumber,
  navigationRequestId,
  isActive,
  isSaving,
  onChange,
  onSave,
  notice,
  headerActions,
  children,
}: RenderedRawFileShellProps) {
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ||
    DEFAULT_TERMINAL_APPEARANCE;

  return (
    <Tabs
      value={mode}
      onValueChange={(nextMode) => {
        if (nextMode === "rendered" || nextMode === "raw") onModeChange(nextMode);
      }}
      className={cn("absolute inset-0 gap-0", !isActive && "pointer-events-none opacity-0")}
      style={{ backgroundColor: terminalAppearance.backgroundColor }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-4 text-xs text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate font-mono">{filePath}</span>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {isSaving && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving...
            </span>
          )}
          {headerActions}
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

      {/* Notices float at the top right, below the file header. */}
      <FloatingNoticeLayer>{notice}</FloatingNoticeLayer>

      <TabsContent value="rendered" className="min-h-0 overflow-auto">
        {children}
      </TabsContent>

      <TabsContent value="raw" className="min-h-0">
        <LazyLoadBoundary
          loadingFallback={
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <span
                role="status"
                aria-label="Loading raw editor…"
                className="flex items-center justify-center"
              >
                <Loader2 className="h-6 w-6 animate-spin" />
              </span>
            </div>
          }
        >
          <LazyMonacoFileEditor
            language={language}
            value={value}
            lineNumber={lineNumber}
            columnNumber={columnNumber}
            navigationRequestId={navigationRequestId}
            isActive={isActive && mode === "raw"}
            onChange={onChange}
            onSave={onSave}
          />
        </LazyLoadBoundary>
      </TabsContent>
    </Tabs>
  );
}
