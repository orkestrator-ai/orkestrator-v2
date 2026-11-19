/**
 * The React side of the ⌘K command palette: the frozen context it acts on,
 * the runtime its commands call, its History provider and its
 * content-free measurement. The command model itself is plain TypeScript in
 * `lib/command-palette/`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { MAX_TABS_PER_ENVIRONMENT } from "@orkestrator/protocol/pane-layout";
import { toast } from "sonner";
import { createLogger } from "@orkestrator/protocol/logger";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import type { BackendId } from "@orkestrator/protocol/federation";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import { useFederation } from "@/components/federation/FederationProvider";
import { runFederatedEnvironmentPower } from "@/components/federation/useFederatedEnvironmentActions";
import { useMachineViews } from "@/components/federation/useMachineViews";
import { findNativeAgentAdapter } from "@/components/native-agent/adapter";
import { requestAppShortcut } from "@/lib/app-shortcuts";
import { backendForScope } from "@/lib/backend/scope-backend";
import { buildPaletteContext } from "@/lib/command-palette/context";
import {
  createTabHistoryProvider,
  paletteTabTitle,
  type HistoryResult,
  type HistorySource,
  type HistoryTabSource,
  type MessageHistoryResult,
  type SessionHistoryResult,
  type TabHistoryResult,
} from "@/lib/command-palette/history";
import {
  openPastSessionTab,
  requestMessageScroll,
} from "@/lib/command-palette/history-destinations";
import {
  createMessageHistoryProvider,
  type MessageHistorySource,
} from "@/lib/command-palette/history-messages";
import {
  createPastSessionLoader,
  createSessionHistoryProvider,
} from "@/lib/command-palette/history-sessions";
import type {
  CommandRuntime,
  CommandTarget,
  PaletteContext,
  PaletteSelection,
  UnavailableReasonCode,
} from "@/lib/command-palette/model";
import {
  PaletteQueryRunner,
  providerView,
  type PaletteProvider,
  type PaletteProviderState,
  type PaletteProviderStatus,
} from "@/lib/command-palette/providers";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import type { MachineView } from "@/lib/federation/aggregate";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { noteDrawerNavigation } from "@/lib/mobile-shell";
import { writeText } from "@/lib/native/clipboard";
import { useScopesWithCommandFallback, useSignal } from "@/lib/node-scope/providers";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { WindowScope } from "@/lib/node-scope/window-scope";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { environmentStore, useEnvironmentStore } from "@/stores/environmentStore";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useConfigStore } from "@/stores/configStore";
import { filesPanelStore } from "@/stores/filesPanelStore";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { getAllLeaves, paneLayoutStore, type EnvironmentPaneState } from "@/stores/paneLayoutStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { createSessionKey } from "@/lib/utils";
import {
  claimSidebarAction,
  releaseSidebarAction,
  useSidebarActionStore,
} from "@/stores/sidebarActionStore";
import { isCommandNodeSelection, useWindowSelection } from "@/stores/windowSelectionStore";
import type { Environment, Project } from "@/types";
import type { PaneNode, TabInfo } from "@/types/paneLayout";

const log = createLogger("web.command-palette");

/**
 * The logical session key the palette lists past sessions under. It names no
 * tab, so the backend's list excludes no conversation for it.
 */
const PALETTE_SESSION_LIST_KEY = "command-palette-history";

/** The sidebar's own handlers for this window's environments and projects. */
export interface CommandPaletteHandlers {
  startEnvironment?: (environmentId: string) => Promise<unknown>;
  stopEnvironment?: (environmentId: string) => Promise<unknown>;
  onAddProject?: () => void;
}

const NO_SELECTION: PaletteSelection = { nodeId: null, projectId: null, environmentId: null };

function toPaletteSelection(
  selection: { nodeId: string; projectId: string | null; environmentId: string | null } | null,
): PaletteSelection {
  return selection
    ? {
        nodeId: selection.nodeId,
        projectId: selection.projectId,
        environmentId: selection.environmentId,
      }
    : NO_SELECTION;
}

/** The machine views of a multi-machine view; empty for a single-machine client. */
export function usePaletteMachines(): readonly MachineView[] {
  const federation = useFederation();
  const views = useMachineViews();
  return federation.enabled ? views : [];
}

/**
 * The palette's context: the window's selection frozen when the palette
 * opens, resolved against live state on every render. `refresh` re-freezes
 * it on what the window shows now (an explicit user choice, offered when the
 * two differ).
 */
export function useCommandPaletteContext({
  open,
  projects,
  environments,
  machines,
  handlers,
  requireChecks,
}: {
  open: boolean;
  projects: readonly Project[];
  environments: readonly Environment[];
  machines: readonly MachineView[];
  handlers: CommandPaletteHandlers;
  requireChecks: boolean;
}): { context: PaletteContext; refresh: () => void; shownSelection: PaletteSelection } {
  const { windowScope } = useScopesWithCommandFallback();
  const windowSelection = useWindowSelection();
  const shown = useMemo(() => toPaletteSelection(windowSelection), [windowSelection]);
  const [frozen, setFrozen] = useState<PaletteSelection | null>(null);
  // Freeze on the render that opens the palette; forget when it closes.
  if (open && frozen === null) setFrozen(shown);
  if (!open && frozen !== null) setFrozen(null);
  const selection = open ? (frozen ?? shown) : shown;

  const deleting = useEnvironmentStore((state) => state.deletingEnvironments);
  const pending = useSidebarActionStore((state) => state.pending);
  const dockerAvailable = useDockerAvailability();
  const recentCommandCount = useCommandPaletteStore((state) => state.recentCommandIds.length);
  const rememberRecent = useCommandPaletteStore((state) => state.rememberRecent);
  const experimentalScheduling = useConfigStore(
    (state) => state.config.global.experimentalScheduling === true,
  );
  const experimentalSelfImprovement = useConfigStore(
    (state) => state.config.global.experimentalSelfImprovement === true,
  );
  const onWindowMachine = isCommandNodeSelection(
    windowScope,
    selection.nodeId === null ? null : { ...selection, nodeId: selection.nodeId as BackendId },
  );

  const workspaceScope = selection.nodeId ? windowScope.get(selection.nodeId as BackendId) : null;
  const tabOwner = workspaceScope ?? windowScope.commandScope();
  const environmentId = selection.environmentId;
  const tabLayout = useStore(tabOwner.store(paneLayoutStore), (state) =>
    open && environmentId && (workspaceScope || onWindowMachine)
      ? state.environments.get(environmentId)
      : undefined,
  );
  const workspaceEnvironment = useStore(tabOwner.store(environmentStore), (state) =>
    open && environmentId && (workspaceScope || onWindowMachine)
      ? state.getEnvironmentById(environmentId)
      : undefined,
  );
  const selectedEnvironment =
    workspaceEnvironment ??
    (onWindowMachine ? environments.find((env) => env.id === environmentId) : undefined);
  const agentTabBlock =
    selectedEnvironment?.setupPhase === "running"
      ? "setup"
      : tabLayout &&
          getAllLeaves(tabLayout.root).reduce((count, leaf) => count + leaf.tabs.length, 0) >=
            MAX_TABS_PER_ENVIRONMENT
        ? "limit"
        : !selectedEnvironment || selectedEnvironment.status !== "running"
          ? "unavailable"
          : undefined;

  const context = useMemo<PaletteContext>(
    () => ({
      ...buildPaletteContext({
        selection,
        shownSelection: shown,
        machines,
        onWindowMachine,
        localProjects: projects,
        localEnvironments: environments,
        localDeleting: deleting,
        pending,
        dockerAvailable,
        requireChecks,
        handlers: {
          environmentPower: Boolean(handlers.startEnvironment && handlers.stopEnvironment),
          addProject: Boolean(handlers.onAddProject),
        },
        recentCommandCount,
        rememberRecentCommands: rememberRecent,
        settingsFlags: { experimentalScheduling, experimentalSelfImprovement },
      }),
      agentTabBlock,
    }),
    [
      agentTabBlock,
      selection,
      shown,
      machines,
      onWindowMachine,
      projects,
      environments,
      deleting,
      pending,
      dockerAvailable,
      requireChecks,
      handlers.startEnvironment,
      handlers.stopEnvironment,
      handlers.onAddProject,
      recentCommandCount,
      rememberRecent,
      experimentalScheduling,
      experimentalSelfImprovement,
    ],
  );
  return { context, refresh: () => setFrozen(shown), shownSelection: shown };
}

/** The node scope holding `machine`'s workspace in this window, when it has one. */
function machineScope(windowScope: WindowScope, target: CommandTarget): NodeScope | null {
  if (!target.machine || target.machine.bound) return windowScope.commandScope();
  return windowScope.get(target.machine.backendId as BackendId);
}

/** The connection `openMachineWorkspace` takes: empty for this window's own machine. */
function targetConnection(target: CommandTarget): string {
  return target.machine && !target.machine.bound ? target.machine.connectionId : "";
}

/**
 * The actions commands call, built from the paths the sidebar, menus and
 * shortcuts already use. Every action takes the command's frozen target;
 * nothing reads the window's current selection.
 */
export function useCommandRuntime({
  handlers,
  machines,
}: {
  handlers: CommandPaletteHandlers;
  machines: readonly MachineView[];
}): CommandRuntime {
  const { windowScope } = useScopesWithCommandFallback();
  const { portal } = useFederation();
  const latest = useRef({ handlers, machines });
  useEffect(() => {
    latest.current = { handlers, machines };
  }, [handlers, machines]);
  const clearRecent = useCommandPaletteStore((state) => state.clearRecent);
  const setRememberRecent = useCommandPaletteStore((state) => state.setRememberRecent);

  return useMemo<CommandRuntime>(
    () => ({
      openEnvironment: (target, options = {}) => {
        const environment = target.environment;
        if (!environment) return;
        noteDrawerNavigation();
        openMachineWorkspace({
          connectionId: targetConnection(target),
          projectId: environment.projectId,
          environmentId: environment.id,
          ...(options.dialog ? { dialog: options.dialog } : {}),
          title: environment.name,
        });
        if (options.filesPanelTab) {
          machineScope(windowScope, target)
            ?.store(filesPanelStore)
            .getState()
            .setActiveTab(options.filesPanelTab);
          useFilesPanelChromeStore.getState().openPanel();
        }
      },
      openProject: (target, options = {}) => {
        const project = target.project;
        if (!project) return;
        noteDrawerNavigation();
        openMachineWorkspace({
          connectionId: targetConnection(target),
          projectId: project.id,
          ...(options.boardTab ? { boardTab: options.boardTab } : {}),
          ...(options.dialog ? { dialog: options.dialog } : {}),
          ...(options.createEnvironment ? { createEnvironment: true } : {}),
          title: project.name,
        });
      },
      openGlobalSettings: (section, machine) =>
        requestGlobalSettings(
          section,
          machine === undefined ? undefined : machine?.bound ? null : (machine?.backendId ?? null),
        ),
      requestAppShortcut: (id) => requestAppShortcut(id),
      environmentPower: async (action, target) => {
        const environment = target.environment;
        if (!environment) return;
        const { handlers: current, machines: views } = latest.current;
        if (target.machine && !target.machine.bound) {
          // Another machine's: the row's own path, on the summary read now.
          const machine = views.find(
            (view) =>
              view.connectionId === target.machine?.connectionId &&
              view.backendId === target.machine.backendId,
          );
          const summary = machine
            ? machine.environmentsByProject
                .get(environment.projectId)
                ?.find((entry) => entry.ref.environmentId === environment.id)
            : undefined;
          if (!machine || !summary) {
            toast.error(`Could not reach ${environment.name}`, {
              description: `It is no longer listed on ${target.machine.name}.`,
            });
            return;
          }
          await runFederatedEnvironmentPower(portal, machine, summary, action);
          return;
        }
        const handler = action === "start" ? current.startEnvironment : current.stopEnvironment;
        if (!handler) return;
        // This client runs one action per environment at a time, as bulk actions do.
        if (!claimSidebarAction(environment.id)) return;
        try {
          await handler(environment.id);
        } catch {
          // `useEnvironments` reports this window's own failures itself.
        } finally {
          releaseSidebarAction(environment.id);
        }
      },
      addProject: () => latest.current.handlers.onAddProject?.(),
      copyText: (text, successMessage) => {
        writeText(text).then(
          () => toast.success(successMessage, { description: text }),
          () => toast.error("Could not copy to the clipboard"),
        );
      },
      clearRecentCommands: clearRecent,
      setRememberRecentCommands: setRememberRecent,
    }),
    [clearRecent, portal, setRememberRecent, windowScope],
  );
}

/** Opens a History row's tab on its own machine, as an attention line opens one. */
function openHistoryTab(result: HistoryResult, tabId: string): void {
  const workTarget = {
    type: "worker-tab" as const,
    projectId: result.projectId,
    environmentId: result.environmentId,
    tabId,
  };
  noteDrawerNavigation();
  if (!result.machine || result.machine.bound) {
    openCoordinatorWorkTarget(workTarget);
    return;
  }
  openMachineWorkspace({
    connectionId: result.machine.connectionId,
    projectId: result.projectId,
    environmentId: result.environmentId,
    title: result.environmentName,
    workTarget,
  });
}

function* historyTabs(node: PaneNode): IterableIterator<TabInfo> {
  if (node.kind === "leaf") yield* node.tabs;
  else for (const child of node.children) yield* historyTabs(child);
}

interface HistoryEnvironmentMetadata {
  environments: ReadonlyMap<string, { name: string; projectId: string }>;
  projects: ReadonlyMap<string, string>;
}

/** Each environment's layout, the palette's own environment first. */
function* orderedLayouts(
  layouts: ReadonlyMap<string, EnvironmentPaneState>,
  first: string | null,
): IterableIterator<[string, EnvironmentPaneState]> {
  const selected = first ? layouts.get(first) : undefined;
  if (first && selected) yield [first, selected];
  for (const entry of layouts) {
    if (entry[0] !== first) yield entry;
  }
}

function* historySources(
  layouts: ReadonlyMap<string, EnvironmentPaneState>,
  first: string | null,
  metadata: HistoryEnvironmentMetadata,
): IterableIterator<HistoryTabSource | null> {
  for (const [environmentId, layout] of orderedLayouts(layouts, first)) {
    const environment = metadata.environments.get(environmentId);
    yield environment
      ? {
          environmentId,
          environmentName: environment.name,
          projectId: environment.projectId,
          projectName: metadata.projects.get(environment.projectId) ?? "",
          tabs: historyTabs(layout.root),
        }
      : null;
  }
}

/** The open agent tabs whose loaded messages the message source searches. */
function* messageSources(
  layouts: ReadonlyMap<string, EnvironmentPaneState>,
  first: string | null,
  metadata: HistoryEnvironmentMetadata,
  projections: () => ReadonlyMap<string, { messages?: readonly unknown[] }>,
): IterableIterator<MessageHistorySource> {
  for (const [environmentId, layout] of orderedLayouts(layouts, first)) {
    const environment = metadata.environments.get(environmentId);
    if (!environment) continue;
    for (const tab of historyTabs(layout.root)) {
      if (tab.type !== "agent-native" || tab.embeddedIn) continue;
      const sessionKey = createSessionKey(environmentId, tab.id);
      yield {
        environmentId,
        environmentName: environment.name,
        projectId: environment.projectId,
        projectName: metadata.projects.get(environment.projectId) ?? "",
        tabId: tab.id,
        tabTitle: paletteTabTitle(tab).title,
        messages: () => projections().get(sessionKey)?.messages,
      };
    }
  }
}

/** Resume-capable platforms of the environment's open agent tabs, and the conversations they hold. */
function pastSessionPlatforms(layout: EnvironmentPaneState | undefined): {
  platforms: AgentPlatform[];
  openSessionIds: Set<string>;
} {
  const platforms = new Set<AgentPlatform>();
  const openSessionIds = new Set<string>();
  if (layout) {
    for (const tab of historyTabs(layout.root)) {
      const data = tab.type === "agent-native" ? tab.nativeAgentData : undefined;
      if (!data?.platform) continue;
      if (data.sessionId) openSessionIds.add(data.sessionId);
      if (nativeAgentCapabilities(data.platform).resume) platforms.add(data.platform);
    }
  }
  return { platforms: Array.from(platforms).sort(), openSessionIds };
}

export interface HistoryGroupView<Row> {
  status: PaletteProviderStatus;
  rows: Row[];
  /** Why the group has nothing to search, when it says so. */
  note?: string;
}

/**
 * Runs `create(request)`'s provider for each new request (its identity is
 * the request), discarding answers for older ones.
 */
function useProviderAnswer<Request extends { query: string }, Row>(
  request: Request | null,
  create: (request: Request) => PaletteProvider<Row>,
): HistoryGroupView<Row> {
  const createRef = useRef(create);
  useEffect(() => {
    createRef.current = create;
  });
  const [state, setState] = useState<{
    request: Request;
    answer: PaletteProviderState<Row>;
  } | null>(null);
  useEffect(() => {
    if (!request) return;
    const runner = new PaletteQueryRunner(createRef.current(request), (answer) =>
      setState({ request, answer }),
    );
    runner.run(request.query, request.query);
    return () => runner.dispose();
  }, [request]);
  return providerView(state?.request === request ? state.answer : null, request?.query ?? null);
}

const IDLE_GROUP = { status: "idle" as const, rows: [] };

/**
 * The History group's three sources, each with its own status: open tabs,
 * messages loaded in open agent tabs, and the frozen environment's past
 * conversations. Only the frozen owner's state is searched, and each request
 * is invalidated whenever its inputs change.
 */
export function useHistorySearch({
  open,
  context,
  query,
  enabled,
  environments,
  projects,
  machines,
}: {
  open: boolean;
  context: PaletteContext;
  query: string;
  enabled: boolean;
  environments: readonly Environment[];
  projects: readonly Project[];
  machines: readonly MachineView[];
}): {
  status: PaletteProviderStatus;
  tabs: HistoryGroupView<TabHistoryResult>;
  messages: HistoryGroupView<MessageHistoryResult>;
  sessions: HistoryGroupView<SessionHistoryResult>;
  openResult: (result: HistoryResult) => boolean;
} {
  const { windowScope } = useScopesWithCommandFallback();
  useSignal(windowScope.nodeScopes);
  const { machine, machineMissing } = context;
  const scope = machineMissing
    ? null
    : machineScope(windowScope, { machine, project: null, environment: null });
  const layoutStore = (scope ?? windowScope.commandScope()).store(paneLayoutStore);
  const layouts = useStore(layoutStore, (state) => (enabled && scope ? state.environments : null));
  const first = context.environment?.id ?? null;
  // The palette's environment's tabs, read while it is open so the past
  // sessions are listed once per palette session, not once per keystroke.
  const frozenLayout = useStore(layoutStore, (state) =>
    open && scope && first ? state.environments.get(first) : undefined,
  );
  const view =
    machine && !machine.bound
      ? machines.find((entry) => entry.connectionId === machine.connectionId)
      : undefined;
  const metadata = useMemo<HistoryEnvironmentMetadata | null>(() => {
    if (!enabled || !scope) return null;
    if (view) {
      const environments = new Map<string, { name: string; projectId: string }>();
      for (const entries of view.environmentsByProject.values()) {
        for (const entry of entries) environments.set(entry.ref.environmentId, entry);
      }
      return {
        environments,
        projects: new Map(view.projects.map((project) => [project.ref.projectId, project.name])),
      };
    }
    return {
      environments: new Map(environments.map((environment) => [environment.id, environment])),
      projects: new Map(projects.map((project) => [project.id, project.name])),
    };
  }, [enabled, scope, view, environments, projects]);
  const ownerKey = machine?.connectionId ?? null;
  // The identity changes even in an A → B → A query sequence or after reopening.
  const request = useMemo(
    () => (layouts && metadata ? { query, layouts, first, metadata, ownerKey } : null),
    [query, layouts, first, metadata, ownerKey],
  );
  const machineRef = useRef(machine);
  useEffect(() => {
    machineRef.current = machine;
  }, [machine]);

  const tabs = useProviderAnswer(request, (current) =>
    createTabHistoryProvider({
      machine: () => machineRef.current,
      sources: () => historySources(current.layouts, current.first, current.metadata),
    }),
  );
  const projectionScope = scope;
  const messages = useProviderAnswer(request, (current) =>
    createMessageHistoryProvider({
      machine: () => machineRef.current,
      sources: () =>
        projectionScope
          ? messageSources(
              current.layouts,
              current.first,
              current.metadata,
              () => projectionScope.store(nativeAgentProjectionStore).getState().projections,
            )
          : [],
    }),
  );

  // Past sessions: the palette's own environment, while it is running.
  const environment = context.environment;
  const sessionsRunnable =
    environment !== null && context.agentTabBlock !== "unavailable" && !context.targetUnknown;
  const { platforms, openSessionIds } = useMemo(
    () => pastSessionPlatforms(frozenLayout),
    [frozenLayout],
  );
  const platformsKey = platforms.join(",");
  const backendScope = scope;
  // One loader per palette session, environment and platform set.
  const environmentId = environment?.id ?? null;
  const environmentName = environment?.name ?? "";
  const environmentProjectId = environment?.projectId ?? "";
  const loader = useMemo(
    () =>
      open && backendScope && environmentId && sessionsRunnable && platformsKey
        ? createPastSessionLoader({
            platforms: platformsKey.split(",") as AgentPlatform[],
            list: (platform) =>
              backendForScope(backendScope).listNativeAgentResumableSessions({
                environmentId,
                agent: platform,
                logicalSessionKey: createSessionKey(environmentId, PALETTE_SESSION_LIST_KEY),
              }),
          })
        : null,
    [open, backendScope, environmentId, sessionsRunnable, platformsKey],
  );
  const projectName = environmentId
    ? (projects.find((project) => project.id === environmentProjectId)?.name ??
      view?.projects.find((project) => project.ref.projectId === environmentProjectId)?.name ??
      "")
    : "";
  const sessionRequest = useMemo(
    () =>
      enabled && loader && environmentId
        ? {
            query,
            loader,
            openSessionIds,
            environment: {
              id: environmentId,
              name: environmentName,
              projectId: environmentProjectId,
              projectName,
            },
          }
        : null,
    [
      enabled,
      loader,
      query,
      openSessionIds,
      environmentId,
      environmentName,
      environmentProjectId,
      projectName,
    ],
  );
  const sessionsAnswer = useProviderAnswer(sessionRequest, (current) =>
    createSessionHistoryProvider({
      loader: current.loader,
      environment: current.environment,
      machine: () => machineRef.current,
      openSessionIds: current.openSessionIds,
      platformLabel: (platform) => findNativeAgentAdapter(platform)?.label ?? platform,
    }),
  );
  const sessions: HistoryGroupView<SessionHistoryResult> =
    !enabled || !environment
      ? IDLE_GROUP
      : !sessionsRunnable
        ? {
            ...IDLE_GROUP,
            status: "ready",
            note: `Start ${environment.name} to list its past sessions.`,
          }
        : !platformsKey
          ? {
              ...IDLE_GROUP,
              status: "ready",
              note: `Open an agent tab in ${environment.name} to list that agent's past sessions.`,
            }
          : sessionsAnswer;

  const unreachable = enabled && !scope;
  const groups = {
    tabs: unreachable ? { status: "failed" as const, rows: [] } : tabs,
    messages: unreachable ? { status: "failed" as const, rows: [] } : messages,
    sessions,
  };
  const statuses = [groups.tabs.status, groups.messages.status, groups.sessions.status];
  const status: PaletteProviderStatus = statuses.includes("loading")
    ? "loading"
    : statuses.every((entry) => entry === "idle")
      ? "idle"
      : statuses.includes("failed")
        ? "failed"
        : statuses.includes("partial")
          ? "partial"
          : "ready";

  /** The row's owner is still this window's or still listed, and its environment is still its project's. */
  const ownerStillListed = (result: HistoryResult): boolean => {
    const owner = result.machine;
    if (
      owner &&
      !owner.bound &&
      !machines.some(
        (entry) => entry.connectionId === owner.connectionId && entry.backendId === owner.backendId,
      )
    )
      return false;
    return metadata?.environments.get(result.environmentId)?.projectId === result.projectId;
  };
  const tabStillOpen = (environmentId: string, tabId: string): boolean => {
    const pane = layoutStore.getState().findPaneWithTab(tabId, environmentId);
    return Boolean(pane?.tabs.some((tab) => tab.id === tabId && !tab.embeddedIn));
  };

  return {
    status,
    ...groups,
    openResult: (result) => {
      if (!scope || !ownerStillListed(result)) return false;
      if (result.source === "tab") {
        if (!groups.tabs.rows.includes(result) || !tabStillOpen(result.environmentId, result.tabId))
          return false;
        openHistoryTab(result, result.tabId);
        return true;
      }
      if (result.source === "message") {
        if (
          !groups.messages.rows.includes(result) ||
          !tabStillOpen(result.environmentId, result.tabId)
        )
          return false;
        requestMessageScroll(scope, result);
        openHistoryTab(result, result.tabId);
        return true;
      }
      // A past session opens a new tab in the palette's own environment only.
      if (!groups.sessions.rows.includes(result) || result.environmentId !== environment?.id)
        return false;
      const block = context.agentTabBlock;
      if (block) {
        toast.error(`Cannot open a tab in ${result.environmentName}`, {
          description:
            block === "setup"
              ? "Wait for its setup to finish."
              : block === "limit"
                ? "It has the most tabs it can hold. Close one first."
                : "Start it first.",
        });
        return false;
      }
      // This window's own list knows its environments before the scope's store may.
      const ownRecord =
        !machine || machine.bound
          ? environments.find((entry) => entry.id === result.environmentId)
          : undefined;
      const tabId = openPastSessionTab(scope, result, ownRecord);
      if (!tabId) {
        toast.error(`Could not open a tab in ${result.environmentName}`, {
          description: "Open the environment, then try again.",
        });
        return false;
      }
      openHistoryTab(result, tabId);
      return true;
    },
  };
}

export type PaletteActivationKind =
  | { kind: "command"; commandId: string }
  | { kind: "destination"; destination: "project" | "environment" }
  | { kind: "history"; source: HistorySource };

/**
 * Content-free measurement for one palette session: what was activated (a
 * static command ID or a result kind, never a name or the query), how long
 * after opening, how many queries found nothing, and which prerequisite
 * categories were missing. Written once, when the palette closes.
 */
export function usePaletteMeasurement(open: boolean) {
  const session = useRef<{
    openedAt: number;
    activated: PaletteActivationKind | null;
    activatedAfterMs: number | null;
    noResultQueries: number;
    unavailableChoices: number;
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    session.current = {
      openedAt: performance.now(),
      activated: null,
      activatedAfterMs: null,
      noResultQueries: 0,
      unavailableChoices: 0,
    };
    return () => {
      const ended = session.current;
      session.current = null;
      if (!ended) return;
      log.info("session.closed", {
        activated:
          ended.activated === null
            ? "none"
            : ended.activated.kind === "command"
              ? ended.activated.commandId
              : ended.activated.kind === "destination"
                ? `destination.${ended.activated.destination}`
                : `history.${ended.activated.source}`,
        activatedAfterMs: ended.activatedAfterMs ?? -1,
        openForMs: Math.round(performance.now() - ended.openedAt),
        noResultQueries: ended.noResultQueries,
        unavailableChoices: ended.unavailableChoices,
      });
    };
  }, [open]);

  return useMemo(
    () => ({
      activated: (kind: PaletteActivationKind) => {
        const current = session.current;
        if (!current) return;
        current.activated = kind;
        current.activatedAfterMs = Math.round(performance.now() - current.openedAt);
      },
      noResults: () => {
        if (session.current) session.current.noResultQueries += 1;
      },
      unavailable: (commandId: string, code: UnavailableReasonCode) => {
        if (session.current) session.current.unavailableChoices += 1;
        log.info("command.unavailable", { commandId, reason: code });
      },
      revalidationFailed: (commandId: string, code: UnavailableReasonCode) => {
        log.warn("command.revalidation-failed", { commandId, reason: code });
      },
    }),
    [],
  );
}
