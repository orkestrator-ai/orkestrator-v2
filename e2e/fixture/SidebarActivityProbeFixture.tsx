import { useState } from "react";
import { EnvironmentItem } from "../../apps/web/src/components/environments/EnvironmentItem";
import { Toaster } from "../../apps/web/src/components/ui/sonner";
import { useAgentActivityStore } from "../../apps/web/src/stores/agentActivityStore";
import type { Environment } from "../../apps/web/src/types";

const environment: Environment = {
  id: "sidebar-probe",
  projectId: "sidebar-probe-project",
  name: "probe-environment",
  branch: "main",
  containerId: "sidebar-probe-container",
  prUrl: null,
  prState: null,
  hasMergeConflicts: false,
  order: 0,
  environmentType: "containerized",
  status: "running",
  setupPhase: "ready",
  networkAccessMode: "restricted",
  createdAt: "2026-10-28T00:00:00.000Z",
};

/** Real responsive rows, visible without opening a shell or drawer. */
export function SidebarActivityProbeFixture() {
  const [status, setStatus] = useState<Environment["status"]>("running");
  const row = (value: Environment) => (
    <EnvironmentItem
      environment={value}
      isSelected={false}
      onSelect={() => {}}
      onDelete={() => {}}
      onStart={() => {}}
      onStop={() => {}}
      onRestart={() => {}}
    />
  );
  return (
    <main className="p-4">
      <Toaster />
      <div className="flex flex-wrap gap-4">
        {(["working", "waiting", "idle"] as const).map((activity) => (
          <button
            key={activity}
            onClick={() => {
              setStatus("running");
              useAgentActivityStore.getState().replaceActivitySnapshot([
                {
                  id: environment.id,
                  agentActivityState: activity,
                  agentActivityUpdatedAt: new Date().toISOString(),
                },
              ]);
            }}
          >
            Set {activity}
          </button>
        ))}
        <button onClick={() => setStatus("stopped")}>Set stopped</button>
        <button onClick={() => setStatus("stopping")}>Set stopping</button>
      </div>
      <span id="pane-title">{environment.name}</span>
      <aside aria-label="Projects and environments" className="w-72">
        {row({ ...environment, status })}
        {row({
          ...environment,
          id: "sidebar-probe-neighbour",
          containerId: "sidebar-probe-neighbour-container",
          name: "probe-neighbour",
          agentActivityState: "working",
          agentActivityUpdatedAt: environment.createdAt,
        })}
      </aside>
    </main>
  );
}
