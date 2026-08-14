import { useCallback, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FileCode, Globe2, Terminal as TerminalIcon, X, Hammer, Repeat2 } from "lucide-react";
import { ClaudeIcon, CodexIcon, CursorAgentIcon, GrokBuildIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { HoverTooltipContent, useHoverTooltip } from "@/components/ui/hover-tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { TabInfo } from "@/types/paneLayout";
import { createDraggableTabId, getNativeAgentData } from "@/types/paneLayout";
import { useSessionStore } from "@/stores/sessionStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { createSessionKey } from "@/lib/utils";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useLoopedReviewStore } from "@/stores/loopedReviewStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { StackedEyes } from "@/components/review/MultiReviewLaunchDialog";
import { useFileDirtyStore } from "@/stores";
import type { TabType } from "@/contexts";

/** Check if a tab type is an OpenCode variant (terminal or native mode) */
const isOpenCodeTab = (type: TabType): boolean =>
  type === "opencode";

/** Check if a tab type is a Claude variant (terminal, native, or tmux mode) */
const isClaudeTab = (type: TabType): boolean =>
  type === "claude" || type === "claude-tmux";

/** Check if a tab type is a Codex variant */
const isCodexTab = (type: TabType): boolean =>
  type === "codex";

const isCursorTab = (type: TabType): boolean => type === "cursor";
const isGrokTab = (type: TabType): boolean => type === "grok";

/** Check if a tab type is a build pipeline tab */
const isBuildTab = (type: TabType): boolean => type === "claude-build";

function getWorkflowTabTitle(tab: TabInfo): "Review" | "PR" | "Resolve" | undefined {
  if (tab.isReviewTab) return "Review";
  if (tab.displayTitle === "PR") return "PR";
  if (tab.displayTitle === "Resolve" || tab.displayTitle === "Conflict") {
    return "Resolve";
  }
  return undefined;
}

interface DraggableTabProps {
  tab: TabInfo;
  paneId: string;
  index: number;
  isActive: boolean;
  /** Whether this tab is focused (active tab in the focused pane) */
  isFocused?: boolean;
  onSelect: () => void;
  /** Reload this tab from its authoritative server-side state. */
  onRefresh?: () => void;
  onClose?: () => void;
  onCloseAll?: () => void;
  onCloseOthers?: () => void;
  onCloseToRight?: () => void;
  /** Whether "Close all" should be enabled for this tab */
  canCloseAll?: boolean;
  /** Whether "Close others" should be enabled for this tab */
  canCloseOthers?: boolean;
  /** Whether "Close to the right" should be enabled for this tab */
  canCloseToRight?: boolean;
  canClose: boolean;
}

export function DraggableTab({
  tab,
  paneId,
  index,
  isActive,
  isFocused = false,
  onSelect,
  onRefresh,
  onClose,
  onCloseAll,
  onCloseOthers,
  onCloseToRight,
  canCloseAll = true,
  canCloseOthers = true,
  canCloseToRight = true,
  canClose,
}: DraggableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: createDraggableTabId(tab.id, paneId),
  });
  const tooltipAnchorRef = useRef<HTMLDivElement | null>(null);
  const tabTooltip = useHoverTooltip();

  // Get session for this tab to check for custom name
  const sessions = useSessionStore((state) => state.sessions);
  const session = Array.from(sessions.values()).find((s) => s.tabId === tab.id);
  const nativeAgentData = getNativeAgentData(tab);

  // Agent-assigned session titles. All three native agents populate these, so
  // all three label their tab with the session name once the agent picks one.
  const claudeSessionTitle = useClaudeStore((state) => {
    if (nativeAgentData?.platform !== "claude") return undefined;
    return state.sessions.get(
      createSessionKey(nativeAgentData.environmentId, tab.id),
    )?.title;
  });
  const codexSessionTitle = useCodexStore((state) => {
    if (nativeAgentData?.platform !== "codex") return undefined;
    return state.sessions.get(
      createSessionKey(nativeAgentData.environmentId, tab.id),
    )?.title;
  });
  const openCodeSessionTitle = useOpenCodeStore((state) => {
    if (nativeAgentData?.platform !== "opencode") {
      return undefined;
    }
    return state.sessions.get(
      createSessionKey(nativeAgentData.environmentId, tab.id),
    )?.title;
  });
  const nativeSessionTitle =
    claudeSessionTitle ?? codexSessionTitle ?? openCodeSessionTitle;
  const workflowTitle = getWorkflowTabTitle(tab);

  // Get build pipeline title for claude-build tabs
  const buildPipelineTitle = useBuildPipelineStore((state) => {
    if (tab.type !== "claude-build" || !tab.buildTabData) return undefined;
    const pipeline = state.pipelines.get(tab.buildTabData.pipelineId);
    return pipeline?.taskTitle;
  });
  const loopedReviewPhase = useLoopedReviewStore((state) => {
    if (tab.type !== "looped-review" || !tab.loopedReviewTabData) return undefined;
    return state.workflows.get(tab.loopedReviewTabData.workflowId)?.phase;
  });
  const multiReviewPhase = useMultiReviewStore((state) => {
    if (tab.type !== "multi-review" || !tab.multiReviewTabData) return undefined;
    return state.workflows.get(tab.multiReviewTabData.workflowId)?.phase;
  });

  // Check if file tab has unsaved changes
  const isDirty = useFileDirtyStore((state) =>
    tab.type === "file" ? state.isDirty(tab.id) : false,
  );

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Get tab title based on type and session name
  const getTabTitle = () => {
    if (tab.type === "file" && tab.fileData) {
      const parts = tab.fileData.filePath.split("/").filter(Boolean);
      return parts.at(-1) ?? tab.fileData.filePath;
    }

    // For terminal tabs, include session name if set
    const tabNumber = index + 1;

    // Workflow tabs keep a stable numbered label instead of adopting the
    // agent-generated session title. "Conflict" supports restored tabs created
    // before the conflict-resolution label changed to "Resolve".
    if (workflowTitle) {
      return `${workflowTitle} ${tabNumber}`;
    }

    if (session?.name) {
      // Custom session name + number for keyboard shortcut reference
      return `${session.name} ${tabNumber}`;
    }

    // Ordinary native agent tabs adopt their auto-generated session title.
    if (nativeSessionTitle) {
      return nativeSessionTitle;
    }

    if (tab.displayTitle) {
      return `${tab.displayTitle} ${tabNumber}`;
    }

    // Build pipeline tab title
    if (isBuildTab(tab.type) && buildPipelineTitle) {
      return `Build: ${buildPipelineTitle}`;
    }

    if (tab.type === "agent-native") {
      const label = nativeAgentData?.platform === "opencode"
        ? "OpenCode"
        : nativeAgentData?.platform === "cursor"
          ? "Cursor"
          : nativeAgentData?.platform === "grok"
            ? "Grok"
            : nativeAgentData?.platform === "codex"
              ? "Codex"
              : nativeAgentData?.platform === "claude"
                ? "Claude"
                : "Agent";
      return `${label} ${tabNumber}`;
    }

    // Default names
    if (tab.type === "plain") return `Terminal ${tabNumber}`;
    if (isClaudeTab(tab.type)) return `Claude ${tabNumber}`;
    if (isOpenCodeTab(tab.type)) return `OpenCode ${tabNumber}`;
    if (isCodexTab(tab.type)) return `Codex ${tabNumber}`;
    if (isCursorTab(tab.type)) return `Cursor ${tabNumber}`;
    if (isGrokTab(tab.type)) return `Grok ${tabNumber}`;
    if (isBuildTab(tab.type)) return `Build ${tabNumber}`;
    if (tab.type === "looped-review") {
      return loopedReviewPhase === "completed"
        ? `Looped Review ✓`
        : `Looped Review ${tabNumber}`;
    }
    if (tab.type === "multi-review") {
      return multiReviewPhase === "completed"
        ? "Multi Review ✓"
        : `Multi Review ${tabNumber}`;
    }
    if (tab.type === "browser") return `Browser ${tabNumber}`;
    if (tab.type === "root") return `ROOT ${tabNumber}`;
    return `Tab ${tabNumber}`;
  };

  // Get tab icon based on type
  const getTabIcon = () => {
    if (tab.type === "file") {
      return <FileCode className="h-3 w-3 shrink-0" />;
    }
    if (tab.type === "browser") {
      return <Globe2 className="h-3 w-3 shrink-0 text-sky-400" />;
    }
    if (tab.type === "agent-native") {
      if (nativeAgentData?.platform === "opencode") return <OpenCodeIcon className="h-3 w-3 shrink-0 text-green-500" />;
      if (nativeAgentData?.platform === "claude") return <ClaudeIcon className="h-3 w-3 shrink-0 text-orange-400" />;
      if (nativeAgentData?.platform === "codex") return <CodexIcon className="h-3 w-3 shrink-0 text-emerald-400" />;
      if (nativeAgentData?.platform === "cursor") return <CursorAgentIcon className="h-3 w-3 shrink-0 text-violet-400" />;
      if (nativeAgentData?.platform === "grok") return <GrokBuildIcon className="h-3 w-3 shrink-0 text-sky-400" />;
      return <TerminalIcon className="h-3 w-3 shrink-0 text-muted-foreground" />;
    }
    if (isOpenCodeTab(tab.type)) {
      return <OpenCodeIcon className="h-3 w-3 shrink-0 text-green-500" />;
    }
    if (isClaudeTab(tab.type)) {
      return <ClaudeIcon className="h-3 w-3 shrink-0 text-orange-400" />;
    }
    if (isCodexTab(tab.type)) {
      return <CodexIcon className="h-3 w-3 shrink-0 text-emerald-400" />;
    }
    if (isCursorTab(tab.type)) {
      return <CursorAgentIcon className="h-3 w-3 shrink-0 text-violet-400" />;
    }
    if (isGrokTab(tab.type)) {
      return <GrokBuildIcon className="h-3 w-3 shrink-0 text-sky-400" />;
    }
    if (isBuildTab(tab.type)) {
      return <Hammer className="h-3 w-3 shrink-0 text-yellow-400" />;
    }
    if (tab.type === "looped-review") {
      return <Repeat2 className="h-3 w-3 shrink-0 text-cyan-400" />;
    }
    if (tab.type === "multi-review") {
      return <StackedEyes className="size-3.5 shrink-0 text-cyan-400" />;
    }
    return <TerminalIcon className="h-3 w-3 shrink-0" />;
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose?.();
  };

  const title = getTabTitle();
  const icon = getTabIcon();
  const titleElement = <span className="max-w-[120px] truncate">{title}</span>;
  const isFileTab = tab.type === "file" && !!tab.fileData;
  const tooltipContent = isFileTab
    ? tab.fileData?.filePath
    : workflowTitle
      ? session?.name || nativeSessionTitle
      : undefined;
  const setTabRefs = useCallback((node: HTMLDivElement | null) => {
    setNodeRef(node);
    tooltipAnchorRef.current = node;
  }, [setNodeRef]);
  const tabTrigger = (
    <div
      ref={setTabRefs}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "group relative flex shrink-0 items-center gap-1.5 px-3 text-xs cursor-grab active:cursor-grabbing select-none self-stretch",
        isActive
          ? "bg-background text-foreground"
          : "bg-zinc-800/85 text-muted-foreground hover:bg-zinc-800 hover:text-foreground",
        isDragging && "opacity-50 z-50",
      )}
      onClick={onSelect}
      onMouseEnter={tooltipContent ? tabTooltip.show : undefined}
      onMouseLeave={tooltipContent ? tabTooltip.hide : undefined}
      onFocus={tooltipContent ? tabTooltip.show : undefined}
      onBlur={tooltipContent ? tabTooltip.hide : undefined}
    >
      {/* Keep the active tab identifiable when it shares the pane background. */}
      {isActive && (
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-x-0 top-0 h-0.5 bg-primary",
            !isFocused && "opacity-60",
          )}
        />
      )}
      {icon}
      {titleElement}
      {isDirty && (
        <span
          className="h-2 w-2 rounded-full bg-muted-foreground"
          title="Unsaved changes"
        />
      )}
      {canClose && (
        <button
          className="ml-1 flex h-7 w-7 items-center justify-center opacity-100 transition-opacity hover:text-red-400 md:h-auto md:w-auto md:opacity-0 md:group-hover:opacity-100"
          onClick={handleClose}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents">{tabTrigger}</ContextMenuTrigger>
      {tooltipContent && (
        <HoverTooltipContent
          anchorRef={tooltipAnchorRef}
          open={tabTooltip.open}
          side="bottom"
          onMouseEnter={tabTooltip.show}
          onMouseLeave={tabTooltip.hide}
        >
          {tooltipContent}
        </HoverTooltipContent>
      )}

      <ContextMenuContent>
        {onRefresh && (
          <>
            <ContextMenuItem onClick={onRefresh}>Refresh</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onClick={onClose} disabled={!canClose || !onClose}>
          Close
        </ContextMenuItem>
        <ContextMenuItem onClick={onCloseAll} disabled={!canCloseAll || !onCloseAll}>
          Close all
        </ContextMenuItem>
        <ContextMenuItem onClick={onCloseOthers} disabled={!canCloseOthers || !onCloseOthers}>
          Close others
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={onCloseToRight}
          disabled={!canCloseToRight || !onCloseToRight}
        >
          Close to the right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
