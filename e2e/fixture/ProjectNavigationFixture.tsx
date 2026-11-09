import { useState } from "react";
import { ActionBar } from "../../apps/web/src/components/layout/ActionBar";
import { ProjectSearchBar } from "../../apps/web/src/components/sidebar/ProjectSearchBar";
import { TerminalProvider } from "../../apps/web/src/contexts/TerminalContext";
import { DockerAvailabilityProvider } from "../../apps/web/src/contexts/DockerAvailabilityContext";
import { useProjectStore, useUIStore } from "../../apps/web/src/stores";
import { ProjectSchedulesView } from "../../apps/web/src/components/projects/ProjectSchedulesView";
import { configStore } from "../../apps/web/src/stores/configStore";
import type { ScheduleAction, ScheduledJob } from "@orkestrator/protocol/scheduled-jobs";
import type { Project } from "../../apps/web/src/types";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

const project: Project = {
  id: "navigation-project",
  name: "Navigation fixture",
  gitUrl: "https://example.test/navigation.git",
  localPath: "/tmp/navigation-fixture",
  addedAt: "2026-10-13T00:00:00Z",
  order: 0,
};

const scheduleKey = "project-navigation-schedules";
function storedSchedules(): ScheduledJob[] {
  return JSON.parse(localStorage.getItem(scheduleKey) ?? "[]");
}

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
    invoke: async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      switch (command) {
        case "get_projects":
          return [project] as T;
        case "get_environments":
          return [] as T;
        case "list_scheduled_jobs":
          return {
            schedules: storedSchedules().map(({ fires, ...job }) => ({
              ...job,
              lastFire: fires.at(-1) ?? null,
              activeFire: null,
            })),
          } as T;
        case "list_agent_mailboxes":
          return { mailboxes: [], total: 0, offset: 0, limit: 200 } as T;
        case "create_scheduled_job": {
          const job: ScheduledJob = {
            version: 1,
            id: "sch_browser",
            name: String(args.name),
            owner: { kind: "operator" },
            ownerKey: "operator",
            ownerLabel: "You",
            trigger: { kind: "once", at: "2099-11-09T12:00:00Z" },
            timeZone: "UTC",
            action: args.action as ScheduleAction,
            catchUpMinutes: 15,
            state: "active",
            nextFireAt: "2099-11-09T12:00:00Z",
            fires: [],
            fireCount: 0,
            revision: 1,
            createdAt: "2026-11-09T10:00:00Z",
            updatedAt: "2026-11-09T10:00:00Z",
          };
          localStorage.setItem(scheduleKey, JSON.stringify([job]));
          return { schedule: job, replayed: false } as T;
        }
        default:
          throw new Error(`Unexpected navigation fixture command: ${command}`);
      }
    },
  };
  const config = appCommandStore(configStore);
  config.getState().setConfig({
    ...config.getState().config,
    global: { ...config.getState().config.global, experimentalScheduling: true },
  });
  appCommandStore(useProjectStore.def).setState({ projects: [project] });
  appCommandStore(useUIStore.def).setState({
    selectedProjectId: project.id,
    selectedEnvironmentId: null,
    projectBoardTab: "kanban",
  });
  return true;
}

export function ProjectNavigationFixture() {
  useState(installFixture);
  const tab = useUIStore((state) => state.projectBoardTab);
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
            {tab === "schedules" ? <ProjectSchedulesView projectId={project.id} /> : null}
          </main>
        </div>
      </DockerAvailabilityProvider>
    </TerminalProvider>
  );
}
