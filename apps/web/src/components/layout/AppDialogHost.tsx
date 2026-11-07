import { lazy, useEffect, useRef } from "react";
import { LazyDialogLoadingFallback, LazyLoadBoundary } from "@/components/LazyLoadBoundary";
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
 * node's data.
 */
export function AppDialogHost() {
  const request = useAppDialogStore((state) => state.request);
  const close = useAppDialogStore((state) => state.close);
  const { windowScope } = useScopesWithCommandFallback();
  // Re-resolve when scopes open or close, so a closed node's request is dropped.
  useSignal(windowScope.nodeScopes);
  const scope = request ? windowScope.get(request.nodeId) : null;
  const unresolved = request !== null && scope === null;
  useEffect(() => {
    if (unresolved) close();
  }, [close, unresolved]);

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
