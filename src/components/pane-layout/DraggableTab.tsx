import { useCallback, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FileCode, Terminal as TerminalIcon, X, Hammer } from "lucide-react";
import { ClaudeIcon, CodexIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
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
import { createDraggableTabId } from "@/types/paneLayout";
import { useSessionStore } from "@/stores/sessionStore";
import { useClaudeStore, createClaudeSessionKey } from "@/stores/claudeStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useFileDirtyStore } from "@/stores";
import type { TabType } from "@/contexts";

/** Check if a tab type is an OpenCode variant (terminal or native mode) */
const isOpenCodeTab = (type: TabType): boolean =>
  type === "opencode" || type === "opencode-native";

/** Check if a tab type is a Claude variant (terminal, native, or tmux mode) */
const isClaudeTab = (type: TabType): boolean =>
  type === "claude" || type === "claude-native" || type === "claude-tmux";

/** Check if a tab type is a Codex variant */
const isCodexTab = (type: TabType): boolean =>
  type === "codex" || type === "codex-native";

/** Check if a tab type is a build pipeline tab */
const isBuildTab = (type: TabType): boolean => type === "claude-build";

interface DraggableTabProps {
  tab: TabInfo;
  paneId: string;
  index: number;
  isActive: boolean;
  /** Whether this tab is focused (active tab in the focused pane) */
  isFocused?: boolean;
  onSelect: () => void;
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
  const fileTooltipAnchorRef = useRef<HTMLDivElement | null>(null);
  const fileTooltip = useHoverTooltip();

  // Get session for this tab to check for custom name
  const sessions = useSessionStore((state) => state.sessions);
  const session = Array.from(sessions.values()).find((s) => s.tabId === tab.id);

  // Get Claude session title for claude-native tabs
  const claudeSessionTitle = useClaudeStore((state) => {
    if (tab.type !== "claude-native" || !tab.claudeNativeData) return undefined;
    const key = createClaudeSessionKey(
      tab.claudeNativeData.environmentId,
      tab.id,
    );
    return state.sessions.get(key)?.title;
  });

  // Get build pipeline title for claude-build tabs
  const buildPipelineTitle = useBuildPipelineStore((state) => {
    if (tab.type !== "claude-build" || !tab.buildTabData) return undefined;
    const pipeline = state.pipelines.get(tab.buildTabData.pipelineId);
    return pipeline?.taskTitle;
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
      const parts = tab.fileData.filePath.split("/");
      return parts[parts.length - 1] || tab.fileData.filePath;
    }

    // For terminal tabs, include session name if set
    const tabNumber = index + 1;

    if (session?.name) {
      // Custom session name + number for keyboard shortcut reference
      return `${session.name} ${tabNumber}`;
    }

    // Auto-generated title from Claude native session takes precedence over
    // the workflow-supplied displayTitle once the agent has named the session.
    if (claudeSessionTitle) {
      return claudeSessionTitle;
    }

    if (tab.displayTitle) {
      return `${tab.displayTitle} ${tabNumber}`;
    }

    // Build pipeline tab title
    if (isBuildTab(tab.type) && buildPipelineTitle) {
      return `Build: ${buildPipelineTitle}`;
    }

    // Default names
    if (tab.type === "plain") return `Terminal ${tabNumber}`;
    if (isClaudeTab(tab.type)) return `Claude ${tabNumber}`;
    if (isOpenCodeTab(tab.type)) return `OpenCode ${tabNumber}`;
    if (isCodexTab(tab.type)) return `Codex ${tabNumber}`;
    if (isBuildTab(tab.type)) return `Build ${tabNumber}`;
    if (tab.type === "root") return `ROOT ${tabNumber}`;
    return `Tab ${tabNumber}`;
  };

  // Get tab icon based on type
  const getTabIcon = () => {
    if (tab.type === "file") {
      return <FileCode className="h-3 w-3 shrink-0" />;
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
    if (isBuildTab(tab.type)) {
      return <Hammer className="h-3 w-3 shrink-0 text-yellow-400" />;
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
  const setTabRefs = useCallback((node: HTMLDivElement | null) => {
    setNodeRef(node);
    fileTooltipAnchorRef.current = node;
  }, [setNodeRef]);
  const tabTrigger = (
    <div
      ref={setTabRefs}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "group relative flex items-center gap-1.5 px-3 text-xs cursor-grab active:cursor-grabbing select-none self-stretch",
        isActive
          ? "bg-background text-foreground"
          : "bg-zinc-800/85 text-muted-foreground hover:bg-zinc-800 hover:text-foreground",
        isDragging && "opacity-50 z-50",
      )}
      onClick={onSelect}
      onMouseEnter={isFileTab ? fileTooltip.show : undefined}
      onMouseLeave={isFileTab ? fileTooltip.hide : undefined}
      onFocus={isFileTab ? fileTooltip.show : undefined}
      onBlur={isFileTab ? fileTooltip.hide : undefined}
    >
      {/* Blue focus indicator line at top */}
      {isFocused && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary" />
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
          className="ml-1 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
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
      {isFileTab && (
        <HoverTooltipContent
          anchorRef={fileTooltipAnchorRef}
          open={fileTooltip.open}
          side="bottom"
          onMouseEnter={fileTooltip.show}
          onMouseLeave={fileTooltip.hide}
        >
          {tab.fileData?.filePath}
        </HoverTooltipContent>
      )}

      <ContextMenuContent>
        <ContextMenuItem onClick={onClose} disabled={!canClose || !onClose}>
          Close
        </ContextMenuItem>
        <ContextMenuItem onClick={onCloseAll} disabled={!canCloseAll}>
          Close all
        </ContextMenuItem>
        <ContextMenuItem onClick={onCloseOthers} disabled={!canCloseOthers}>
          Close others
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onCloseToRight} disabled={!canCloseToRight}>
          Close to the right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
