import { useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { HoverTooltipContent, useHoverTooltip } from "@/components/ui/hover-tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  FolderGit2,
  Trash2,
  ChevronRight,
  Plus,
  Settings2,
  LayoutGrid,
} from "lucide-react";
import type { Project, Environment } from "@/types";
import { cn } from "@/lib/utils";
import { SortableEnvironmentItem } from "./SortableEnvironmentItem";

interface SortableProjectGroupProps {
  project: Project;
  environments: Environment[];
  isCollapsed: boolean;
  isSelected: boolean;
  onToggleCollapse: () => void;
  selectedEnvironmentId: string | null;
  onSelectProject: () => void;
  onSelectEnvironment: (environmentId: string, modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => void;
  onDeleteProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onDeleteEnvironment: (environmentId: string) => void;
  onStartEnvironment: (environmentId: string) => void;
  onStopEnvironment: (environmentId: string) => void;
  onRestartEnvironment: (environmentId: string) => void;
  onUpdateEnvironment?: (environment: Environment) => void;
  onCreateEnvironment: () => void;
  isMultiSelectMode?: boolean;
  selectedEnvironmentIds?: string[];
}

export function SortableProjectGroup({
  project,
  environments,
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
  onUpdateEnvironment,
  onCreateEnvironment,
  isMultiSelectMode = false,
  selectedEnvironmentIds = [],
}: SortableProjectGroupProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const projectTooltipAnchorRef = useRef<HTMLButtonElement>(null);
  const projectTooltip = useHoverTooltip();

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const confirmDelete = () => {
    onDeleteProject(project.id);
    setShowDeleteDialog(false);
  };

  const handleAddEnvironment = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.currentTarget.blur();
    onCreateEnvironment();
  };

  // Count running environments
  const runningCount = environments.filter((e) => e.status === "running").length;

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={cn("px-2 py-0.5", isDragging && "opacity-50 z-50")}
      >
        <Collapsible open={!isCollapsed} onOpenChange={onToggleCollapse}>
          {/* Project Header with Context Menu */}
          <div
            className={cn(
              "relative mx-1 flex items-center group/project rounded-lg border transition-colors",
              isSelected
                ? "border-zinc-700/70 bg-zinc-800/85"
                : "border-transparent hover:bg-zinc-800/55"
            )}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <ContextMenu>
              <ContextMenuTrigger className="contents">
                <button
                  {...attributes}
                  {...listeners}
                  ref={projectTooltipAnchorRef}
                  type="button"
                  className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground active:cursor-grabbing"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectProject();
                  }}
                  onMouseEnter={projectTooltip.show}
                  onMouseLeave={projectTooltip.hide}
                  onFocus={projectTooltip.show}
                  onBlur={projectTooltip.hide}
                >
                  <FolderGit2 className="h-4 w-4 shrink-0 text-zinc-500" />
                  <span className="truncate font-medium">{project.name}</span>
                  {environments.length > 0 && (
                    <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-zinc-800 px-1 text-[10px] text-zinc-300">
                      {environments.length}
                    </span>
                  )}
                </button>
              </ContextMenuTrigger>
              <HoverTooltipContent
                anchorRef={projectTooltipAnchorRef}
                open={projectTooltip.open}
                side="right"
                align="center"
                onMouseEnter={projectTooltip.show}
                onMouseLeave={projectTooltip.hide}
              >
                <p className="font-mono text-xs">{project.gitUrl}</p>
                {project.localPath && (
                  <p className="text-xs text-muted-foreground">{project.localPath}</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {environments.length} environment{environments.length !== 1 && "s"}
                  {runningCount > 0 && ` (${runningCount} running)`}
                </p>
                <p className="text-xs text-muted-foreground">Click to open board</p>
              </HoverTooltipContent>
              <ContextMenuContent>
                <ContextMenuItem onClick={onSelectProject}>
                  <LayoutGrid className="h-4 w-4 mr-2" />
                  Open Board
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={onOpenSettings}>
                  <Settings2 className="h-4 w-4 mr-2" />
                  Repository Settings
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={onCreateEnvironment}>
                  <Plus className="h-4 w-4 mr-2" />
                  New Environment
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={() => setShowDeleteDialog(true)}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Project
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            {/* Action buttons - shown on hover, replacing chevron */}
            {/* Add button - shown on hover */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                "h-6 w-6 text-muted-foreground opacity-100 transition-opacity hover:text-foreground md:opacity-0",
                isHovered && "md:opacity-100"
              )}
              onClick={handleAddEnvironment}
              title="Create environment"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>

            {/* Chevron arrow - far right */}
            <CollapsibleTrigger
              className="shrink-0 rounded p-1 transition-colors hover:bg-zinc-800/80"
              onClick={(e) => e.stopPropagation()}
            >
              <ChevronRight
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform duration-200",
                  !isCollapsed && "rotate-90"
                )}
              />
            </CollapsibleTrigger>
          </div>

          {/* Environments List */}
          <CollapsibleContent>
            <div className="space-y-0.5 pb-1">
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
                      onUpdate={onUpdateEnvironment}
                      isMultiSelectMode={isMultiSelectMode}
                      isChecked={selectedEnvironmentIds.includes(environment.id)}
                    />
                  ))}
                </SortableContext>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove <strong>{project.name}</strong> from your projects?
              {environments.length > 0 && (
                <span className="block mt-2 text-orange-500">
                  Warning: This project has {environments.length} environment
                  {environments.length !== 1 && "s"} that will also be deleted.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
