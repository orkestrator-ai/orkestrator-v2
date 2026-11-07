import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { useFederation } from "@/components/federation/FederationProvider";
import { CommandNodeHomeIcon } from "@/components/federation/MachineDot";
import { CoordinatorActivityIcon } from "@/components/projects/CoordinatorActivityIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MachineView } from "@/lib/federation/aggregate";
import { openMachineWorkspace, openRepository } from "@/lib/federation/open-workspace";
import { projectLandingBoardTab } from "@/lib/federation/window-grouping";
import { resolveEnvironmentAgentActivity } from "@/lib/environment-agent-activity";
import { usePortalLayout } from "@/lib/portal/portal-layout";
import { cn } from "@/lib/utils";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useCoordinatorActivityStore } from "@/stores/coordinatorActivityStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import type { Environment, Project } from "@/types";
import {
  compactLocalRepositories,
  compactRepositories,
  compactRepositoryStatus,
  remoteMemberFacts,
  type CompactMemberFacts,
  type CompactRepository,
  type CompactRepositoryStatus,
} from "./compact-repositories";

const ICON_BUTTON_CLASS =
  "flex size-11 shrink-0 items-center justify-center rounded-lg outline-hidden hover:bg-hover focus-hairline";

/** This window's status for each repository, read from what its project rows read. */
function useCompactStatuses(
  repositories: readonly CompactRepository[],
  environments: readonly Environment[],
): Map<string, CompactRepositoryStatus> {
  const retainCoordinators = useCoordinatorActivityStore((state) => state.retain);
  useEffect(() => retainCoordinators(), [retainCoordinators]);
  const coordinators = useCoordinatorActivityStore((state) => state.projects);
  const containerStates = useAgentActivityStore((state) => state.containerStates);
  const containerStateUpdatedAt = useAgentActivityStore((state) => state.containerStateUpdatedAt);
  const activeBuilds = useBuildPipelineStore((state) => state.activeBuildEnvironmentIds);
  const deletingEnvironments = useEnvironmentStore((state) => state.deletingEnvironments);
  const deletingProjects = useProjectStore((state) => state.deletingProjects);
  const messagingEnabled = useConfigStore(
    (state) => state.config.global.agentMessaging?.enabled === true,
  );
  const mailboxes = useAgentMailStore((state) => state.summary);

  return useMemo(() => {
    const gone = (environment: Environment) =>
      deletingEnvironments.has(environment.id) ||
      Boolean(environment.deletionRequestedAt) ||
      environment.lifecycleOperation === "deleting";

    const boundFacts = (projectId: string): CompactMemberFacts => {
      const own = environments.filter((environment) => environment.projectId === projectId);
      const home = own.find((environment) => environment.projectHome && !gone(environment));
      let unreadMail = 0;
      let failedMail = false;
      if (messagingEnabled) {
        for (const mailbox of mailboxes.values()) {
          if (mailbox.projectId !== projectId) continue;
          unreadMail += mailbox.userUnseenCount ?? mailbox.unreadCount;
          failedMail ||= mailbox.failedInjectCount > 0;
        }
      }
      return {
        coordinator: coordinators.get(projectId) ?? null,
        working: own.some(
          (environment) =>
            !environment.projectHome &&
            !gone(environment) &&
            (activeBuilds.has(environment.id) ||
              resolveEnvironmentAgentActivity(
                environment,
                containerStates,
                containerStateUpdatedAt,
              ) === "working"),
        ),
        waiting: own.some(
          (environment) =>
            !environment.projectHome &&
            !gone(environment) &&
            resolveEnvironmentAgentActivity(
              environment,
              containerStates,
              containerStateUpdatedAt,
            ) === "waiting",
        ),
        home: home
          ? {
              deleting: deletingProjects.has(projectId),
              buildActive: activeBuilds.has(home.id),
              activity: resolveEnvironmentAgentActivity(
                home,
                containerStates,
                containerStateUpdatedAt,
              ),
              hasUnreadWork: home.hasUnreadWork === true,
            }
          : null,
        unreadWork: own.some(
          (environment) =>
            !environment.projectHome && !gone(environment) && environment.hasUnreadWork === true,
        ),
        unreadMail,
        failedMail,
      };
    };

    return new Map(
      repositories.map((repository) => [
        repository.key,
        compactRepositoryStatus(
          repository.members.map(({ machine, projectId }) =>
            machine && !machine.bound
              ? remoteMemberFacts(machine.environmentsByProject.get(projectId) ?? [])
              : boundFacts(projectId),
          ),
        ),
      ]),
    );
  }, [
    activeBuilds,
    containerStateUpdatedAt,
    containerStates,
    coordinators,
    deletingEnvironments,
    deletingProjects,
    environments,
    mailboxes,
    messagingEnabled,
    repositories,
  ]);
}

function CompactRepositoryIcon({
  repository,
  status,
  selected,
  onOpen,
}: {
  repository: CompactRepository;
  status: CompactRepositoryStatus;
  selected: boolean;
  onOpen: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) buttonRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return (
    <li data-testid="compact-repository" data-repository={repository.key}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={buttonRef}
            type="button"
            aria-label={[repository.name, ...status.labels].join(", ")}
            aria-current={selected ? "page" : undefined}
            data-selected={selected || undefined}
            className={cn(
              ICON_BUTTON_CLASS,
              selected && "bg-linear-to-r from-selected to-selected-edge",
            )}
            onClick={onOpen}
          >
            {/* Everything but the tile sits outside the flow, so status never moves it. */}
            <span className="relative inline-flex">
              <CoordinatorActivityIcon state={status.ring} ringRadiusClassName="rounded-[11px]">
                {/* The tile is translucent; this keeps the halo around it, not through it. */}
                <span className="rounded-lg bg-sidebar">
                  <CommandNodeHomeIcon
                    colorToken={repository.colorToken}
                    projectIcon={repository.icon}
                  />
                </span>
              </CoordinatorActivityIcon>
              {status.badge ? (
                <span
                  data-testid="compact-repository-badge"
                  data-badge={status.badge}
                  aria-hidden="true"
                  className={cn(
                    "absolute -top-1 -right-1 z-20 size-2.5 rounded-full ring-2 ring-sidebar",
                    "forced-colors:bg-[CanvasText]",
                    status.badge === "attention" ? "bg-amber-400" : "bg-cyan-400",
                  )}
                />
              ) : null}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          <span className="font-medium">{repository.name}</span>
          {status.labels.map((label) => (
            <span key={label} className="block text-muted-foreground">
              {label}
            </span>
          ))}
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

/** Up, Down, Home and End move focus among the list's buttons. */
function handleListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
  const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
  const current = buttons.indexOf(event.target as HTMLButtonElement);
  if (current === -1) return;
  const next =
    event.key === "ArrowDown"
      ? current + 1
      : event.key === "ArrowUp"
        ? current - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : null;
  if (next === null) return;
  event.preventDefault();
  buttons[Math.min(Math.max(next, 0), buttons.length - 1)]?.focus();
}

/**
 * The sidebar's compact mode: one large icon per top-level repository, with no
 * text but the tooltips. Clicking one opens what its row or repository heading
 * opens; the sidebar stays compact.
 */
export function CompactRepositoryList({
  machines,
  localProjects,
  environments,
  loading,
  onAddProject,
}: {
  /** The machines the window names; empty uses `localProjects`. */
  machines: readonly MachineView[];
  /** This window's projects, in its sidebar's order. */
  localProjects: readonly Project[];
  environments: readonly Environment[];
  loading: boolean;
  onAddProject: () => void;
}) {
  const { portalState } = useFederation();
  const layout = usePortalLayout();
  const selectProject = useUIStore((state) => state.selectProject);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const remoteActive = useRemoteWorkspaceStore((state) => state.active);

  const repositories = useMemo(
    () =>
      machines.length > 0
        ? compactRepositories(machines, layout, portalState.selfId)
        : compactLocalRepositories(localProjects),
    [layout, localProjects, machines, portalState.selfId],
  );
  const statuses = useCompactStatuses(repositories, environments);

  const isSelected = (repository: CompactRepository) =>
    repository.members.some(({ machine, projectId }) =>
      remoteActive
        ? machine?.connectionId === remoteActive.nodeId && projectId === remoteActive.projectId
        : (!machine || machine.bound) && projectId === selectedProjectId,
    );

  const open = (repository: CompactRepository) => {
    const { opens } = repository;
    if (!("project" in opens)) {
      selectProject(opens.projectId);
      return;
    }
    const projectId = opens.project.ref.projectId;
    if (repository.repository) {
      openRepository({
        repository: repository.repository,
        projectKey: opens.id,
        connectionId: opens.machine.connectionId,
        projectId,
        coordinatorGated: opens.machine.bound && portalState.status?.mode === "leaf",
        title: opens.name,
      });
    } else if (opens.machine.bound) {
      selectProject(projectId);
    } else {
      const boardTab = projectLandingBoardTab("repository", false);
      openMachineWorkspace({
        connectionId: opens.machine.connectionId,
        projectId,
        ...(boardTab ? { boardTab } : {}),
        title: opens.name,
      });
    }
  };

  return (
    <nav
      aria-label="Repositories"
      data-sidebar-scroll
      data-testid="compact-repository-list"
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {repositories.length === 0 ? (
        <div className="flex justify-center py-2">
          {loading ? (
            <span role="status" aria-label="Loading projects" className={ICON_BUTTON_CLASS}>
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-muted-foreground" />
            </span>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Add project"
                  className={ICON_BUTTON_CLASS}
                  onClick={onAddProject}
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={6}>
                Add project
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      ) : (
        <ul className="flex flex-col items-center gap-1 py-2" onKeyDown={handleListKeyDown}>
          {repositories.map((repository) => (
            <CompactRepositoryIcon
              key={repository.key}
              repository={repository}
              status={statuses.get(repository.key) ?? compactRepositoryStatus([])}
              selected={isSelected(repository)}
              onOpen={() => open(repository)}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
