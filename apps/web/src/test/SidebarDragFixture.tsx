import {
  resolveProjectArrangementIntent,
  type ProjectArrangementIntent,
} from "@orkestrator/protocol/project-arrangement";
import { useState } from "react";
import type { AgentRegistrySnapshot } from "@orkestrator/protocol/agent-registry";
import { NativeInteractionAnchor } from "@/components/native-agent/NativeInteractionAnchor";
import { paneLayoutStore, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { COORDINATOR_ACTIVITY_COMMAND } from "@orkestrator/protocol/coordinator-activity";
import { emptyPortalLayout, type PortalLayout } from "@orkestrator/protocol/portal-layout";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { HierarchicalSidebar } from "@/components/sidebar/HierarchicalSidebar";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { TerminalProvider } from "@/contexts/TerminalContext";
import { environmentStore, projectStore, uiStore } from "@/stores";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { prMonitorStore } from "@/stores/prMonitorStore";
import { type ActivitySortOrder, useUIChromeStore } from "@/stores/uiChromeStore";
import type { Project, Environment } from "@/types";
import { appCommandStore } from "@/test/app-command-store";

const ALIGNMENT_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const ATTENTION_TAB = "waiting-agent";
const ATTENTION_QUESTION = "Choose a deployment window";
const HOME_QUESTION = "Choose the project review window";

function attentionRegistry(environmentId: string): AgentRegistrySnapshot {
  const detail = environmentId === "p-env-2" ? HOME_QUESTION : ATTENTION_QUESTION;
  return {
    generatedAt: new Date().toISOString(),
    environments: [],
    entries: [
      {
        projectId: "p",
        environmentId,
        environmentName: environmentId,
        tabId: ATTENTION_TAB,
        ownerKind: "environment",
        kind: "native",
        agent: "claude",
        displayName: "Claude",
        tabOrdinal: 2,
        state: "waiting",
        pending: {
          interactionId: "question-target",
          kind: "question",
          label: "Question",
          detail,
          since: Date.now() - 4 * 60_000,
          count: 2,
        },
      },
    ],
  };
}

const LONG_NAME = "a-machine-or-checkout-name-long-enough-that-it-has-to-truncate-in-the-sidebar";

/** `?activity-sort`: an environment in each state the "By activity" list orders by. */
const ACTIVITY_SORT_ROWS: ReadonlyArray<
  Pick<Environment, "name" | "agentActivityState" | "hasUnreadWork" | "lastActivityAt"> & {
    merged?: true;
  }
> = [
  {
    name: "merged-working",
    merged: true,
    agentActivityState: "working",
    lastActivityAt: "2026-10-28T15:00:00Z",
  },
  { name: "merged-recent", merged: true, lastActivityAt: "2026-10-28T14:00:00Z" },
  { name: "working-recent", agentActivityState: "working", lastActivityAt: "2026-10-28T13:00:00Z" },
  { name: "idle-recent", lastActivityAt: "2026-10-28T12:00:00Z" },
  { name: "unread", hasUnreadWork: true, lastActivityAt: "2026-10-28T11:00:00Z" },
  { name: "waiting", agentActivityState: "waiting", lastActivityAt: "2026-10-28T10:00:00Z" },
  { name: "idle-old", lastActivityAt: "2026-10-28T08:00:00Z" },
  { name: "working-old", agentActivityState: "working", lastActivityAt: "2026-10-28T07:00:00Z" },
  {
    name: "merged-unread",
    merged: true,
    hasUnreadWork: true,
    lastActivityAt: "2026-10-28T06:00:00Z",
  },
];

function usageSample(cpuPercent: number) {
  return {
    cpuPercent,
    ramPercent: 40,
    gpuPercent: 0,
    diskPercent: 50,
    sampledAt: new Date().toISOString(),
  };
}

function install() {
  const params = new URLSearchParams(location.search);
  // `?cross-machine`: "By activity" over this window's rows and two connected
  // machines', all running, plus a machine that is down. The two connected
  // machines share an environment ID, which stays two environments.
  const crossMachine = params.has("cross-machine");
  // `?merged`: another machine (Remote) is known, so the sidebar shows the
  // multi-machine repository list (design EL01) with its machine tiles.
  const merged = params.has("merged") || crossMachine;
  const groups = params.has("groups");
  // A third, empty machine, so a machine tile has a neighbour on each side.
  const spare = params.has("spare");
  // `?alignment`: projects with and without a project icon, a long project
  // and machine name, mail badges, another machine's copy of a repository,
  // and a project with no repository, which is a heading of its own.
  const alignment = params.has("alignment");
  const attentionTarget = params.has("attention-target");
  const activitySort = params.has("activity-sort");
  // `?merge-ready`: `p-env-1` and `q-env-1` have a PR ready to merge, while
  // `p-env-2`'s is blocked, so the two can be compared side by side.
  const signal = params.get("signal");
  const mergeReady = params.has("merge-ready") || signal !== null;
  const readyIds = new Set(["p-env-1", "q-env-1"]);
  const prFor = (id: string) =>
    !mergeReady || (!readyIds.has(id) && id !== "p-env-2")
      ? { prUrl: null, prState: null, hasMergeConflicts: null }
      : {
          prUrl: `https://github.com/acme/source/pull/${id.length}${id.at(-1)}`,
          prState: "open" as const,
          hasMergeConflicts: readyIds.has(id) && signal === "merge-conflicts",
          prMergeability: readyIds.has(id)
            ? signal === "merge-conflicts"
              ? ("dirty" as const)
              : ("clean" as const)
            : ("blocked" as const),
        };
  const storageKey = `sidebar-drag-fixture:${location.search}`;
  const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as {
    projects: Project[];
    layout: PortalLayout;
  } | null;
  let projects: Project[] =
    saved?.projects ??
    (groups ? ["p", "p2", "q", "q2"] : ["p", "q"])
      .concat(alignment ? ["solo"] : [])
      .map((id, order) => ({
        id,
        name: alignment && id === "p2" ? LONG_NAME : id,
        gitUrl:
          id === "solo"
            ? ""
            : `https://github.com/acme/${id.startsWith("p") ? "source" : "target"}.git`,
        localPath: null,
        addedAt: "2026-10-22T00:00:00Z",
        order,
        ...(groups ? { folder: id.startsWith("p") ? "Source" : "Target" } : {}),
        ...(alignment && (id === "p" || id === "solo") ? { icon: ALIGNMENT_ICON } : {}),
      }));
  let layout = saved?.layout ?? emptyPortalLayout();
  const environments: Environment[] = activitySort
    ? ACTIVITY_SORT_ROWS.map(({ merged: rowMerged, ...row }, order) => ({
        id: row.name,
        projectId: "p",
        branch: row.name,
        containerId: null,
        status: "running",
        prUrl: rowMerged ? `https://github.com/acme/source/pull/${order + 1}` : null,
        prState: rowMerged ? "merged" : null,
        hasMergeConflicts: null,
        createdAt: "2026-10-22T00:00:00Z",
        networkAccessMode: "restricted",
        order,
        environmentType: "local",
        agentActivityUpdatedAt: "2026-10-28T10:00:00Z",
        ...row,
      }))
    : projects.flatMap((project) =>
        [1, 2, 3].map((index) => ({
          id: `${project.id}-env-${index}`,
          name: `${project.id}-env-${index}`,
          projectId: project.id,
          branch: "main",
          containerId: null,
          status: crossMachine ? "running" : "stopped",
          ...prFor(`${project.id}-env-${index}`),
          createdAt: "2026-10-22T00:00:00Z",
          networkAccessMode: "restricted",
          order: index,
          environmentType: "local",
          agentActivityState:
            readyIds.has(`${project.id}-env-${index}`) && signal === "needs-answer"
              ? "waiting"
              : "idle",
          agentActivityUpdatedAt: "2026-10-28T10:00:00Z",
          ...(attentionTarget && project.id === "p" && index < 3
            ? {
                status: "running" as const,
                agentActivityState: "working" as const,
                hasWaitingNativeTab: true,
                projectHome: index === 2,
              }
            : {}),
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
        case "get_host_maintenance":
          return {
            revision: 1,
            version: "2.34.4-beta",
            updater: {
              kind: "desktop",
              available: false,
              reason: "Fixture",
              latestVersion: null,
              updateAvailable: false,
              checkedAt: null,
              checkError: null,
            },
            checkRequest: null,
            job: null,
            tasks: {},
            nextRelease: null,
            ghChannel: "pinned",
            updateChannel: "beta",
          } as T;
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
                  ["bk_remote", "Remote"],
                  ...(spare || crossMachine ? [["bk_spare", "Spare"]] : []),
                  ...(crossMachine ? [["bk_down", "Down"]] : []),
                ].map(([nodeId, name]) => ({
                  nodeId,
                  available: nodeId !== "bk_down",
                  freshness: params.has("catching-up") ? "catching-up" : "current",
                  loadedAt: 1,
                  truncated: false,
                  lastError: null,
                  projects:
                    alignment || crossMachine
                      ? [
                          {
                            ref: { backendId: nodeId, projectId: "r" },
                            key: JSON.stringify([nodeId, "project", "r"]),
                            name: "r",
                            order: 0,
                            repositoryHint: "github.com/acme/source",
                            icon: ALIGNMENT_ICON,
                          },
                        ]
                      : [],
                  environments: crossMachine
                    ? ["r-env", `${name?.toLowerCase()}-env`].map((id, order) => ({
                        ref: { backendId: nodeId, environmentId: id },
                        key: JSON.stringify([nodeId, "environment", id]),
                        projectId: "r",
                        name: `${name?.toLowerCase()}-${order === 0 ? "feature" : "fix"}`,
                        order,
                        status: "running",
                        environmentType: "local",
                        activity: "idle",
                        hasUnreadWork: false,
                        deleting: false,
                        isProjectHome: false,
                      }))
                    : alignment
                      ? [
                          {
                            ref: { backendId: nodeId, environmentId: "r-env" },
                            key: JSON.stringify([nodeId, "environment", "r-env"]),
                            projectId: "r",
                            name: "r-env",
                            order: 0,
                            status: "stopped",
                            activity: "idle",
                            hasUnreadWork: false,
                            deleting: false,
                            isProjectHome: false,
                            agentMailUnread: 120,
                            agentMailFailed: true,
                          },
                        ]
                      : [],
                  view: {
                    nodeId,
                    enabled: true,
                    displayName: alignment ? LONG_NAME : name,
                    ...(crossMachine
                      ? { colorToken: nodeId === "bk_remote" ? "rose" : "amber" }
                      : {}),
                    fallbackName: name,
                    routes: [],
                    routeOrder: [],
                    hasCredential: true,
                    attachment: { status: "attached" },
                    connection: {
                      state: nodeId === "bk_down" ? "unavailable" : "connected",
                      epoch: 1,
                    },
                    addedAt: "t",
                    source: "portal",
                  },
                }))
              : [],
          } as T;
        case "get_backend_profile":
          return { revision: 1, displayName: "Self", colorToken: "teal", updatedAt: "t" } as T;
        case "get_portal_layout":
          return layout as T;
        case "arrange_projects_by_intent": {
          // Resolved against current projects, as the backend does. The write
          // records the result too, which is what the specs assert on.
          const intent = args!.intent as ProjectArrangementIntent;
          const ordered = [...projects].sort((left, right) => left.order - right.order);
          const arrangement = resolveProjectArrangementIntent(intent, ordered);
          calls.setState((state) => ({
            writes: [...state.writes, { command, args: { ...args, ...arrangement } }],
          }));
          if (arrangement) {
            projects = arrangement.projectIds.map((id, order) => ({
              ...projects.find((project) => project.id === id)!,
              order,
              ...(id in arrangement.folders ? { folder: arrangement.folders[id] } : {}),
            }));
            persist();
          }
          return projects as T;
        }
        case "update_portal_layout":
          calls.setState((state) => ({ writes: [...state.writes, { command, args }] }));
          layout = { ...layout, ...args, revision: layout.revision + 1 };
          persist();
          return layout as T;
        case "get_system_usage":
          return usageSample(31) as T;
        case "invoke_on_node":
          if (args?.command === "changes_get_view") return { outcome: "ok", result: null } as T;
          // The machine tiles' CPU reads are not writes.
          if (args?.command === "get_system_usage")
            return { outcome: "ok", result: usageSample(18) } as T;
          calls.setState((state) => ({ writes: [...state.writes, { command, args }] }));
          return { outcome: "ok", result: {} } as T;
        case "reorder_environments":
          calls.setState((state) => ({ writes: [...state.writes, { command, args }] }));
          return undefined as T;
        case "get_connections":
          return { activeConnectionId: "local", connections: [] } as T;
        case "get_agent_registry":
          return (
            attentionTarget && typeof args?.environmentId === "string"
              ? attentionRegistry(args.environmentId)
              : { generatedAt: new Date().toISOString(), entries: [], environments: [] }
          ) as T;
        case "list_node_outcomes":
          return [] as T;
        case COORDINATOR_ACTIVITY_COMMAND:
          return { projects: {} } as T;
        default:
          return [] as T;
      }
    },
  };
  appCommandStore(projectStore).getState().setProjects(projects);
  appCommandStore(environmentStore).setState({ environments });
  if (mergeReady) {
    // The fixture has no PR monitor service, so seed its confirmed mirror.
    appCommandStore(prMonitorStore)
      .getState()
      .applySnapshot(
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
    appCommandStore(prMonitorStore).getState().setSyncStatus("current");
  }
  appCommandStore(uiStore).setState({
    collapsedProjects: [],
    collapsedProjectFolders: [],
    projectCollapseChoices: projects.map((p) => p.id),
    selectedProjectId: null,
    selectedEnvironmentId: null,
  });
  useUIChromeStore.setState({
    environmentSortMode: activitySort || crossMachine ? "activity" : "project",
    activitySortOrder: (params.get("order") as ActivitySortOrder | null) ?? "priority",
  });
  useMachineViewStore.setState({
    grouping: "repository",
    machineFilter: [],
    environmentOrdering: "machine",
    collapsedMachines: [],
    collapsedProjectKeys: [],
    collapsedFolderKeys: [],
  });
  return calls;
}

function AttentionTargetTranscript() {
  const environmentId = useUIStore((state) => state.selectedEnvironmentId);
  const activeTabId = usePaneLayoutStore((state) =>
    environmentId ? state.getActivePane(environmentId)?.activeTabId : null,
  );
  if (!environmentId) return null;
  function hydrate(id: string) {
    appCommandStore(paneLayoutStore)
      .getState()
      .finishHydration(id, {
        activePaneId: "attention-pane",
        containerId: null,
        root: {
          kind: "leaf",
          id: "attention-pane",
          activeTabId: "working-agent",
          tabs: [
            { id: "working-agent", type: "plain" },
            {
              id: ATTENTION_TAB,
              type: "agent-native",
              nativeAgentData: { environmentId: id, platform: "claude" },
            },
          ],
        },
      });
  }
  if (activeTabId !== ATTENTION_TAB)
    return (
      <button type="button" onClick={() => hydrate(environmentId)}>
        Finish layout hydration
      </button>
    );
  return (
    <section
      aria-label="Agent transcript"
      className="max-h-44 overflow-auto rounded border border-border p-2"
    >
      <div aria-hidden="true" className="h-72" />
      <NativeInteractionAnchor
        active
        environmentId={environmentId}
        tabId={ATTENTION_TAB}
        interactionId="other-question"
      >
        <div className="mb-4 rounded bg-muted p-2">Other pending question</div>
      </NativeInteractionAnchor>
      {!new URLSearchParams(location.search).has("settled") && (
        <NativeInteractionAnchor
          active
          environmentId={environmentId}
          tabId={ATTENTION_TAB}
          interactionId="question-target"
        >
          <div className="rounded bg-muted p-2">
            {environmentId === "p-env-2" ? HOME_QUESTION : ATTENTION_QUESTION}
          </div>
        </NativeInteractionAnchor>
      )}
    </section>
  );
}

let instance: ReturnType<typeof install> | undefined;
export function SidebarDragFixture() {
  const [calls] = useState(() => (instance ??= install()));
  const { writes } = useStore(calls);
  const params = new URLSearchParams(location.search);
  const attentionTarget = params.has("attention-target");
  return (
    <DockerAvailabilityProvider available={false}>
      <TerminalProvider>
        <FederationProvider>
          <main className="h-screen max-w-sm bg-background text-foreground">
            {!attentionTarget && (
              <output data-testid="sidebar-writes">{JSON.stringify(writes)}</output>
            )}
            {attentionTarget && <AttentionTargetTranscript />}
            <HierarchicalSidebar />
          </main>
        </FederationProvider>
      </TerminalProvider>
    </DockerAvailabilityProvider>
  );
}
