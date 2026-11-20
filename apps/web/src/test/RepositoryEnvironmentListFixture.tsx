import { useMemo, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { NodeView } from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
  type NodeSummary,
} from "@orkestrator/protocol/node-summaries";
import {
  applyRepositoryEnvironmentOrder,
  emptyPortalLayout,
  type PortalLayout,
  type PortalLayoutUpdate,
  type RepositoryEnvironmentOrderUpdate,
} from "@orkestrator/protocol/portal-layout";
import { FederationProvider, useFederation } from "@/components/federation/FederationProvider";
import { MachineTiles } from "@/components/federation/MachineTiles";
import { RepositoryEnvironmentList } from "@/components/federation/RepositoryEnvironmentList";
import { useRemoteMachineViews } from "@/components/federation/useMachineViews";
import { useRevealMachineProject } from "@/components/federation/useRevealMachineProject";
import { MobileAppShellLayout } from "@/components/layout/MobileAppShellLayout";
import { ProjectSearchBar } from "@/components/sidebar/ProjectSearchBar";
import { filterMachines } from "@/lib/federation/aggregate";
import { isMachineShown, orderMachines } from "@/lib/federation/sidebar-layout";
import { portalLayoutStore, usePortalLayout } from "@/lib/portal/portal-layout";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";

/**
 * The multi-machine sidebar's list (design EL01) over seven fake machines:
 * the machine tiles above the repository list, as `HierarchicalSidebar` lays
 * them out. Every machine is another machine of this window (the command node
 * `bk_self` has no projects), so every row is a remote row.
 *
 * - `?ordering=manual`: environments ordered by hand (`environmentOrder`).
 * - `?offline=<machine>`: that machine is unavailable (its tile dims, its rows go).
 * - `?machine-updates`: older releases across the full machine tile palette.
 *
 * The fake command node records portal layout writes (`updates`) and writes
 * routed to a machine (`reorders`); it answers each machine's CPU read.
 */

interface FakeEnvironment {
  name: string;
  status?: "running" | "stopped";
  agentActivityState?: "working" | "waiting" | "idle";
  hasUnreadWork?: boolean;
  prState?: "open" | "merged";
}

interface FakeProject {
  id: string;
  name: string;
  /** `owner/name` on github.com; none for a project with no repository. */
  repository?: string;
  environments: FakeEnvironment[];
}

interface FakeMachine {
  nodeId: string;
  name: string;
  colorToken: string;
  cpu: number;
  projects: FakeProject[];
}

/** Machines in the command node's order; environment names are unique across them. */
export const REPOSITORY_LIST_MACHINES: readonly FakeMachine[] = [
  {
    nodeId: "bk_mini",
    name: "mini",
    colorToken: "teal",
    cpu: 23,
    projects: [
      {
        id: "ork",
        name: "orkestrator-v2",
        repository: "acme/orkestrator-v2",
        environments: [
          { name: "sidebar-redesign", status: "running", agentActivityState: "working" },
          { name: "fix-merge-queue", status: "running", agentActivityState: "idle" },
        ],
      },
      {
        id: "web",
        name: "website",
        repository: "acme/website",
        environments: [{ name: "blog-migration", status: "stopped" }],
      },
      { id: "infra", name: "infra", repository: "acme/infra", environments: [] },
    ],
  },
  {
    nodeId: "bk_beelink",
    name: "beelink",
    colorToken: "violet",
    cpu: 61,
    projects: [
      {
        id: "ork",
        name: "orkestrator-v2",
        repository: "acme/orkestrator-v2",
        environments: [{ name: "release-notes", status: "running", prState: "open" }],
      },
    ],
  },
  {
    nodeId: "bk_beelink2",
    name: "beelink2",
    colorToken: "blue",
    cpu: 8,
    projects: [
      {
        id: "tg",
        name: "telegram-scraper",
        repository: "acme/telegram-scraper",
        environments: [
          { name: "rate-limits", status: "running", agentActivityState: "working" },
          { name: "media-backfill", status: "stopped" },
        ],
      },
    ],
  },
  {
    nodeId: "bk_omarchy-hp",
    name: "omarchy-hp",
    colorToken: "amber",
    cpu: 44,
    projects: [
      {
        id: "tg",
        name: "telegram-scraper",
        repository: "acme/telegram-scraper",
        environments: [{ name: "proxy-rotation", status: "running", hasUnreadWork: true }],
      },
    ],
  },
  {
    nodeId: "bk_rkmbp",
    name: "rkmbp",
    colorToken: "rose",
    cpu: 92,
    projects: [
      { id: "ork", name: "orkestrator-v2", repository: "acme/orkestrator-v2", environments: [] },
      {
        id: "scratch",
        name: "scratch",
        environments: [{ name: "notebook", status: "running", agentActivityState: "idle" }],
      },
    ],
  },
  {
    nodeId: "bk_mbp3",
    name: "mbp3",
    colorToken: "green",
    cpu: 15,
    projects: [
      {
        id: "ork",
        name: "orkestrator-v2",
        repository: "acme/orkestrator-v2",
        environments: [
          { name: "desktop-smoke", status: "running", agentActivityState: "working" },
          { name: "perf-trace", status: "stopped", prState: "merged" },
        ],
      },
    ],
  },
  {
    nodeId: "bk_omarchy-gram",
    name: "omarchy-gram",
    colorToken: "orange",
    cpu: 37,
    projects: [
      {
        id: "web",
        name: "website",
        repository: "acme/website",
        environments: [{ name: "pricing-page", status: "running", agentActivityState: "working" }],
      },
    ],
  },
];

function view(machine: FakeMachine, connected: boolean): NodeView {
  return {
    nodeId: machine.nodeId as BackendId,
    enabled: true,
    displayName: machine.name,
    colorToken: machine.colorToken,
    fallbackName: machine.name,
    routes: [],
    routeOrder: [],
    hasCredential: true,
    attachment: { status: "attached" },
    connection: {
      state: connected ? "connected" : "unavailable",
      epoch: 1,
      ...(connected ? {} : { lastError: { code: "unreachable", message: "Connection lost" } }),
    },
    addedAt: "2026-11-01T00:00:00.000Z",
    source: "portal",
  } as NodeView;
}

function summary(machine: FakeMachine, connected: boolean): NodeSummary {
  const nodeId = machine.nodeId as BackendId;
  let order = 0;
  return {
    nodeId,
    view: view(machine, connected),
    available: connected,
    freshness: connected ? "current" : "stale",
    loadedAt: Date.now() - 60_000,
    truncated: false,
    lastError: connected ? null : "Connection lost",
    projects: machine.projects.map((project, index) =>
      toNodeProjectSummary(
        nodeId,
        {
          id: project.id,
          name: project.name,
          order: index,
          ...(project.repository ? { gitUrl: `https://github.com/${project.repository}.git` } : {}),
        },
        index,
      )!,
    ),
    environments: machine.projects.flatMap((project) =>
      project.environments.map((environment, index) => {
        order += 1;
        return toNodeEnvironmentSummary(
          nodeId,
          {
            id: environment.name,
            projectId: project.id,
            branch: environment.name,
            order: index,
            environmentType: "local",
            lastActivityAt: new Date(Date.now() - order * 7 * 60_000).toISOString(),
            ...environment,
          },
          index,
        )!;
      }),
    ),
  };
}

function usageSample(cpuPercent: number) {
  return {
    cpuPercent,
    ramPercent: 58,
    gpuPercent: 0,
    diskPercent: 64,
    sampledAt: new Date().toISOString(),
  };
}

function install() {
  const params = new URLSearchParams(location.search);
  const offline = new Set(params.getAll("offline"));
  const machineUpdates = params.has("machine-updates");
  const machines = machineUpdates
    ? [
        ...REPOSITORY_LIST_MACHINES,
        { nodeId: "bk_slate", name: "Slate", colorToken: "slate", cpu: 29, projects: [] },
        { nodeId: "bk_neutral", name: "Neutral", colorToken: "neutral", cpu: 52, projects: [] },
      ]
    : REPOSITORY_LIST_MACHINES;
  const nodes = machines.map((machine) => {
    const node = summary(
      params.get("empty") === machine.name ? { ...machine, projects: [] } : machine,
      !offline.has(machine.name),
    );
    return machineUpdates ? { ...node, version: "2.38.0" } : node;
  });
  const cpuByNode = new Map(machines.map((machine) => [machine.nodeId, machine.cpu]));
  const liveLayout = params.has("command-node");
  let layout: PortalLayout = {
    ...emptyPortalLayout(),
    ...(params.has("legacy-layout") ? {} : { manualOrderSupported: true }),
  };
  portalLayoutStore.setState({ layout, loaded: !liveLayout, error: null });
  useMachineViewStore.setState({
    machineFilter: [],
    grouping: "repository",
    environmentOrdering: params.get("ordering") === "manual" ? "manual" : "machine",
    revealedProject: null,
    openedRepository: null,
  });
  const state = createStore(() => ({
    updates: [] as Array<PortalLayoutUpdate | RepositoryEnvironmentOrderUpdate>,
    reorders: [] as Array<{ nodeId: unknown; projectId: unknown; environmentIds: unknown }>,
  }));
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      if (
        liveLayout &&
        ["get_portal_layout", "update_repository_environment_order"].includes(command)
      ) {
        const response = await fetch("/__fixture/sidebar-command-node", {
          method: "POST",
          body: JSON.stringify({ command, args }),
        });
        if (!response.ok) throw new Error("Command node request failed");
        const saved = await response.json();
        if (command === "update_repository_environment_order") {
          const update = args as unknown as RepositoryEnvironmentOrderUpdate;
          state.setState((current) => ({ updates: [...current.updates, update] }));
        }
        return saved as T;
      }
      switch (command) {
        case "get_node_status":
          return { nodeId: "bk_self", mode: "command" } as T;
        case "list_nodes":
          return { nodes: [] } as T;
        case "get_node_summaries":
          return {
            selfId: "bk_self",
            nodes: structuredClone(nodes),
            ...(machineUpdates ? { selfVersion: "2.40.0" } : {}),
          } as T;
        case "get_backend_profile":
          return { revision: 1, displayName: "Self", colorToken: "slate", updatedAt: "t" } as T;
        case "watch_node_events":
          return { watchId: args?.watchId, expiresAt: Date.now() + 90_000, renewed: true } as T;
        case "unwatch_node_events":
          return { removed: true } as T;
        case "list_node_outcomes":
          return [] as T;
        case "get_portal_layout":
          return layout as T;
        case "update_portal_layout": {
          const update = args as PortalLayoutUpdate;
          layout = { ...layout, ...update, revision: layout.revision + 1 };
          state.setState((current) => ({ updates: [...current.updates, update] }));
          return layout as T;
        }
        case "update_repository_environment_order": {
          const update = args as unknown as RepositoryEnvironmentOrderUpdate;
          layout = {
            ...layout,
            environmentOrder: applyRepositoryEnvironmentOrder(layout.environmentOrder, update),
            revision: layout.revision + 1,
          };
          state.setState((current) => ({ updates: [...current.updates, update] }));
          return layout as T;
        }
        case "get_system_usage":
          return usageSample(12) as T;
        case "invoke_on_node": {
          const nodeId = String(args?.nodeId);
          const routed = args?.command;
          if (routed === "get_system_usage")
            return { outcome: "ok", result: usageSample(cpuByNode.get(nodeId) ?? 0) } as T;
          // Reads from mounted rows and hover cards are not writes.
          if (routed === "changes_get_view")
            return { outcome: "ok", result: { kind: "deleted" } } as T;
          if (routed === "get_environment") return { outcome: "ok", result: null } as T;
          if (routed === "get_agent_registry")
            return {
              outcome: "ok",
              result: { generatedAt: new Date(0).toISOString(), entries: [], environments: [] },
            } as T;
          if (routed === "reorder_environments") {
            const routedArgs = args?.args as { projectId?: unknown; environmentIds?: unknown };
            state.setState((current) => ({
              reorders: [
                ...current.reorders,
                {
                  nodeId,
                  projectId: routedArgs?.projectId,
                  environmentIds: routedArgs?.environmentIds,
                },
              ],
            }));
          }
          return { outcome: "ok", result: {} } as T;
        }
        default:
          return [] as T;
      }
    },
  };
  return state;
}

function SidebarColumn() {
  const remote = useRemoteMachineViews();
  const layout = usePortalLayout();
  const { portalState } = useFederation();
  const machines = useMemo(
    () => orderMachines(remote, layout, portalState.selfId),
    [layout, portalState.selfId, remote],
  );
  const machineFilter = useMachineViewStore((value) => value.machineFilter);
  const ordering = useMachineViewStore((value) => value.environmentOrdering);
  const reveal = useRevealMachineProject();
  const visible = useMemo(() => filterMachines(machines, machineFilter), [machineFilter, machines]);
  const shownIds = useMemo(
    () => new Set(visible.filter(isMachineShown).map((machine) => machine.connectionId)),
    [visible],
  );
  const listedIds = useMemo(
    () => new Set(visible.map((machine) => machine.connectionId)),
    [visible],
  );
  return (
    // 340 px inside the divider, as the sidebar column is laid out at that width.
    <aside
      aria-label="Sidebar"
      data-testid="fixture-sidebar"
      className="flex h-full w-[340px] max-w-full flex-col bg-sidebar text-foreground shadow-[1px_0_0_var(--color-border)]"
    >
      {/* The sidebar header's row: the search, where the sidebar puts it. */}
      <div className="flex h-12 shrink-0 items-center border-b border-border/80 bg-chrome px-2">
        <ProjectSearchBar
          projects={[]}
          environments={[]}
          onSelectProject={() => {}}
          onSelectEnvironment={() => {}}
          onSelectMachineProject={reveal}
        />
      </div>
      <MachineTiles machines={machines} />
      <div data-sidebar-scroll className="min-h-0 flex-1 overflow-y-auto">
        <RepositoryEnvironmentList
          machines={machines}
          shownIds={shownIds}
          listedIds={listedIds}
          ordering={ordering}
          bound={{
            renderEnvironment: () => null,
            selectedEnvironmentId: null,
            onDragEnd: () => {},
            onCreate: () => {},
          }}
          onAddProject={() => {}}
        />
      </div>
    </aside>
  );
}

let instance: ReturnType<typeof install> | undefined;
export function RepositoryEnvironmentListFixture() {
  const [store] = useState(() => (instance ??= install()));
  const phoneOverlay = new URLSearchParams(location.search).has("phone-overlay");
  const state = useStore(store);
  const filter = useMachineViewStore((value) => value.machineFilter);
  // What the central region shows: another node's workspace, and what it asked for.
  const shown = useRemoteWorkspaceStore((value) => value.active);
  const latest = useRemoteWorkspaceStore((value) =>
    value.active ? value.requests[value.active.nodeId]?.request : undefined,
  );
  return (
    <main className="h-dvh bg-background">
      <div hidden>
        <output data-testid="updates">{JSON.stringify(state.updates)}</output>
        <output data-testid="reorders">{JSON.stringify(state.reorders)}</output>
        <output data-testid="filter">{JSON.stringify(filter)}</output>
        <output data-testid="opened">{shown ? shown.nodeId : null}</output>
        <output data-testid="intent">{latest ? JSON.stringify(latest) : null}</output>
      </div>
      <FederationProvider>
        {phoneOverlay ? (
          <MobileAppShellLayout
            selectedProjectId={null}
            selectedEnvironmentId={null}
            title="Repository list"
            filesPanelOpen={false}
            centralPanelStyle={{}}
            actionBar={null}
            agentInfoButton={null}
            sidebar={<SidebarColumn />}
            filesPanel={null}
            onTitleBarMouseDown={() => {}}
          />
        ) : (
          <SidebarColumn />
        )}
      </FederationProvider>
    </main>
  );
}
