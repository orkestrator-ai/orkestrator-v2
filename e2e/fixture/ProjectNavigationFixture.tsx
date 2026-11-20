import { useState } from "react";
import { ActionBar } from "../../apps/web/src/components/layout/ActionBar";
import { MobileAppShellLayout } from "../../apps/web/src/components/layout/MobileAppShellLayout";
import { ProjectSearchBar } from "../../apps/web/src/components/sidebar/ProjectSearchBar";
import { TerminalProvider } from "../../apps/web/src/contexts/TerminalContext";
import { DockerAvailabilityProvider } from "../../apps/web/src/contexts/DockerAvailabilityContext";
import { useEnvironmentStore, useProjectStore, useUIStore } from "../../apps/web/src/stores";
import { ProjectSchedulesView } from "../../apps/web/src/components/projects/ProjectSchedulesView";
import { configStore } from "../../apps/web/src/stores/configStore";
import type { ScheduleAction, ScheduledJob } from "@orkestrator/protocol/scheduled-jobs";
import type { Project } from "../../apps/web/src/types";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";
import { clientEnvironmentFixture } from "../../apps/web/src/test/environments-results";
import { portalStore } from "../../apps/web/src/lib/portal/portal-store";
import { getWindowScope } from "../../apps/web/src/lib/node-scope/app-window-scope";
import type { BackendId } from "@orkestrator/protocol/federation";
import { repositoryHint, type NodeSummary } from "@orkestrator/protocol/node-summaries";

const project: Project = {
  id: "navigation-project",
  name: "Navigation fixture",
  gitUrl: "https://example.test/fixtures/navigation.git",
  localPath: "/tmp/navigation-fixture",
  addedAt: "2026-10-13T00:00:00Z",
  order: 0,
};

const scheduleKey = "project-navigation-schedules";
function storedSchedules(): ScheduledJob[] {
  return JSON.parse(localStorage.getItem(scheduleKey) ?? "[]");
}

function matchingMachine(id: string, name: string, available: boolean): NodeSummary {
  const nodeId = id as BackendId;
  const projectId = `${id}-project`;
  return {
    nodeId,
    view: {
      nodeId,
      enabled: true,
      displayName: name,
      fallbackName: name,
      routes: [],
      routeOrder: [],
      hasCredential: true,
      attachment: { status: "attached" },
      connection: { state: available ? "connected" : "unavailable", epoch: 1 },
      addedAt: project.addedAt,
      source: "portal",
    },
    available,
    freshness: available ? "current" : "stale",
    loadedAt: 0,
    truncated: false,
    lastError: null,
    projects: [
      {
        ref: { backendId: nodeId, projectId },
        key: `${nodeId}:${projectId}`,
        name: project.name,
        order: 0,
        repositoryHint: repositoryHint(project.gitUrl),
      },
    ],
    environments: [],
  };
}

function installFixture(params: URLSearchParams) {
  const worktree =
    params.get("view") === "worktree"
      ? clientEnvironmentFixture({
          projectId: project.id,
          environmentType: "local",
          name: "Navigation worktree",
          worktreePath: "/tmp/navigation-worktree",
        })
      : null;
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
        case "list_environments":
          return (worktree ? [worktree] : []) as T;
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
  if (params.has("machines")) {
    portalStore.store.setState({
      selfId: getWindowScope().commandScope().nodeId,
      nodes: [
        matchingMachine("bk_navigation_leaf", "Build machine", true),
        matchingMachine("bk_navigation_offline", "Offline machine", false),
      ],
    });
  }
  const ui = appCommandStore(useUIStore.def).getState();
  if (worktree) {
    appCommandStore(useEnvironmentStore.def).getState().setEnvironments([worktree]);
    ui.selectProjectAndEnvironment(project.id, worktree.id);
  } else {
    ui.selectProject(params.get("view") === "empty" ? null : project.id);
  }
  ui.setProjectBoardTab("kanban");
  return true;
}

export function ProjectNavigationFixture() {
  const params = new URLSearchParams(window.location.search);
  useState(() => installFixture(params));
  const tab = useUIStore((state) => state.projectBoardTab);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const presentation = params.get("presentation");
  const grid = presentation === "grid" || presentation === "tools";
  return (
    <TerminalProvider>
      <DockerAvailabilityProvider available={false}>
        {presentation === "tools" ? (
          <div className="flex h-full flex-col bg-background text-foreground">
            <MobileAppShellLayout
              selectedProjectId={selectedProjectId}
              selectedEnvironmentId={selectedEnvironmentId}
              title="Navigation fixture"
              filesPanelOpen={false}
              centralPanelStyle={{}}
              initialSidebarOpen={false}
              actionBar={<ActionBar presentation="grid" />}
              agentInfoButton={null}
              sidebar={null}
              filesPanel={null}
              onTitleBarMouseDown={() => undefined}
            />
          </div>
        ) : (
          <div className="flex h-screen bg-background text-foreground">
            <aside className="flex w-32 shrink-0 flex-col border-r border-border/80 md:w-72">
              <div
                data-testid="project-navigation-sidebar-header"
                className="flex h-14 shrink-0 items-center border-b border-border/80 px-2 md:h-12"
              >
                <ProjectSearchBar
                  projects={[project]}
                  environments={[]}
                  onSelectProject={() => undefined}
                  onSelectEnvironment={() => undefined}
                />
              </div>
            </aside>
            <main className="flex min-w-0 flex-1 flex-col">
              <ActionBar presentation={grid ? "grid" : "bar"} />
              {tab === "schedules" ? <ProjectSchedulesView projectId={project.id} /> : null}
            </main>
          </div>
        )}
      </DockerAvailabilityProvider>
    </TerminalProvider>
  );
}
