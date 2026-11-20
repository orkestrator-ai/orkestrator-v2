import {
  useLayoutEffect,
  useMemo,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  RepositoryEnvironmentRows,
  type BoundEnvironmentRendering,
} from "@/components/federation/RepositoryEnvironmentList";
import { HoverPopoverPanel } from "@/components/ui/hover-popover";
import type { EnvironmentOrdering } from "@/lib/federation/environment-list";
import type { MachineView } from "@/lib/federation/aggregate";
import { isMachineShown } from "@/lib/federation/sidebar-layout";
import { useUIStore } from "@/stores/uiStore";
import type { Environment } from "@/types";
import { SortableEnvironmentRowFrame } from "./EnvironmentRowFrame";
import type { CompactRepository, CompactRepositoryStatus } from "./compact-repositories";

/** How the popover lists a repository's environments: the full sidebar's own rows. */
export interface CompactEnvironmentRendering {
  /** The machines the window names; empty in a window that names none. */
  machines: readonly MachineView[];
  ordering: EnvironmentOrdering;
  bound: BoundEnvironmentRendering;
  /** This window's environments of one project, as its project group lists them. */
  projectEnvironments: (projectId: string) => readonly Environment[];
}

/** Each row's focus target: the selectable region of an environment row. */
const ROW_FOCUS_SELECTOR = '[data-compact-popover-rows] [role="button"][tabindex="0"]';

function rowTargets(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(ROW_FOCUS_SELECTOR));
}

function EmptyRows() {
  return (
    <p data-testid="compact-popover-empty" className="px-3 py-2 text-xs text-muted-foreground">
      No environments
    </p>
  );
}

/** This window's own project, in a window that names no machines. */
function LocalProjectRows({
  projectId,
  rendering,
}: {
  projectId: string;
  rendering: CompactEnvironmentRendering;
}) {
  const multiSelecting = useUIStore((state) => state.selectedEnvironmentIds.length > 0);
  const environments = rendering.projectEnvironments(projectId);
  if (environments.length === 0) return <EmptyRows />;
  return (
    <>
      {environments.map((environment) => (
        <SortableEnvironmentRowFrame
          key={environment.id}
          sortableId={environment.id}
          sortable={false}
          selected={!multiSelecting && rendering.bound.selectedEnvironmentId === environment.id}
          name={environment.name}
          data={{ "data-testid": "repository-environment-row" }}
        >
          {rendering.bound.renderEnvironment(environment.id)}
        </SortableEnvironmentRowFrame>
      ))}
    </>
  );
}

/**
 * The popover beside a compact icon: the repository's name and status, then
 * its environments as the full sidebar lists them under its heading. Click or
 * Enter on an environment opens it as there and closes the popover; Escape or
 * Left closes it and returns focus to the icon; Up, Down, Home and End move
 * among the rows; Tab past either end returns to the icon.
 */
export function CompactRepositoryPopover({
  id,
  repository,
  status,
  getAnchor,
  open,
  rendering,
  autoFocus,
  onAutoFocused,
  onPointerEnter,
  onPointerLeave,
  onDismiss,
  onBlurOutside,
}: {
  id: string;
  /** The repository shown; kept while the popover closes. */
  repository: CompactRepository | null;
  status: CompactRepositoryStatus | undefined;
  /** The repository's icon. */
  getAnchor: () => HTMLElement | null;
  open: boolean;
  rendering: CompactEnvironmentRendering;
  /** Moves focus to the first row (or the panel) once it is drawn. */
  autoFocus: boolean;
  /** Focus has moved in; the caller clears `autoFocus`. */
  onAutoFocused: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /** Closes the popover; `returnFocus` puts focus back on the icon. */
  onDismiss: (returnFocus: boolean) => void;
  /** Focus moved somewhere other than the popover and its icon. */
  onBlurOutside: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { machines } = rendering;
  // The same machines compact lists repositories from: every connected one.
  const shownIds = useMemo(
    () => new Set(machines.filter(isMachineShown).map((machine) => machine.connectionId)),
    [machines],
  );

  useLayoutEffect(() => {
    if (!open || !autoFocus) return;
    const panel = panelRef.current;
    if (!panel) return;
    (rowTargets(panel)[0] ?? panel).focus();
    onAutoFocused();
  }, [autoFocus, onAutoFocused, open]);

  if (!repository) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      onDismiss(true);
      return;
    }
    const target = event.target as HTMLElement;
    if (
      (event.key === "Enter" || event.key === " ") &&
      target.closest("[data-environment-selection-id]")
    ) {
      // The row has opened its environment; the environment takes focus next.
      onDismiss(false);
      return;
    }
    const rows = rowTargets(panel);
    const current = rows.indexOf(target);
    if (event.key === "Tab") {
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      const index = focusable.indexOf(target);
      const leaving = event.shiftKey ? index <= 0 : index === focusable.length - 1;
      if (leaving) {
        event.preventDefault();
        onDismiss(true);
      }
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? current + 1
        : event.key === "ArrowUp"
          ? current - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : null;
    if (next === null || rows.length === 0) return;
    event.preventDefault();
    rows[Math.min(Math.max(next, 0), rows.length - 1)]?.focus();
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const modified = event.shiftKey || event.metaKey || event.ctrlKey;
    if (!modified && (event.target as HTMLElement).closest("[data-environment-selection-id]")) {
      onDismiss(false);
    }
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as HTMLElement | null;
    if (!next || panelRef.current?.contains(next) || next === getAnchor()) return;
    // A row's own menu or confirmation dialog takes focus; the popover holds them.
    if (next.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
    onBlurOutside();
  };

  const firstMember = repository.members[0];
  const listsMachines = firstMember?.machine !== undefined;

  return (
    <HoverPopoverPanel
      getAnchor={getAnchor}
      anchorKey={repository.key}
      open={open}
      id={id}
      role="dialog"
      aria-label={`${repository.name} environments`}
      data-testid="compact-repository-popover"
      data-repository={repository.key}
      tabIndex={-1}
      className="flex max-h-[min(28rem,calc(100vh-1rem))] w-72 flex-col overflow-hidden outline-hidden"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onBlur={handleBlur}
      panelRef={panelRef}
    >
      <div className="flex min-w-0 items-baseline gap-2 border-b border-divider px-3 pt-2.5 pb-2">
        <span className="truncate text-[13px] font-medium text-foreground">{repository.name}</span>
        {status && status.labels.length > 0 ? (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {status.labels.join(" · ")}
          </span>
        ) : null}
      </div>
      <div data-compact-popover-rows className="min-h-0 overflow-y-auto py-1">
        {listsMachines ? (
          <RepositoryEnvironmentRows
            machines={machines}
            shownIds={shownIds}
            repositoryKey={repository.key}
            ordering={rendering.ordering}
            bound={rendering.bound}
            empty={<EmptyRows />}
          />
        ) : firstMember ? (
          <LocalProjectRows projectId={firstMember.projectId} rendering={rendering} />
        ) : (
          <EmptyRows />
        )}
      </div>
    </HoverPopoverPanel>
  );
}
