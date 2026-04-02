import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

  const handleAddEnvironment = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCreateEnvironment();
  };

  // Count running environments
  const runningCount = environments.filter((e) => e.status === "running").length;

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={cn("border-b border-white/10", isDragging && "opacity-50 z-50")}
      >
        <Collapsible open={!isCollapsed} onOpenChange={onToggleCollapse}>
          {/* Project Header with Context Menu */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                {...attributes}
                {...listeners}
                className="relative flex items-center group/project cursor-grab active:cursor-grabbing pl-1 pr-2"
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
              >
                <div className="flex flex-1 items-center gap-0 rounded-md text-sm text-foreground">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectProject();
                        }}
                      >
                        <FolderGit2 className="h-4 w-4 shrink-0" />
                        <span className="truncate font-medium">{project.name}</span>
                        {environments.length > 0 && (
                          <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] bg-zinc-600 text-zinc-300">
                            {environments.length}
                          </span>
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" align="center">
                      <p className="font-mono text-xs">{project.gitUrl}</p>
                      {project.localPath && (
                        <p className="text-xs text-muted-foreground">{project.localPath}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        {environments.length} environment{environments.length !== 1 && "s"}
                        {runningCount > 0 && ` (${runningCount} running)`}
                      </p>
                      <p className="text-xs text-muted-foreground">Click to open board</p>
                    </TooltipContent>
                  </Tooltip>
                </div>

                {/* Action buttons - shown on hover, replacing chevron */}
                {/* Add button - shown on hover */}
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-6 w-6 text-muted-foreground hover:text-foreground transition-opacity",
                    isHovered ? "opacity-100" : "opacity-0"
                  )}
                  onClick={handleAddEnvironment}
                  title="Create environment"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>

                {/* Chevron arrow - far right */}
                <CollapsibleTrigger asChild>
                  <button
                    className="shrink-0 p-1 rounded hover:bg-accent/50 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ChevronRight
                      className={cn(
                        "h-4 w-4 text-muted-foreground transition-transform duration-200",
                        !isCollapsed && "rotate-90"
                      )}
                    />
                  </button>
                </CollapsibleTrigger>
              </div>
            </ContextMenuTrigger>
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

          {/* Environments List */}
          <CollapsibleContent>
            <div>
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
