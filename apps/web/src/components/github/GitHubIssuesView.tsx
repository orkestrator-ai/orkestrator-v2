import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  AlertCircle,
  Github,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useGitHubIssuesStore } from "@/stores/githubIssuesStore";
import type { GitHubIssue, GitHubIssueStatus } from "@/types/github";
import {
  GITHUB_WORKFLOW_STAGES,
  GitHubIssueCard,
  getGitHubStageLabel,
} from "./GitHubIssueCard";
import { GitHubIssueDetail } from "./GitHubIssueDetail";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function GitHubIssueColumn({
  stage,
  issues,
  projectId,
  onOpen,
  onStatusChange,
}: {
  stage: (typeof GITHUB_WORKFLOW_STAGES)[number];
  issues: GitHubIssue[];
  projectId: string;
  onOpen: (issue: GitHubIssue) => void;
  onStatusChange: (issue: GitHubIssue, status: GitHubIssueStatus) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `github-stage:${stage.id}`,
    data: { type: "github-stage", status: stage.id },
  });
  const mutations = useGitHubIssuesStore((state) => state.mutations);

  return (
    <section className="flex h-full w-[calc(100vw-1.5rem)] min-w-[270px] shrink-0 snap-center flex-col sm:w-[320px] sm:min-w-[290px]">
      <div className="mb-2 flex items-center gap-2 px-2 py-2">
        <span className={cn("h-2.5 w-2.5 rounded-full", stage.color)} />
        <h3 className="text-sm font-semibold text-foreground">{stage.label}</h3>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          {issues.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "relative min-h-52 flex-1 overflow-y-auto rounded-xl border border-border/50 bg-gradient-to-b to-transparent p-2 transition-[background-color,border-color]",
          stage.wash,
          isOver && "border-primary/50 bg-primary/10",
        )}
      >
        <div className="space-y-2">
          {issues.map((issue) => (
            <GitHubIssueCard
              key={issue.id}
              issue={issue}
              onOpen={() => onOpen(issue)}
              onStatusChange={(status) => onStatusChange(issue, status)}
              statusPending={mutations.has(
                `status:${projectId}:${issue.number}`,
              )}
            />
          ))}
        </div>
        {issues.length === 0 && (
          <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground">
            Drop an issue here
          </div>
        )}
      </div>
    </section>
  );
}

interface GitHubIssuesViewProps {
  projectId: string;
}

export function GitHubIssuesView({ projectId }: GitHubIssuesViewProps) {
  const snapshot = useGitHubIssuesStore((state) => state.snapshots.get(projectId));
  const loading = useGitHubIssuesStore((state) =>
    state.loadingProjects.has(projectId),
  );
  const loadError = useGitHubIssuesStore((state) =>
    state.projectErrors.get(projectId),
  );
  const mutationErrors = useGitHubIssuesStore((state) => state.mutationErrors);
  const statusMutating = useGitHubIssuesStore((state) =>
    Array.from(state.mutations).some((key) =>
      key.startsWith(`status:${projectId}:`),
    ),
  );
  const loadIssues = useGitHubIssuesStore((state) => state.loadIssues);
  const changeStatus = useGitHubIssuesStore((state) => state.changeStatus);
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(
    null,
  );
  const [activeIssueNumber, setActiveIssueNumber] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    setSelectedIssueNumber(null);
    setActiveIssueNumber(null);
    void loadIssues(projectId);
  }, [loadIssues, projectId]);

  const issuesByStage = useMemo(() => {
    const grouped: Record<GitHubIssueStatus, GitHubIssue[]> = {
      backlog: [],
      todo: [],
      inprogress: [],
      review: [],
    };
    for (const issue of snapshot?.issues ?? []) {
      grouped[issue.status].push(issue);
    }
    return grouped;
  }, [snapshot?.issues]);

  const activeIssue = useMemo(
    () =>
      activeIssueNumber === null
        ? undefined
        : snapshot?.issues.find((issue) => issue.number === activeIssueNumber),
    [activeIssueNumber, snapshot?.issues],
  );
  const selectedSummary =
    selectedIssueNumber === null
      ? undefined
      : snapshot?.issues.find((issue) => issue.number === selectedIssueNumber);
  const statusMutationError = Array.from(mutationErrors)
    .filter(([key]) => key.startsWith(`status:${projectId}:`))
    .at(-1)?.[1];

  const handleStatusChange = useCallback(
    async (issue: GitHubIssue, status: GitHubIssueStatus) => {
      if (issue.status === status) return;
      try {
        await changeStatus(projectId, issue.number, status);
        toast.success(`Moved #${issue.number} to ${getGitHubStageLabel(status)}`);
      } catch (error) {
        toast.error("Status change failed", {
          description: errorMessage(
            error,
            "The issue was reloaded from GitHub. Try again.",
          ),
        });
      }
    },
    [changeStatus, projectId],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const issueNumber = event.active.data.current?.issueNumber;
    setActiveIssueNumber(typeof issueNumber === "number" ? issueNumber : null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveIssueNumber(null);
      const issueNumber = event.active.data.current?.issueNumber;
      const destination = event.over?.data.current?.status;
      if (typeof issueNumber !== "number" || typeof destination !== "string") {
        return;
      }
      const issue = snapshot?.issues.find(
        (candidate) => candidate.number === issueNumber,
      );
      if (!issue) return;
      void handleStatusChange(issue, destination as GitHubIssueStatus);
    },
    [handleStatusChange, snapshot?.issues],
  );

  if (selectedIssueNumber !== null && snapshot) {
    return (
      <GitHubIssueDetail
        projectId={projectId}
        repository={snapshot.repository}
        issueNumber={selectedIssueNumber}
        summary={selectedSummary}
        onBack={() => setSelectedIssueNumber(null)}
        onClosed={() => setSelectedIssueNumber(null)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-3 sm:px-6 sm:py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
          <Github className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-foreground">
            {snapshot?.repository.fullName ?? "GitHub Issues"}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {snapshot
              ? `${snapshot.issues.length} open issue${snapshot.issues.length === 1 ? "" : "s"} · signed in as @${snapshot.viewer.login}`
              : "Open issues for this project repository"}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || statusMutating}
          onClick={() => void loadIssues(projectId)}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </header>

      {(loadError || statusMutationError) && (
        <div className="mx-3 mt-3 flex shrink-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive sm:mx-6">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p>{loadError ?? statusMutationError}</p>
            {loadError && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={loading || statusMutating}
                onClick={() => void loadIssues(projectId)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            )}
          </div>
        </div>
      )}

      {!snapshot && loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading open issues
        </div>
      ) : !snapshot && loadError ? (
        <div className="flex-1" />
      ) : snapshot?.issues.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-sm rounded-xl border border-dashed border-border p-8 text-center">
            <Github className="mx-auto h-7 w-7 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">No open issues</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              New open issues from {snapshot.repository.fullName} will appear here
              after refresh.
            </p>
          </div>
        </div>
      ) : snapshot ? (
        <div className="min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto p-3 sm:p-6">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragCancel={() => setActiveIssueNumber(null)}
            onDragEnd={handleDragEnd}
            accessibility={{
              announcements: {
                onDragStart({ active }) {
                  const issueNumber = active.data.current?.issueNumber;
                  return `Picked up GitHub issue ${issueNumber ?? ""}`;
                },
                onDragOver({ active, over }) {
                  const issueNumber = active.data.current?.issueNumber;
                  const status = over?.data.current?.status as
                    | GitHubIssueStatus
                    | undefined;
                  return status
                    ? `Issue ${issueNumber ?? ""} is over ${getGitHubStageLabel(status)}`
                    : `Issue ${issueNumber ?? ""} is no longer over a stage`;
                },
                onDragEnd({ active, over }) {
                  const issueNumber = active.data.current?.issueNumber;
                  const status = over?.data.current?.status as
                    | GitHubIssueStatus
                    | undefined;
                  return status
                    ? `Moved issue ${issueNumber ?? ""} to ${getGitHubStageLabel(status)}`
                    : `Stopped moving issue ${issueNumber ?? ""}`;
                },
                onDragCancel({ active }) {
                  return `Cancelled moving issue ${active.data.current?.issueNumber ?? ""}`;
                },
              },
            }}
          >
            <div className="flex h-full gap-3 sm:gap-4">
              {GITHUB_WORKFLOW_STAGES.map((stage) => (
                <GitHubIssueColumn
                  key={stage.id}
                  stage={stage}
                  issues={issuesByStage[stage.id]}
                  projectId={projectId}
                  onOpen={(issue) => setSelectedIssueNumber(issue.number)}
                  onStatusChange={(issue, status) =>
                    void handleStatusChange(issue, status)
                  }
                />
              ))}
            </div>
            <DragOverlay dropAnimation={null}>
              {activeIssue && (
                <GitHubIssueCard
                  issue={activeIssue}
                  onOpen={() => {}}
                  onStatusChange={() => {}}
                  isOverlay
                />
              )}
            </DragOverlay>
          </DndContext>
        </div>
      ) : null}
    </div>
  );
}
