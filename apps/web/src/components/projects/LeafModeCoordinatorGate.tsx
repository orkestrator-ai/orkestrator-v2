import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { loadProjectsFromBackend } from "@/hooks/useProjects";
import { repositoryHint } from "@/lib/federation/summaries";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { coordinatorDefersToCommandNode } from "@/lib/federation/window-grouping";
import { useNodeScope, useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useFederation } from "@/components/federation/FederationProvider";
import { useWindowGrouping } from "@/components/federation/useWindowGrouping";
import { projectStore } from "@/stores/projectStore";
import { portalStore } from "@/lib/portal/portal-store";
import { useProjectStore, useUIStore } from "@/stores";

/** Whether `scope` is another node shown in the window's own tree (plan item 4001). */
function isInTreeLeaf(scope: NodeScope | null): boolean {
  return scope?.role === "leaf";
}

/** The workspace's node and the project: a project id is per node. */
export function leafCoordinatorGateKey(
  projectId: string | undefined,
  scope: NodeScope | null = null,
): string {
  const node = isInTreeLeaf(scope) ? scope!.nodeId : "local";
  return `${node}:${projectId ?? ""}`;
}

/** What the gate needs of the command node, on a leaf. */
interface CommandNodeFacts {
  /** Whether `self` has been read (a failed read counts: `self` is then null). */
  readonly loaded: boolean;
  readonly self: {
    readonly displayName: string;
    readonly truncated: boolean;
    readonly projects: ReadonlyArray<{
      readonly ref: { readonly projectId: string };
      readonly name: string;
      readonly repositoryHint?: string | null;
    }>;
  } | null;
  /** The command node, for opening its coordinator; null while unknown. */
  readonly nodeId: string | null;
  readonly retry: () => Promise<void>;
}

/**
 * For a node in the window's tree (plan items 4001 and 5004): the command
 * node is the window's command scope, which holds its projects directly. A
 * failed read of them leaves `self` null, so the gate offers a retry rather
 * than waiting for ever.
 */
function useCommandScopeNode(enabled: boolean): CommandNodeFacts | null {
  const { windowScope } = useScopesWithCommandFallback();
  const commandScope = windowScope.commandScope();
  const { boundMachine } = useFederation();
  const selfId = useStore(portalStore.store, (state) => state.selfId);
  const projects = useStore(commandScope.store(projectStore), (state) =>
    enabled ? state.projects : null,
  );
  const hasLoaded = useStore(
    commandScope.store(projectStore),
    (state) => enabled && state.hasLoaded,
  );
  const failed = useStore(
    commandScope.store(projectStore),
    (state) => enabled && !state.hasLoaded && !state.isLoading && state.error !== null,
  );
  return useMemo(
    () =>
      projects
        ? {
            loaded: hasLoaded || failed,
            self: hasLoaded
              ? {
                  displayName: boundMachine?.name ?? "",
                  truncated: false,
                  projects: projects.map((project) => ({
                    ref: { projectId: project.id },
                    name: project.name,
                    repositoryHint: repositoryHint(project.gitUrl),
                  })),
                }
              : null,
            // Opening the command node's own project needs no portal id: the
            // window shows its own node for its command scope's id too.
            nodeId: selfId ?? commandScope.nodeId,
            retry: () => loadProjectsFromBackend(commandScope),
          }
        : null,
    [boundMachine?.name, commandScope, failed, hasLoaded, projects, selfId],
  );
}

/** Shown while the facts the gate decides on are still loading. */
function PendingCoordination() {
  return (
    <div
      id="project-panel-coordinator"
      role="tabpanel"
      className="flex h-full items-center justify-center text-sm text-muted-foreground"
      data-testid="leaf-mode-coordinator-pending"
    >
      <p role="status">Checking repository coordination…</p>
    </div>
  );
}

/**
 * Coordinators belong to the command node. A node attached to another
 * command node (leaf mode) keeps its own coordinator conversations, since
 * they may hold important information, but they stay behind this notice
 * until the user chooses to open them. That choice lasts for the app session,
 * per project (`openedLeafCoordinators` in the UI store). Nothing is shown,
 * and so nothing starts the coordinator, until the portal status has loaded;
 * a failed status read counts as loaded, so a broken portal never hides it.
 *
 * A node the user reaches through a command node (a leaf shown in the
 * window's tree) follows the window's sidebar grouping (`machineViewStore`)
 * and takes the command node's projects from the window's command scope.
 * Grouped by repository,
 * the notice leads to the command node's coordinator for the same
 * repository when the command node has one, and the leaf's opens directly
 * when it has not. An unavailable or incomplete summary cannot establish
 * absence, so the user can retry or explicitly open this node's coordinator.
 * Grouped by machine, project or activity, the machines are not
 * linked, so the leaf's coordinator opens directly.
 */
export function LeafModeCoordinatorGate({
  projectId,
  children,
}: {
  projectId?: string;
  children: ReactNode;
}) {
  const status = useStore(portalStore.store, (state) => state.status);
  const portalStatusLoaded = useStore(portalStore.store, (state) => state.loaded);
  const scope = useNodeScope();
  // Another node in the window's tree is on a leaf; the command node's
  // projects come from the window's command scope.
  const onLeaf = isInTreeLeaf(scope);
  const commandNode = useCommandScopeNode(onLeaf);
  const self = commandNode?.self ?? null;
  const commandNodeId = commandNode?.nodeId ?? null;
  const portalLoaded = onLeaf ? (commandNode?.loaded ?? false) : portalStatusLoaded;
  const projectsLoaded = useProjectStore((state) => state.hasLoaded);
  const projectsLoading = useProjectStore((state) => state.isLoading);
  const projectsError = useProjectStore((state) => state.error);
  const gitUrl = useProjectStore(
    (state) => state.projects.find((project) => project.id === projectId)?.gitUrl,
  );
  // The window's grouping, read from the window's own stores (plan item 4005).
  const grouping = useWindowGrouping();
  const gateKey = leafCoordinatorGateKey(projectId, scope);
  const opened = useUIStore((state) => state.openedLeafCoordinators.includes(gateKey));
  const openLeafCoordinator = useUIStore((state) => state.openLeafCoordinator);
  const openAnyway = () => openLeafCoordinator(gateKey);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (!portalStore.getState().loaded) void portalStore.refresh();
  }, []);

  if (opened) return <>{children}</>;
  // The portal status is the command node's: on a leaf window it is not this
  // node's mode. Until it loads, this node's mode is unknown. A failed read
  // still marks it loaded, so the coordinator then opens as on any other node.
  if (!onLeaf && !portalLoaded) return <PendingCoordination />;
  const leafMode = !onLeaf && status?.mode === "leaf";
  if (!onLeaf && !leafMode) return <>{children}</>;
  if (onLeaf && !coordinatorDefersToCommandNode(grouping)) return <>{children}</>;

  // No known controller name (an empty list, or blank names) reads as the command node.
  const controllerNames = onLeaf
    ? [self?.displayName]
    : (status?.controllers ?? []).map((entry) => entry.displayName);
  const named = controllerNames.map((name) => (name ?? "").trim()).filter(Boolean);
  const controllers = named.length > 0 ? named.join(", ") : "the command node";
  const hint = repositoryHint(gitUrl);
  const commandProject =
    onLeaf && hint ? self?.projects.find((project) => project.repositoryHint === hint) : undefined;

  if (onLeaf) {
    const projectReadFailed = !projectsLoaded && !projectsLoading && projectsError;
    const summaryUnavailable = portalLoaded && !self;
    const summaryIncomplete = portalLoaded && self?.truncated && !commandProject;
    if (projectReadFailed || summaryUnavailable || summaryIncomplete) {
      return (
        <div
          id="project-panel-coordinator"
          role="tabpanel"
          className="flex h-full items-center justify-center p-6"
          data-testid="leaf-mode-coordinator-unavailable"
        >
          <div className="max-w-md space-y-3 text-sm">
            <p role="alert">
              {projectReadFailed
                ? `Could not load this node's projects: ${projectsError}`
                : summaryUnavailable
                  ? "The command node's repository information is unavailable."
                  : "The command node's repository list is incomplete."}{" "}
              We could not confirm whether this repository has a coordinator on the command node.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={retrying || projectsLoading}
                onClick={async () => {
                  setRetrying(true);
                  try {
                    await Promise.all([
                      commandNode?.retry(),
                      ...(!projectsLoaded ? [loadProjectsFromBackend(scope)] : []),
                    ]);
                  } finally {
                    setRetrying(false);
                  }
                }}
              >
                {retrying ? "Retrying…" : "Try again"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={openAnyway}>
                Open this node&apos;s coordinator anyway
              </Button>
            </div>
          </div>
        </div>
      );
    }
    // Until the command node's projects are known, show neither the notice
    // nor the conversations.
    if (!portalLoaded || !projectsLoaded) return <PendingCoordination />;
    // The command node has no copy of this repository to coordinate it.
    if (!commandProject) return <>{children}</>;
  }

  return (
    <div
      id="project-panel-coordinator"
      role="tabpanel"
      className="flex h-full items-center justify-center p-6"
      data-testid="leaf-mode-coordinator-gate"
    >
      <div className="max-w-md space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
        <p className="flex items-center gap-2 font-medium text-amber-100">
          <ShieldAlert className="h-4 w-4" />
          {onLeaf ? "Coordination happens on the command node" : "This node is in leaf mode"}
        </p>
        <p className="text-muted-foreground">
          It is controlled by {controllers}. Coordination for this project happens there, not here.
          This node&apos;s own coordinator conversations are kept, but its coordinator does not act
          across nodes while this node is controlled.
          {onLeaf
            ? " The sidebar is grouped by repository; group it by machine or project to open this node's coordinator directly."
            : null}
        </p>
        <div className="flex flex-wrap gap-2">
          {commandProject && commandNodeId ? (
            <Button
              type="button"
              size="sm"
              onClick={() =>
                openMachineWorkspace({
                  connectionId: commandNodeId,
                  projectId: commandProject.ref.projectId,
                  boardTab: "coordinator",
                  title: commandProject.name,
                })
              }
            >
              Open the coordinator on {controllers}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={openAnyway}>
            Open this node&apos;s coordinator anyway
          </Button>
        </div>
      </div>
    </div>
  );
}
