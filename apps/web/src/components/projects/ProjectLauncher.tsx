import { useMemo, useState } from "react";
import { ChevronRight, FolderGit2, Plus } from "lucide-react";
import { CreateEnvironmentFlowDialog } from "@/components/environments/CreateEnvironmentFlowDialog";
import type { CreateEnvironmentFlowOperations } from "@/components/environments/CreateEnvironmentFlowDialog";
import { Button } from "@/components/ui/button";
import { useProjects } from "@/hooks/useProjects";
import { useUIStore } from "@/stores";
import type { Project } from "@/types";

const RECENT_PROJECT_LIMIT = 5;

export function resolveRecentProjects(
  projects: Project[],
  recentProjectIds: string[],
): Project[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const resolved: Project[] = [];
  const seen = new Set<string>();

  for (const projectId of recentProjectIds) {
    const project = projectsById.get(projectId);
    if (!project || seen.has(project.id)) continue;
    resolved.push(project);
    seen.add(project.id);
  }

  const fallbackProjects = [...projects].sort((left, right) => {
    const addedAtDelta = Date.parse(right.addedAt) - Date.parse(left.addedAt);
    return Number.isNaN(addedAtDelta) || addedAtDelta === 0
      ? left.order - right.order
      : addedAtDelta;
  });

  for (const project of fallbackProjects) {
    if (resolved.length >= RECENT_PROJECT_LIMIT) break;
    if (seen.has(project.id)) continue;
    resolved.push(project);
    seen.add(project.id);
  }

  return resolved.slice(0, RECENT_PROJECT_LIMIT);
}

function projectLocation(project: Project): string {
  return project.localPath || project.gitUrl;
}

interface ProjectLauncherContentProps {
  projects: Project[];
  isLoading: boolean;
  onOpenProject: (projectId: string) => void;
  onCreateEnvironment: (projectId: string) => void;
}

export function ProjectLauncherContent({
  projects,
  isLoading,
  onOpenProject,
  onCreateEnvironment,
}: ProjectLauncherContentProps) {
  return (
    <section className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-5 py-12 sm:px-8">
      <div className="mb-6 border-b border-border/70 pb-5">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Workspace
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Recent projects
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Open a project or start a new environment.
        </p>
      </div>

      {isLoading && projects.length === 0 ? (
        <p className="py-8 text-sm text-muted-foreground">Loading projects...</p>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center">
          <h2 className="text-sm font-medium text-foreground">No projects yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a project from the sidebar to get started.
          </p>
        </div>
      ) : (
        <ul className="space-y-2" aria-label="Recent projects">
          {projects.map((project) => (
            <li
              key={project.id}
              className="group flex overflow-hidden rounded-lg border border-border/80 bg-card/70 transition-colors hover:border-zinc-500 hover:bg-card"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left outline-none focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                onClick={() => onOpenProject(project.id)}
                aria-label={`Open ${project.name}`}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-zinc-400">
                  <FolderGit2 className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {project.name}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                    {projectLocation(project)}
                  </span>
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-400"
                  aria-hidden="true"
                />
              </button>

              <Button
                type="button"
                variant="ghost"
                className="h-auto w-14 shrink-0 rounded-none border-l border-border/80 text-zinc-400 hover:bg-zinc-800 hover:text-foreground"
                onClick={() => onCreateEnvironment(project.id)}
                aria-label={`Create environment for ${project.name}`}
                title={`Create environment for ${project.name}`}
              >
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ProjectLauncher(operations: CreateEnvironmentFlowOperations) {
  const { projects, isLoading } = useProjects();
  const recentProjectIds = useUIStore((state) => state.recentProjectIds);
  const selectProject = useUIStore((state) => state.selectProject);
  const [createEnvironmentProjectId, setCreateEnvironmentProjectId] = useState<
    string | null
  >(null);

  const recentProjects = useMemo(
    () => resolveRecentProjects(projects, recentProjectIds),
    [projects, recentProjectIds],
  );

  return (
    <div className="h-full overflow-y-auto bg-background">
      <ProjectLauncherContent
        projects={recentProjects}
        isLoading={isLoading}
        onOpenProject={selectProject}
        onCreateEnvironment={setCreateEnvironmentProjectId}
      />

      <CreateEnvironmentFlowDialog
        open={createEnvironmentProjectId !== null}
        onOpenChange={(open) => {
          if (!open) setCreateEnvironmentProjectId(null);
        }}
        projectId={createEnvironmentProjectId}
        {...operations}
      />
    </div>
  );
}
