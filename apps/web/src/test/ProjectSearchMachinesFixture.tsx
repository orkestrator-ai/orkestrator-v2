import { useState } from "react";
import type { NodeView } from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
  type NodeSummary,
} from "@orkestrator/protocol/node-summaries";
import { useRevealMachineProject } from "@/components/federation/useRevealMachineProject";
import { useMachineViews } from "@/components/federation/useMachineViews";
import {
  MergedProjectList,
  RemoteMachineSection,
} from "@/components/federation/FederatedSidebarSections";
import { isMachineShown } from "@/lib/federation/sidebar-layout";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useUIStore } from "@/stores/uiStore";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { ProjectSearchBar } from "@/components/sidebar/ProjectSearchBar";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import type { Environment, Project } from "@/types";

/**
 * The ⌘K search on a command node with three leaves: mbp3 (connected),
 * mini (offline, last-known rows), and empty (connected, no projects).
 * This machine has orkestrator-v2 too, so
 * that project appears once per machine.
 */

const localProject: Project = {
  id: "ork-local",
  name: "orkestrator-v2",
  gitUrl: "https://github.com/acme/orkestrator-v2.git",
  localPath: "/code/orkestrator-v2",
  addedAt: "2026-01-01T00:00:00.000Z",
  order: 0,
};

const localEnvironment: Environment = {
  id: "env-local",
  projectId: "ork-local",
  name: "fix-merged-search-results-layout",
  branch: "fix-merged-search-results-layout",
  containerId: null,
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: new Date().toISOString(),
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "local",
};

function view(nodeId: string, name: string, colorToken: string, connected: boolean): NodeView {
  return {
    nodeId: nodeId as BackendId,
    enabled: true,
    displayName: name,
    colorToken,
    fallbackName: name,
    routes: [],
    routeOrder: [],
    hasCredential: true,
    attachment: { status: "attached" },
    connection: {
      state: connected ? "connected" : "unavailable",
      epoch: 1,
      ...(connected ? {} : { lastError: { code: "unreachable", message: "Connection lost" } }),
    },
    addedAt: "2026-10-21T00:00:00.000Z",
    source: "portal",
  } as NodeView;
}

function node(
  nodeId: string,
  name: string,
  colorToken: string,
  connected: boolean,
  projects: Record<string, unknown>[],
  environments: Record<string, unknown>[],
): NodeSummary {
  const backendId = nodeId as BackendId;
  return {
    nodeId: backendId,
    view: view(nodeId, name, colorToken, connected),
    available: connected,
    freshness: connected ? "current" : "stale",
    loadedAt: Date.now() - 5 * 60_000,
    truncated: false,
    lastError: connected ? null : "Connection lost",
    projects: projects.map((raw, index) => toNodeProjectSummary(backendId, raw, index)!),
    environments: environments.map((raw, index) =>
      toNodeEnvironmentSummary(backendId, raw, index)!,
    ),
  };
}

const nodes: NodeSummary[] = [
  node(
    "bk_mbp3",
    "mbp3",
    "teal",
    true,
    [
      { id: "tg", name: "telegram-scraper", gitUrl: "git@github.com:acme/telegram-scraper.git" },
      {
        id: "ork-3",
        name: "orkestrator-v2",
        gitUrl: "https://github.com/acme/orkestrator-v2.git",
        defaultBranch: "main",
      },
    ],
    [
      {
        id: "run",
        projectId: "ork-3",
        name: "run-desktop-app",
        branch: "run-desktop-app",
        status: "stopped",
        lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ],
  ),
  node(
    "bk_mini",
    "mini",
    "rose",
    false,
    [{ id: "ork-m", name: "orkestrator-v2", gitUrl: "https://github.com/acme/orkestrator-v2.git" }],
    [],
  ),
  node("bk_empty", "empty", "amber", true, [], []),
];

function install() {
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(commandName: string) => {
      if (commandName === "get_node_status") return { nodeId: "bk_self", mode: "command" } as T;
      if (commandName === "get_node_summaries") return { selfId: "bk_self", nodes } as T;
      if (commandName === "get_backend_profile")
        return { revision: 1, displayName: "studio", colorToken: "violet", updatedAt: "t" } as T;
      if (commandName === "list_node_outcomes") return [] as T;
      if (commandName === "get_portal_layout") return undefined as T;
      return [] as T;
    },
  };
  return true;
}

function SearchContent() {
  const reveal = useRevealMachineProject();
  const machines = useMachineViews();
  const grouping = useMachineViewStore((state) => state.grouping);
  const sort = useUIStore((state) => state.environmentSortMode);
  const [selected, setSelected] = useState<string | null>(null);
  const opened = useRemoteWorkspaceStore((state) => state.active?.nodeId ?? null);
  return (
    <main className="max-w-sm">
      <output data-testid="selected">{selected}</output>
      <output data-testid="opened">{opened}</output>
      <label>
        Sidebar view
        <select
          aria-label="Sidebar view"
          value={sort === "activity" ? "activity" : grouping}
          onChange={(event) => {
            const mode = event.target.value;
            useUIStore
              .getState()
              .setEnvironmentSortMode(mode === "activity" ? "activity" : "project");
            if (mode === "machine" || mode === "project" || mode === "repository")
              useMachineViewStore.getState().setGrouping(mode);
          }}
        >
          <option value="machine">By machine</option>
          <option value="project">By project</option>
          <option value="repository">By repository</option>
          <option value="activity">By activity</option>
        </select>
      </label>
      <ProjectSearchBar
        projects={[localProject]}
        environments={[localEnvironment]}
        onSelectProject={(id) => setSelected(`local:${id}`)}
        onSelectEnvironment={(id) => setSelected(`local-environment:${id}`)}
        onSelectMachineProject={(machine, id) => {
          reveal(machine, id);
          setSelected(`${machine.name}:${id}`);
        }}
      />
      <aside aria-label="Machine projects">
        {sort === "activity" ? null : grouping === "machine" ? (
          machines
            .filter((machine) => !machine.bound)
            .map((machine) => <RemoteMachineSection key={machine.connectionId} machine={machine} />)
        ) : (
          <MergedProjectList
            machines={machines}
            shownIds={
              new Set(machines.filter(isMachineShown).map((machine) => machine.connectionId))
            }
            mode={grouping}
            renderBoundProject={() => null}
            onBoundEnvironmentDragEnd={() => {}}
          />
        )}
      </aside>
    </main>
  );
}

export function ProjectSearchMachinesFixture() {
  useState(install);
  return (
    <FederationProvider>
      <SearchContent />
    </FederationProvider>
  );
}
