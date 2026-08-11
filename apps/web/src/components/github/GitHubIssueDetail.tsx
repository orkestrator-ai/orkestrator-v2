import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Container,
  ExternalLink,
  FolderGit2,
  Loader2,
  MessageSquare,
  Pencil,
  RefreshCw,
  Save,
  Send,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { useBuildPipeline } from "@/hooks/useBuildPipeline";
import { useDurableComposeDraft } from "@/hooks/useDurableComposeDraft";
import {
  openInBrowser,
  retryBuildPipelineCompletionComment,
} from "@/lib/backend";
import {
  githubIssueDetailKey,
  useGitHubIssuesStore,
} from "@/stores/githubIssuesStore";
import {
  useBuildPipelineStore,
  type BuildPipeline,
} from "@/stores/buildPipelineStore";
import type { EnvironmentType } from "@/types";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueStatus,
  GitHubRepository,
} from "@/types/github";
import {
  GITHUB_WORKFLOW_STAGES,
  getGitHubStageLabel,
} from "./GitHubIssueCard";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import { useLocalEnvironmentAvailable } from "@/hooks/useLocalEnvironmentAvailable";

function formatGitHubDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

const isStringDraft = (value: unknown): value is string => typeof value === "string";
const isBlankDraft = (value: string): boolean => value.length === 0;

function findIssuePipelines(
  pipelines: Map<string, BuildPipeline>,
  repository: GitHubRepository,
  issueNumber: number,
): BuildPipeline[] {
  return Array.from(pipelines.values())
    .filter((pipeline) => {
      const source = pipeline.source;
      return (
        source?.type === "github" &&
        source.repositoryOwner.toLowerCase() === repository.owner.toLowerCase() &&
        source.repositoryName.toLowerCase() === repository.name.toLowerCase() &&
        source.issueNumber === issueNumber
      );
    })
    .sort((left, right) => {
      const activeDelta =
        Number(right.phase !== "complete" && right.phase !== "failed") -
        Number(left.phase !== "complete" && left.phase !== "failed");
      return activeDelta || right.createdAt.localeCompare(left.createdAt);
    });
}

function GitHubComment({
  projectId,
  issueNumber,
  comment,
}: {
  projectId: string;
  issueNumber: number;
  comment: GitHubIssueComment;
}) {
  const editComment = useGitHubIssuesStore((state) => state.editComment);
  const mutations = useGitHubIssuesStore((state) => state.mutations);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft, clearDraft] = useDurableComposeDraft({
    ownerType: "project",
    ownerId: projectId,
    namespace: "github-comment-edit",
    localKey: String(comment.id),
    initialValue: comment.body,
    isEmpty: isBlankDraft,
    isValid: isStringDraft,
    enabled: editing,
  });
  const [error, setError] = useState<string | null>(null);
  const mutationKey = `comment-edit:${projectId}:${comment.id}`;
  const saving = mutations.has(mutationKey);

  useEffect(() => {
    if (!editing) setDraft(comment.body);
  }, [comment.body, editing]);

  const handleSave = async () => {
    const body = draft.trim();
    if (!body || saving) return;
    setError(null);
    try {
      await editComment(projectId, issueNumber, comment.id, body);
      void clearDraft().catch((clearError) => {
        console.warn("[GitHubComment] Failed to clear saved edit draft:", clearError);
      });
      setEditing(false);
      toast.success("Comment updated");
    } catch (saveError) {
      setError(errorMessage(saveError, "Could not save the comment."));
    }
  };

  return (
    <article className="rounded-lg border border-border/60 bg-card/40">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-xs">
        <span className="font-medium text-foreground">
          {comment.author?.login ?? "Ghost"}
        </span>
        <span className="text-muted-foreground">{formatGitHubDate(comment.createdAt)}</span>
        {comment.isEdited && <span className="text-muted-foreground">(edited)</span>}
        {comment.canEdit && !editing && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs"
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
        )}
      </div>
      <div className="p-3">
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error) setError(null);
              }}
              aria-label={`Edit comment by ${comment.author?.login ?? "unknown author"}`}
              className="min-h-28 resize-y"
              disabled={saving}
            />
            {error && (
              <div className="flex items-start gap-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void clearDraft().catch(() => undefined);
                  setError(null);
                  setEditing(false);
                }}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !draft.trim()}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save comment
              </Button>
            </div>
          </div>
        ) : (
          <MessageMarkdown content={comment.body} />
        )}
      </div>
    </article>
  );
}

interface GitHubIssueDetailProps {
  projectId: string;
  repository: GitHubRepository;
  issueNumber: number;
  summary?: GitHubIssue;
  onBack: () => void;
  onClosed: () => void;
}

type GitHubBuildActions = Pick<
  ReturnType<typeof useBuildPipeline>,
  "startBuildFromGitHubIssue" | "navigateToPipeline"
>;

interface GitHubIssueDetailContentProps extends GitHubIssueDetailProps {
  buildPipeline: GitHubBuildActions;
}

export function GitHubIssueDetail(props: GitHubIssueDetailProps) {
  const buildPipeline = useBuildPipeline();
  return <GitHubIssueDetailContent {...props} buildPipeline={buildPipeline} />;
}

export function GitHubIssueDetailContent({
  projectId,
  repository,
  issueNumber,
  summary,
  onBack,
  onClosed,
  buildPipeline,
}: GitHubIssueDetailContentProps) {
  const dockerAvailable = useDockerAvailability();
  const localEnvironmentAvailable = useLocalEnvironmentAvailable(projectId);
  const key = githubIssueDetailKey(projectId, issueNumber);
  const detail = useGitHubIssuesStore((state) => state.details.get(key));
  const loading = useGitHubIssuesStore((state) => state.loadingDetails.has(key));
  const loadError = useGitHubIssuesStore((state) => state.detailErrors.get(key));
  const loadIssue = useGitHubIssuesStore((state) => state.loadIssue);
  const saveIssue = useGitHubIssuesStore((state) => state.saveIssue);
  const closeIssue = useGitHubIssuesStore((state) => state.closeIssue);
  const changeStatus = useGitHubIssuesStore((state) => state.changeStatus);
  const addComment = useGitHubIssuesStore((state) => state.addComment);
  const mutations = useGitHubIssuesStore((state) => state.mutations);
  const mutationErrors = useGitHubIssuesStore((state) => state.mutationErrors);

  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const replacePipeline = useBuildPipelineStore(
    (state) => state.replacePipeline,
  );
  const { startBuildFromGitHubIssue, navigateToPipeline } = buildPipeline;

  const [editing, setEditing] = useState(false);
  const issueDraftKey = `${repository.owner}/${repository.name}#${issueNumber}`;
  const [titleDraft, setTitleDraft, clearTitleDraft] = useDurableComposeDraft({
    ownerType: "project",
    ownerId: projectId,
    namespace: "github-issue-title",
    localKey: issueDraftKey,
    initialValue: detail?.title ?? summary?.title ?? "",
    isEmpty: isBlankDraft,
    isValid: isStringDraft,
    enabled: editing,
  });
  const [bodyDraft, setBodyDraft, clearBodyDraft] = useDurableComposeDraft({
    ownerType: "project",
    ownerId: projectId,
    namespace: "github-issue-body",
    localKey: issueDraftKey,
    initialValue: detail?.body ?? summary?.body ?? "",
    isEmpty: isBlankDraft,
    isValid: isStringDraft,
    enabled: editing,
  });
  const [editError, setEditError] = useState<string | null>(null);
  const [commentDraft, setCommentDraft, clearCommentDraft] = useDurableComposeDraft({
    ownerType: "project",
    ownerId: projectId,
    namespace: "github-comment",
    localKey: `${repository.owner}/${repository.name}#${issueNumber}`,
    initialValue: "",
    isEmpty: isBlankDraft,
    isValid: isStringDraft,
  });
  const [commentError, setCommentError] = useState<string | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [startingType, setStartingType] = useState<EnvironmentType | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [retryingCompletionIds, setRetryingCompletionIds] = useState<Set<string>>(
    () => new Set(),
  );

  const displayedIssue = detail ?? summary;
  const editKey = `edit:${projectId}:${issueNumber}`;
  const closeKey = `close:${projectId}:${issueNumber}`;
  const statusKey = `status:${projectId}:${issueNumber}`;
  const commentKey = `comment-add:${projectId}:${issueNumber}`;
  const saving = mutations.has(editKey);
  const closing = mutations.has(closeKey);
  const changingStatus = mutations.has(statusKey);
  const postingComment = mutations.has(commentKey);
  const statusError = mutationErrors.get(statusKey);
  const issuePipelines = useMemo(
    () => findIssuePipelines(pipelines, repository, issueNumber),
    [issueNumber, pipelines, repository],
  );
  const selectedPipeline = issuePipelines[0];
  const failedCompletionPipelines = issuePipelines.filter(
    (pipeline) => pipeline.completionCommentStatus === "failed",
  );
  const activePipeline =
    selectedPipeline &&
    selectedPipeline.phase !== "complete" &&
    selectedPipeline.phase !== "failed"
      ? selectedPipeline
      : undefined;

  useEffect(() => {
    void loadIssue(projectId, issueNumber);
  }, [issueNumber, loadIssue, projectId]);

  useEffect(() => {
    if (!detail || editing) return;
    setTitleDraft(detail.title);
    setBodyDraft(detail.body);
  }, [detail, editing]);

  const handleSave = async () => {
    if (!detail || saving || !titleDraft.trim()) return;
    setEditError(null);
    try {
      await saveIssue(projectId, issueNumber, {
        title: titleDraft.trim(),
        body: bodyDraft,
      });
      void Promise.all([clearTitleDraft(), clearBodyDraft()]).catch((clearError) => {
        console.warn("[GitHubIssueDetail] Failed to clear saved issue drafts:", clearError);
      });
      setEditing(false);
      toast.success("Issue updated");
    } catch (error) {
      setEditError(errorMessage(error, "Could not save the issue."));
    }
  };

  const handleClose = async () => {
    if (closing) return;
    setCloseError(null);
    try {
      await closeIssue(projectId, issueNumber);
      setCloseOpen(false);
      toast.success(`Issue #${issueNumber} closed`);
      onClosed();
    } catch (error) {
      setCloseError(errorMessage(error, "Could not close the issue."));
    }
  };

  const handleStatusChange = async (status: GitHubIssueStatus) => {
    if (!displayedIssue || status === displayedIssue.status || changingStatus) return;
    try {
      await changeStatus(projectId, issueNumber, status);
      toast.success(`Moved to ${getGitHubStageLabel(status)}`);
    } catch (error) {
      toast.error("Status change failed", {
        description: errorMessage(error, "GitHub could not update this issue."),
      });
    }
  };

  const handleAddComment = async () => {
    const body = commentDraft.trim();
    if (!detail || !body || postingComment) return;
    setCommentError(null);
    try {
      await addComment(projectId, issueNumber, body);
      void clearCommentDraft().catch((error) => {
        console.warn("[GitHubIssueDetail] Failed to clear posted comment draft:", error);
      });
      toast.success("Comment added");
    } catch (error) {
      setCommentError(errorMessage(error, "Could not add the comment."));
    }
  };

  const handleStartBuild = async (environmentType: EnvironmentType) => {
    if (!detail || activePipeline || startingType) return;
    if (environmentType === "containerized" && !dockerAvailable) return;
    if (environmentType === "local" && !localEnvironmentAvailable) return;
    setStartingType(environmentType);
    setBuildError(null);
    try {
      const pipelineId = await startBuildFromGitHubIssue(
        {
          repositoryOwner: repository.owner,
          repositoryName: repository.name,
          number: detail.number,
          url: detail.htmlUrl,
          title: detail.title,
          body: detail.body,
          labels: detail.labels.map((label) => label.name),
          status: detail.status,
          comments: detail.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            authorLogin: comment.author?.login,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
          })),
          authorLogin: detail.author?.login,
          assigneeLogins: detail.assignees.map((assignee) => assignee.login),
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
        },
        projectId,
        environmentType,
      );
      if (!pipelineId) {
        setBuildError("The build pipeline could not be started. Review the error details and try again.");
      }
    } catch (error) {
      setBuildError(errorMessage(error, "Could not start the build."));
    } finally {
      setStartingType(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-3 sm:px-6">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Back to GitHub issues"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {repository.fullName}#{issueNumber}
            </span>
            {displayedIssue && <span>{getGitHubStageLabel(displayedIssue.status)}</span>}
          </div>
          <h2 className="truncate text-base font-semibold text-foreground sm:text-lg">
            {displayedIssue?.title ?? `Issue #${issueNumber}`}
          </h2>
        </div>
        {displayedIssue && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void openInBrowser(displayedIssue.htmlUrl)}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Open on GitHub</span>
          </Button>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-5xl space-y-5 p-3 sm:p-6">
          {loading && !detail && (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading issue and discussion
            </div>
          )}

          {loadError && !detail && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{loadError}</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => void loadIssue(projectId, issueNumber)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          )}

          {detail && (
            <>
              {statusError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{statusError}</span>
                </div>
              )}

              <section className="rounded-xl border border-border/70 bg-card/30">
                <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
                  <Select
                    value={detail.status}
                    onValueChange={(value) =>
                      void handleStatusChange(value as GitHubIssueStatus)
                    }
                    disabled={changingStatus}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="Issue status"
                      className="w-36 bg-background/60"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {GITHUB_WORKFLOW_STAGES.map((stage) => (
                        <SelectItem key={stage.id} value={stage.id}>
                          <span className={`h-2 w-2 rounded-full ${stage.color}`} />
                          {stage.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {!editing ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      onClick={() => {
                        setTitleDraft(detail.title);
                        setBodyDraft(detail.body);
                        setEditError(null);
                        setEditing(true);
                      }}
                      disabled={saving || closing}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit issue
                    </Button>
                  ) : (
                    <div className="ml-auto flex gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        onClick={() => {
                          void Promise.all([clearTitleDraft(), clearBodyDraft()])
                            .catch(() => undefined);
                          setEditError(null);
                          setEditing(false);
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={saving || !titleDraft.trim()}
                        onClick={() => void handleSave()}
                      >
                        {saving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )}
                        Save changes
                      </Button>
                    </div>
                  )}
                </div>

                <div className="space-y-4 p-4">
                  {editing ? (
                    <>
                      <Input
                        value={titleDraft}
                        onChange={(event) => {
                          setTitleDraft(event.target.value);
                          if (editError) setEditError(null);
                        }}
                        aria-label="Issue title"
                        disabled={saving}
                        className="text-base font-medium"
                      />
                      <Textarea
                        value={bodyDraft}
                        onChange={(event) => {
                          setBodyDraft(event.target.value);
                          if (editError) setEditError(null);
                        }}
                        aria-label="Issue body"
                        disabled={saving}
                        className="min-h-56 resize-y font-mono text-sm"
                        placeholder="Add a Markdown description"
                      />
                      {editError && (
                        <div className="flex items-start gap-2 text-sm text-destructive">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{editError}</span>
                        </div>
                      )}
                    </>
                  ) : detail.body ? (
                    <MessageMarkdown content={detail.body} />
                  ) : (
                    <p className="text-sm text-muted-foreground">No description provided.</p>
                  )}
                </div>
              </section>

              <section className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="mb-1 text-xs text-muted-foreground">Author</div>
                  <div className="flex items-center gap-1.5">
                    <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
                    {detail.author?.login ?? "Ghost"}
                  </div>
                </div>
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="mb-1 text-xs text-muted-foreground">Assignees</div>
                  <div>
                    {detail.assignees.length
                      ? detail.assignees.map((assignee) => assignee.login).join(", ")
                      : "Unassigned"}
                  </div>
                </div>
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="mb-1 text-xs text-muted-foreground">Created</div>
                  <div>{formatGitHubDate(detail.createdAt)}</div>
                </div>
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="mb-1 text-xs text-muted-foreground">Updated</div>
                  <div>{formatGitHubDate(detail.updatedAt)}</div>
                </div>
                {detail.labels.length > 0 && (
                  <div className="rounded-lg border border-border/60 p-3 sm:col-span-2 lg:col-span-4">
                    <div className="mb-2 text-xs text-muted-foreground">Labels</div>
                    <div className="flex flex-wrap gap-1.5">
                      {detail.labels.map((label) => (
                        <span
                          key={label.name}
                          className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs"
                          title={label.description}
                        >
                          {label.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <Separator />

              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Discussion</h3>
                  <span className="text-xs text-muted-foreground">
                    {detail.comments.length}
                  </span>
                </div>
                {detail.comments.length ? (
                  detail.comments.map((comment) => (
                    <GitHubComment
                      key={comment.id}
                      projectId={projectId}
                      issueNumber={issueNumber}
                      comment={comment}
                    />
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                    No comments yet.
                  </div>
                )}
                <div className="space-y-2 rounded-lg border border-border/60 bg-card/30 p-3">
                  <Textarea
                    value={commentDraft}
                    onChange={(event) => {
                      setCommentDraft(event.target.value);
                      if (commentError) setCommentError(null);
                    }}
                    aria-label="Add GitHub comment"
                    placeholder="Add to the discussion"
                    className="min-h-28 resize-y"
                    disabled={postingComment}
                  />
                  {commentError && (
                    <div className="flex items-start gap-2 text-sm text-destructive">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{commentError}</span>
                    </div>
                  )}
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      disabled={postingComment || !commentDraft.trim()}
                      onClick={() => void handleAddComment()}
                    >
                      {postingComment ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                      Comment
                    </Button>
                  </div>
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Build from this issue</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    The issue and current discussion are copied into the build context.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!dockerAvailable || !!startingType || !!activePipeline}
                    title={!dockerAvailable ? "Start Docker to run a container build" : undefined}
                    onClick={() => void handleStartBuild("containerized")}
                  >
                    {startingType === "containerized" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Container className="h-3.5 w-3.5" />
                    )}
                    Build Container
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!localEnvironmentAvailable || !!startingType || !!activePipeline}
                    title={
                      !localEnvironmentAvailable
                        ? "Add a local project checkout to run a local build"
                        : undefined
                    }
                    onClick={() => void handleStartBuild("local")}
                  >
                    {startingType === "local" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FolderGit2 className="h-3.5 w-3.5" />
                    )}
                    Build Local
                  </Button>
                  {selectedPipeline?.environmentId && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void navigateToPipeline(selectedPipeline)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View Build
                    </Button>
                  )}
                  {selectedPipeline && (
                    <span className="text-xs text-muted-foreground">
                      Build phase: {selectedPipeline.phase}
                    </span>
                  )}
                  {activePipeline && (
                    <span className="text-xs text-muted-foreground">
                      A build is already active for this issue.
                    </span>
                  )}
                </div>
                {buildError && (
                  <div className="flex items-start gap-2 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{buildError}</span>
                  </div>
                )}
                {failedCompletionPipelines.map((pipeline) => (
                  <div
                    key={pipeline.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3"
                  >
                    <span className="min-w-0 flex-1 text-xs text-destructive">
                      GitHub completion comment failed for build{" "}
                      {formatGitHubDate(pipeline.createdAt)}:{" "}
                      {pipeline.completionCommentError}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Retry completion comment for build ${pipeline.id}`}
                      disabled={retryingCompletionIds.has(pipeline.id)}
                      onClick={async () => {
                        if (retryingCompletionIds.has(pipeline.id)) return;
                        setRetryingCompletionIds((current) =>
                          new Set(current).add(pipeline.id));
                        try {
                          replacePipeline(
                            await retryBuildPipelineCompletionComment(pipeline.id),
                          );
                        } catch (error) {
                          toast.error("Failed to retry GitHub completion comment", {
                            description: errorMessage(
                              error,
                              "The completion comment could not be retried.",
                            ),
                          });
                        } finally {
                          setRetryingCompletionIds((current) => {
                            const next = new Set(current);
                            next.delete(pipeline.id);
                            return next;
                          });
                        }
                      }}
                    >
                      {retryingCompletionIds.has(pipeline.id) ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      {retryingCompletionIds.has(pipeline.id)
                        ? "Retrying…"
                        : "Retry comment"}
                    </Button>
                  </div>
                ))}
                {selectedPipeline?.completionCommentStatus === "posting" && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Posting completion comment
                  </span>
                )}
                {selectedPipeline?.completionCommentStatus === "posted" && (
                  <span className="inline-flex items-center gap-1 text-xs text-green-500">
                    <Check className="h-3 w-3" />
                    Completion comment posted
                  </span>
                )}
              </section>

              <Separator />

              <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/20 p-4">
                <div>
                  <h3 className="text-sm font-medium">Close this issue</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Closed issues leave this open-issue board.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={closing || saving}
                  onClick={() => {
                    setCloseError(null);
                    setCloseOpen(true);
                  }}
                >
                  {closing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  Close Issue
                </Button>
              </section>
            </>
          )}
        </div>
      </ScrollArea>

      <AlertDialog open={closeOpen} onOpenChange={setCloseOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close issue #{issueNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              This closes the issue on GitHub and removes it from the open-issue
              board. It does not change or stop any builds.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {closeError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{closeError}</span>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={closing}
              onClick={(event) => {
                event.preventDefault();
                void handleClose();
              }}
            >
              {closing && <Loader2 className="h-4 w-4 animate-spin" />}
              Close Issue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
