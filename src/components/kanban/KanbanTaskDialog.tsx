import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Trash2, Send, CheckCircle2, Container, FolderGit2, ExternalLink, Loader2 } from "lucide-react";
import type { KanbanTask, KanbanStatus } from "@/stores/kanbanStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useBuildPipeline } from "@/hooks/useBuildPipeline";

const STATUS_LABELS: Record<KanbanStatus, string> = {
  backlog: "Backlog",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
};

interface KanbanTaskDialogProps {
  task: KanbanTask | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, dialog opens in create mode for this project */
  createForProjectId?: string;
}

export function KanbanTaskDialog({ task, open, onOpenChange, createForProjectId }: KanbanTaskDialogProps) {
  const updateTask = useKanbanStore((s) => s.updateTask);
  const deleteTask = useKanbanStore((s) => s.deleteTask);
  const addTaskStore = useKanbanStore((s) => s.addTask);
  const addComment = useKanbanStore((s) => s.addComment);
  const deleteComment = useKanbanStore((s) => s.deleteComment);

  const { startBuild, navigateToBuild } = useBuildPipeline();
  const getPipelineByTaskId = useBuildPipelineStore((s) => s.getPipelineByTaskId);
  const [isBuildStarting, setIsBuildStarting] = useState(false);
  const [confirmBuildType, setConfirmBuildType] = useState<"containerized" | "local" | null>(null);

  const isCreateMode = !!createForProjectId;

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAC, setEditAC] = useState("");
  const [commentText, setCommentText] = useState("");
  const [isEditingAC, setIsEditingAC] = useState(false);

  // Reset create mode fields when dialog opens in create mode
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setEditTitle("");
      setEditDescription("");
      setEditAC("");
      setIsEditing(false);
      setIsEditingAC(false);
    }
    onOpenChange(newOpen);
  };

  if (!task && !isCreateMode) return null;

  const handleStartEdit = () => {
    if (task) {
      setEditTitle(task.title);
      setEditDescription(task.description);
    }
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    if (editTitle.trim() && task) {
      void updateTask(task.id, { title: editTitle.trim(), description: editDescription.trim() });
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleCreate = () => {
    if (editTitle.trim() && createForProjectId) {
      // Capture values before closing to avoid stale state in the .then() closure
      const title = editTitle.trim();
      const description = editDescription.trim();
      const ac = editAC.trim();
      handleOpenChange(false);
      void addTaskStore(createForProjectId, title, description).then((newTaskId) => {
        if (ac && newTaskId) {
          void updateTask(newTaskId, { acceptanceCriteria: ac });
        }
      });
    }
  };

  const handleCreateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCreate();
    }
  };

  const handleStartEditAC = () => {
    if (task) {
      setEditAC(task.acceptanceCriteria);
    }
    setIsEditingAC(true);
  };

  const handleSaveAC = () => {
    if (task) {
      void updateTask(task.id, { acceptanceCriteria: editAC.trim() });
    }
    setIsEditingAC(false);
  };

  const handleCancelAC = () => {
    setIsEditingAC(false);
  };

  const handleDelete = () => {
    if (task) {
      void deleteTask(task.id);
    }
    handleOpenChange(false);
  };

  const handleAddComment = () => {
    if (commentText.trim() && task) {
      void addComment(task.id, commentText.trim());
      setCommentText("");
    }
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAddComment();
    }
  };

  const handleStartBuild = async (type: "containerized" | "local") => {
    if (!task) return;
    setIsBuildStarting(true);
    try {
      await startBuild(task, type);
      handleOpenChange(false);
    } finally {
      setIsBuildStarting(false);
    }
  };

  if (isCreateMode) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[560px] max-h-[85vh] flex flex-col">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                Backlog
              </span>
            </div>
            <div className="space-y-2 pt-1">
              <DialogTitle className="sr-only">New Task</DialogTitle>
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleCreateKeyDown}
                placeholder="Task title..."
                className="text-lg font-semibold"
                autoFocus
              />
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Description..."
                rows={3}
              />
            </div>
          </DialogHeader>

          <Separator />

          {/* Acceptance Criteria */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-medium">Acceptance Criteria</h4>
            </div>
            <Textarea
              value={editAC}
              onChange={(e) => setEditAC(e.target.value)}
              placeholder="Define what 'done' looks like..."
              rows={4}
            />
          </div>

          {/* Create Actions */}
          <div className="flex gap-2 pt-2">
            <Button size="sm" onClick={handleCreate} disabled={!editTitle.trim()}>
              Create Task
            </Button>
            <Button size="sm" variant="ghost" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!task) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                {STATUS_LABELS[task.status]}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          {isEditing ? (
            <div className="space-y-2 pt-1">
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="text-lg font-semibold"
                autoFocus
              />
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Description..."
                rows={3}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveEdit}>Save</Button>
                <Button size="sm" variant="ghost" onClick={handleCancelEdit}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="cursor-pointer" onClick={handleStartEdit}>
              <DialogTitle className="text-lg">{task.title}</DialogTitle>
              {task.description ? (
                <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">
                  {task.description}
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground/50 italic">
                  Click to add a description...
                </p>
              )}
            </div>
          )}
        </DialogHeader>

        <Separator />

        {/* Acceptance Criteria */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">Acceptance Criteria</h4>
          </div>
          {isEditingAC ? (
            <div className="space-y-2">
              <Textarea
                value={editAC}
                onChange={(e) => setEditAC(e.target.value)}
                placeholder="Define what 'done' looks like..."
                rows={4}
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveAC}>Save</Button>
                <Button size="sm" variant="ghost" onClick={handleCancelAC}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div
              className="cursor-pointer rounded-md border border-border/50 p-2.5 hover:border-border transition-colors min-h-[40px]"
              onClick={handleStartEditAC}
            >
              {task.acceptanceCriteria ? (
                <p className="text-sm text-foreground whitespace-pre-wrap">
                  {task.acceptanceCriteria}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground/50 italic">
                  Click to add acceptance criteria...
                </p>
              )}
            </div>
          )}
        </div>

        <Separator />

        {/* Build Actions */}
        {(() => {
          const existingPipeline = getPipelineByTaskId(task.id);
          const hasActiveBuild = existingPipeline && !["complete", "failed"].includes(existingPipeline.phase);

          return (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 flex-1"
                  disabled={isBuildStarting || !!hasActiveBuild}
                  onClick={() => {
                    if (task.environmentId) {
                      setConfirmBuildType("containerized");
                    } else {
                      void handleStartBuild("containerized");
                    }
                  }}
                >
                  {isBuildStarting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Container className="h-3.5 w-3.5" />
                  )}
                  Build Container
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 flex-1"
                  disabled={isBuildStarting || !!hasActiveBuild}
                  onClick={() => {
                    if (task.environmentId) {
                      setConfirmBuildType("local");
                    } else {
                      void handleStartBuild("local");
                    }
                  }}
                >
                  {isBuildStarting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FolderGit2 className="h-3.5 w-3.5" />
                  )}
                  Build Local
                </Button>
                {task.environmentId && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => {
                      navigateToBuild(task);
                      handleOpenChange(false);
                    }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View Build
                    {existingPipeline && (
                      <span className="text-xs text-muted-foreground ml-1">
                        ({existingPipeline.phase})
                      </span>
                    )}
                  </Button>
                )}
              </div>
            </div>
          );
        })()}

        <Separator />

        {/* Comments */}
        <div className="flex-1 min-h-0">
          <h4 className="text-sm font-medium mb-2">Comments ({task.comments.length})</h4>
          <ScrollArea className="max-h-[200px]">
            <div className="space-y-3 pr-3">
              {task.comments.length === 0 && (
                <p className="text-xs text-muted-foreground italic">No comments yet</p>
              )}
              {task.comments.map((comment) => (
                <div
                  key={comment.id}
                  className="group/comment rounded-md bg-muted/50 p-2.5 text-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="whitespace-pre-wrap text-foreground flex-1">{comment.text}</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0 opacity-0 group-hover/comment:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      onClick={() => void deleteComment(task.id, comment.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  <span className="text-[10px] text-muted-foreground mt-1 block">
                    {new Date(comment.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Add Comment */}
        <div className="flex items-center gap-2 pt-2">
          <Input
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={handleCommentKeyDown}
            placeholder="Add a comment..."
            className="flex-1"
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={handleAddComment}
            disabled={!commentText.trim()}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </DialogContent>

      <AlertDialog open={!!confirmBuildType} onOpenChange={(open) => { if (!open) setConfirmBuildType(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Environment Already Exists</AlertDialogTitle>
            <AlertDialogDescription>
              This task already has an environment linked to it. Starting a new build will create an additional environment.
              <span className="block mt-2">
                Are you sure you want to start a new{" "}
                <strong>{confirmBuildType === "containerized" ? "container" : "local"}</strong> build?
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmBuildType) {
                  void handleStartBuild(confirmBuildType);
                }
                setConfirmBuildType(null);
              }}
            >
              Start Build
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
