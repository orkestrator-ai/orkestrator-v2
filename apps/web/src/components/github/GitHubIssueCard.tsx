import { useDraggable } from "@dnd-kit/core";
import { CircleDot, GripVertical, MessageSquare, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { GitHubIssue, GitHubIssueStatus } from "@/types/github";

export const GITHUB_WORKFLOW_STAGES: Array<{
  id: GitHubIssueStatus;
  label: string;
  color: string;
  wash: string;
}> = [
  {
    id: "backlog",
    label: "Backlog",
    color: "bg-zinc-500",
    wash: "from-zinc-500/10",
  },
  {
    id: "todo",
    label: "Todo",
    color: "bg-sky-500",
    wash: "from-sky-500/10",
  },
  {
    id: "inprogress",
    label: "In Progress",
    color: "bg-violet-500",
    wash: "from-violet-500/10",
  },
  {
    id: "review",
    label: "Review",
    color: "bg-amber-500",
    wash: "from-amber-500/10",
  },
];

export function getGitHubStageLabel(status: GitHubIssueStatus): string {
  return GITHUB_WORKFLOW_STAGES.find((stage) => stage.id === status)?.label ?? status;
}

function safeLabelColor(color: string): string {
  return /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : "#6b7280";
}

interface GitHubIssueCardProps {
  issue: GitHubIssue;
  onOpen: () => void;
  onStatusChange: (status: GitHubIssueStatus) => void;
  statusPending?: boolean;
  isOverlay?: boolean;
}

export function GitHubIssueCard({
  issue,
  onOpen,
  onStatusChange,
  statusPending,
  isOverlay,
}: GitHubIssueCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `github-issue:${issue.number}`,
    data: { type: "github-issue", issueNumber: issue.number, status: issue.status },
    disabled: statusPending || isOverlay,
  });

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={cn(
        "group rounded-lg border border-border/70 bg-card p-3 shadow-sm transition-[border-color,box-shadow,opacity]",
        "hover:border-border hover:shadow-md focus-within:border-primary/50",
        isDragging && "opacity-25",
        isOverlay && "w-[304px] rotate-1 border-primary/50 shadow-xl",
      )}
    >
      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="mt-[-0.2rem] h-7 w-6 shrink-0 cursor-grab touch-none text-muted-foreground opacity-60 hover:opacity-100 active:cursor-grabbing"
          aria-label={`Drag issue #${issue.number}`}
          disabled={statusPending || isOverlay}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </Button>
        <button
          type="button"
          className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onClick={onOpen}
        >
          <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <CircleDot className="h-3 w-3 text-green-500" />#{issue.number}
          </span>
          <span className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
            {issue.title}
          </span>
        </button>
      </div>

      {issue.labels.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1 pl-8">
          {issue.labels.slice(0, 3).map((label) => (
            <span
              key={label.name}
              className="max-w-[8.5rem] truncate rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                borderColor: `${safeLabelColor(label.color)}66`,
                backgroundColor: `${safeLabelColor(label.color)}18`,
                color: safeLabelColor(label.color),
              }}
              title={label.name}
            >
              {label.name}
            </span>
          ))}
          {issue.labels.length > 3 && (
            <span className="px-1 py-0.5 text-[10px] text-muted-foreground">
              +{issue.labels.length - 3}
            </span>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 pl-8">
        <Select
          value={issue.status}
          onValueChange={(value) => onStatusChange(value as GitHubIssueStatus)}
          disabled={statusPending}
        >
          <SelectTrigger
            size="sm"
            aria-label={`Status for issue #${issue.number}`}
            className="h-7 min-w-0 flex-1 border-border/70 bg-input-surface px-2 text-xs shadow-none"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {GITHUB_WORKFLOW_STAGES.map((stage) => (
              <SelectItem key={stage.id} value={stage.id}>
                <span className={cn("h-2 w-2 rounded-full", stage.color)} />
                {stage.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {issue.commentsCount > 0 && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
            aria-label={`${issue.commentsCount} comments`}
          >
            <MessageSquare className="h-3 w-3" />
            {issue.commentsCount}
          </span>
        )}
        {issue.assignees.length > 0 && (
          <span
            className="inline-flex items-center text-muted-foreground"
            title={issue.assignees.map((assignee) => assignee.login).join(", ")}
            aria-label={`Assigned to ${issue.assignees.map((assignee) => assignee.login).join(", ")}`}
          >
            <UserRound className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </article>
  );
}
