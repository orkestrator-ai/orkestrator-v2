import { Bell, Loader2 } from "lucide-react";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { resolveEnvironmentAgentActivity } from "@/lib/environment-agent-activity";
import type { Environment } from "@/types";

export interface ProjectHomeStatus {
  label: "working" | "needs attention";
  /** The spinner shows whenever it works, even while it also needs the user. */
  working: boolean;
}

/**
 * What a project's hidden home row shows in its project's navigation: a
 * spinner while it works, a bell while it needs the user, nothing otherwise.
 * One rule for this window's homes and other machines' homes.
 */
export function projectHomeStatus(home: {
  deleting: boolean;
  buildActive: boolean;
  activity: "idle" | "working" | "waiting";
  hasUnreadWork: boolean;
}): ProjectHomeStatus | null {
  const working = home.buildActive || home.activity === "working";
  const waiting = home.hasUnreadWork || home.activity === "waiting";
  if (home.deleting || (!working && !waiting)) return null;
  return { label: waiting ? "needs attention" : "working", working };
}

/** The home's activity button, in a project header (compact) or the activity list. */
export function ProjectHomeActivityButton({
  status,
  projectName,
  onOpen,
  compact = false,
}: {
  status: ProjectHomeStatus;
  projectName: string;
  onOpen: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={`${projectName} Home ${status.label}`}
      title={`Open Home — ${status.label}`}
      className={
        compact
          ? "shrink-0 rounded-md p-1 text-amber-400 hover:bg-hover"
          : "mx-3 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-hover"
      }
      onClick={onOpen}
    >
      {status.working ? (
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Bell aria-hidden="true" className="h-3.5 w-3.5" />
      )}
      {!compact && (
        <span>
          {projectName} Home — {status.label}
        </span>
      )}
    </button>
  );
}

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
  const buildActive = useBuildPipelineStore((state) =>
    state.activeBuildEnvironmentIds.has(home.id),
  );
  const status = projectHomeStatus({
    deleting: projectDeleting || deleting,
    buildActive,
    activity,
    hasUnreadWork: home.hasUnreadWork === true,
  });
  if (!status) return null;
  return (
    <ProjectHomeActivityButton
      status={status}
      projectName={projectName}
      compact={compact}
      onOpen={() => {
        if (
          useProjectStore.getState().deletingProjects.has(home.projectId) ||
          useEnvironmentStore.getState().isDeleting(home.id)
        )
          return;
        const ui = useUIStore.getState();
        ui.selectProjectAndEnvironment(home.projectId, home.id);
        ui.setProjectBoardTab("home");
      }}
    />
  );
}
