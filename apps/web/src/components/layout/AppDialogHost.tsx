import { lazy, useEffect, useEffectEvent, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LazyDialogLoadingFallback, LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { toast } from "sonner";
import type { BackendId } from "@orkestrator/protocol/federation";
import { CreateEnvironmentFlowDialog } from "@/components/environments/CreateEnvironmentFlowDialog";
import {
  prepareCreateEnvironmentTarget,
  type CreateEnvironmentTarget,
} from "@/components/environments/create-environment-target";
import { useFederation } from "@/components/federation/FederationProvider";
import { nodeName } from "@/components/federation/NodeWorkspaceStatus";
import {
  DockerAvailabilityProvider,
  useDockerAvailabilityReady,
} from "@/contexts/DockerAvailabilityContext";
import { useNodeDockerAvailability } from "@/hooks/useNodeDockerAvailability";
import { DeleteProjectDialog } from "@/components/projects/DeleteProjectDialog";
import {
  createProjectUpdateHandler,
  deleteProjectAndEnvironments,
} from "@/components/sidebar/HierarchicalSidebar";
import { useEnvironments } from "@/hooks";
import { useProjects } from "@/hooks/useProjects";
import { backendForScope } from "@/lib/backend/scope-backend";
import {
  NodeScopeProvider,
  useNodeScope,
  useScopesWithCommandFallback,
  useSignal,
  WindowScopeProvider,
} from "@/lib/node-scope/providers";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.app");

const LazyEnvironmentSettingsDialog = lazy(async () => ({
  default: (await import("@/components/environments/EnvironmentSettingsDialog"))
    .EnvironmentSettingsDialog,
}));

const LazyRepositorySettings = lazy(async () => ({
  default: (await import("@/components/settings/RepositorySettings")).RepositorySettings,
}));

/**
 * Renders the dialog `useAppDialogStore` holds, outside every drawer and row,
 * inside the scope of the node the request names. A request for a node this
 * window has no scope for is dropped rather than shown against another
 * node's data, except New Environment: that dialog is the window's own, aimed
 * at a machine, and opens the machine's scope behind it.
 */
export function AppDialogHost() {
  const request = useAppDialogStore((state) => state.request);
  const requestSequence = useAppDialogStore((state) => state.requestSequence);
  const close = useAppDialogStore((state) => state.close);
  const { windowScope } = useScopesWithCommandFallback();
  // Re-resolve when scopes open or close, so a closed node's request is dropped.
  useSignal(windowScope.nodeScopes);
  const scope = request ? windowScope.get(request.nodeId) : null;
  const unresolved = request !== null && scope === null && request.kind !== "create-environment";
  useEffect(() => {
    if (unresolved) close();
  }, [close, unresolved]);

  if (request?.kind === "create-environment") {
    return (
      <WindowScopeProvider windowScope={windowScope}>
        <CreateEnvironmentHost
          key={requestSequence}
          requestSequence={requestSequence}
          nodeId={request.nodeId}
          projectId={request.projectId}
        />
      </WindowScopeProvider>
    );
  }
  if (!scope) return null;
  // Keyed by node: the same id on another node is another dialog.
  return (
    <WindowScopeProvider windowScope={windowScope}>
      <NodeScopeProvider key={scope.nodeId} scope={scope}>
        <AppDialogContent />
      </NodeScopeProvider>
    </WindowScopeProvider>
  );
}

function AppDialogContent() {
  const request = useAppDialogStore((state) => state.request);
  const requestSequence = useAppDialogStore((state) => state.requestSequence);
  switch (request?.kind) {
    case "environment-settings":
      return (
        <EnvironmentSettingsHost
          key={request.environmentId}
          environmentId={request.environmentId}
          section={request.section}
          sectionRequest={requestSequence}
        />
      );
    case "repository-settings":
      return <RepositorySettingsHost projectId={request.projectId} />;
    case "delete-project":
      return <DeleteProjectHost projectId={request.projectId} />;
    default:
      return null;
  }
}

function EnvironmentSettingsHost({
  environmentId,
  section,
  sectionRequest,
}: {
  environmentId: string;
  section?: "container";
  sectionRequest: number;
}) {
  // This node's backend (plan item 4001); the command node outside a node scope.
  const backendScope = useScopesWithCommandFallback().scope;
  const close = useAppDialogStore((state) => state.close);
  const environment = useEnvironmentStore(
    (state) => state.environments.find((candidate) => candidate.id === environmentId) ?? null,
  );
  const updateEnvironment = useEnvironmentStore((state) => state.updateEnvironment);

  // A snapshot may arrive after navigation. Keep the request pending until
  // its environment appears; only a previously visible environment disappearing
  // means it was removed. Keying this host by id resets that history.
  const seenEnvironment = useRef(false);
  useEffect(() => {
    if (environment) seenEnvironment.current = true;
    else if (seenEnvironment.current) close();
  }, [close, environment]);

  if (!environment) return null;
  return (
    <LazyLoadBoundary
      loadingFallback={<LazyDialogLoadingFallback label="Loading environment settings…" />}
    >
      <LazyEnvironmentSettingsDialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        environment={environment}
        initialSection={section}
        sectionRequest={sectionRequest}
        onUpdate={(updated) => updateEnvironment(updated.id, updated)}
        onRestart={backendForScope(backendScope).recreateEnvironment}
      />
    </LazyLoadBoundary>
  );
}

/**
 * The request's project, dropping the request once the project is gone.
 *
 * A hydration check (plan item 5003): a node opened in the window's tree a
 * moment ago may not have read its projects yet, so the request waits for
 * the node's first project list (and any read in flight) before it decides
 * the project is gone.
 */
function useRequestedProject(projectId: string) {
  const close = useAppDialogStore((state) => state.close);
  const project = useProjectStore(
    (state) => state.projects.find((candidate) => candidate.id === projectId) ?? null,
  );
  const projectsLoaded = useProjectStore((state) => state.hasLoaded && !state.isLoading);
  useEffect(() => {
    if (!project && projectsLoaded) close();
  }, [close, project, projectsLoaded]);
  return { project, close };
}

function RepositorySettingsHost({ projectId }: { projectId: string }) {
  const { project, close } = useRequestedProject(projectId);
  const { updateProject } = useProjects();
  const configLoaded = useConfigStore((state) => state.hasLoaded);

  if (!project || !configLoaded) return null;
  return (
    <LazyLoadBoundary
      loadingFallback={<LazyDialogLoadingFallback label="Loading repository settings…" />}
    >
      <LazyRepositorySettings
        project={project}
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        onUpdateProject={createProjectUpdateHandler(updateProject)}
      />
    </LazyLoadBoundary>
  );
}

function DeleteProjectHost({ projectId }: { projectId: string }) {
  const { project, close } = useRequestedProject(projectId);
  const { removeProject } = useProjects();
  const { deleteEnvironment } = useEnvironments(null);
  const scope = useNodeScope();
  // Includes the project home, which has no sidebar row and is not counted.
  const environments = useEnvironmentStore((state) => state.environments);
  const projectEnvironments = environments.filter(
    (environment) => environment.projectId === projectId,
  );

  if (!project) return null;
  return (
    <DeleteProjectDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      projectName={project.name}
      environmentCount={
        projectEnvironments.filter((environment) => !environment.projectHome).length
      }
      onConfirm={async () => {
        try {
          // A cold node scope or a missed update can leave the renderer list empty.
          // A failed owner read must retain the project and allow a retry.
          await deleteProjectAndEnvironments(
            projectId,
            await backendForScope(scope).getEnvironmentSnapshots(projectId),
            deleteEnvironment,
            removeProject,
            scope,
          );
        } catch (error) {
          log.error("project.delete-failed", { projectId, error: formatLogError(error) });
          throw error;
        }
      }}
    />
  );
}

interface CreateEnvironmentHostProps {
  requestSequence: number;
  nodeId: BackendId;
  projectId: string;
}

function CreateEnvironmentHost(props: CreateEnvironmentHostProps) {
  const { windowScope } = useScopesWithCommandFallback();
  const scope = windowScope.get(props.nodeId);
  return scope?.role === "command" ? (
    <NodeScopeProvider scope={scope}>
      <CommandCreateEnvironmentHost {...props} />
    </NodeScopeProvider>
  ) : (
    <MachineCreateEnvironmentHost {...props} />
  );
}

/** The dialog aimed at the window's own node, once its defaults have loaded. */
function CommandCreateEnvironmentHost({ requestSequence, projectId }: CreateEnvironmentHostProps) {
  const project = useProjectStore((state) =>
    state.projects.find((candidate) => candidate.id === projectId),
  );
  const projectsLoaded = useProjectStore((state) => state.hasLoaded);
  const projectsLoading = useProjectStore((state) => state.isLoading);
  const { windowScope } = useScopesWithCommandFallback();
  const configReady = useConfigStore((state) => state.hasLoaded);
  const dockerReady = useDockerAvailabilityReady();
  const ready = Boolean(project && projectsLoaded && configReady && dockerReady);
  const missing = projectsLoaded && !projectsLoading && !project;
  useEffect(() => {
    if (missing) closeCreateRequest(requestSequence);
    else if (!ready) {
      return windowScope.selection.subscribe(() => closeCreateRequest(requestSequence));
    }
  }, [missing, ready, requestSequence, windowScope]);

  if (!project || !ready) return null;
  return (
    <CreateEnvironmentFlowDialog
      open
      onOpenChange={(open) => {
        if (!open) closeCreateRequest(requestSequence);
      }}
      projectId={projectId}
      projectName={project.name}
    />
  );
}

/** The dialog aimed at another machine, once its scope holds what the form reads. */
function MachineCreateEnvironmentHost({
  requestSequence,
  nodeId,
  projectId,
}: CreateEnvironmentHostProps) {
  const { windowScope } = useScopesWithCommandFallback();
  useSignal(windowScope.nodeScopes);
  const { portalState } = useFederation();
  const machine = nodeName(portalState.nodes, nodeId);
  const [target, setTarget] = useState<CreateEnvironmentTarget | null>(null);
  const reportFailure = useEffectEvent((error: unknown) => {
    toast.error(`Could not open the new environment form on ${machine}`, {
      description: error instanceof Error ? error.message : String(error),
    });
    closeCreateRequest(requestSequence);
  });
  useEffect(() => {
    const preparation = new AbortController();
    // Until it opens, going elsewhere in the window drops the request.
    const stopSelection = windowScope.selection.subscribe(() =>
      closeCreateRequest(requestSequence),
    );
    prepareCreateEnvironmentTarget({
      windowScope,
      nodeId,
      projectId,
      requireUsable: false,
      signal: preparation.signal,
    }).then(
      (prepared) => {
        stopSelection();
        if (!preparation.signal.aborted) setTarget(prepared);
      },
      (error: unknown) => {
        stopSelection();
        if (!preparation.signal.aborted) reportFailure(error);
      },
    );
    return () => {
      preparation.abort();
      stopSelection();
    };
  }, [nodeId, projectId, requestSequence, windowScope]);

  if (!target) {
    return (
      <ConnectingToMachine machine={machine} onCancel={() => closeCreateRequest(requestSequence)} />
    );
  }
  return (
    <NodeScopeProvider scope={target.scope}>
      <MachineCreateEnvironmentDialog
        target={target}
        onClose={() => closeCreateRequest(requestSequence)}
      />
    </NodeScopeProvider>
  );
}

function MachineCreateEnvironmentDialog({
  target,
  onClose,
}: {
  target: CreateEnvironmentTarget;
  onClose: () => void;
}) {
  const dockerAvailable =
    useNodeDockerAvailability(target.scope, !target.scope.disposed, target) ??
    target.dockerAvailable;
  return (
    <DockerAvailabilityProvider available={dockerAvailable}>
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        projectId={target.projectId}
      />
    </DockerAvailabilityProvider>
  );
}

/** How long a machine takes to answer before the window says it is waiting for it. */
const CONNECTING_DIALOG_DELAY_MS = 400;

function ConnectingToMachine({ machine, onCancel }: { machine: string; onCancel: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), CONNECTING_DIALOG_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Dialog
      open={shown}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Create Ork (environment)</DialogTitle>
          <DialogDescription className="flex items-center gap-2" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Connecting to {machine}…
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function closeCreateRequest(sequence: number): void {
  const dialogs = useAppDialogStore.getState();
  if (dialogs.requestSequence === sequence) dialogs.close();
}
