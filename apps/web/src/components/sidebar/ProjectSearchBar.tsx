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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusIndicator } from "@/components/environments/StatusIndicator";
import { WORKSPACE_BAR_HEIGHT_CLASS } from "@/components/pane-layout/TabShell";
import { useConfigStore } from "@/stores/configStore";
import { useUIStore } from "@/stores/uiStore";
import { formatCompactRelativeTime } from "@/lib/format-relative-time";
import {
  buildProjectSearchResults,
  flattenProjectSearchResults,
  nextProjectSearchFilter,
  parseProjectSearchQuery,
  previousProjectSearchFilter,
  type ProjectSearchFilter,
  type ProjectSearchHit,
} from "@/lib/project-search";
import { cn } from "@/lib/utils";
import type { Environment, Project } from "@/types";

const FILTER_LABELS: Record<ProjectSearchFilter, string> = {
  all: "All",
  projects: "Projects",
  environments: "Environments",
};

const RESULTS_LIST_ID = "project-search-results";

function projectSearchOptionId(hitId: string): string {
  return `project-search-option-${hitId}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
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
  if (hit.type === "project") {
    return (
      <button
        ref={rowRef}
        type="button"
        id={projectSearchOptionId(hit.id)}
        role="option"
        tabIndex={-1}
        data-testid={`project-search-item-${hit.id}`}
        aria-selected={isActive}
        onMouseEnter={onHighlight}
        onClick={() => onSelect(hit)}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
          isActive ? "bg-zinc-800 text-foreground" : "text-zinc-200 hover:bg-zinc-800/70",
        )}
      >
        <FolderGit2 className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm">{hit.project.name}</span>
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
    <button
      ref={rowRef}
      type="button"
      id={projectSearchOptionId(hit.id)}
      role="option"
      tabIndex={-1}
      data-testid={`project-search-item-${hit.id}`}
      aria-selected={isActive}
      onMouseEnter={onHighlight}
      onClick={() => onSelect(hit)}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
        isActive ? "bg-zinc-800 text-foreground" : "text-zinc-200 hover:bg-zinc-800/70",
      )}
    >
      <StatusIndicator status={hit.environment.status} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm">{hit.environment.name}</span>
      <span className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-zinc-500">
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
    </button>
  );
}

export function ProjectSearchBar({
  projects,
  environments,
  onSelectProject,
  onSelectEnvironment,
}: {
  projects: Project[];
  environments: Environment[];
  onSelectProject: (projectId: string) => void;
  onSelectEnvironment: (environmentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectSearchFilter>("all");
  const [selectedHitId, setSelectedHitId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement | null>(null);

  const recentProjectIds = useUIStore((state) => state.recentProjectIds);
  const repositories = useConfigStore((state) => state.config.repositories);

  const defaultBranches = useMemo(() => {
    const branches = new Map<string, string>();
    for (const project of projects) {
      branches.set(project.id, repositories[project.id]?.defaultBranch ?? "main");
    }
    return branches;
  }, [projects, repositories]);

  const results = useMemo(
    () =>
      buildProjectSearchResults({
        query,
        filter,
        projects,
        environments,
        recentProjectIds,
        defaultBranches,
      }),
    [query, filter, projects, environments, recentProjectIds, defaultBranches],
  );
  const hits = useMemo(() => flattenProjectSearchResults(results), [results]);
  const selectedIndex = useMemo(() => {
    if (hits.length === 0) return -1;
    const index = selectedHitId ? hits.findIndex((hit) => hit.id === selectedHitId) : -1;
    return index >= 0 ? index : 0;
  }, [hits, selectedHitId]);
  const selectedHit = selectedIndex >= 0 ? hits[selectedIndex] : undefined;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const hasModifier = event.metaKey || event.ctrlKey;
      const hasBothModifiers = event.metaKey && event.ctrlKey;
      if (
        hasModifier &&
        !hasBothModifiers &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        if (isTypingTarget(event.target) && !open) return;
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }

      if (!open || event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setOpen(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFilter("all");
      setSelectedHitId(null);
      return;
    }

    setNow(new Date());
    const timeoutId = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [open]);

  useEffect(() => {
    setSelectedHitId(null);
  }, [query, filter]);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = (hit: ProjectSearchHit) => {
    if (hit.type === "project") {
      onSelectProject(hit.project.id);
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

  const hasQuery = parseProjectSearchQuery(query).length > 0;
  const projectHeading = hasQuery ? "Projects" : "Recent projects";
  const environmentHeading = hasQuery ? "Environments" : "Recent environments";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center border-b border-border/80 bg-chrome px-2",
        WORKSPACE_BAR_HEIGHT_CLASS,
      )}
    >
      <button
        type="button"
        data-testid="project-search-trigger"
        aria-label="Search projects and environments"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full items-center gap-2 rounded-lg border border-border/70 bg-input-surface px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-elevated hover:text-foreground md:h-7"
      >
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">Search projects, environments...</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          data-testid="project-search-dialog"
          className="max-w-2xl gap-0 overflow-hidden p-0 sm:max-w-2xl sm:p-0"
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
                  aria-label={`Filter results: ${FILTER_LABELS[filter]}`}
                >
                  <ListFilter className="h-3.5 w-3.5" aria-hidden="true" />
                  Filter
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
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
                {projects.length === 0
                  ? "No projects yet"
                  : hasQuery
                    ? "No projects or environments match that search."
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
