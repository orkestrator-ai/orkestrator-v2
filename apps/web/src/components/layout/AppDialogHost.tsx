import { lazy, useEffect, useRef } from "react";
import { LazyDialogLoadingFallback, LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { DeleteProjectDialog } from "@/components/projects/DeleteProjectDialog";
import {
  createProjectUpdateHandler,
  deleteProjectAndEnvironments,
} from "@/components/sidebar/HierarchicalSidebar";
import { useEnvironments } from "@/hooks";
import { useProjects } from "@/hooks/useProjects";
import * as backend from "@/lib/backend";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";

const LazyEnvironmentSettingsDialog = lazy(async () => ({
  default: (await import("@/components/environments/EnvironmentSettingsDialog"))
    .EnvironmentSettingsDialog,
}));

const LazyRepositorySettings = lazy(async () => ({
  default: (await import("@/components/settings/RepositorySettings")).RepositorySettings,
}));

/** Renders the dialog `useAppDialogStore` holds, outside every drawer and row. */
export function AppDialogHost() {
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
        onRestart={backend.recreateEnvironment}
      />
    </LazyLoadBoundary>
  );
}

/** The request's project, dropping the request once the project is gone. */
function useRequestedProject(projectId: string) {
  const close = useAppDialogStore((state) => state.close);
  const project = useProjectStore(
    (state) => state.projects.find((candidate) => candidate.id === projectId) ?? null,
  );
  useEffect(() => {
    if (!project) close();
  }, [close, project]);
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
          // A cold realm or a missed update can leave the renderer list empty.
          // A failed owner read must retain the project and allow a retry.
          await deleteProjectAndEnvironments(
            projectId,
            await backend.getEnvironmentSnapshots(projectId),
            deleteEnvironment,
            removeProject,
          );
        } catch (error) {
          console.error("Failed to delete project:", error);
          throw error;
        }
      }}
    />
  );
}
