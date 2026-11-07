import { useState } from "react";
import { COORDINATOR_ACTIVITY_COMMAND } from "@orkestrator/protocol/coordinator-activity";
import { ActionBar } from "../../apps/web/src/components/layout/ActionBar";
import { EnvironmentStatusMarker } from "../../apps/web/src/components/environments/EnvironmentStatusMarker";
import { MachineHomeIcon } from "../../apps/web/src/components/federation/MachineDot";
import { SortableProjectGroup } from "../../apps/web/src/components/sidebar/SortableProjectGroup";
import { TerminalProvider } from "../../apps/web/src/contexts/TerminalContext";
import { DockerAvailabilityProvider } from "../../apps/web/src/contexts/DockerAvailabilityContext";
import { useProjectStore, useUIStore } from "../../apps/web/src/stores";
import { useCoordinatorActivityStore } from "../../apps/web/src/stores/coordinatorActivityStore";
import type { Project } from "../../apps/web/src/types";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

const project = (id: string, name: string, order: number): Project => ({
  id,
  name,
  gitUrl: `https://example.test/${id}.git`,
  localPath: `/tmp/${id}`,
  addedAt: "2026-11-03T00:00:00Z",
  order,
});

const projects = [
  project("orkestrator", "orkestrator", 0),
  project("website", "website", 1),
  project("docs", "docs", 2),
];

/** What the fake backend answers; the buttons change the first project's state. */
const activity: Record<string, "working" | "waiting"> = {
  orkestrator: "working",
  website: "waiting",
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
          return projects as T;
        case "get_environments":
          return [] as T;
        case COORDINATOR_ACTIVITY_COMMAND:
          return { projects: { ...activity } } as T;
        default:
          throw new Error(`Unexpected coordinator activity fixture command: ${command}`);
      }
    },
  };
  appCommandStore(useProjectStore.def).setState({ projects });
  appCommandStore(useUIStore.def).setState({
    selectedProjectId: projects[0]!.id,
    selectedEnvironmentId: null,
    projectBoardTab: "coordinator",
  });
  return true;
}

const noop = () => undefined;

/**
 * The real sidebar project headers and project navigation, fed by the real
 * coordinator activity store over a fake backend. One environment row's marker
 * sits beside them for comparison.
 */
export function CoordinatorActivityFixture() {
  useState(installFixture);
  const setFirst = (state: "working" | "waiting" | null) => {
    if (state) activity.orkestrator = state;
    else delete activity.orkestrator;
    void appCommandStore(useCoordinatorActivityStore.def).getState().refresh();
  };
  return (
    <TerminalProvider>
      <DockerAvailabilityProvider available={false}>
        <div className="flex h-screen bg-background text-foreground">
          <aside
            data-testid="fixture-sidebar"
            className="flex w-72 shrink-0 flex-col gap-1 border-r border-border/80 py-2"
          >
            {projects.map((item, index) => (
              <SortableProjectGroup
                key={item.id}
                project={item}
                machineIcon={
                  index === 0 ? undefined : (
                    <MachineHomeIcon colorToken="teal" machineName="This computer" />
                  )
                }
                environments={[]}
                isCollapsed
                isSelected={index === 0}
                selectedEnvironmentId={null}
                onToggleCollapse={noop}
                onSelectProject={noop}
                onSelectEnvironment={noop}
                onDeleteProject={noop}
                onOpenSettings={noop}
                onDeleteEnvironment={noop}
                onStartEnvironment={noop}
                onStopEnvironment={noop}
                onRestartEnvironment={noop}
                onCreateEnvironment={noop}
              />
            ))}
            <div className="mx-3 flex items-center gap-2 py-1 pl-4 text-[13px] text-muted-foreground">
              <EnvironmentStatusMarker local state="working" machine={null} />
              <span>an environment, working</span>
            </div>
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            <ActionBar
              presentation={
                new URLSearchParams(window.location.search).get("presentation") === "grid"
                  ? "grid"
                  : "bar"
              }
            />
            <div className="flex gap-2 p-4">
              <button onClick={() => setFirst(null)}>Coordinator idle</button>
              <button onClick={() => setFirst("working")}>Coordinator working</button>
              <button onClick={() => setFirst("waiting")}>Coordinator waiting</button>
            </div>
          </main>
        </div>
      </DockerAvailabilityProvider>
    </TerminalProvider>
  );
}
