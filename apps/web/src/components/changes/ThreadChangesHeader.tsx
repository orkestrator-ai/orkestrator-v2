import { useCallback, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ThreadChangesSummary } from "./ThreadChangesSummary";
import { TurnChangesHistory } from "./TurnChangesHistory";
import { useThreadChangeResource } from "./useThreadChangeResource";

/**
 * Change-tracking strip above a native agent conversation: the current
 * thread segment's `thread-net` summary and a collapsible list of per-turn
 * changes. Until the backend reports a thread segment (no turn captured yet,
 * or a backend without change tracking) it renders only `containment`, or
 * nothing when that is absent.
 *
 * Presentation only. It reads backend resources and opens historical diff
 * tabs; background tracking never depends on it being mounted.
 */
export function ThreadChangesHeader({
  environmentId,
  logicalSessionKey,
  turnActive,
  onOpenDiff,
  containment,
}: {
  environmentId: string;
  logicalSessionKey: string;
  /** Re-reads the thread segment and history on each turn edge. */
  turnActive: boolean;
  /** Overrides the terminal context's file-tab opener. */
  onOpenDiff?: (title: string, target: ChangeDiffTarget) => void;
  /**
   * The environment's containment line, shown in the same row whether or not
   * change tracking has reported yet: what isolates the agent is worth stating
   * before its first turn as much as after.
   */
  containment?: ReactNode;
}) {
  const thread = useThreadChangeResource(environmentId, logicalSessionKey, turnActive);
  const createFileTab = useOptionalTerminalContext()?.createFileTab ?? null;
  const [historyOpen, setHistoryOpen] = useState(false);
  const openDiff = useCallback(
    (title: string, target: ChangeDiffTarget) => {
      if (onOpenDiff) onOpenDiff(title, target);
      else createFileTab?.(title, { isDiff: true, changeDiff: target });
    },
    [createFileTab, onOpenDiff],
  );
  const canOpen = Boolean(onOpenDiff ?? createFileTab);

  if (!thread) {
    if (!containment) return null;
    return (
      <div
        data-testid="environment-containment-row"
        className="flex min-h-7 shrink-0 items-center border-b border-border/60 bg-background px-2 py-0.5 @sm:px-4"
      >
        <div className="min-w-0 px-1.5">{containment}</div>
      </div>
    );
  }
  return (
    <Collapsible
      open={historyOpen}
      onOpenChange={setHistoryOpen}
      data-testid="thread-changes-header"
      className="shrink-0 border-b border-border/60 bg-background px-2 @sm:px-4"
    >
      <div className="flex min-h-7 items-center gap-2 py-0.5">
        <ThreadChangesSummary
          key={thread.resourceKey}
          resourceKey={thread.resourceKey}
          onOpenDiff={canOpen ? openDiff : undefined}
        />
        {containment ? (
          <div className="ml-auto flex min-w-0 flex-1 justify-end overflow-hidden">
            {containment}
          </div>
        ) : null}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid="turn-changes-toggle"
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-elevated hover:text-foreground",
              !containment && "ml-auto",
            )}
          >
            {historyOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            Turn changes
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="max-h-72 overflow-y-auto pb-2">
        {historyOpen ? (
          <TurnChangesHistory
            environmentId={environmentId}
            logicalSessionKey={logicalSessionKey}
            refreshToken={`${thread.segmentId}\0${turnActive ? "active" : "idle"}`}
            onOpenDiff={canOpen ? openDiff : undefined}
          />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
