import { useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { emptyPortalLayout, type PortalLayout } from "@orkestrator/protocol/portal-layout";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { HierarchicalSidebar } from "@/components/sidebar/HierarchicalSidebar";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { TerminalProvider } from "@/contexts/TerminalContext";
import { useProjectStore, useEnvironmentStore, useUIStore } from "@/stores";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import type { Project, Environment } from "@/types";

function install() {
  const params = new URLSearchParams(location.search);
  const byMachine = params.has("machines");
  const merged = params.has("merged") || byMachine;
  const groups = params.has("groups");
  const repository = params.has("repository");
  // A third, empty machine, so an expanded machine has a neighbour on each side.
  const spare = params.has("spare");
  // `?merge-ready`: `p-env-1` and `q-env-1` have a PR ready to merge, while
  // `p-env-2`'s is blocked, so the two can be compared side by side.
  const mergeReady = params.has("merge-ready");
  const readyIds = new Set(["p-env-1", "q-env-1"]);
  const prFor = (id: string) =>
    !mergeReady || (!readyIds.has(id) && id !== "p-env-2")
      ? { prUrl: null, prState: null, hasMergeConflicts: null }
      : {
          prUrl: `https://github.com/acme/source/pull/${id.length}${id.at(-1)}`,
          prState: "open" as const,
          hasMergeConflicts: false,
          prMergeability: readyIds.has(id) ? ("clean" as const) : ("blocked" as const),
        };
  const storageKey = `sidebar-drag-fixture:${location.search}`;
  const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as {
    projects: Project[];
    layout: PortalLayout;
  } | null;
  let projects: Project[] =
    saved?.projects ??
    (groups ? ["p", "p2", "q", "q2"] : ["p", "q"]).map((id, order) => ({
      id,
      name: id,
      gitUrl: `https://github.com/acme/${id.startsWith("p") ? "source" : "target"}.git`,
      localPath: null,
      addedAt: "2026-10-22T00:00:00Z",
      order,
      ...(groups ? { folder: id.startsWith("p") ? "Source" : "Target" } : {}),
    }));
  let layout = saved?.layout ?? emptyPortalLayout();
  const environments: Environment[] = projects.flatMap((project) =>
    [1, 2, 3].map((index) => ({
      id: `${project.id}-env-${index}`,
      name: `${project.id}-env-${index}`,
      projectId: project.id,
      branch: "main",
      containerId: null,
      status: "stopped",
      ...prFor(`${project.id}-env-${index}`),
      createdAt: "2026-10-22T00:00:00Z",
      networkAccessMode: "restricted",
      order: index,
      environmentType: "local",
    })),
  );
  const calls = createStore<{ writes: Array<{ command: string; args: unknown }> }>(() => ({
    writes: [],
  }));
  const persist = () => sessionStorage.setItem(storageKey, JSON.stringify({ projects, layout }));
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      switch (command) {
        case "get_projects":
          return projects as T;
        case "get_environments":
          return environments.filter((env) => env.projectId === args?.projectId) as T;
        case "get_node_status":
          return { nodeId: "bk_self", mode: "command" } as T;
        case "get_node_summaries":
          return {
            selfId: "bk_self",
            nodes: merged
              ? [["bk_remote", "Remote"], ...(spare ? [["bk_spare", "Spare"]] : [])].map(
                  ([nodeId, name]) => ({
                    nodeId,
                    available: true,
                    freshness: params.has("catching-up") ? "catching-up" : "current",
                    loadedAt: 1,
                    truncated: false,
                    lastError: null,
                    projects: [],
                    environments: [],
                    view: {
                      nodeId,
                      enabled: true,
                      displayName: name,
                      fallbackName: name,
                      routes: [],
                      routeOrder: [],
                      hasCredential: true,
                      attachment: { status: "attached" },
                      connection: { state: "connected", epoch: 1 },
                      addedAt: "t",
                      source: "portal",
                    },
                  }),
                )
              : [],
          } as T;
        case "get_backend_profile":
          return { revision: 1, displayName: "Self", colorToken: "teal", updatedAt: "t" } as T;
        case "get_portal_layout":
          return layout as T;
        case "arrange_projects": {
          calls.setState((state) => ({ writes: [...state.writes, { command, args }] }));
          const ids = args!.projectIds as string[];
          const folders = args!.folders as Record<string, string | null>;
          projects = ids.map((id, order) => ({
            ...projects.find((project) => project.id === id)!,
            order,
            ...(id in folders ? { folder: folders[id] } : {}),
          }));
          persist();
          return projects as T;
        }
        case "update_portal_layout":
          calls.setState((state) => ({ writes: [...state.writes, { command, args }] }));
          layout = { ...layout, ...args, revision: layout.revision + 1 };
          persist();
          return layout as T;
        case "reorder_environments":
          calls.setState((state) => ({ writes: [...state.writes, { command, args }] }));
          return undefined as T;
        case "get_connections":
          return { activeConnectionId: "local", connections: [] } as T;
        case "list_node_outcomes":
          return [] as T;
        default:
          return [] as T;
      }
    },
  };
  useProjectStore.getState().setProjects(projects);
  useEnvironmentStore.setState({ environments });
  if (mergeReady) {
    // The fixture has no PR monitor service, so seed its confirmed mirror.
    usePrMonitorStore.getState().applySnapshot(
      environments
        .filter((environment) => environment.prUrl)
        .map((environment) => ({
          environmentId: environment.id,
          mode: "normal",
          checkInProgress: false,
          consecutiveErrors: 0,
          lastCheckAt: "2026-10-28T10:00:00.000Z",
          lastSuccessfulCheckAt: "2026-10-28T10:00:00.000Z",
          prUrl: environment.prUrl,
          prState: environment.prState,
          hasMergeConflicts: environment.hasMergeConflicts,
          checkSummary: { passed: 3, total: 3, pending: 0 },
        })),
    );
    usePrMonitorStore.getState().setSyncStatus("current");
  }
  useUIStore.setState({
    collapsedProjects: [],
    collapsedProjectFolders: [],
    projectCollapseChoices: projects.map((p) => p.id),
    selectedProjectId: null,
    selectedEnvironmentId: null,
    environmentSortMode: "project",
  });
  useMachineViewStore.setState({
    grouping: repository ? "repository" : merged && !byMachine ? "project" : "machine",
    collapsedMachines: [],
    collapsedProjectKeys: [],
    collapsedFolderKeys: [],
  });
  return calls;
}

let instance: ReturnType<typeof install> | undefined;
export function SidebarDragFixture() {
  const [calls] = useState(() => (instance ??= install()));
  const { writes } = useStore(calls);
  return (
    <DockerAvailabilityProvider available={false}>
      <TerminalProvider>
        <FederationProvider>
          <main className="h-screen max-w-sm bg-background text-foreground">
            <output data-testid="sidebar-writes">{JSON.stringify(writes)}</output>
            <HierarchicalSidebar />
          </main>
        </FederationProvider>
      </TerminalProvider>
    </DockerAvailabilityProvider>
  );
}
