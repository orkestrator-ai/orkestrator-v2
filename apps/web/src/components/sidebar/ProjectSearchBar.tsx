import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { FolderGit2, ListFilter, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusIndicator } from "@/components/environments/StatusIndicator";
import {
  EnvironmentNameShimmer,
  EnvironmentNameSignalMarker,
} from "@/components/environments/EnvironmentNameShimmer";
import {
  useEnvironmentIdNameSignal,
  useShimmerRequiresChecks,
} from "@/hooks/useEnvironmentNameSignal";
import { WORKSPACE_BAR_HEIGHT_CLASS } from "@/components/pane-layout/TabShell";
import { projectKey, projectRef } from "@orkestrator/protocol/federation";
import { useConfigStore } from "@/stores/configStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { useUIStore } from "@/stores/uiStore";
import { MOBILE_SHELL_MEDIA_QUERY } from "@/lib/mobile-shell";
import { onAppShortcut } from "@/lib/app-shortcuts";
import { formatCompactRelativeTime } from "@/lib/format-relative-time";
import { ALL_MACHINES, type MachineView } from "@/lib/federation/aggregate";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { projectLandingBoardTab, windowGroupingFor } from "@/lib/federation/window-grouping";
import {
  localSearchSource,
  machineAvailability,
  machineSearchSource,
  parseProjectSearchQuery,
  searchProjectsAndEnvironments,
  THIS_MACHINE,
  type ProjectSearchAvailability,
  type ProjectSearchFilter,
  type ProjectSearchHit,
  type ProjectSearchMachineFilter,
  type ProjectSearchResults,
} from "@/lib/project-search";
import { COMMAND_CATALOG, commandById } from "@/lib/command-palette/catalog";
import {
  commandAvailability,
  commandTarget,
  filterShowsGroup,
  isPaletteFilter,
  nextPaletteFilter,
  PALETTE_FILTER_LABELS,
  PALETTE_FILTERS,
  type CommandAvailability,
  type CommandDescriptor,
  type CommandNextStep,
  type CommandTarget,
  type PaletteFilter,
} from "@/lib/command-palette/model";
import {
  commandInMachineScope,
  searchCommands,
  type CommandResult,
} from "@/lib/command-palette/search";
import type { HistoryResult } from "@/lib/command-palette/history";
import { moveActiveRow, resolveActiveRow } from "@/lib/command-palette/selection";
import {
  CommandConfirmPanel,
  CommandRow,
  HistoryRow,
  PaletteContextBar,
  PaletteGroupHeading,
  paletteOptionId,
} from "@/components/command-palette/CommandPaletteParts";
import {
  openHistoryResult,
  useCommandPaletteContext,
  useCommandRuntime,
  useHistorySearch,
  usePaletteMeasurement,
  type CommandPaletteHandlers,
} from "@/components/command-palette/useCommandPalette";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { cn } from "@/lib/utils";
import { useFederation } from "@/components/federation/FederationProvider";
import { MachineBadge, MachineDot, machineStatusText } from "@/components/federation/MachineDot";
import { useExpandMachineProject } from "@/components/federation/useRevealMachineProject";
import { useMachineViews } from "@/components/federation/useMachineViews";
import type { Environment, Project } from "@/types";

const RESULTS_LIST_ID = "project-search-results";
const MACHINE_FILTER_THIS_LABEL = "This machine";
const NO_HANDLERS: CommandPaletteHandlers = {};
const NO_DESTINATIONS: ProjectSearchResults = {
  projects: [],
  environments: [],
  incomplete: false,
  projectCount: 0,
};

/** The destination search a palette filter runs, or none for a command group. */
function destinationFilter(filter: PaletteFilter): ProjectSearchFilter | null {
  return filter === "all" || filter === "projects" || filter === "environments" ? filter : null;
}

/** One row of the palette, in display order; `id` is unique across groups. */
type PaletteRow =
  | { kind: "destination"; id: string; hit: ProjectSearchHit }
  | { kind: "command"; id: string; result: CommandResult }
  | { kind: "history"; id: string; result: HistoryResult };

/** A command waiting for confirmation, with the target it was chosen for. */
interface PendingConfirmation {
  command: CommandDescriptor;
  target: CommandTarget;
}

function sameTarget(a: CommandTarget, b: CommandTarget): boolean {
  return (
    (a.machine?.connectionId ?? null) === (b.machine?.connectionId ?? null) &&
    (a.project?.id ?? null) === (b.project?.id ?? null) &&
    (a.environment?.id ?? null) === (b.environment?.id ?? null)
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

/** The open-search shortcut accepts either modifier; label it the way the platform does. */
export function searchShortcutLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl K";
  const platform = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘K" : "Ctrl K";
}

const AVAILABILITY_LABELS: Record<Exclude<ProjectSearchAvailability, "live">, string> = {
  offline: "offline",
  stale: "stale",
  loading: "loading",
};

function machineStatus(machine: MachineView): string {
  return machineStatusText({
    transport: machine.transport,
    freshness: machine.freshness,
    loadedAt: machine.loadedAt,
  });
}

/** The row's machine: dot and name, plus the offline/stale/loading marker. */
function HitMachineLabel({ hit }: { hit: ProjectSearchHit }) {
  const { machine, availability } = hit;
  if (!machine) return null;
  return (
    <span
      className="flex max-w-36 shrink-0 items-center gap-1.5"
      data-testid="project-search-machine"
    >
      <MachineBadge
        colorToken={machine.colorToken}
        machineName={machine.name}
        status={machineStatus(machine)}
      />
      {availability !== "live" ? (
        <span
          className="shrink-0 rounded-md border border-amber-400/30 px-1 py-px text-[11px] font-medium text-amber-400/90"
          data-testid="project-search-availability"
          title={machineStatus(machine)}
        >
          {AVAILABILITY_LABELS[availability]}
        </span>
      ) : null}
    </span>
  );
}

/** One connected machine in the Filter menu, marked while it is not live. */
function MachineFilterItem({ machine }: { machine: MachineView }) {
  const availability = machineAvailability(machine);
  return (
    <DropdownMenuRadioItem value={machine.connectionId} className="gap-2">
      <MachineDot colorToken={machine.colorToken} machineName={machine.name} />
      <span className="min-w-0 truncate">{machine.name}</span>
      {availability !== "live" ? (
        <span className="ml-auto shrink-0 text-[11px] font-medium text-amber-400/90">
          {AVAILABILITY_LABELS[availability]}
        </span>
      ) : null}
    </DropdownMenuRadioItem>
  );
}

/** Machine and project in the accessible name, where rows come from several machines. */
function hitLabel(hit: ProjectSearchHit): string | undefined {
  if (!hit.machine) return undefined;
  const state = hit.availability === "live" ? "" : `, ${AVAILABILITY_LABELS[hit.availability]}`;
  return hit.type === "project"
    ? `${hit.project.name}, project on ${hit.machine.name}${state}`
    : `${hit.environment.name}, environment of ${hit.project.name} on ${hit.machine.name}${state}`;
}

function ProjectSearchRow({
  hit,
  isActive,
  now,
  onHighlight,
  onSelect,
  rowRef,
}: {
  hit: ProjectSearchHit;
  isActive: boolean;
  now: Date;
  onHighlight: () => void;
  onSelect: (hit: ProjectSearchHit) => void;
  rowRef?: (node: HTMLButtonElement | null) => void;
}) {
  // This machine's rows read the live PR monitor and agent activity; another
  // machine's carry the ready answer from its summary.
  const isLocalEnvironmentHit = hit.type === "environment" && (!hit.machine || hit.machine.bound);
  const localNameSignal = useEnvironmentIdNameSignal(
    isLocalEnvironmentHit ? hit.environment.id : null,
  );
  const nameSignal =
    hit.type !== "environment"
      ? null
      : isLocalEnvironmentHit
        ? localNameSignal
        : hit.environment.readyToMerge === true
          ? "merge-ready"
          : null;
  const nameSignalDescriptionId = useId();
  const rowProps = {
    ref: rowRef,
    type: "button" as const,
    id: paletteOptionId(hit.id),
    role: "option",
    tabIndex: -1,
    "data-testid": `project-search-item-${hit.id}`,
    "data-machine": hit.machine?.connectionId,
    "data-availability": hit.machine ? hit.availability : undefined,
    "aria-selected": isActive,
    "aria-label": hitLabel(hit),
    "aria-describedby": nameSignal ? nameSignalDescriptionId : undefined,
    onMouseEnter: onHighlight,
    onClick: () => onSelect(hit),
    className: cn(
      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
      isActive ? "bg-zinc-800 text-foreground" : "text-zinc-200 hover:bg-zinc-800/70",
      // A machine's last-known rows while it is offline, stale or loading.
      hit.availability !== "live" && "opacity-60",
    ),
  };

  if (hit.type === "project") {
    return (
      <button {...rowProps}>
        <FolderGit2 className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm">{hit.project.name}</span>
        <HitMachineLabel hit={hit} />
        <span className="shrink-0 tabular-nums text-[11px] text-zinc-500">
          {hit.environmentCount}
        </span>
      </button>
    );
  }

  const age = formatCompactRelativeTime(
    hit.environment.lastActivityAt ?? hit.environment.createdAt,
    now,
  );

  return (
    <button {...rowProps}>
      <StatusIndicator status={hit.environment.status} className="shrink-0" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <EnvironmentNameShimmer signal={nameSignal} className="min-w-0 truncate text-sm">
          {hit.environment.name}
        </EnvironmentNameShimmer>
        <EnvironmentNameSignalMarker signal={nameSignal} descriptionId={nameSignalDescriptionId} />
      </span>
      {/* On a phone the name, project and machine take the row. */}
      <span className="hidden min-w-0 items-center gap-2 overflow-hidden text-[11px] text-zinc-500 sm:flex">
        {age ? <span className="tabular-nums">{age}</span> : null}
        {hit.isPrimary ? (
          <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-zinc-400">
            primary
          </span>
        ) : null}
        <span className="max-w-36 truncate">{hit.environment.branch}</span>
      </span>
      <span className="shrink-0 rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-400">
        {hit.project.name}
      </span>
      <HitMachineLabel hit={hit} />
    </button>
  );
}

export function ProjectSearchBar({
  projects,
  environments,
  allEnvironments = environments,
  onSelectProject,
  onSelectEnvironment,
  onSelectMachineProject,
  commandHandlers = NO_HANDLERS,
}: {
  projects: Project[];
  environments: Environment[];
  /**
   * Every environment of this window's machine, project homes included: what
   * the palette's commands may act on. Defaults to `environments`.
   */
  allEnvironments?: Environment[];
  onSelectProject: (projectId: string) => void;
  onSelectEnvironment: (environmentId: string) => void;
  /**
   * Another machine's project, or an environment of one, was chosen: select
   * and reveal the project in the sidebar. The search opens it itself.
   */
  onSelectMachineProject?: (machine: MachineView, projectId: string) => void;
  /** The sidebar's own environment and project handlers, which commands reuse. */
  commandHandlers?: CommandPaletteHandlers;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PaletteFilter>("all");
  const [machineFilterChoice, setMachineFilter] =
    useState<ProjectSearchMachineFilter>(ALL_MACHINES);
  /** The row the user chose with the keyboard or pointer. */
  const [chosenRowId, setChosenRowId] = useState<string | null>(null);
  /** The row highlighted when the current query's results appeared. */
  const [pinnedRowId, setPinnedRowId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [now, setNow] = useState(() => new Date());
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement | null>(null);
  /** Where focus was when the palette opened; dismissing returns it there. */
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /** The palette closed because a result ran: the destination takes focus. */
  const closedByActivationRef = useRef(false);

  const recentProjectIds = useUIStore((state) => state.recentProjectIds);
  const recentKeys = useMachineViewStore((state) => state.recentKeys);
  const repositories = useConfigStore((state) => state.config.repositories);
  const recentCommandIds = useCommandPaletteStore((state) => state.recentCommandIds);
  const noteCommand = useCommandPaletteStore((state) => state.noteCommand);
  const requireChecks = useShimmerRequiresChecks();
  const federation = useFederation();
  const machineViews = useMachineViews();
  const paletteMachines = useMemo(
    () => (federation.enabled ? machineViews : []),
    [federation.enabled, machineViews],
  );
  // Other machines are searched in a multi-machine view only; each row is
  // then labelled with its machine, this window's own included.
  const boundMachine = federation.enabled
    ? (machineViews.find((machine) => machine.bound) ?? null)
    : null;
  const remoteMachines = useMemo(
    () => (federation.enabled ? machineViews.filter((machine) => !machine.bound) : []),
    [federation.enabled, machineViews],
  );
  const backendId = boundMachine?.backendId ?? federation.bound?.backendId ?? null;
  // A connection the filter named may have been forgotten since.
  const machineFilter =
    machineFilterChoice === ALL_MACHINES ||
    machineFilterChoice === THIS_MACHINE ||
    remoteMachines.some((machine) => machine.connectionId === machineFilterChoice)
      ? machineFilterChoice
      : ALL_MACHINES;

  const defaultBranches = useMemo(() => {
    const branches = new Map<string, string>();
    for (const project of projects) {
      branches.set(project.id, repositories[project.id]?.defaultBranch ?? "main");
    }
    return branches;
  }, [projects, repositories]);

  const sources = useMemo(
    () => [
      localSearchSource({
        machine: boundMachine,
        backendId,
        projects,
        environments,
        defaultBranches,
      }),
      ...remoteMachines.map((machine) => machineSearchSource(machine, requireChecks)),
    ],
    [
      backendId,
      boundMachine,
      defaultBranches,
      environments,
      projects,
      remoteMachines,
      requireChecks,
    ],
  );
  // Recently used on any machine, newest first, then this machine's older
  // recent projects (recorded before cross-machine recents existed).
  const searchRecentKeys = useMemo(
    () => [
      ...recentKeys,
      ...recentProjectIds.map((id) => (backendId ? projectKey(projectRef(backendId, id)) : id)),
    ],
    [backendId, recentKeys, recentProjectIds],
  );

  const projectFilter = destinationFilter(filter);
  const results = useMemo(
    () =>
      projectFilter
        ? searchProjectsAndEnvironments({
            query,
            filter: projectFilter,
            machineFilter,
            sources,
            recentKeys: searchRecentKeys,
          })
        : NO_DESTINATIONS,
    [query, projectFilter, machineFilter, sources, searchRecentKeys],
  );

  const {
    context,
    refresh: refreshContext,
    shownSelection,
  } = useCommandPaletteContext({
    open,
    projects,
    environments: allEnvironments,
    machines: paletteMachines,
    handlers: commandHandlers,
    requireChecks,
  });
  const runtime = useCommandRuntime({ handlers: commandHandlers, machines: paletteMachines });
  const measurement = usePaletteMeasurement(open);
  const hasQuery = parseProjectSearchQuery(query).length > 0;

  const commandResults = useMemo(
    () =>
      searchCommands({
        query,
        filter,
        machineFilter,
        commands: COMMAND_CATALOG,
        context,
        recentCommandIds,
      }),
    [context, filter, machineFilter, query, recentCommandIds],
  );
  // History answers later: an empty query lists it only in its own category.
  const historyEnabled =
    open && filterShowsGroup(filter, "history") && (hasQuery || filter === "history");
  const history = useHistorySearch({
    context,
    query,
    enabled: historyEnabled,
    environments: allEnvironments,
    machines: paletteMachines,
  });
  const historyRows = useMemo(
    () =>
      history.rows.filter((row) =>
        commandInMachineScope(
          { machine: row.machine, project: null, environment: null },
          machineFilter,
        ),
      ),
    [history.rows, machineFilter],
  );

  // Fixed group order: destinations, actions, settings, history. A late
  // History answer can only add rows at the end.
  const rows = useMemo<PaletteRow[]>(
    () => [
      ...results.projects.map((hit) => ({ kind: "destination" as const, id: hit.id, hit })),
      ...results.environments.map((hit) => ({ kind: "destination" as const, id: hit.id, hit })),
      ...commandResults.actions.map((result) => ({
        kind: "command" as const,
        id: result.rowId,
        result,
      })),
      ...commandResults.settings.map((result) => ({
        kind: "command" as const,
        id: result.rowId,
        result,
      })),
      ...historyRows.map((result) => ({ kind: "history" as const, id: result.rowId, result })),
    ],
    [commandResults, historyRows, results],
  );
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const activeRowId = resolveActiveRow(rowIds, chosenRowId, pinnedRowId);
  // The highlight holds its row while later answers arrive; it is pinned the
  // first time this query shows a row, and re-pinned only if that row goes.
  if (open && chosenRowId === null && activeRowId !== pinnedRowId) setPinnedRowId(activeRowId);
  const activeRow = rows.find((row) => row.id === activeRowId);

  // Relative times are measured from when the search opens.
  const rememberFocus = () => {
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    closedByActivationRef.current = false;
  };
  const openSearch = () => {
    if (open) return;
    rememberFocus();
    setNow(new Date());
    setOpen(true);
  };
  const handleOpenChange = (next: boolean) => {
    if (next) openSearch();
    else setOpen(false);
  };

  // ⌘K / Ctrl+K toggles the search from anywhere in the window, the
  // composer, terminals and other nodes' workspaces included (see `app-shortcuts.ts`).
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(
    () =>
      onAppShortcut("search-projects", () => {
        // Closing content remains mounted until motion settles. Reopen its
        // desktop panel before the search can be unmounted by that timer.
        const chrome = useUIChromeStore.getState();
        if (!window.matchMedia(MOBILE_SHELL_MEDIA_QUERY).matches && !chrome.sidebarOpen) {
          chrome.toggleSidebar();
          openRef.current = false;
        }
        if (!openRef.current) {
          const active = document.activeElement;
          restoreFocusRef.current = active instanceof HTMLElement ? active : null;
          closedByActivationRef.current = false;
          setNow(new Date());
        }
        openRef.current = !openRef.current;
        setOpen(openRef.current);
      }),
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!open || event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setOpen(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Closing clears the search; a new query or filter moves the selection back
  // to the first row and leaves a pending confirmation.
  const [searchScope, setSearchScope] = useState({ open, query, filter, machineFilter });
  if (
    searchScope.open !== open ||
    searchScope.query !== query ||
    searchScope.filter !== filter ||
    searchScope.machineFilter !== machineFilter
  ) {
    setSearchScope({ open, query, filter, machineFilter });
    setChosenRowId(null);
    setPinnedRowId(null);
    setConfirmation(null);
    if (!open) {
      setQuery("");
      setFilter("all");
      setMachineFilter(ALL_MACHINES);
    }
  }

  useEffect(() => {
    if (!open) return;
    const timeoutId = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [open]);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeRowId]);

  // Counted once per query that finds nothing anywhere (never the query itself).
  const settled = history.status !== "loading";
  const noResults = open && hasQuery && settled && rows.length === 0;
  useEffect(() => {
    if (noResults) measurement.noResults();
  }, [measurement, noResults, query]);

  const expandMachineProject = useExpandMachineProject();

  const closeAfterActivation = () => {
    closedByActivationRef.current = true;
    setOpen(false);
  };

  const handleSelect = (hit: ProjectSearchHit) => {
    measurement.activated({ kind: "destination", destination: hit.type });
    const other = hit.machine && !hit.machine.bound ? hit.machine : null;
    if (hit.type === "project") {
      if (other) {
        // Another machine's project is selected in the sidebar, under its
        // machine, even while that machine is offline (its last-known tree),
        // and opened there as its sidebar row opens it.
        onSelectMachineProject?.(other, hit.project.id);
        // Read after the reveal, which can switch the sidebar's grouping.
        const grouping = windowGroupingFor(
          useUIChromeStore.getState().environmentSortMode,
          useMachineViewStore.getState().grouping,
          window.matchMedia(MOBILE_SHELL_MEDIA_QUERY).matches,
        );
        const landingTab = projectLandingBoardTab(grouping, false);
        openMachineWorkspace({
          connectionId: other.connectionId,
          projectId: hit.project.id,
          ...(landingTab ? { landingTab } : {}),
          title: hit.project.name,
        });
      } else {
        onSelectProject(hit.project.id);
      }
    } else if (other) {
      // Make the environment visible without the project reveal's grouping
      // change: activity view already renders environment rows directly.
      expandMachineProject(other, hit.environment.projectId);
      openMachineWorkspace({
        connectionId: other.connectionId,
        projectId: hit.environment.projectId,
        environmentId: hit.environment.id,
        title: hit.environment.name,
      });
    } else {
      onSelectEnvironment(hit.environment.id);
    }
    closeAfterActivation();
  };

  /** Runs a command once on its frozen target; the owner reports the outcome. */
  const runCommand = (command: CommandDescriptor, target: CommandTarget) => {
    measurement.activated({ kind: "command", commandId: command.id });
    noteCommand(command.id);
    closeAfterActivation();
    // Run once and never retried here: a failure or a lost answer is
    // reported by the handler's owner (a toast, the row's state), and
    // repeating it is the user's call.
    try {
      void Promise.resolve(command.run(target, runtime)).catch(() => undefined);
    } catch (error) {
      toast.error(`${command.label} failed`, {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const followNextStep = (step: CommandNextStep) => {
    if (step.kind === "filter") {
      setFilter(step.filter);
      inputRef.current?.focus();
      return;
    }
    if (step.kind === "refresh-context") {
      refreshContext();
      inputRef.current?.focus();
      return;
    }
    const next = commandById(step.commandId);
    if (!next) return;
    const availability = commandAvailability(next, context);
    // A next step is always a destination; it never runs a change unasked.
    if (!availability.available || next.effect === "mutation") return;
    runCommand(next, commandTarget(next, context));
  };

  const handleCommand = (result: CommandResult) => {
    const { command } = result;
    // Decided now, from live state, for the target frozen at open.
    const availability = commandAvailability(command, context);
    if (!availability.available) {
      measurement.unavailable(command.id, availability.code);
      if (availability.nextStep) followNextStep(availability.nextStep);
      return;
    }
    const target = commandTarget(command, context);
    if (command.confirm) {
      setConfirmation({ command, target });
      return;
    }
    runCommand(command, target);
  };

  // The confirmation re-reads its command's availability for the frozen target.
  const confirmationAvailability = ((): CommandAvailability | null => {
    if (!confirmation) return null;
    const availability = commandAvailability(confirmation.command, context);
    if (!availability.available) return availability;
    return sameTarget(commandTarget(confirmation.command, context), confirmation.target)
      ? availability
      : {
          available: false,
          reason: "The target changed since this was chosen",
          code: "target-missing",
        };
  })();

  const confirmCommand = () => {
    if (!confirmation || !confirmationAvailability) return;
    if (!confirmationAvailability.available) {
      measurement.revalidationFailed(confirmation.command.id, confirmationAvailability.code);
      return;
    }
    runCommand(confirmation.command, confirmation.target);
  };

  const backFromConfirmation = useCallback(() => {
    setConfirmation(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const handleHistory = (result: HistoryResult) => {
    measurement.activated({ kind: "history" });
    openHistoryResult(result);
    closeAfterActivation();
  };

  const activateRow = (row: PaletteRow) => {
    if (row.kind === "destination") handleSelect(row.hit);
    else if (row.kind === "command") handleCommand(row.result);
    else handleHistory(row.result);
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = moveActiveRow(rowIds, activeRowId, event.key === "ArrowDown" ? 1 : -1);
      if (next !== null) setChosenRowId(next);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      setFilter((current) => nextPaletteFilter(current, event.shiftKey ? -1 : 1));
      return;
    }

    if (event.key === "Enter") {
      // Composing an IME character: Enter commits the text, not a result.
      if (event.nativeEvent.isComposing) return;
      if (!activeRow) return;
      event.preventDefault();
      activateRow(activeRow);
    }
  };

  const shortcutLabel = useMemo(() => searchShortcutLabel(), []);
  const projectHeading = hasQuery ? "Projects" : "Recent projects";
  const environmentHeading = hasQuery ? "Environments" : "Recent environments";
  const actionsHeading = hasQuery || filter !== "all" ? "Actions" : "Suggested actions";
  const machineFilterMachine =
    remoteMachines.find((machine) => machine.connectionId === machineFilter) ??
    (machineFilter === THIS_MACHINE ? boundMachine : null);
  const filterLabel = [
    PALETTE_FILTER_LABELS[filter],
    ...(machineFilter === ALL_MACHINES
      ? []
      : [machineFilterMachine?.name ?? MACHINE_FILTER_THIS_LABEL]),
  ].join(", ");
  const showsDestinations = projectFilter !== null;
  const destinationCount = results.projects.length + results.environments.length;
  // In All, a query that matches only commands shows them without a
  // destination "no match" line above; the line stays when nothing matches.
  const destinationEmptyText =
    !showsDestinations || destinationCount > 0 || (filter === "all" && hasQuery && rows.length > 0)
      ? null
      : sources.every((source) => source.projects.length === 0)
        ? "No projects yet"
        : hasQuery
          ? "No projects or environments match that search."
          : results.projectCount === 0
            ? machineFilter !== THIS_MACHINE && machineFilterMachine
              ? `No projects on ${machineFilterMachine.name}`
              : "No projects on this machine"
            : "No environments yet";
  const shownName = (() => {
    if (context.selectionCurrent) return null;
    const environment = allEnvironments.find((entry) => entry.id === shownSelection.environmentId);
    if (environment) return environment.name;
    const project = projects.find((entry) => entry.id === shownSelection.projectId);
    return project?.name ?? null;
  })();

  const rowRef = (id: string) =>
    id === activeRowId
      ? (node: HTMLButtonElement | null) => {
          selectedItemRef.current = node;
        }
      : undefined;

  const renderDestination = (hit: ProjectSearchHit) => (
    <ProjectSearchRow
      key={hit.id}
      hit={hit}
      isActive={hit.id === activeRowId}
      now={now}
      onHighlight={() => setChosenRowId(hit.id)}
      onSelect={handleSelect}
      rowRef={rowRef(hit.id)}
    />
  );
  const renderCommand = (result: CommandResult) => (
    <CommandRow
      key={result.rowId}
      result={result}
      context={context}
      isActive={result.rowId === activeRowId}
      onHighlight={() => setChosenRowId(result.rowId)}
      onSelect={handleCommand}
      rowRef={rowRef(result.rowId)}
    />
  );

  return (
    <div
      data-testid="project-search-bar"
      className={cn(
        "flex shrink-0 items-center border-b border-border/80 bg-chrome px-2",
        WORKSPACE_BAR_HEIGHT_CLASS,
      )}
    >
      <button
        type="button"
        data-testid="project-search-trigger"
        aria-label="Search projects and environments"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={openSearch}
        // Borderless, so the padding is purely optical: it puts the icon's ink
        // under the header's "Projects" title (pl-3) and the badge's right edge
        // under the ink of the header's 28px "+" button (pr-2).
        className="flex h-8 w-full items-center gap-2 rounded-lg bg-input-surface pl-[3px] pr-[9px] text-left text-sm text-muted-foreground transition-colors hover:bg-elevated hover:text-foreground md:h-7"
      >
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">Search projects, environments...</span>
        <kbd
          data-testid="project-search-shortcut"
          aria-hidden="true"
          className="ml-auto shrink-0 rounded-[5px] border border-border/70 bg-zinc-900 px-1.5 py-px font-sans text-[11px] font-medium text-zinc-300"
        >
          {shortcutLabel}
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          data-testid="project-search-dialog"
          size="2xl"
          overlayClassName="z-[90]"
          className="z-[90] gap-0 overflow-hidden p-0 sm:p-0"
          onEscapeKeyDown={(event) => {
            // Escape leaves a confirmation first; the palette stays open.
            if (!confirmation) return;
            event.preventDefault();
            backFromConfirmation();
          }}
          onCloseAutoFocus={(event) => {
            // Dismissed: back to where the user was. Activated: the
            // destination owns focus now.
            event.preventDefault();
            const previous = restoreFocusRef.current;
            restoreFocusRef.current = null;
            if (!closedByActivationRef.current && previous?.isConnected) previous.focus();
          }}
        >
          <DialogTitle className="sr-only">Search projects and environments</DialogTitle>
          <DialogDescription className="sr-only">
            Search projects and environments, including containerized and local environments, and
            run actions, open settings or reopen tabs.
          </DialogDescription>

          {/*
           * The focus line frames an inset field rather than the full-width header,
           * whose square corners the dialog's rounded clip would cut off.
           */}
          <div className="flex items-center gap-1.5 border-b border-border/70 px-2.5 py-2">
            <div
              data-testid="project-search-field"
              className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[9px] bg-input-surface px-2.5 has-[>input:focus-visible]:focus-hairline-frame"
            >
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                ref={inputRef}
                role="combobox"
                aria-expanded="true"
                aria-controls={RESULTS_LIST_ID}
                aria-activedescendant={activeRowId ? paletteOptionId(activeRowId) : undefined}
                aria-autocomplete="list"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Search projects, environments, actions, settings..."
                aria-label="Search projects and environments"
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                disabled={confirmation !== null}
                className="h-8 min-w-0 flex-1 !bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="project-search-filter"
                  className="h-8 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
                  aria-label={`Filter results: ${filterLabel}`}
                >
                  <ListFilter className="h-3.5 w-3.5" aria-hidden="true" />
                  Filter
                  {machineFilterMachine && machineFilter !== ALL_MACHINES ? (
                    <MachineDot
                      colorToken={machineFilterMachine.colorToken}
                      machineName={machineFilterMachine.name}
                    />
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[100] w-52">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Filter results
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={filter}
                  onValueChange={(value) => {
                    if (isPaletteFilter(value)) setFilter(value);
                  }}
                >
                  {PALETTE_FILTERS.map((option) => (
                    <DropdownMenuRadioItem key={option} value={option}>
                      {PALETTE_FILTER_LABELS[option]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {remoteMachines.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Machine
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={machineFilter}
                      onValueChange={(value) => setMachineFilter(value)}
                      data-testid="project-search-machine-filter"
                    >
                      <DropdownMenuRadioItem value={ALL_MACHINES}>
                        All machines
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value={THIS_MACHINE}>
                        <span className="min-w-0 truncate">
                          {MACHINE_FILTER_THIS_LABEL}
                          {boundMachine ? ` (${boundMachine.name})` : ""}
                        </span>
                      </DropdownMenuRadioItem>
                      {remoteMachines.map((machine) => (
                        <MachineFilterItem key={machine.connectionId} machine={machine} />
                      ))}
                    </DropdownMenuRadioGroup>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <PaletteContextBar context={context} shownName={shownName} onRefresh={refreshContext} />

          {confirmation && confirmationAvailability ? (
            <CommandConfirmPanel
              command={confirmation.command}
              target={confirmation.target}
              availability={confirmationAvailability}
              onBack={backFromConfirmation}
              onConfirm={confirmCommand}
            />
          ) : (
            <div
              id={RESULTS_LIST_ID}
              role="listbox"
              aria-label="Search results"
              className="max-h-[28rem] overflow-y-auto px-2 py-2"
            >
              <div className="space-y-3">
                {destinationEmptyText ? (
                  <div
                    className={cn(
                      "px-3 text-center text-sm text-muted-foreground",
                      rows.length === 0 ? "py-10" : "py-2",
                    )}
                  >
                    {destinationEmptyText}
                  </div>
                ) : null}

                {results.projects.length > 0 ? (
                  <section>
                    <PaletteGroupHeading>{projectHeading}</PaletteGroupHeading>
                    <div className="space-y-0.5">{results.projects.map(renderDestination)}</div>
                  </section>
                ) : null}

                {results.environments.length > 0 ? (
                  <section>
                    <PaletteGroupHeading>{environmentHeading}</PaletteGroupHeading>
                    <div className="space-y-0.5">{results.environments.map(renderDestination)}</div>
                  </section>
                ) : null}

                {commandResults.actions.length > 0 ? (
                  <section data-testid="command-palette-actions">
                    <PaletteGroupHeading>{actionsHeading}</PaletteGroupHeading>
                    <div className="space-y-0.5">{commandResults.actions.map(renderCommand)}</div>
                  </section>
                ) : null}

                {commandResults.settings.length > 0 ? (
                  <section data-testid="command-palette-settings">
                    <PaletteGroupHeading>Settings</PaletteGroupHeading>
                    <div className="space-y-0.5">{commandResults.settings.map(renderCommand)}</div>
                  </section>
                ) : null}

                {historyEnabled && (historyRows.length > 0 || history.status !== "ready") ? (
                  <section data-testid="command-palette-history">
                    <PaletteGroupHeading status={history.status}>Open tabs</PaletteGroupHeading>
                    {history.status === "failed" ? (
                      <p className="px-3 text-[11px] text-amber-400/90">
                        Open tabs could not be searched.
                      </p>
                    ) : null}
                    <div className="space-y-0.5">
                      {historyRows.map((result) => (
                        <HistoryRow
                          key={result.rowId}
                          result={result}
                          multiMachine={context.multiMachine}
                          isActive={result.rowId === activeRowId}
                          onHighlight={() => setChosenRowId(result.rowId)}
                          onSelect={handleHistory}
                          rowRef={rowRef(result.rowId)}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}

                {noResults ? (
                  <p
                    className="px-3 text-center text-[11px] text-muted-foreground"
                    data-testid="command-palette-no-results"
                  >
                    {filter === "all" && machineFilter === ALL_MACHINES
                      ? "Nothing matches. Try other words, or Settings and History in the filter."
                      : "Nothing matches here. Try All categories and All machines in the filter."}
                  </p>
                ) : null}
              </div>
              {results.incomplete ? (
                <p
                  className="px-3 pt-2 text-[11px] text-amber-400/90"
                  data-testid="federated-search-incomplete"
                >
                  Results may be incomplete: some machines are unavailable or not fully loaded.
                </p>
              ) : null}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-t border-border/70 px-4 py-2 text-[11px] text-zinc-500">
            {confirmation ? (
              <>
                <ShortcutHint keys="Enter" label={confirmation.command.confirm?.verb ?? "Run"} />
                <ShortcutHint keys="Esc" label="Back" />
              </>
            ) : (
              <>
                <ShortcutHint keys="Enter" label={activeRow?.kind === "command" ? "Run" : "Open"} />
                <ShortcutHint keys="Esc" label="Close" />
                <ShortcutHint keys="↑↓" label="Move" />
                <ShortcutHint keys="Tab" label="Filter" />
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
