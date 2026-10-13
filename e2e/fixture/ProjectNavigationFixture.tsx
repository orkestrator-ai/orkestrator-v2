import { useState } from "react";
import { ActionBar } from "../../apps/web/src/components/layout/ActionBar";
import { ProjectSearchBar } from "../../apps/web/src/components/sidebar/ProjectSearchBar";
import { TerminalProvider } from "../../apps/web/src/contexts/TerminalContext";
import { DockerAvailabilityProvider } from "../../apps/web/src/contexts/DockerAvailabilityContext";
import { useProjectStore, useUIStore } from "../../apps/web/src/stores";
import type { Project } from "../../apps/web/src/types";

const project: Project = {
  id: "navigation-project",
  name: "Navigation fixture",
  gitUrl: "https://example.test/navigation.git",
  localPath: "/tmp/navigation-fixture",
  addedAt: "2026-10-13T00:00:00Z",
  order: 0,
};

function installFixture() {
  window.orkestrator = {
    clipboard: {
      readText: async () => "",
      writeText: async () => undefined,
      readImage: async () => null,
      writeImage: async () => undefined,
    },
    process: { exit: async () => undefined },
    window: { startDragging: async () => undefined },
    listen: () => () => undefined,
    invoke: async <T,>(command: string): Promise<T> => {
      switch (command) {
        case "get_projects":
          return [project] as T;
        case "get_environments":
          return [] as T;
        default:
          throw new Error(`Unexpected navigation fixture command: ${command}`);
      }
    },
  };
  useProjectStore.setState({ projects: [project] });
  useUIStore.setState({
    selectedProjectId: project.id,
    selectedEnvironmentId: null,
    projectBoardTab: "kanban",
  });
  return true;
}

export function ProjectNavigationFixture() {
  useState(installFixture);
  const grid = new URLSearchParams(window.location.search).get("presentation") === "grid";
  return (
    <TerminalProvider>
      <DockerAvailabilityProvider available={false}>
        <div className="flex h-screen bg-background text-foreground">
          <aside className="flex w-32 shrink-0 flex-col border-r border-border/80 md:w-72">
            <div className="h-14 shrink-0 border-b border-border/80 md:h-12" />
            <ProjectSearchBar
              projects={[project]}
              environments={[]}
              onSelectProject={() => undefined}
              onSelectEnvironment={() => undefined}
            />
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            <ActionBar presentation={grid ? "grid" : "bar"} />
          </main>
        </div>
      </DockerAvailabilityProvider>
    </TerminalProvider>
  );
}
