import { useState } from "react";
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
import { FolderGit2, Trash2, ChevronRight } from "lucide-react";
import type { Project } from "@/types";
import { cn } from "@/lib/utils";

interface ProjectItemProps {
  project: Project;
  isSelected: boolean;
  onSelect: (projectId: string) => void;
  onDelete: (projectId: string) => void;
}

export function ProjectItem({ project, isSelected, onSelect, onDelete }: ProjectItemProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteDialog(true);
  };

  const confirmDelete = () => {
    onDelete(project.id);
    setShowDeleteDialog(false);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onSelect(project.id)}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            className={cn(
              "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              isSelected
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <FolderGit2 className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">{project.name}</span>

            {/* Delete button - shown on hover */}
            <div
              className={cn(
                "flex items-center gap-1 transition-opacity",
                isHovered || isSelected ? "opacity-100" : "opacity-0"
              )}
            >
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                onClick={handleDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            <ChevronRight className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              isSelected && "rotate-90"
            )} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="center">
          <p className="font-mono text-xs">{project.gitUrl}</p>
          {project.localPath && (
            <p className="text-xs text-muted-foreground">{project.localPath}</p>
          )}
        </TooltipContent>
      </Tooltip>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove <strong>{project.name}</strong> from your projects?
              This will not delete any environments associated with this project.
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
