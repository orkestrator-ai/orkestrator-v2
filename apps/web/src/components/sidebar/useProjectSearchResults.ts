import { useMemo } from "react";
import { projectKey, projectRef, type BackendId } from "@orkestrator/protocol/federation";
import type { MachineView } from "@/lib/federation/aggregate";
import {
  localSearchSource,
  machineSearchSource,
  searchProjectsAndEnvironments,
  type ProjectSearchFilter,
  type ProjectSearchMachineFilter,
  type ProjectSearchResults,
} from "@/lib/project-search";
import type { Environment, Project } from "@/types";

const NO_DESTINATIONS: ProjectSearchResults = {
  projects: [],
  environments: [],
  incomplete: false,
  projectCount: 0,
};

export interface ProjectSearchResultsInput {
  /** The palette is open. Closed, nothing below is read, prepared or ranked. */
  open: boolean;
  query: string;
  /** The destination filter, or null while a command category is shown. */
  filter: ProjectSearchFilter | null;
  machineFilter: ProjectSearchMachineFilter;
  /** This window's machine in a multi-machine view, else null. */
  boundMachine: MachineView | null;
  backendId: BackendId | null;
  projects: readonly Project[];
  environments: readonly Environment[];
  /** Repository settings by project ID, for each project's default branch. */
  repositories: Readonly<Record<string, { defaultBranch?: string } | undefined>>;
  /** Every other machine searched, in sidebar order. */
  remoteMachines: readonly MachineView[];
  /** This machine's auto-merge "Require checks to pass" setting. */
  requireChecks: boolean;
  /** Cross-machine recents, newest first. */
  recentKeys: readonly string[];
  /** This machine's older recent project IDs. */
  recentProjectIds: readonly string[];
}

export interface ProjectSearchResultsView {
  results: ProjectSearchResults;
  /** Some machine in the search has a project; false while closed. */
  hasProjects: boolean;
}

/**
 * The palette's destination results. Sources are prepared and ranked only
 * while the palette is open: a closed palette renders nothing, so a change to
 * environments, machines or recents behind it does no search work. Opening
 * ranks the inputs current at that moment.
 */
export function useProjectSearchResults({
  open,
  query,
  filter,
  machineFilter,
  boundMachine,
  backendId,
  projects,
  environments,
  repositories,
  remoteMachines,
  requireChecks,
  recentKeys,
  recentProjectIds,
}: ProjectSearchResultsInput): ProjectSearchResultsView {
  const sources = useMemo(() => {
    if (!open) return null;
    const defaultBranches = new Map<string, string>();
    for (const project of projects) {
      defaultBranches.set(project.id, repositories[project.id]?.defaultBranch ?? "main");
    }
    return [
      localSearchSource({
        machine: boundMachine,
        backendId,
        projects,
        environments,
        defaultBranches,
      }),
      ...remoteMachines.map((machine) => machineSearchSource(machine, requireChecks)),
    ];
  }, [
    open,
    backendId,
    boundMachine,
    environments,
    projects,
    remoteMachines,
    repositories,
    requireChecks,
  ]);

  // Recently used on any machine, newest first, then this machine's older
  // recent projects (recorded before cross-machine recents existed).
  const searchRecentKeys = useMemo(
    () =>
      open
        ? [
            ...recentKeys,
            ...recentProjectIds.map((id) =>
              backendId ? projectKey(projectRef(backendId, id)) : id,
            ),
          ]
        : null,
    [open, backendId, recentKeys, recentProjectIds],
  );

  const results = useMemo(
    () =>
      sources && searchRecentKeys && filter
        ? searchProjectsAndEnvironments({
            query,
            filter,
            machineFilter,
            sources,
            recentKeys: searchRecentKeys,
          })
        : NO_DESTINATIONS,
    [query, filter, machineFilter, sources, searchRecentKeys],
  );

  const hasProjects = useMemo(
    () => sources?.some((source) => source.projects.length > 0) ?? false,
    [sources],
  );

  return { results, hasProjects };
}
