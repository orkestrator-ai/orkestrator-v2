import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowLeftRight, MessagesSquare } from "lucide-react";
import type { CoordinatorConversation } from "@orkestrator/protocol/coordinator";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { TAB_ICON_CLASS } from "@/components/pane-layout/TabShell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  canSplitCoordinatorPane,
  collectCoordinatorLeaves,
  moveCoordinatorConversation,
  splitCoordinatorPaneAtEdge,
  type CoordinatorPaneLayout,
  type CoordinatorPaneLeaf,
} from "@/lib/coordinator-pane-layout";
import { cn } from "@/lib/utils";
import { coordinatorTabElementId, SortableCoordinatorTab } from "./CoordinatorPaneTree";

/** Same reveal as the shell's close button: on hover or focus with a fine pointer. */
const TAB_ACTION_CLASS =
  "flex h-7 w-7 items-center justify-center text-muted-foreground opacity-100 transition-opacity hover:text-foreground focus-hairline disabled:pointer-events-none disabled:opacity-40 md:h-auto md:w-auto md:hover-fine:opacity-0 md:hover-fine:group-focus-within:opacity-100 md:hover-fine:group-hover:opacity-100 md:hover-fine:focus-visible:opacity-100";

/** A keyboard move owns focus until the user leaves its destination tab. */
function focusMovedTab(elementId: string) {
  const tab = document.getElementById(elementId);
  if (!tab) return;
  tab.setAttribute("data-preserve-focus", "");
  tab.addEventListener("blur", () => tab.removeAttribute("data-preserve-focus"), { once: true });
  tab.focus();
}

interface CoordinatorConversationTabProps {
  conversation: CoordinatorConversation;
  pane: CoordinatorPaneLeaf;
  layout: CoordinatorPaneLayout;
  paneFocused: boolean;
  /** Whether a main tab shows its Main marker: only once side agents are open beside it. */
  markMain: boolean;
  conversationBusy: boolean;
  onSelect: () => void;
  onClose: () => void;
  /** Close the main and start the next one on a platform the user picks. Main only. */
  onChangeAgent?: () => void;
  /** A tab group change; the page keeps the backend's selection on the focused group. */
  onLayoutChange: (change: (layout: CoordinatorPaneLayout) => CoordinatorPaneLayout) => void;
}

/**
 * One conversation's tab: its agent, title and Main marker, the Change agent
 * and close actions, and a menu for moving it between tab groups without
 * dragging. The menu opens on right-click, the context-menu key or Shift+F10,
 * and drops down from the tab rather than from the pointer, so it opens in
 * the same place from the keyboard.
 */
export function CoordinatorConversationTab({
  conversation: item,
  pane,
  layout,
  paneFocused,
  markMain,
  conversationBusy,
  onSelect,
  onClose,
  onChangeAgent,
  onLayoutChange,
}: CoordinatorConversationTabProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const tabRef = useRef<HTMLButtonElement>(null);
  const movedTabId = useRef<string | null>(null);
  const isMain = item.role === "main";
  const isActive = pane.activeConversationId === item.id;
  const showMain = isMain && markMain;
  const groups = collectCoordinatorLeaves(layout.root);
  const canSplit = canSplitCoordinatorPane(layout, pane.id);
  const changeAgent = isMain && item.agent ? onChangeAgent : undefined;
  // The badge is part of what identifies the tab, so it belongs in the
  // accessible name rather than being read as loose text after it.
  const name = [
    item.title,
    showMain ? "main" : null,
    item.agent ? AGENT_PLATFORM_LABELS[item.agent] : "no agent chosen yet",
  ]
    .filter(Boolean)
    .join(", ");
  const openMenu = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    movedTabId.current = null;
    setMenuOpen(true);
  };

  const moveTab = (change: (current: CoordinatorPaneLayout) => CoordinatorPaneLayout) => {
    onLayoutChange((current) => {
      const next = change(current);
      const destination = collectCoordinatorLeaves(next.root).find((group) =>
        group.conversationIds.includes(item.id),
      );
      const elementId = destination ? coordinatorTabElementId(destination.id, item.id) : null;
      movedTabId.current = elementId;
      // A React state updater can run after this event returns. Schedule
      // from the applied change so its destination ID exists before focus.
      if (elementId) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => focusMovedTab(elementId));
        });
      }
      return next;
    });
  };

  return (
    <SortableCoordinatorTab
      conversationId={item.id}
      paneId={pane.id}
      isActive={isActive}
      isFocused={paneFocused}
      onClick={(event) => {
        // Selecting is the whole action; the pane's own focus
        // handler would only repeat it with the previous tab.
        event.stopPropagation();
        onSelect();
      }}
      onContextMenu={openMenu}
      closeLabel={
        isMain
          ? `Close ${item.title}. The next message for the coordinator starts a new one with the default agent.`
          : `Close ${item.title}`
      }
      onClose={conversationBusy ? undefined : onClose}
    >
      <button
        ref={tabRef}
        type="button"
        role="tab"
        id={coordinatorTabElementId(pane.id, item.id)}
        aria-selected={isActive}
        aria-haspopup="menu"
        className="flex max-w-44 items-center gap-1.5 focus-hairline"
        aria-label={name}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            openMenu(event);
          }
        }}
      >
        {/* Which agent a conversation belongs to is fixed at its first
        prompt and cannot be changed afterwards, so the tab strip is
        where that has to be legible: the brand mark once assigned,
        and an explicit prompt while it is not. */}
        {item.agent ? (
          <AgentPlatformIcon platform={item.agent} accent className={TAB_ICON_CLASS} />
        ) : (
          <MessagesSquare className={cn(TAB_ICON_CLASS, "text-muted-foreground")} />
        )}
        <span className="truncate">{item.title}</span>
        {showMain ? (
          <span
            data-coordinator-main-marker=""
            className="shrink-0 rounded-sm border border-primary/40 px-1 text-[10px] leading-4 text-primary"
          >
            Main
          </span>
        ) : null}
        {item.agent ? null : (
          <span className="shrink-0 text-[10px] text-muted-foreground">Choose agent</span>
        )}
      </button>
      {/* Before close, where closing used to be the only way to change agent. */}
      {changeAgent ? (
        <button
          type="button"
          aria-label="Change agent"
          title="Change agent: start a new main conversation on another platform"
          className={cn("ml-1", TAB_ACTION_CLASS)}
          disabled={conversationBusy}
          onClick={(event) => {
            event.stopPropagation();
            changeAgent();
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <ArrowLeftRight className="h-3 w-3" />
        </button>
      ) : null}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {/* Only an anchor along the tab's bottom edge; the tab opens the menu. */}
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden="true"
            tabIndex={-1}
            className="pointer-events-none absolute inset-x-0 bottom-0"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          aria-label={`${item.title} actions`}
          // Portalled, but its events still bubble through the tab in React:
          // a click there is not a tab selection, nor a press a drag starts from.
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (movedTabId.current) {
              const elementId = movedTabId.current;
              requestAnimationFrame(() => {
                requestAnimationFrame(() => focusMovedTab(elementId));
              });
            } else {
              tabRef.current?.focus();
            }
          }}
        >
          {isMain ? (
            <>
              <DropdownMenuItem
                disabled={!changeAgent || conversationBusy}
                onSelect={() => changeAgent?.()}
              >
                Change agent…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem
            disabled={!canSplit}
            onSelect={() =>
              moveTab((current) =>
                splitCoordinatorPaneAtEdge(current, pane.id, "right", item.id, pane.id),
              )
            }
          >
            Move to new group
          </DropdownMenuItem>
          {groups.map((group, index) =>
            group.id === pane.id ? null : (
              <DropdownMenuItem
                key={group.id}
                onSelect={() =>
                  moveTab((current) =>
                    moveCoordinatorConversation(current, pane.id, group.id, item.id),
                  )
                }
              >
                Move to group {index + 1}
              </DropdownMenuItem>
            ),
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={conversationBusy} onSelect={onClose}>
            {isMain ? "Close…" : "Close"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SortableCoordinatorTab>
  );
}
