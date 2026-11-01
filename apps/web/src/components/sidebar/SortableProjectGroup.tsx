import { ProjectHomeActivity } from "./ProjectHomeActivity";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useSortable } from "@dnd-kit/sortable";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DeleteProjectDialog } from "@/components/projects/DeleteProjectDialog";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import type { Project, Environment, EnvironmentType } from "@/types";
import { cn } from "@/lib/utils";
import { openInBrowser } from "@/lib/backend";
import { getGitHubRepositoryUrl } from "@/lib/gitUrl";
import { SortableEnvironmentItem } from "./SortableEnvironmentItem";
import { ProjectGroupHeader } from "./ProjectGroupHeader";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useConfigStore } from "@/stores/configStore";

interface SortableProjectGroupProps {
  project: Project;
  environments: Environment[];
  home?: Environment;
  isCollapsed: boolean;
  isSelected: boolean;
  onToggleCollapse: () => void;
  selectedEnvironmentId: string | null;
  onSelectProject: () => void;
  onSelectEnvironment: (
    environmentId: string,
    modifiers?: { shiftKey?: boolean; metaKey?: boolean },
  ) => void;
  onDeleteProject: (projectId: string) => void | Promise<void>;
  onOpenSettings: () => void;
  onDeleteEnvironment: (environmentId: string) => void;
  onStartEnvironment: (environmentId: string) => void;
  onStopEnvironment: (environmentId: string) => void;
  onRestartEnvironment: (environmentId: string) => void;
  onForkEnvironment?: (environmentId: string, environmentType: EnvironmentType) => void;
  onCreateEnvironment: () => void;
  /** Copies the project to another machine; shown only when there are other machines. */
  onCopyToMachine?: () => void;
  /** Opens the folder composer for this project. */
  onAddToFolder?: () => void;
  /** Lifts this project back out to the root level; omitted when it has no folder. */
  onRemoveFromFolder?: () => void;
  isMultiSelectMode?: boolean;
  selectedEnvironmentIds?: string[];
  /** Drag id in a list that mixes machines (the project key); the project ID otherwise. */
  sortableId?: string;
  /**
   * Shown before the name, in lists that mix machines. Such rows put the
   * chevron last, as the list's folder headings do.
   */
  machineIcon?: ReactNode;
  /** Shown instead of the project name (a repository group names the machine). */
  label?: string;
  labelClassName?: string;
  /** This window's machine, where the sidebar names machines. */
  machineName?: string;
}

export function SortableProjectGroup({
  project,
  environments,
  home,
  isCollapsed,
  isSelected,
  onToggleCollapse,
  selectedEnvironmentId,
  onSelectProject,
  onSelectEnvironment,
  onDeleteProject,
  onOpenSettings,
  onDeleteEnvironment,
  onStartEnvironment,
  onStopEnvironment,
  onRestartEnvironment,
  onForkEnvironment,
  onCreateEnvironment,
  onCopyToMachine,
  onAddToFolder,
  onRemoveFromFolder,
  isMultiSelectMode = false,
  selectedEnvironmentIds = [],
  sortableId,
  machineIcon,
  label = project.name,
  labelClassName,
  machineName,
}: SortableProjectGroupProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId ?? project.id,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  const githubRepositoryUrl = getGitHubRepositoryUrl(project.gitUrl);

  // Count running environments
  const runningCount = environments.filter((e) => e.status === "running").length;
  const messagingEnabled = useConfigStore(
    (state) => state.config.global.agentMessaging?.enabled === true,
  );
  const unreadMail = useAgentMailStore((state) => {
    if (!messagingEnabled) return 0;
    let count = 0;
    for (const mailbox of state.summary.values()) {
      if (mailbox.projectId === project.id) count += mailbox.userUnseenCount ?? mailbox.unreadCount;
    }
    return count;
  });
  const hasFailedMail = useAgentMailStore(
    (state) =>
      messagingEnabled &&
      Array.from(state.summary.values()).some(
        (mailbox) => mailbox.projectId === project.id && mailbox.failedInjectCount > 0,
      ),
  );

  return (
    <>
      <div ref={setNodeRef} style={style} className={cn("px-2", isDragging && "opacity-50 z-50")}>
        <Collapsible open={!isCollapsed} onOpenChange={onToggleCollapse}>
          <ProjectGroupHeader
            projectName={project.name}
            label={label}
            labelClassName={labelClassName}
            icon={machineIcon}
            card={{
              repository: project.gitUrl,
              ...(project.localPath ? { path: project.localPath } : {}),
              environmentCount: environments.length,
              runningCount,
              openHint: "Click to open board",
            }}
            unreadMail={unreadMail}
            failedMail={hasFailedMail}
            highlighted={isSelected}
            ariaCurrent={isSelected ? "page" : undefined}
            sortable
            dragAttributes={attributes}
            dragListeners={listeners}
            isCollapsed={isCollapsed}
            onOpen={onSelectProject}
            writable
            menu={{
              openBoard: onSelectProject,
              ...(githubRepositoryUrl
                ? {
                    openGithub: () => {
                      void openInBrowser(githubRepositoryUrl).catch(() => {
                        toast.error("Could not open repository in browser.");
                      });
                    },
                  }
                : {}),
              openSettings: onOpenSettings,
              newEnvironment: onCreateEnvironment,
              ...(onCopyToMachine ? { copyToMachine: onCopyToMachine } : {}),
              ...(onAddToFolder ? { addToFolder: onAddToFolder } : {}),
              ...(onRemoveFromFolder ? { removeFromFolder: onRemoveFromFolder } : {}),
              deleteProject: () => setShowDeleteDialog(true),
            }}
            homeActivity={
              home && <ProjectHomeActivity home={home} projectName={project.name} compact />
            }
            newEnvironment={
              machineName
                ? {
                    label: `New environment in ${project.name} on ${machineName}`,
                    title: `New environment on ${machineName}`,
                  }
                : { label: `New environment in ${project.name}`, title: "Create environment" }
            }
          />

          {/* Environments List */}
          <CollapsibleContent>
            {environments.length > 0 && (
              <SortableContext
                items={environments.map((e) => e.id)}
                strategy={verticalListSortingStrategy}
              >
                {environments.map((environment) => (
                  <SortableEnvironmentItem
                    key={environment.id}
                    environment={environment}
                    isSelected={selectedEnvironmentId === environment.id}
                    onSelect={onSelectEnvironment}
                    onDelete={onDeleteEnvironment}
                    onStart={onStartEnvironment}
                    onStop={onStopEnvironment}
                    onRestart={onRestartEnvironment}
                    onFork={onForkEnvironment}
                    isMultiSelectMode={isMultiSelectMode}
                    isChecked={selectedEnvironmentIds.includes(environment.id)}
                  />
                ))}
              </SortableContext>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteProjectDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        projectName={project.name}
        environmentCount={environments.length}
        onConfirm={() => onDeleteProject(project.id)}
      />
    </>
  );
}
