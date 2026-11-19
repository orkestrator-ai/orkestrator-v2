import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NAVIGATION_SHORTCUTS, type DiffNavigationCommand } from "./diff-hunk-navigation";

/**
 * The diff tab's second row: which comparison a live file shows (all
 * changes, unstaged, staged), where the reader is among the hunks and files,
 * and the outcome of the last staging action.
 */

export interface DiffScopeChoice {
  resourceKey: string;
  label: string;
}

export interface StagingFeedback {
  kind: "applied" | "refused" | "failed";
  text: string;
  /** The refusal says the reviewed diff is out of date: offer a reload. */
  stale: boolean;
}

interface DiffNavigationBarProps {
  isMobile: boolean;
  scopeChoices: DiffScopeChoice[] | null;
  activeScope: string | null;
  onScopeChange: (resourceKey: string) => void;
  /** Hunks in the shown body; null while no body is shown. */
  hunkCount: number | null;
  activePosition: number | null;
  file: { index: number; count: number; hasPrevious: boolean; hasNext: boolean } | null;
  onNavigate: (command: DiffNavigationCommand) => void;
  feedback: StagingFeedback | null;
  onDismissFeedback: () => void;
  onReload?: () => void;
}

function NavButton({
  command,
  label,
  disabled,
  onNavigate,
  className,
  children,
}: {
  command: DiffNavigationCommand;
  label: string;
  disabled: boolean;
  onNavigate: (command: DiffNavigationCommand) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const shortcut = NAVIGATION_SHORTCUTS[command];
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("h-6 w-6 p-0", className)}
      disabled={disabled}
      onClick={() => onNavigate(command)}
      title={`${label} (${shortcut.label})`}
      aria-label={label}
      aria-keyshortcuts={shortcut.aria}
    >
      {children}
    </Button>
  );
}

export function DiffNavigationBar({
  isMobile,
  scopeChoices,
  activeScope,
  onScopeChange,
  hunkCount,
  activePosition,
  file,
  onNavigate,
  feedback,
  onDismissFeedback,
  onReload,
}: DiffNavigationBarProps) {
  const showHunks = hunkCount !== null && hunkCount > 0;
  if (!scopeChoices && !showHunks && !feedback) return null;
  const position = activePosition ?? 0;
  return (
    <div
      data-testid="diff-viewer-navigation"
      className="border-b border-border/60 bg-background text-[11px] text-muted-foreground"
    >
      <div
        className={cn("flex min-h-8 flex-wrap items-center gap-2 py-1", isMobile ? "px-2" : "px-4")}
      >
        {scopeChoices && (
          <div
            role="group"
            aria-label="Compare"
            className="flex items-center rounded border border-border/60"
          >
            {scopeChoices.map((choice) => {
              const active = choice.resourceKey === activeScope;
              return (
                <button
                  key={choice.resourceKey}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onScopeChange(choice.resourceKey)}
                  className={cn(
                    "px-2 py-0.5 first:rounded-l last:rounded-r hover:text-foreground",
                    active && "bg-primary/15 text-blue-300",
                  )}
                >
                  {choice.label}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex-1" />
        {showHunks && (
          <div className="flex items-center gap-0.5" role="group" aria-label="Change navigation">
            {file && file.count > 1 && (
              <>
                <NavButton
                  command="previous-file"
                  label="Previous file"
                  disabled={!file.hasPrevious}
                  onNavigate={onNavigate}
                >
                  <ChevronsUp className="h-3.5 w-3.5" />
                </NavButton>
                <span data-testid="diff-viewer-file-position" className="px-1 font-mono">
                  File {file.index + 1} of {file.count}
                </span>
                <NavButton
                  command="next-file"
                  label="Next file"
                  disabled={!file.hasNext}
                  onNavigate={onNavigate}
                >
                  <ChevronsDown className="h-3.5 w-3.5" />
                </NavButton>
                <span className="mx-1 h-3 w-px bg-border" />
              </>
            )}
            <NavButton
              command="previous-hunk"
              label="Previous change"
              disabled={position === 0}
              onNavigate={onNavigate}
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </NavButton>
            <span
              data-testid="diff-viewer-hunk-position"
              aria-live="polite"
              className="px-1 font-mono"
            >
              Change {position + 1} of {hunkCount}
            </span>
            <NavButton
              command="next-hunk"
              label="Next change"
              disabled={position >= hunkCount - 1}
              onNavigate={onNavigate}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </NavButton>
          </div>
        )}
      </div>
      {feedback && (
        <div
          role={feedback.kind === "applied" ? "status" : "alert"}
          data-testid="diff-viewer-staging-feedback"
          className={cn(
            "flex items-center gap-2 border-t border-border/40 py-1",
            isMobile ? "px-2" : "px-4",
            feedback.kind === "applied" ? "text-success" : "text-failure",
          )}
        >
          <span className="min-w-0 flex-1">{feedback.text}</span>
          {feedback.stale && onReload && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={onReload}
            >
              <RefreshCw className="h-3 w-3" />
              Reload and review again
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={onDismissFeedback}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
