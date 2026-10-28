import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { FolderGit2, ListFilter, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
import { WORKSPACE_BAR_HEIGHT_CLASS } from "@/components/pane-layout/TabShell";
import { projectKey, projectRef } from "@orkestrator/protocol/federation";
import { useConfigStore } from "@/stores/configStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useUIStore } from "@/stores/uiStore";
import { onAppShortcut } from "@/lib/app-shortcuts";
import { formatCompactRelativeTime } from "@/lib/format-relative-time";
import { ALL_MACHINES, type MachineView } from "@/lib/federation/aggregate";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import {
  flattenProjectSearchResults,
  localSearchSource,
  machineAvailability,
  machineSearchSource,
  nextProjectSearchFilter,
  parseProjectSearchQuery,
  previousProjectSearchFilter,
  searchProjectsAndEnvironments,
  THIS_MACHINE,
  type ProjectSearchAvailability,
  type ProjectSearchFilter,
  type ProjectSearchHit,
  type ProjectSearchMachineFilter,
} from "@/lib/project-search";
import { cn } from "@/lib/utils";
import { useFederation } from "@/components/federation/FederationProvider";
import { MachineBadge, MachineDot, machineStatusText } from "@/components/federation/MachineDot";
import { useMachineViews } from "@/components/federation/useMachineViews";
import type { Environment, Project } from "@/types";

const FILTER_LABELS: Record<ProjectSearchFilter, string> = {
  all: "All",
  projects: "Projects",
  environments: "Environments",
};

const RESULTS_LIST_ID = "project-search-results";
const MACHINE_FILTER_THIS_LABEL = "This machine";

function projectSearchOptionId(hitId: string): string {
  return `project-search-option-${hitId}`;
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

function ShortcutHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="rounded-md border border-border/70 bg-zinc-900 px-1.5 py-0.5 font-sans text-[10px] font-medium text-zinc-300">
        {keys}
      </kbd>
      <span>{label}</span>
    </span>
  );
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
          className="shrink-0 rounded-md border border-amber-400/30 px-1 py-px text-[10px] text-amber-400/90"
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
        <span className="ml-auto shrink-0 text-[10px] text-amber-400/90">
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
  const rowProps = {
    ref: rowRef,
    type: "button" as const,
    id: projectSearchOptionId(hit.id),
    role: "option",
    tabIndex: -1,
    "data-testid": `project-search-item-${hit.id}`,
    "data-machine": hit.machine?.connectionId,
    "data-availability": hit.machine ? hit.availability : undefined,
    "aria-selected": isActive,
    "aria-label": hitLabel(hit),
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
      <span className="min-w-0 flex-1 truncate text-sm">{hit.environment.name}</span>
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
  onSelectProject,
  onSelectEnvironment,
  onSelectMachineProject,
}: {
  projects: Project[];
  environments: Environment[];
  onSelectProject: (projectId: string) => void;
  onSelectEnvironment: (environmentId: string) => void;
  /** Another machine's project was chosen: select and reveal it in the sidebar. */
  onSelectMachineProject?: (machine: MachineView, projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectSearchFilter>("all");
  const [machineFilterChoice, setMachineFilter] =
    useState<ProjectSearchMachineFilter>(ALL_MACHINES);
  const [selectedHitId, setSelectedHitId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement | null>(null);

  const recentProjectIds = useUIStore((state) => state.recentProjectIds);
  const recentKeys = useMachineViewStore((state) => state.recentKeys);
  const repositories = useConfigStore((state) => state.config.repositories);
  const federation = useFederation();
  const machineViews = useMachineViews();
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
      ...remoteMachines.map(machineSearchSource),
    ],
    [backendId, boundMachine, defaultBranches, environments, projects, remoteMachines],
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

  const results = useMemo(
    () =>
      searchProjectsAndEnvironments({
        query,
        filter,
        machineFilter,
        sources,
        recentKeys: searchRecentKeys,
      }),
    [query, filter, machineFilter, sources, searchRecentKeys],
  );
  const hits = useMemo(() => flattenProjectSearchResults(results), [results]);
  const selectedIndex = useMemo(() => {
    if (hits.length === 0) return -1;
    const index = selectedHitId ? hits.findIndex((hit) => hit.id === selectedHitId) : -1;
    return index >= 0 ? index : 0;
  }, [hits, selectedHitId]);
  const selectedHit = selectedIndex >= 0 ? hits[selectedIndex] : undefined;

  // Relative times are measured from when the search opens.
  const openSearch = () => {
    if (open) return;
    setNow(new Date());
    setOpen(true);
  };
  const handleOpenChange = (next: boolean) => {
    if (next) openSearch();
    else setOpen(false);
  };

  // ⌘K / Ctrl+K toggles the search from anywhere in the window, the
  // composer, terminals and workspace realms included (see `app-shortcuts.ts`).
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(
    () =>
      onAppShortcut("search-projects", () => {
        if (!openRef.current) setNow(new Date());
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
  // to the first hit.
  const [searchScope, setSearchScope] = useState({ open, query, filter, machineFilter });
  if (
    searchScope.open !== open ||
    searchScope.query !== query ||
    searchScope.filter !== filter ||
    searchScope.machineFilter !== machineFilter
  ) {
    setSearchScope({ open, query, filter, machineFilter });
    setSelectedHitId(null);
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
  }, [selectedIndex]);

  const handleSelect = (hit: ProjectSearchHit) => {
    const other = hit.machine && !hit.machine.bound ? hit.machine : null;
    if (hit.type === "project") {
      // Another machine's project is selected in the sidebar, under its
      // machine, even while that machine is offline (its last-known tree).
      if (other) onSelectMachineProject?.(other, hit.project.id);
      else onSelectProject(hit.project.id);
    } else if (other) {
      // Opened on its machine, as its sidebar row opens it (offline included).
      openMachineWorkspace({
        connectionId: other.connectionId,
        projectId: hit.environment.projectId,
        environmentId: hit.environment.id,
        title: hit.environment.name,
      });
    } else {
      onSelectEnvironment(hit.environment.id);
    }
    setOpen(false);
  };

  const moveSelection = (delta: number) => {
    if (hits.length === 0) return;
    const currentIndex = selectedHitId ? hits.findIndex((hit) => hit.id === selectedHitId) : 0;
    const safeIndex = currentIndex < 0 ? 0 : currentIndex;
    const nextIndex = Math.max(0, Math.min(safeIndex + delta, hits.length - 1));
    setSelectedHitId(hits[nextIndex]?.id ?? null);
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      setFilter((current) =>
        event.shiftKey ? previousProjectSearchFilter(current) : nextProjectSearchFilter(current),
      );
      return;
    }

    if (event.key === "Enter") {
      const selected = hits.find((hit) => hit.id === selectedHitId) ?? hits[0];
      if (!selected) return;
      event.preventDefault();
      handleSelect(selected);
    }
  };

  const shortcutLabel = useMemo(() => searchShortcutLabel(), []);
  const hasQuery = parseProjectSearchQuery(query).length > 0;
  const projectHeading = hasQuery ? "Projects" : "Recent projects";
  const environmentHeading = hasQuery ? "Environments" : "Recent environments";
  const machineFilterMachine =
    remoteMachines.find((machine) => machine.connectionId === machineFilter) ??
    (machineFilter === THIS_MACHINE ? boundMachine : null);
  const filterLabel = [
    FILTER_LABELS[filter],
    ...(machineFilter === ALL_MACHINES
      ? []
      : [machineFilterMachine?.name ?? MACHINE_FILTER_THIS_LABEL]),
  ].join(", ");

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
          className="ml-auto shrink-0 rounded-[5px] border border-border/70 bg-zinc-900 px-1.5 py-px font-sans text-[10px] font-medium text-zinc-300"
        >
          {shortcutLabel}
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          data-testid="project-search-dialog"
          size="2xl"
          className="gap-0 overflow-hidden p-0 sm:p-0"
        >
          <DialogTitle className="sr-only">Search projects and environments</DialogTitle>
          <DialogDescription className="sr-only">
            Search projects and environments, including containerized and local environments.
          </DialogDescription>

          <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={RESULTS_LIST_ID}
              aria-activedescendant={
                selectedHit ? projectSearchOptionId(selectedHit.id) : undefined
              }
              aria-autocomplete="list"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Search projects, environments..."
              aria-label="Search projects and environments"
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
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
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Filter results
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={filter}
                  onValueChange={(value) => {
                    if (value === "all" || value === "projects" || value === "environments") {
                      setFilter(value);
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="projects">Projects</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="environments">Environments</DropdownMenuRadioItem>
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

          <div
            id={RESULTS_LIST_ID}
            role="listbox"
            aria-label="Search results"
            className="max-h-[28rem] overflow-y-auto px-2 py-2"
          >
            {hits.length === 0 ? (
              <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                {sources.every((source) => source.projects.length === 0)
                  ? "No projects yet"
                  : hasQuery
                    ? "No projects or environments match that search."
                    : results.projectCount === 0
                      ? machineFilter !== THIS_MACHINE && machineFilterMachine
                        ? `No projects on ${machineFilterMachine.name}`
                        : "No projects on this machine"
                      : "No environments yet"}
              </div>
            ) : (
              <div className="space-y-3">
                {results.projects.length > 0 ? (
                  <section>
                    <h3 className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                      {projectHeading}
                    </h3>
                    <div className="space-y-0.5">
                      {results.projects.map((hit) => (
                        <ProjectSearchRow
                          key={hit.id}
                          hit={hit}
                          isActive={hit.id === selectedHit?.id}
                          now={now}
                          onHighlight={() => setSelectedHitId(hit.id)}
                          onSelect={handleSelect}
                          rowRef={
                            hit.id === selectedHit?.id
                              ? (node) => {
                                  selectedItemRef.current = node;
                                }
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </section>
                ) : null}

                {results.environments.length > 0 ? (
                  <section>
                    <h3 className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                      {environmentHeading}
                    </h3>
                    <div className="space-y-0.5">
                      {results.environments.map((hit) => (
                        <ProjectSearchRow
                          key={hit.id}
                          hit={hit}
                          isActive={hit.id === selectedHit?.id}
                          now={now}
                          onHighlight={() => setSelectedHitId(hit.id)}
                          onSelect={handleSelect}
                          rowRef={
                            hit.id === selectedHit?.id
                              ? (node) => {
                                  selectedItemRef.current = node;
                                }
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            )}
            {results.incomplete ? (
              <p
                className="px-3 pt-2 text-[11px] text-amber-400/90"
                data-testid="federated-search-incomplete"
              >
                Results may be incomplete: some machines are unavailable or not fully loaded.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-t border-border/70 px-4 py-2 text-[11px] text-zinc-500">
            <ShortcutHint keys="Enter" label="Open" />
            <ShortcutHint keys="Esc" label="Close" />
            <ShortcutHint keys="↑↓" label="Move" />
            <ShortcutHint keys="Tab" label="Filter" />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
