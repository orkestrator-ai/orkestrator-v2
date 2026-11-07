import { detectShortcutPlatform } from "@/lib/keyboard-shortcuts";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { useCallback, useRef, type KeyboardEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  FileCode,
  FileText,
  GitPullRequest,
  Globe2,
  Paintbrush,
  Terminal as TerminalIcon,
  Hammer,
  Network,
  StickyNote,
  Workflow,
} from "lucide-react";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
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
import {
  createDraggableTabId,
  createPaneTabElementId,
  getNativeAgentData,
} from "@/types/paneLayout";
import { useSessionStore } from "@/stores/sessionStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { createSessionKey } from "@/lib/utils";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { StackedEyes } from "@/components/review/MultiReviewLaunchDialog";
import { useFileDirtyStore } from "@/stores";
import { openAgentMailForTab } from "@/components/agent-mail/agent-mail-ui";
import { agentMailCapabilities, resolveTabDisplayName } from "@orkestrator/protocol/agent-mail";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { getAllLeaves, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { TabType } from "@/contexts";
import { getWorkflowTabTitle } from "./workflow-tab-title";
import { TabLaunchOverrideMarker } from "./TabLaunchOverrideMarker";
import { TAB_ICON_CLASS, TabShell } from "./TabShell";
import { useConfigStore } from "@/stores/configStore";
import { usePreviewServiceStore } from "@/stores/previewServiceStore";
import { parsePreviewTabTarget } from "@orkestrator/protocol/preview-services";

/** Check if a tab type is an OpenCode variant (terminal or native mode) */
const isOpenCodeTab = (type: TabType): boolean => type === "opencode";

/** Check if a tab type is a Claude variant (terminal, native, or tmux mode) */
const isClaudeTab = (type: TabType): boolean => type === "claude" || type === "claude-tmux";

/** Check if a tab type is a Codex variant */
const isCodexTab = (type: TabType): boolean => type === "codex";

const isCursorTab = (type: TabType): boolean => type === "cursor";
const isGrokTab = (type: TabType): boolean => type === "grok";

/** Check if a tab type is a build pipeline tab */
const isBuildTab = (type: TabType): boolean => type === "claude-build";

interface DraggableTabProps {
  tab: TabInfo;
  /** Owning environment, used for environment-scoped authoritative state. */
  environmentId?: string;
  paneId: string;
  index: number;
  isActive: boolean;
  /** Whether this tab is focused (active tab in the focused pane) */
  isFocused?: boolean;
  onSelect: () => void;
  /** Reload this tab from its authoritative server-side state. */
  onRefresh?: () => void;
  onClose?: () => void;
  /** Closes the tab from the keyboard, keeping keyboard focus in the strip. */
  onKeyboardClose?: () => void;
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
  environmentId,
  paneId,
  index,
  isActive,
  isFocused = false,
  onSelect,
  onRefresh,
  onClose,
  onKeyboardClose,
  onCloseAll,
  onCloseOthers,
  onCloseToRight,
  canCloseAll = true,
  canCloseOthers = true,
  canCloseToRight = true,
  canClose,
}: DraggableTabProps) {
  // This node's messages panel (plan item 4001); the command node outside a node scope.
  const mailScope = useScopesWithCommandFallback().scope;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: createDraggableTabId(tab.id, paneId),
  });
  const tooltipAnchorRef = useRef<HTMLDivElement | null>(null);
  const tabTooltip = useHoverTooltip();

  // Get session for this tab to check for custom name
  const sessions = useSessionStore((state) => state.sessions);
  const session = Array.from(sessions.values()).find((s) => s.tabId === tab.id);
  const nativeAgentData = getNativeAgentData(tab);
  const owningEnvironmentId = environmentId ?? nativeAgentData?.environmentId;
  const tabOrdinal = usePaneLayoutStore((state) => {
    const paneState = owningEnvironmentId ? state.environments.get(owningEnvironmentId) : undefined;
    if (!paneState) return index + 1;
    const allTabs = getAllLeaves(paneState.root).flatMap((leaf) => leaf.tabs);
    const ordinal = allTabs.findIndex((candidate) => candidate.id === tab.id) + 1;
    return ordinal || index + 1;
  });
  const mailAgent = nativeAgentData?.platform
    ? nativeAgentData.platform
    : isAgentPlatform(tab.type)
      ? tab.type
      : tab.type === "claude-tmux"
        ? "claude"
        : null;
  const mailCapabilities = agentMailCapabilities(tab.type, mailAgent, Boolean(mailAgent));
  const messagingEnabled = useConfigStore(
    (state) => state.config.global.agentMessaging?.enabled === true,
  );

  /*
   * Agent-assigned session title. The neutral projection is the source for
   * every native provider.
   */
  const nativeSessionTitle = useNativeAgentProjectionStore((state) =>
    nativeAgentData
      ? state.projections.get(createSessionKey(nativeAgentData.environmentId, tab.id))?.title
      : undefined,
  );
  const workflowTitle = getWorkflowTabTitle(tab);

  // Get build pipeline title for claude-build tabs
  const buildPipelineTitle = useBuildPipelineStore((state) => {
    const pipelineId =
      tab.type === "claude-build"
        ? tab.buildTabData?.pipelineId
        : tab.type === "key-information"
          ? tab.keyInformationTabData?.pipelineId
          : undefined;
    if (!pipelineId) return undefined;
    return state.pipelines.get(pipelineId)?.taskTitle;
  });
  const multiReviewPhase = useMultiReviewStore((state) => {
    if (tab.type !== "multi-review" || !tab.multiReviewTabData) return undefined;
    return state.workflows.get(tab.multiReviewTabData.workflowId)?.phase;
  });

  // A service tab is named after its service once its environment's list is loaded.
  const serviceLabel = usePreviewServiceStore((state) => {
    if (tab.type !== "browser") return undefined;
    const target = parsePreviewTabTarget(tab.browserData?.url);
    if (target.kind !== "service") return undefined;
    return state.service(target.ref.environmentId, target.ref.serviceId)?.definition.label;
  });

  // Check if file tab has unsaved changes
  const isDirty = useFileDirtyStore((state) =>
    tab.type === "file" ? state.isDirty(tab.id) : false,
  );

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  // Get tab title based on type and session name
  const getTabTitle = () => {
    if (tab.type === "pull-request" && tab.pullRequestData) {
      const { ref, title } = tab.pullRequestData;
      return title ? `#${ref.number} ${title}` : `${ref.repo} #${ref.number}`;
    }
    if (tab.type === "file" && tab.fileData) {
      const parts = tab.fileData.filePath.split("/").filter(Boolean);
      return parts.at(-1) ?? tab.fileData.filePath;
    }

    // For terminal tabs, include session name if set
    const tabNumber = tabOrdinal;

    // Workflow tabs keep a stable numbered label instead of adopting the
    // agent-generated session title. "Conflict" supports restored tabs created
    // before the conflict-resolution label changed to "Resolve".
    if (workflowTitle) {
      return resolveTabDisplayName({
        tabType: tab.type,
        tabOrdinal,
        workflowLabel: workflowTitle,
      });
    }

    if (mailCapabilities.canPull) {
      return resolveTabDisplayName({
        tabType: tab.type,
        tabOrdinal,
        agent: mailAgent,
        customSessionName: session?.name,
        nativeSessionTitle,
        displayTitle: tab.displayTitle,
      });
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
    if (tab.type === "key-information" && tab.keyInformationTabData?.view === "notes") {
      return buildPipelineTitle ? `Notes: ${buildPipelineTitle}` : `Notes ${tabNumber}`;
    }
    if (tab.type === "key-information") {
      return buildPipelineTitle
        ? `Key info: ${buildPipelineTitle}`
        : `Key information ${tabNumber}`;
    }

    if (tab.type === "agent-native") {
      const label =
        nativeAgentData?.platform === "opencode"
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
    if (tab.type === "multi-review") {
      return multiReviewPhase === "completed" || multiReviewPhase === "interactive"
        ? "Multi Review ✓"
        : `Multi Review ${tabNumber}`;
    }
    if (tab.type === "design-canvas") return `Design ${tabNumber}`;
    if (tab.type === "graph-designer") return `Graphs ${tabNumber}`;
    if (tab.type === "graph-run") {
      return `${tab.graphRunData?.title?.trim() || "Graph run"} ${tabNumber}`;
    }
    if (tab.type === "browser") return `${serviceLabel || "Browser"} ${tabNumber}`;
    if (tab.type === "root") return `ROOT ${tabNumber}`;
    return `Tab ${tabNumber}`;
  };

  // Get tab icon based on type
  const getTabIcon = () => {
    if (tab.type === "file") {
      return <FileCode className="h-3 w-3 shrink-0" />;
    }
    if (tab.type === "design-canvas")
      return <Paintbrush className="h-3 w-3 shrink-0 text-violet-400" />;
    if (tab.type === "graph-designer")
      return <Network className="h-3 w-3 shrink-0 text-indigo-400" />;
    if (tab.type === "graph-run") return <Workflow className="h-3 w-3 shrink-0 text-indigo-400" />;
    if (tab.type === "key-information" && tab.keyInformationTabData?.view === "notes")
      return <StickyNote className="h-3 w-3 shrink-0 text-amber-400" />;
    if (tab.type === "key-information")
      return <FileText className="h-3 w-3 shrink-0 text-amber-400" />;
    if (tab.type === "browser") {
      return <Globe2 className="h-3 w-3 shrink-0 text-sky-400" />;
    }
    if (tab.type === "pull-request") {
      return <GitPullRequest className="h-3 w-3 shrink-0 text-success" />;
    }
    if (tab.type === "agent-native") {
      const platform = nativeAgentData?.platform;
      if (!platform) return <TerminalIcon className="h-3 w-3 shrink-0 text-muted-foreground" />;
      return <AgentPlatformIcon platform={platform} accent className={TAB_ICON_CLASS} />;
    }
    if (isOpenCodeTab(tab.type)) {
      return <AgentPlatformIcon platform="opencode" accent className={TAB_ICON_CLASS} />;
    }
    if (isClaudeTab(tab.type)) {
      return <AgentPlatformIcon platform="claude" accent className={TAB_ICON_CLASS} />;
    }
    if (isCodexTab(tab.type)) {
      return <AgentPlatformIcon platform="codex" accent className={TAB_ICON_CLASS} />;
    }
    if (isCursorTab(tab.type)) {
      return <AgentPlatformIcon platform="cursor" accent className={TAB_ICON_CLASS} />;
    }
    if (isGrokTab(tab.type)) {
      return <AgentPlatformIcon platform="grok" accent className={TAB_ICON_CLASS} />;
    }
    if (isBuildTab(tab.type)) {
      return <Hammer className="h-3 w-3 shrink-0 text-yellow-400" />;
    }
    if (tab.type === "multi-review") {
      return <StackedEyes className="size-3.5 shrink-0 text-cyan-400" />;
    }
    return <TerminalIcon className="h-3 w-3 shrink-0" />;
  };

  const title = getTabTitle();
  const icon = getTabIcon();
  const titleElement = (
    <>
      <span className="max-w-[120px] truncate">{title}</span>
    </>
  );
  const isFileTab = tab.type === "file" && !!tab.fileData;
  const tooltipContent = isFileTab
    ? tab.fileData?.filePath
    : tab.type === "pull-request" && tab.pullRequestData
      ? `${tab.pullRequestData.ref.owner}/${tab.pullRequestData.ref.repo} #${tab.pullRequestData.ref.number}${tab.pullRequestData.title ? ` · ${tab.pullRequestData.title}` : ""}`
      : workflowTitle
        ? session?.name || nativeSessionTitle
        : undefined;
  const setTabRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      tooltipAnchorRef.current = node;
    },
    [setNodeRef],
  );
  const isMac = detectShortcutPlatform() === "mac";
  const closeFromKeyboard = onKeyboardClose ?? onClose;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The close button inside the tab answers its own keys.
    if (event.target !== event.currentTarget) return;
    const hasModifier = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
    // During a keyboard drag these keys belong to the drag sensor.
    if (!isDragging) {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault();
        const { left, bottom } = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: left,
            clientY: bottom,
          }),
        );
        return;
      }
      if (event.key === "Enter" && !hasModifier) {
        // A real click, so the pane's own click handling runs as it does for a pointer.
        event.preventDefault();
        event.currentTarget.click();
        return;
      }
      if ((event.key === "Delete" || (isMac && event.key === "Backspace")) && !hasModifier) {
        event.preventDefault();
        // Focus moves to the next tab, so holding the key must not close them all.
        if (canClose && !event.repeat) closeFromKeyboard?.();
        return;
      }
    }
    // Space stays with the sortable, which announces it as the way to pick a tab up.
    listeners?.onKeyDown?.(event);
  };
  const tabTrigger = (
    <TabShell
      ref={setTabRefs}
      id={createPaneTabElementId(owningEnvironmentId, paneId, tab.id)}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      aria-label={isDirty ? `${title}, unsaved changes` : title}
      aria-haspopup="menu"
      aria-keyshortcuts={canClose ? (isMac ? "Delete Backspace" : "Delete") : undefined}
      // Only the drag instructions: the rest of `attributes` names a button role
      // and a "sortable" role description, which would be announced over the tab.
      aria-describedby={attributes["aria-describedby"]}
      style={style}
      {...listeners}
      onKeyDown={handleKeyDown}
      isActive={isActive}
      isFocused={isFocused}
      className={cn("cursor-grab active:cursor-grabbing", isDragging && "opacity-50 z-50")}
      onClick={onSelect}
      onMouseEnter={tooltipContent ? tabTooltip.show : undefined}
      onMouseLeave={tooltipContent ? tabTooltip.hide : undefined}
      onFocus={tooltipContent ? tabTooltip.show : undefined}
      onBlur={tooltipContent ? tabTooltip.hide : undefined}
      onClose={canClose ? () => onClose?.() : undefined}
      closeLabel={`Close ${title}`}
      closeTabIndex={-1}
    >
      {icon}
      {titleElement}
      {/* Only an agent tab can be a coordinator's worker; others never ask. A
          native tab can show before its platform is known, so its type is enough. */}
      {(mailAgent || tab.type === "agent-native") && owningEnvironmentId && (
        <TabLaunchOverrideMarker environmentId={owningEnvironmentId} tabId={tab.id} />
      )}
      {isDirty && (
        <span className="h-2 w-2 rounded-full bg-muted-foreground" title="Unsaved changes" />
      )}
    </TabShell>
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
        {owningEnvironmentId && messagingEnabled && mailCapabilities.canPull && (
          <>
            <ContextMenuItem
              onClick={() => openAgentMailForTab(owningEnvironmentId, tab.id, "inbox", mailScope)}
            >
              Messages…
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {onRefresh && (
          <>
            <ContextMenuItem onClick={onRefresh}>Refresh</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem
          // A menu item chosen with the keyboard clicks with a detail of 0.
          onClick={(event) => (event.detail === 0 ? closeFromKeyboard : onClose)?.()}
          disabled={!canClose || !onClose}
        >
          Close
        </ContextMenuItem>
        <ContextMenuItem onClick={onCloseAll} disabled={!canCloseAll || !onCloseAll}>
          Close all
        </ContextMenuItem>
        <ContextMenuItem onClick={onCloseOthers} disabled={!canCloseOthers || !onCloseOthers}>
          Close others
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onCloseToRight} disabled={!canCloseToRight || !onCloseToRight}>
          Close to the right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
