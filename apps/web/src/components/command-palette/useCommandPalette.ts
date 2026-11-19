/**
 * The React side of the ⌘K command palette: the frozen context it acts on,
 * the runtime its commands call, its History provider and its
 * content-free measurement. The command model itself is plain TypeScript in
 * `lib/command-palette/`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { createLogger } from "@orkestrator/protocol/logger";
import type { BackendId } from "@orkestrator/protocol/federation";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import { useFederation } from "@/components/federation/FederationProvider";
import { runFederatedEnvironmentPower } from "@/components/federation/useFederatedEnvironmentActions";
import { useMachineViews } from "@/components/federation/useMachineViews";
import { requestAppShortcut } from "@/lib/app-shortcuts";
import { buildPaletteContext } from "@/lib/command-palette/context";
import {
  createTabHistoryProvider,
  type HistoryResult,
  type HistoryTabSource,
} from "@/lib/command-palette/history";
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
  type PaletteProviderState,
  type PaletteProviderStatus,
} from "@/lib/command-palette/providers";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import type { MachineView } from "@/lib/federation/aggregate";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { noteDrawerNavigation } from "@/lib/mobile-shell";
import { writeText } from "@/lib/native/clipboard";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { WindowScope } from "@/lib/node-scope/window-scope";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useEnvironmentStore } from "@/stores";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useConfigStore } from "@/stores/configStore";
import { filesPanelStore } from "@/stores/filesPanelStore";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import {
  claimSidebarAction,
  releaseSidebarAction,
  useSidebarActionStore,
} from "@/stores/sidebarActionStore";
import { isCommandNodeSelection, useWindowSelection } from "@/stores/windowSelectionStore";
import type { Environment, Project } from "@/types";

const log = createLogger("web.command-palette");

/** The sidebar's own handlers for this window's environments and projects. */
export interface CommandPaletteHandlers {
  startEnvironment?: (environmentId: string) => Promise<unknown>;
  stopEnvironment?: (environmentId: string) => Promise<unknown>;
  restartEnvironment?: (environmentId: string) => Promise<unknown>;
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

  const context = useMemo(
    () =>
      buildPaletteContext({
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
          environmentPower: Boolean(
            handlers.startEnvironment && handlers.stopEnvironment && handlers.restartEnvironment,
          ),
          addProject: Boolean(handlers.onAddProject),
        },
        recentCommandCount,
        rememberRecentCommands: rememberRecent,
        settingsFlags: { experimentalScheduling, experimentalSelfImprovement },
      }),
    [
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
      handlers.restartEnvironment,
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
      openGlobalSettings: (section) => requestGlobalSettings(section),
      requestAppShortcut: (id) => requestAppShortcut(id),
      environmentPower: async (action, target) => {
        const environment = target.environment;
        if (!environment) return;
        const { handlers: current, machines: views } = latest.current;
        if (target.machine && !target.machine.bound) {
          // Another machine's: the row's own path, on the summary read now.
          const machine = views.find((view) => view.connectionId === target.machine?.connectionId);
          const summary = machine
            ? Array.from(machine.environmentsByProject.values())
                .flat()
                .find((entry) => entry.ref.environmentId === environment.id)
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
        const handler =
          action === "start"
            ? current.startEnvironment
            : action === "stop"
              ? current.stopEnvironment
              : current.restartEnvironment;
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
export function openHistoryResult(result: HistoryResult): void {
  const workTarget = {
    type: "worker-tab" as const,
    projectId: result.projectId,
    environmentId: result.environmentId,
    tabId: result.tabId,
  };
  noteDrawerNavigation();
  if (!result.machine || result.machine.bound) {
    // This window's machine is the command scope's node.
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

/** The open tabs of the palette's machine, its own environment first. */
function historySources(
  windowScope: WindowScope,
  {
    environments: local,
    machines: views,
    context,
  }: {
    environments: readonly Environment[];
    machines: readonly MachineView[];
    context: PaletteContext;
  },
): HistoryTabSource[] {
  const machine = context.machine;
  const scope = machineScope(windowScope, { machine, project: null, environment: null });
  if (!scope) return [];
  const layouts = scope.store(paneLayoutStore).getState();
  const view =
    machine && !machine.bound
      ? (views.find((entry) => entry.connectionId === machine.connectionId) ?? null)
      : null;
  const describe = (environmentId: string) => {
    if (view) {
      const summary = Array.from(view.environmentsByProject.values())
        .flat()
        .find((entry) => entry.ref.environmentId === environmentId);
      if (!summary) return null;
      const project = view.projects.find((entry) => entry.ref.projectId === summary.projectId);
      return { name: summary.name, projectId: summary.projectId, projectName: project?.name ?? "" };
    }
    const environment = local.find((entry) => entry.id === environmentId);
    if (!environment) return null;
    return {
      name: environment.name,
      projectId: environment.projectId,
      projectName: context.project?.id === environment.projectId ? context.project.name : "",
    };
  };
  const first = context.environment?.id;
  const ids = Array.from(layouts.environments.keys()).sort((left, right) =>
    left === first ? -1 : right === first ? 1 : 0,
  );
  const sources: HistoryTabSource[] = [];
  for (const environmentId of ids) {
    const described = describe(environmentId);
    if (!described) continue;
    sources.push({
      environmentId,
      environmentName: described.name,
      projectId: described.projectId,
      projectName: described.projectName,
      tabs: layouts.getAllTabs(environmentId),
    });
  }
  return sources;
}

/**
 * Searches the open tabs of the palette's machine when History is in scope.
 * Each query is a new generation; an older answer is discarded and its scan
 * aborted, and closing the palette stops the runner.
 */
export function useHistorySearch({
  context,
  query,
  enabled,
  environments,
  machines,
}: {
  context: PaletteContext;
  query: string;
  enabled: boolean;
  environments: readonly Environment[];
  machines: readonly MachineView[];
}): { status: PaletteProviderStatus; rows: HistoryResult[] } {
  const { windowScope } = useScopesWithCommandFallback();
  const sourcesRef = useRef({ environments, machines, context });
  useEffect(() => {
    sourcesRef.current = { environments, machines, context };
  }, [context, environments, machines]);
  const nodeKey = context.machine && !context.machine.bound ? context.machine.backendId : "this";

  const [state, setState] = useState<PaletteProviderState<HistoryResult> | null>(null);
  // The key names the machine and the query, so another machine's tabs or
  // another query is a new request.
  const key = enabled ? `${nodeKey}\u0000${query}` : null;
  useEffect(() => {
    // One runner per request: the cleanup aborts it and discards its answer,
    // so only the latest query's rows are ever reported. The tabs and names
    // are read when the search runs, from the latest sources.
    if (key === null) return;
    const provider = createTabHistoryProvider({
      machine: () => sourcesRef.current.context.machine,
      sources: () => historySources(windowScope, sourcesRef.current),
    });
    const runner = new PaletteQueryRunner(provider, setState);
    runner.run(query, key);
    return () => runner.dispose();
  }, [key, query, windowScope]);

  return providerView(state, key);
}

export type PaletteActivationKind =
  | { kind: "command"; commandId: string }
  | { kind: "destination"; destination: "project" | "environment" }
  | { kind: "history" };

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
                : "history",
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
      revalidationFailed: (commandId: string, code: UnavailableReasonCode | "target-changed") => {
        log.warn("command.revalidation-failed", { commandId, reason: code });
      },
    }),
    [],
  );
}
