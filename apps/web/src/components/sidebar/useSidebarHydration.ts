import { useEffect, useRef, useState } from "react";
import { useUIStore } from "@/stores/uiStore";

/** Defaults apply once per project, after its authoritative environment result. */
export function useSidebarHydration(
  projects: readonly { id: string }[],
  projectsLoaded: boolean,
  environments: readonly { projectId: string; projectHome?: boolean }[],
  load: (projectId: string) => Promise<unknown>,
): boolean {
  const previousEnvironmentCount = useRef(environments.length);
  const started = useRef(new Set<string>());
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (previousEnvironmentCount.current > 0 && environments.length === 0) {
      started.current.clear();
      setSettled(new Set());
    }
    previousEnvironmentCount.current = environments.length;
  }, [environments.length]);
  useEffect(() => {
    if (!projectsLoaded) return;
    for (const project of projects) {
      if (started.current.has(project.id)) continue;
      started.current.add(project.id);
      void load(project.id).then(
        () => {
          setSettled((previous) => new Set(previous).add(project.id));
        },
        (error: unknown) => {
          console.error(`Failed to load environments for project ${project.id}:`, error);
          started.current.delete(project.id);
        },
      );
    }
  }, [environments.length, load, projects, projectsLoaded]);
  const ready = projectsLoaded && projects.every((project) => settled.has(project.id));
  useEffect(() => {
    if (!ready) return;
    useUIStore.getState().collapseEmptyProjects(
      projects.map((p) => p.id),
      new Set(environments.filter((e) => !e.projectHome).map((e) => e.projectId)),
    );
  }, [environments, projects, ready]);
  return ready;
}
