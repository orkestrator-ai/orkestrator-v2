/** Shared fixtures for the command palette's model, search and context tests. */
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
} from "@orkestrator/protocol/node-summaries";
import type { MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import type { Environment, Project } from "@/types";
import { buildPaletteContext, type PaletteContextSources } from "./context";
import type { PaletteContext } from "./model";

export function project(overrides: Partial<Project> & Pick<Project, "id" | "name">): Project {
  return {
    gitUrl: `https://github.com/acme/${overrides.name}.git`,
    localPath: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

export function environment(
  overrides: Partial<Environment> & Pick<Environment, "id" | "projectId" | "name">,
): Environment {
  return {
    branch: "main",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

export function machineView(
  node: string,
  name: string,
  rawProjects: Record<string, unknown>[],
  rawEnvironments: Record<string, unknown>[],
  overrides: Partial<MachineView> = {},
): MachineView {
  const backendId = node as BackendId;
  const environmentsByProject = new Map<string, FederatedEnvironment[]>();
  rawEnvironments.forEach((raw, index) => {
    const summary = toNodeEnvironmentSummary(backendId, raw, index)!;
    environmentsByProject.set(summary.projectId, [
      ...(environmentsByProject.get(summary.projectId) ?? []),
      summary,
    ]);
  });
  return {
    connectionId: node,
    backendId,
    name,
    colorToken: "teal",
    bound: false,
    freshness: "current",
    transport: "connected",
    loadedAt: 1,
    truncated: false,
    projects: rawProjects.map((raw, index) => toNodeProjectSummary(backendId, raw, index)!),
    environmentsByProject,
    ...overrides,
  };
}

export const localProject = project({ id: "p-ork", name: "orkestrator-v2" });
export const runningContainer = environment({
  id: "e-box",
  projectId: "p-ork",
  name: "build-modal-steps",
  status: "running",
});
export const localWorktree = environment({
  id: "e-local",
  projectId: "p-ork",
  name: "checkout",
  environmentType: "local",
  status: "running",
});

/** A context over this window's machine, with every handler supplied. */
export function localContext(overrides: Partial<PaletteContextSources> = {}): PaletteContext {
  const selection = overrides.selection ?? {
    nodeId: "bk_self",
    projectId: "p-ork",
    environmentId: "e-box",
  };
  return buildPaletteContext({
    selection,
    shownSelection: selection,
    machines: [],
    onWindowMachine: true,
    localProjects: [localProject],
    localEnvironments: [runningContainer, localWorktree],
    localDeleting: new Set(),
    pending: new Set(),
    dockerAvailable: true,
    requireChecks: false,
    handlers: { environmentPower: true, addProject: true },
    recentCommandCount: 0,
    rememberRecentCommands: true,
    settingsFlags: {},
    ...overrides,
  });
}
