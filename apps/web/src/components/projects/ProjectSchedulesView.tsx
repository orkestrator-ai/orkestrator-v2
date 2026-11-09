import { CalendarClock, FlaskConical } from "lucide-react";
import type { ReactNode } from "react";
import { ScheduleManager } from "@/components/settings/ScheduleManager";
import { useScheduleApi } from "@/components/settings/schedule-api";
import { Button } from "@/components/ui/button";
import { useNodeScope } from "@/lib/node-scope/providers";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useConfigStore, useProjectStore } from "@/stores";

/**
 * A project's Scheduling tab: the schedules that belong to the project (its
 * agents' and coordinator's, and those that launch into it, run a graph in it
 * or prompt or mail one of its environments) and new schedules created
 * inside it. The same list and editor as Settings → Schedules, on the
 * project's own node.
 */
export function ProjectSchedulesView({ projectId }: { projectId: string }) {
  const scope = useNodeScope();
  const api = useScheduleApi();
  const projectName = useProjectStore(
    (state) => state.projects.find((project) => project.id === projectId)?.name,
  );
  const configLoaded = useConfigStore((state) => state.hasLoaded);
  const enabled = useConfigStore((state) => state.config.global.experimentalScheduling === true);

  const frame = (actions: ReactNode, children: ReactNode) => (
    <div
      id="project-panel-schedules"
      role="tabpanel"
      aria-label="Scheduling"
      className="h-full overflow-y-auto"
      data-testid="project-schedules"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_20rem] space-y-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <CalendarClock className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              Scheduling
            </h2>
            <p className="text-sm text-muted-foreground">
              Work the backend starts in {projectName ?? "this project"} at a set time, once or
              repeatedly: launch an environment, prompt or mail one of its agents, or run a graph.
              Schedules its agents and coordinator set are listed here too.
            </p>
          </div>
          {actions}
        </header>
        {children}
      </div>
    </div>
  );

  // Until the config has loaded the backend's own answer decides: it refuses
  // the list with "turned off" while scheduling is off.
  if (configLoaded && !enabled) {
    return frame(
      null,
      <div
        className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-muted-foreground"
        data-testid="project-schedules-disabled"
      >
        <FlaskConical className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
        <p>Scheduling is experimental and turned off.</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => requestGlobalSettings("experimental")}
        >
          Turn it on in Settings → Experimental
        </Button>
      </div>,
    );
  }

  return (
    <ScheduleManager
      api={api}
      projectId={projectId}
      scope={scope}
      emptyText="No schedules for this project yet. Create one to launch work, prompt an agent or run a graph on a timer."
      frame={({ actions, children }) => frame(actions, children)}
    />
  );
}
