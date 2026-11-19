import { Loader2 } from "lucide-react";
import { UnreadBellIcon } from "@/components/environments/UnreadBellIcon";
import { useEnvironmentPendingTarget } from "@/components/environments/EnvironmentAttentionLine";
import {
  LOCAL_AGENT_SUMMARY_SOURCE,
  type AgentSummarySource,
} from "@/components/environments/EnvironmentAgentSummary";
import { environmentAttentionParts } from "@/components/environments/environment-row-model";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useNodeScope } from "@/lib/node-scope/providers";
import { environmentStore, useEnvironmentStore } from "@/stores/environmentStore";
import { projectStore, useProjectStore } from "@/stores/projectStore";
import { uiStore } from "@/stores/uiStore";
import { resolveEnvironmentAgentActivity } from "@/lib/environment-agent-activity";
import type { Environment } from "@/types";

export interface ProjectHomeStatus {
  label: "working" | "needs attention";
  /** The spinner shows whenever it works, even while it also needs the user. */
  working: boolean;
  waiting: boolean;
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
  hasWaitingNativeTab?: boolean;
}): ProjectHomeStatus | null {
  const working = home.buildActive || home.activity === "working";
  const waiting = home.activity === "waiting" || home.hasWaitingNativeTab === true;
  const needsAttention = waiting || home.hasUnreadWork;
  if (home.deleting || (!working && !needsAttention)) return null;
  return { label: needsAttention ? "needs attention" : "working", working, waiting };
}

/** The home's activity button, in a project header (compact) or the activity list. */
export function ProjectHomeActivityButton({
  status,
  projectName,
  environmentId,
  source,
  lastActivityAt,
  onOpen,
  compact = false,
}: {
  status: ProjectHomeStatus;
  projectName: string;
  environmentId: string;
  source: AgentSummarySource;
  lastActivityAt?: string;
  onOpen: (tabId?: string, interactionId?: string) => void;
  compact?: boolean;
}) {
  const target = useEnvironmentPendingTarget(environmentId, status.waiting ? source : null);
  const now = useMinuteClock();
  const { head, tail } = environmentAttentionParts(
    { tone: "waiting", text: "Waiting for you", since: lastActivityAt ?? null, readsPending: true },
    target?.pending ?? null,
    now.getTime(),
    target?.total,
  );
  const attention = tail ? `${head} · ${tail}` : head;
  const label = `${projectName} home ${status.label}`;
  return (
    <button
      type="button"
      aria-label={status.waiting ? `${label}, ${attention}` : label}
      title={status.waiting ? attention : `Open project home — ${status.label}`}
      className={
        compact
          ? "shrink-0 rounded-md p-1 text-amber-400 hover:bg-hover"
          : "mx-3 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-hover"
      }
      onClick={() => onOpen(target?.tabId, target?.pending.interactionId)}
    >
      {status.working ? (
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <UnreadBellIcon aria-hidden="true" className="h-3.5 w-3.5" />
      )}
      {!compact && (
        <span className="min-w-0 truncate">
          {projectName} home — {status.waiting ? attention : status.label}
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
  // The node this home belongs to: the one the selectors below read.
  const scope = useNodeScope();
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
    hasWaitingNativeTab: home.status === "running" && home.hasWaitingNativeTab,
  });
  if (!status) return null;
  return (
    <ProjectHomeActivityButton
      status={status}
      projectName={projectName}
      environmentId={home.id}
      source={LOCAL_AGENT_SUMMARY_SOURCE}
      lastActivityAt={home.lastActivityAt}
      compact={compact}
      onOpen={(tabId, interactionId) => {
        if (
          scope.store(projectStore).getState().deletingProjects.has(home.projectId) ||
          scope.store(environmentStore).getState().isDeleting(home.id)
        )
          return;
        const ui = scope.store(uiStore).getState();
        if (tabId) {
          openCoordinatorWorkTarget(
            {
              type: "worker-tab",
              projectId: home.projectId,
              environmentId: home.id,
              tabId,
              interactionId,
            },
            undefined,
            scope,
          );
        } else {
          ui.selectProjectAndEnvironment(home.projectId, home.id);
        }
        ui.setProjectBoardTab("home");
      }}
    />
  );
}
