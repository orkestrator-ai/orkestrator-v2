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
import type { Project, Environment } from "@/types";

function install() {
  const params = new URLSearchParams(location.search);
  const merged = params.has("merged");
  const groups = params.has("groups");
  const repository = params.has("repository");
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
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
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
              ? [
                  {
                    nodeId: "bk_remote",
                    available: true,
                    freshness: "current",
                    loadedAt: 1,
                    truncated: false,
                    lastError: null,
                    projects: [],
                    environments: [],
                    view: {
                      nodeId: "bk_remote",
                      enabled: true,
                      displayName: "Remote",
                      fallbackName: "Remote",
                      routes: [],
                      routeOrder: [],
                      hasCredential: true,
                      attachment: { status: "attached" },
                      connection: { state: "connected", epoch: 1 },
                      addedAt: "t",
                      source: "portal",
                    },
                  },
                ]
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
  useUIStore.setState({
    collapsedProjects: [],
    collapsedProjectFolders: [],
    projectCollapseChoices: projects.map((p) => p.id),
    selectedProjectId: null,
    selectedEnvironmentId: null,
    environmentSortMode: "project",
  });
  useMachineViewStore.setState({
    grouping: repository ? "repository" : merged ? "project" : "machine",
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
