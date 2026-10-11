import { Bell, Loader2 } from "lucide-react";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { resolveEnvironmentAgentActivity } from "@/components/environments/EnvironmentItem";
import type { Environment } from "@/types";

/** The hidden home row's activity belongs to its project's navigation. */
export function ProjectHomeActivity({
  home,
  projectName,
  compact = false,
}: {
  home: Environment;
  projectName: string;
  compact?: boolean;
}) {
  const projectDeleting = useProjectStore((state) => state.deletingProjects.has(home.projectId));
  const deleting = useEnvironmentStore((state) => state.isDeleting(home.id));
  const activity = useAgentActivityStore((state) =>
    resolveEnvironmentAgentActivity(home, state.containerStates, state.containerStateUpdatedAt),
  );
  const building = useBuildPipelineStore((state) => state.activeBuildEnvironmentIds.has(home.id));
  const working = building || activity === "working";
  const waiting = home.hasUnreadWork || activity === "waiting";
  if (projectDeleting || deleting || (!working && !waiting)) return null;
  const status = waiting ? "needs attention" : "working";
  return (
    <button
      type="button"
      aria-label={`${projectName} Home ${status}`}
      title={`Open Home — ${status}`}
      className={
        compact
          ? "shrink-0 rounded-md p-1 text-amber-400 hover:bg-hover"
          : "mx-3 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-hover"
      }
      onClick={() => {
        if (
          useProjectStore.getState().deletingProjects.has(home.projectId) ||
          useEnvironmentStore.getState().isDeleting(home.id)
        )
          return;
        const ui = useUIStore.getState();
        ui.selectProjectAndEnvironment(home.projectId, home.id);
        ui.setProjectBoardTab("home");
      }}
    >
      {working ? (
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Bell aria-hidden="true" className="h-3.5 w-3.5" />
      )}
      {!compact && (
        <span>
          {projectName} Home — {status}
        </span>
      )}
    </button>
  );
}
