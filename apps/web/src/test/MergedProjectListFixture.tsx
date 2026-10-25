import { useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { projectKey, projectRef, type BackendId } from "@orkestrator/protocol/federation";
import { emptyPortalLayout, type PortalLayoutUpdate } from "@orkestrator/protocol/portal-layout";
import { toNodeEnvironmentSummary } from "@orkestrator/protocol/node-summaries";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { MergedProjectList } from "@/components/federation/FederatedSidebarSections";
import type { MachineView } from "@/lib/federation/aggregate";
import { portalLayoutStore } from "@/lib/portal/portal-layout";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";

const hintA = "gitlab.example/team-a/shared/app";
const hintB = "gitlab.example/team-b/shared/app";

function machine(
  node: string,
  name: string,
  projects: Array<[string, string | null, string | null]>,
): MachineView {
  const backendId = node as BackendId;
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
    projects: projects.map(([id, repositoryHint, folder], order) => {
      const ref = projectRef(backendId, id);
      return {
        ref,
        key: projectKey(ref),
        name: id,
        order,
        repositoryHint: repositoryHint ?? undefined,
        folder: folder ?? undefined,
      };
    }),
    environmentsByProject: new Map(
      projects.map(([id]) => [
        id,
        ["one", "two"].map((suffix, order) =>
          toNodeEnvironmentSummary(
            backendId,
            {
              id: `${id}-${suffix}`,
              projectId: id,
              name: `${id}-${suffix}`,
              order,
              status: "running",
            },
            order,
          )!,
        ),
      ]),
    ),
  };
}

const remote = machine("bk_remote", "Remote", [
  ["p", hintA, "Work"],
  ["q", hintA, "Work"],
  ["r", hintB, "Later"],
]);
const command = machine("bk_self", "Command", [["local", hintA, null]]);

function install() {
  let layout = {
    ...emptyPortalLayout(),
    projectOrder: [...remote.projects.map((p) => p.key), command.projects[0]!.key],
    repositoryOrder: [
      remote.projects[0]!.key,
      remote.projects[1]!.key,
      command.projects[0]!.key,
      remote.projects[2]!.key,
    ],
  };
  portalLayoutStore.setState({ layout, loaded: true, error: null });
  const state = createStore(() => ({
    updates: [] as PortalLayoutUpdate[],
    reorders: [] as unknown[],
  }));
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(commandName: string, args?: Record<string, unknown>) => {
      if (commandName === "get_node_status") return { nodeId: "bk_self", mode: "command" } as T;
      if (commandName === "get_node_summaries") return { selfId: "bk_self", nodes: [] } as T;
      if (commandName === "get_backend_profile")
        return { revision: 1, displayName: "Command", colorToken: "teal", updatedAt: "t" } as T;
      if (commandName === "watch_node_events")
        return { watchId: args?.watchId, expiresAt: Date.now() + 90_000, renewed: true } as T;
      if (commandName === "unwatch_node_events") return { removed: true } as T;
      if (commandName === "get_portal_layout") return layout as T;
      if (commandName === "update_portal_layout") {
        const update = args as PortalLayoutUpdate;
        layout = { ...layout, ...update, revision: layout.revision + 1 };
        state.setState((current) => ({ updates: [...current.updates, update] }));
        return layout as T;
      }
      if (commandName === "invoke_on_node") {
        // Reads from mounted badges and hover cards are not reorder writes.
        if (args?.command === "changes_get_view")
          return { outcome: "ok", result: { kind: "deleted" } } as T;
        if (args?.command === "get_environment") return { outcome: "ok", result: null } as T;
        if (args?.command === "get_agent_registry")
          return {
            outcome: "ok",
            result: { generatedAt: new Date(0).toISOString(), entries: [], environments: [] },
          } as T;
        state.setState((current) => ({ reorders: [...current.reorders, args] }));
        return { outcome: "ok", result: {} } as T;
      }
      return [] as T;
    },
  };
  return state;
}

let instance: ReturnType<typeof install> | undefined;
export function MergedProjectListFixture() {
  const [store] = useState(() => (instance ??= install()));
  const state = useStore(store);
  const selected = useUIStore((value) => value.selectedProjectId);
  // What the central region shows: another node's workspace, and what it asked for.
  const shown = useRemoteWorkspaceStore((value) => value.active);
  const latest = useRemoteWorkspaceStore((value) =>
    value.active ? value.requests[value.active.nodeId]?.request : undefined,
  );
  const { type: _type, ...request } = latest ?? { type: "select" };
  const params = new URLSearchParams(location.search);
  const shownIds = new Set(params.has("fallback") ? ["bk_remote"] : ["bk_remote", "bk_self"]);
  return (
    <main className="max-w-lg p-4">
      <output data-testid="updates">{JSON.stringify(state.updates)}</output>
      <output data-testid="reorders">{JSON.stringify(state.reorders)}</output>
      <output data-testid="selected">{selected}</output>
      <output data-testid="opened">
        {shown ? JSON.stringify({ nodeId: shown.nodeId }) : null}
      </output>
      <output data-testid="intent">{latest ? JSON.stringify(request) : null}</output>
      <FederationProvider>
        <MergedProjectList
          machines={[remote, command]}
          shownIds={shownIds}
          mode={params.get("mode") === "project" ? "project" : "repository"}
          renderBoundProject={() => null}
          onBoundEnvironmentDragEnd={() => {}}
        />
      </FederationProvider>
    </main>
  );
}
