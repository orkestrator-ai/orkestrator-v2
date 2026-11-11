import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Columns3,
  List,
  CalendarClock,
  Check,
  ExternalLink,
  Hammer,
  Link2,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  Unlink,
  Unplug,
} from "lucide-react";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { BuildLaunchDialog, type BuildLaunchSelection } from "@/components/build/BuildLaunchDialog";
import { useBuildLaunchOptions } from "@/hooks/useBuildLaunchOptions";
import { useBuildPipeline } from "@/hooks/useBuildPipeline";
import { useDurableComposeDraft } from "@/hooks/useDurableComposeDraft";
import { composeDraftKey, discardComposeDraft } from "@/lib/compose-draft-persistence";
import { useNodeScope, useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import {
  buildPipelineStore,
  useBuildPipelineStore,
  type BuildPipeline,
} from "@/stores/buildPipelineStore";
import { useLocalEnvironmentAvailable } from "@/hooks/useLocalEnvironmentAvailable";
import { openInBrowser } from "@/lib/backend";
import { cn } from "@/lib/utils";
import type {
  LinearBoardLink,
  LinearConnectionStatus,
  LinearIssueComment,
  LinearIssueDetail,
  LinearIssueListItem,
  LinearNodeConnection,
  LinearWorkflowState,
} from "@/types/linear";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { LinearBoardPicker, linearBoardName } from "./LinearBoardPicker";
import { LinearConnectDialog } from "./LinearConnectDialog";
import { LinearUseConnectionNotice } from "./LinearUseConnectionNotice";
import {
  type LinearLane,
  buildLinearLanes,
  buildStatusOrder,
  compareIssueOrder,
  compareStatusOrder,
  type IssueOrder,
} from "./linear-issue-order";
import { LinearIssueBoard, LinearLanesMenu } from "./LinearIssueBoard";
import {
  DEFAULT_LINEAR_PROJECT_VIEW,
  useLinearViewPreferencesStore,
  type LinearIssueView,
} from "@/stores/linearViewPreferencesStore";

const log = createLogger("web.linear");

interface LinearTicketsViewProps {
  projectId: string;
}

type LinearBuildPipelineActions = Pick<
  ReturnType<typeof useBuildPipeline>,
  "startBuildFromLinearIssue" | "navigateToPipeline"
>;

interface LinearTicketsViewContentProps extends LinearTicketsViewProps {
  buildPipeline: LinearBuildPipelineActions;
}

type LoadState = "idle" | "loading" | "loaded" | "error";
/**
 * The project's Linear board: `unsupported` is a node from before board
 * links, which lists every issue the key can see, as it always did.
 */
type BoardState = "unknown" | "linked" | "unlinked" | "unsupported";

const isStringDraft = (value: unknown): value is string => typeof value === "string";
const isBlankDraft = (value: string): boolean => value.length === 0;

function formatUpdatedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** Whether `seen` is a strictly later `updatedAt` than `answered`; unknown times are not. */
function readAfter(seen: string | undefined, answered: string | undefined): boolean {
  if (!seen || !answered) return false;
  const a = Date.parse(seen);
  const b = Date.parse(answered);
  return !Number.isNaN(a) && !Number.isNaN(b) && a > b;
}

function getIssuePipeline(
  pipelines: Map<string, BuildPipeline>,
  issueId: string,
): BuildPipeline | undefined {
  const matches = Array.from(pipelines.values()).filter(
    (pipeline) => pipeline.source?.type === "linear" && pipeline.source.issueId === issueId,
  );
  matches.sort((a, b) => {
    const activeDelta = Number(isActivePipeline(b)) - Number(isActivePipeline(a));
    if (activeDelta !== 0) return activeDelta;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return matches[0];
}

function isActivePipeline(pipeline: BuildPipeline | undefined): boolean {
  return !!pipeline && !["complete", "failed"].includes(pipeline.phase);
}

function IssueMetadata({ issue }: { issue: LinearIssueListItem | LinearIssueDetail }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{issue.identifier}</span>
      <span>{issue.status}</span>
      {issue.teamKey && <span>{issue.teamKey}</span>}
      {issue.assigneeName && <span>{issue.assigneeName}</span>}
      {issue.priorityLabel && <span>{issue.priorityLabel}</span>}
      <span className="inline-flex items-center gap-1">
        <CalendarClock className="h-3 w-3" />
        {formatUpdatedDate(issue.updatedAt)}
      </span>
    </div>
  );
}

function LinearCommentItem({ comment }: { comment: LinearIssueComment }) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {comment.authorName ?? "Unknown author"}
        </span>
        <span>{formatUpdatedDate(comment.createdAt)}</span>
      </div>
      <div className="min-w-0 text-sm">
        <MessageMarkdown content={comment.body} />
      </div>
    </div>
  );
}

export function LinearTicketsView({ projectId }: LinearTicketsViewProps) {
  const buildPipeline = useBuildPipeline();
  return <LinearTicketsViewContent projectId={projectId} buildPipeline={buildPipeline} />;
}

export function LinearTicketsViewContent({
  projectId,
  buildPipeline,
}: LinearTicketsViewContentProps) {
  const nodeBackend = useScopeBackend();
  const onCommandNode = useScopesWithCommandFallback().scope.role === "command";
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [boardLink, setBoardLink] = useState<LinearBoardLink | null>(null);
  const [boardState, setBoardState] = useState<BoardState>("unknown");
  const [changingBoard, setChangingBoard] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [nodeConnections, setNodeConnections] = useState<LinearNodeConnection[]>([]);
  const [copyingFrom, setCopyingFrom] = useState<string | null>(null);
  // Both start loading: the first load begins on mount.
  const [connectionState, setConnectionState] = useState<LoadState>("loading");
  const [issues, setIssues] = useState<LinearIssueListItem[]>([]);
  /** The linked board's workflow states: the board view's lanes, empty ones included. */
  const [boardStates, setBoardStates] = useState<LinearWorkflowState[]>([]);
  const viewPreference =
    useLinearViewPreferencesStore((state) => state.projects[projectId]) ??
    DEFAULT_LINEAR_PROJECT_VIEW;
  const setView = useLinearViewPreferencesStore((state) => state.setView);
  const setLaneHidden = useLinearViewPreferencesStore((state) => state.setLaneHidden);
  const showAllLanes = useLinearViewPreferencesStore((state) => state.showAllLanes);
  const issueView: LinearIssueView = viewPreference.view;
  const hiddenLanes = useMemo(
    () => new Set(viewPreference.hiddenLanes),
    [viewPreference.hiddenLanes],
  );
  const [issuesState, setIssuesState] = useState<LoadState>("loading");
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set());
  const [issueOrder, setIssueOrder] = useState<IssueOrder>("manual");
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LinearIssueDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [buildDialogOpen, setBuildDialogOpen] = useState(false);
  const [isBuildStarting, setIsBuildStarting] = useState(false);
  const [retryingCompletionComment, setRetryingCompletionComment] = useState(false);
  const [commentBody, setCommentBody, clearCommentDraft] = useDurableComposeDraft({
    ownerType: "project",
    ownerId: projectId,
    namespace: "linear-comment",
    localKey: selectedIssueId ?? "none",
    initialValue: "",
    isEmpty: isBlankDraft,
    isValid: isStringDraft,
    enabled: selectedIssueId !== null,
  });
  const [commentState, setCommentState] = useState<LoadState>("idle");
  const [commentError, setCommentError] = useState<string | null>(null);
  const connectionRequestRef = useRef(0);
  const issuesRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  /** Bumped whenever a load replaces the issues: a move's rollback is stale after one. */
  const issuesLoadedRef = useRef(0);
  /** Issues with a move in flight; another move of the same issue waits for it to settle. */
  const movingIssuesRef = useRef(new Set<string>());
  const [movingIssueIds, setMovingIssueIds] = useState<ReadonlySet<string>>(() => new Set());
  const buildLaunchTriggerRef = useRef<HTMLButtonElement>(null);
  const selectedIssueIdRef = useRef(selectedIssueId);
  const commentBodyRef = useRef(commentBody);
  const commentEditRevisionsRef = useRef(new Map<string, number>());
  // Read after a comment submission settles, so they track the latest commit.
  useLayoutEffect(() => {
    selectedIssueIdRef.current = selectedIssueId;
    commentBodyRef.current = commentBody;
  }, [selectedIssueId, commentBody]);

  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const pipelineStore = useNodeScope().store(buildPipelineStore);
  const localEnvironmentAvailable = useLocalEnvironmentAvailable(projectId);
  const replacePipeline = useBuildPipelineStore((state) => state.replacePipeline);
  const { startBuildFromLinearIssue, navigateToPipeline } = buildPipeline;
  const { catalog: launchCatalog, defaults: launchDefaults } = useBuildLaunchOptions(
    projectId,
    selectedIssueId !== null,
  );

  /** Callers mark the connection as loading; see `loadIssues`. */
  const loadConnection = useCallback(() => {
    const requestId = connectionRequestRef.current + 1;
    connectionRequestRef.current = requestId;
    return nodeBackend.getLinearConnection().then(
      (status) => {
        if (connectionRequestRef.current !== requestId) return null;
        setConnection(status);
        setConnectionState("loaded");
        return status;
      },
      (error: unknown) => {
        if (connectionRequestRef.current !== requestId) return null;
        setConnection({
          connected: false,
          hasToken: false,
          error: error instanceof Error ? error.message : "Failed to verify Linear connection",
        });
        setConnectionState("error");
        return null;
      },
    );
  }, [nodeBackend]);

  /**
   * On a command node that is not connected: which other machines are, so
   * the tab can offer their connection here. An older node has no answer.
   */
  const loadNodeConnections = useCallback(
    (requestId: number) =>
      nodeBackend.getLinearNodeConnections().then(
        (connections) => {
          if (issuesRequestRef.current === requestId) setNodeConnections(connections);
        },
        () => {
          if (issuesRequestRef.current === requestId) setNodeConnections([]);
        },
      ),
    [nodeBackend],
  );

  /** The project's board link, or `unsupported` on a node from before board links. */
  const fetchBoardLink = useCallback(async (): Promise<{
    link: LinearBoardLink | null;
    state: BoardState;
  }> => {
    try {
      const link = await nodeBackend.getLinearBoardLink(projectId);
      return { link, state: link ? "linked" : "unlinked" };
    } catch (error) {
      if (incompatibility(error, "get_linear_board_link")?.code === "unknown-command") {
        return { link: null, state: "unsupported" };
      }
      throw error;
    }
  }, [nodeBackend, projectId]);

  /** Loads without marking the load as started; `loadIssues` does both. */
  const fetchIssues = useCallback(() => {
    const requestId = issuesRequestRef.current + 1;
    issuesRequestRef.current = requestId;
    return loadConnection()
      .then(async (status) => {
        if (issuesRequestRef.current !== requestId) return;
        if (!status?.connected) {
          issuesLoadedRef.current += 1;
          setIssues([]);
          setIssuesState("loaded");
          if (onCommandNode) void loadNodeConnections(requestId);
          return;
        }
        setNodeConnections([]);
        const board = await fetchBoardLink();
        if (issuesRequestRef.current !== requestId) return;
        setBoardLink(board.link);
        setBoardState(board.state);
        if (board.state === "unlinked") {
          issuesLoadedRef.current += 1;
          setIssues([]);
          setBoardStates([]);
          setIssuesState("loaded");
          return;
        }
        // The board's states give the board view its empty lanes too; without
        // them (an older node, or a failed read) lanes come from the issues.
        const [nextIssues, states] = await Promise.all([
          nodeBackend.getLinearIssues(board.state === "linked" ? projectId : undefined),
          board.state === "linked"
            ? Promise.resolve()
                .then(() => nodeBackend.getLinearBoardOptions(projectId))
                .then(
                  (options) => options.states ?? [],
                  () => [],
                )
            : Promise.resolve([]),
        ]);
        if (issuesRequestRef.current !== requestId) return;
        issuesLoadedRef.current += 1;
        setIssues(nextIssues);
        setBoardStates(states);
        setIssuesState("loaded");
      })
      .catch((error: unknown) => {
        if (issuesRequestRef.current !== requestId) return;
        setIssuesError(error instanceof Error ? error.message : "Failed to load Linear tickets");
        setIssuesState("error");
      });
  }, [fetchBoardLink, loadConnection, loadNodeConnections, nodeBackend, onCommandNode, projectId]);

  const loadIssues = useCallback(() => {
    setIssuesState("loading");
    setIssuesError(null);
    setConnectionState("loading");
    return fetchIssues();
  }, [fetchIssues]);

  // The initial state already shows this first load as loading.
  useEffect(() => {
    void fetchIssues();
  }, [fetchIssues]);

  const statusOrder = useMemo(() => buildStatusOrder(issues), [issues]);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort(([a], [b]) => compareStatusOrder(a, b, statusOrder));
  }, [issues, statusOrder]);

  const filteredIssues = useMemo(() => {
    if (selectedStatuses.size === 0) return issues;
    return issues.filter((issue) => selectedStatuses.has(issue.status));
  }, [issues, selectedStatuses]);

  const groupedIssues = useMemo(() => {
    const groups = new Map<string, LinearIssueListItem[]>();
    const orderedIssues = [...filteredIssues].sort((a, b) => compareIssueOrder(a, b, issueOrder));
    for (const issue of orderedIssues) {
      const group = groups.get(issue.status) ?? [];
      group.push(issue);
      groups.set(issue.status, group);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => compareStatusOrder(a, b, statusOrder));
  }, [filteredIssues, issueOrder, statusOrder]);

  const lanes = useMemo(
    () => buildLinearLanes(issues, boardStates, issueOrder),
    [issues, boardStates, issueOrder],
  );

  /**
   * A card dropped on another lane: show it there at once, move the issue to
   * that lane's workflow state in Linear, and put it back if Linear refuses.
   *
   * One move per issue at a time: the card cannot be dragged again until its
   * move settles, so an earlier answer can never land after a later one. A
   * load that lands meanwhile read Linear after the move began, so it wins
   * over the rollback (the move may have been applied even though its answer
   * failed). Linear's answer to a successful move is applied unless the issue
   * has since been read with a newer `updatedAt`.
   */
  const handleMoveIssue = useCallback(
    async (issue: LinearIssueListItem, to: LinearLane) => {
      if (!to.stateId || movingIssuesRef.current.has(issue.id)) return;
      const setMoving = (moving: boolean) => {
        if (moving) movingIssuesRef.current.add(issue.id);
        else movingIssuesRef.current.delete(issue.id);
        setMovingIssueIds(new Set(movingIssuesRef.current));
      };
      setMoving(true);
      const loadedAtStart = issuesLoadedRef.current;
      const before = {
        status: issue.status,
        statusType: issue.statusType,
        statusPosition: issue.statusPosition,
      };
      const patch = (
        fields: Partial<LinearIssueListItem>,
        applies: (candidate: LinearIssueListItem) => boolean = () => true,
      ) =>
        setIssues((current) =>
          current.map((candidate) =>
            candidate.id === issue.id && applies(candidate)
              ? { ...candidate, ...fields }
              : candidate,
          ),
        );
      patch({ status: to.status, statusType: to.type, statusPosition: to.position });
      try {
        const updated = await nodeBackend.updateLinearIssue(projectId, issue.id, {
          stateId: to.stateId,
        });
        patch(
          {
            status: updated.status ?? to.status,
            statusType: updated.statusType ?? to.type,
            statusPosition: updated.statusPosition ?? to.position,
            ...(updated.updatedAt ? { updatedAt: updated.updatedAt } : {}),
          },
          (candidate) => !readAfter(candidate.updatedAt, updated.updatedAt),
        );
        toast.success(`${issue.identifier} moved to ${to.status}`);
      } catch (error) {
        if (issuesLoadedRef.current === loadedAtStart) {
          patch(before, (candidate) => candidate.status === to.status);
        }
        toast.error(`Could not move ${issue.identifier} to ${to.status}`, {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setMoving(false);
      }
    },
    [nodeBackend, projectId],
  );

  const selectedPipeline = selectedIssueId
    ? getIssuePipeline(pipelines, selectedIssueId)
    : undefined;
  const hasActiveBuild = isActivePipeline(selectedPipeline);
  const selectedIssueSummary = selectedIssueId
    ? issues.find((issue) => issue.id === selectedIssueId)
    : undefined;

  // Reads and comments name the project when it has a board, so the backend
  // refuses an issue that is not on it.
  const boardProjectId = boardState === "linked" ? projectId : undefined;

  const loadDetail = useCallback(
    async (issueId: string) => {
      const requestId = detailRequestRef.current + 1;
      detailRequestRef.current = requestId;
      setDetailState("loading");
      setDetailError(null);
      try {
        const nextDetail = await nodeBackend.getLinearIssue(issueId, boardProjectId);
        if (detailRequestRef.current !== requestId) return;
        setDetail(nextDetail);
        setDetailState("loaded");
        setCommentError(null);
      } catch (error) {
        if (detailRequestRef.current !== requestId) return;
        setDetail(null);
        setDetailError(error instanceof Error ? error.message : "Failed to load Linear ticket");
        setDetailState("error");
      }
    },
    [boardProjectId, nodeBackend],
  );

  const handleSelectIssue = (issueId: string) => {
    setSelectedIssueId(issueId);
    setDetail(null);
    setDetailError(null);
    setCommentError(null);
    setCommentState("idle");
    void loadDetail(issueId);
  };

  const handleBackToList = () => {
    detailRequestRef.current += 1;
    setSelectedIssueId(null);
    setDetail(null);
    setDetailError(null);
    setDetailState("idle");
    setBuildDialogOpen(false);
    setCommentError(null);
    setCommentState("idle");
  };

  const handleToggleStatus = (status: string) => {
    setSelectedStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const handleStartBuild = async (selection: BuildLaunchSelection) => {
    if (!detail) return;
    // A build can be admitted by another tab while this launcher is open. Read
    // the authoritative store again at confirmation time so a stale render can
    // never submit configuration that the backend will discard in favour of the
    // already-active admission.
    const activePipeline = getIssuePipeline(pipelineStore.getState().pipelines, detail.id);
    if (activePipeline && isActivePipeline(activePipeline)) {
      setBuildDialogOpen(false);
      await navigateToPipeline(activePipeline);
      return;
    }
    setBuildDialogOpen(false);
    setIsBuildStarting(true);
    try {
      await startBuildFromLinearIssue(detail, projectId, selection.environmentType, {
        steps: selection.steps,
        reviewers: selection.reviewers,
        reviewPreparation: selection.reviewPreparation,
        includeComments: selection.includeComments ?? true,
        deliveryPolicy: selection.deliveryPolicy,
        networkAccessMode: selection.networkAccessMode,
      });
    } finally {
      setIsBuildStarting(false);
    }
  };

  const handlePostComment = async () => {
    const body = commentBody.trim();
    if (!detail || !body || commentState === "loading") return;
    const submittedIssueId = detail.id;
    const submittedDraftValue = commentBody;
    const submittedEditRevision = commentEditRevisionsRef.current.get(submittedIssueId) ?? 0;

    setCommentState("loading");
    setCommentError(null);
    try {
      const comment = await nodeBackend.postLinearIssueComment(
        submittedIssueId,
        body,
        boardProjectId,
      );
      setDetail((current) => {
        if (!current || current.id !== submittedIssueId) return current;
        return {
          ...current,
          comments: [...current.comments, comment].sort((a, b) =>
            a.createdAt.localeCompare(b.createdAt),
          ),
        };
      });
      const submittedDraftGenerationIsCurrent =
        (commentEditRevisionsRef.current.get(submittedIssueId) ?? 0) === submittedEditRevision;
      const submittedDraftIsCurrent =
        submittedDraftGenerationIsCurrent &&
        (selectedIssueIdRef.current !== submittedIssueId ||
          commentBodyRef.current === submittedDraftValue);
      if (submittedDraftIsCurrent) {
        const clearSubmittedDraft =
          selectedIssueIdRef.current === submittedIssueId
            ? clearCommentDraft()
            : discardComposeDraft(composeDraftKey("linear-comment", projectId, submittedIssueId));
        void clearSubmittedDraft.catch((error) => {
          log.warn("comment-draft.clear-failed", { error: formatLogError(error) });
        });
      }
      if (selectedIssueIdRef.current === submittedIssueId && submittedDraftIsCurrent) {
        setCommentState("loaded");
      }
      toast.success("Linear comment added");
    } catch (error) {
      if (
        selectedIssueIdRef.current === submittedIssueId &&
        (commentEditRevisionsRef.current.get(submittedIssueId) ?? 0) === submittedEditRevision &&
        commentBodyRef.current === submittedDraftValue
      ) {
        setCommentState("error");
        setCommentError(error instanceof Error ? error.message : "Failed to add Linear comment");
      }
    }
  };

  if (selectedIssueId) {
    const issueForHeader = detail ?? selectedIssueSummary;
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex items-center gap-3 border-b border-border px-6 py-4">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Back to Linear tickets"
            onClick={handleBackToList}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-foreground">
              {issueForHeader?.title ?? "Linear Ticket"}
            </h2>
            {issueForHeader && <IssueMetadata issue={issueForHeader} />}
          </div>
          {issueForHeader?.url && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => void openInBrowser(issueForHeader.url!)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </Button>
          )}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-4xl space-y-5 p-6">
            {detailState === "loading" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading ticket
              </div>
            )}

            {detailState === "error" && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4">
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{detailError}</span>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void loadDetail(selectedIssueId)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleBackToList}>
                    Back
                  </Button>
                </div>
              </div>
            )}

            {detail && (
              <>
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">Description</h3>
                  {detail.description ? (
                    <div className="rounded-md border border-border/60 bg-muted/20 p-4">
                      <MessageMarkdown content={detail.description} />
                    </div>
                  ) : (
                    <div className="rounded-md border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
                      No description
                    </div>
                  )}
                </div>

                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="rounded-md border border-border/60 p-3">
                    <div className="text-xs text-muted-foreground">Created</div>
                    <div>{detail.createdAt ? formatUpdatedDate(detail.createdAt) : "Unknown"}</div>
                  </div>
                  <div className="rounded-md border border-border/60 p-3">
                    <div className="text-xs text-muted-foreground">Updated</div>
                    <div>{formatUpdatedDate(detail.updatedAt)}</div>
                  </div>
                  {detail.creatorName && (
                    <div className="rounded-md border border-border/60 p-3">
                      <div className="text-xs text-muted-foreground">Creator</div>
                      <div>{detail.creatorName}</div>
                    </div>
                  )}
                  {detail.projectName && (
                    <div className="rounded-md border border-border/60 p-3">
                      <div className="text-xs text-muted-foreground">Linear Project</div>
                      <div>{detail.projectName}</div>
                    </div>
                  )}
                  {detail.cycleName && (
                    <div className="rounded-md border border-border/60 p-3">
                      <div className="text-xs text-muted-foreground">Cycle</div>
                      <div>{detail.cycleName}</div>
                    </div>
                  )}
                  {detail.labels.length > 0 && (
                    <div className="rounded-md border border-border/60 p-3 sm:col-span-2">
                      <div className="text-xs text-muted-foreground">Labels</div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {detail.labels.map((label) => (
                          <span key={label} className="rounded bg-muted px-2 py-0.5 text-xs">
                            {label}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-medium text-foreground">Comments</h3>
                    <span className="text-xs text-muted-foreground">{detail.comments.length}</span>
                  </div>
                  {detail.comments.length > 0 ? (
                    <div className="space-y-3">
                      {detail.comments.map((comment) => (
                        <LinearCommentItem key={comment.id} comment={comment} />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                      No comments
                    </div>
                  )}
                  <div className="space-y-2 rounded-md border border-border/60 p-3">
                    <Textarea
                      value={commentBody}
                      onChange={(event) => {
                        if (selectedIssueId) {
                          commentEditRevisionsRef.current.set(
                            selectedIssueId,
                            (commentEditRevisionsRef.current.get(selectedIssueId) ?? 0) + 1,
                          );
                        }
                        setCommentBody(event.target.value);
                        if (commentError) setCommentError(null);
                      }}
                      placeholder="Add a comment"
                      aria-label="Add Linear comment"
                      className="min-h-24 resize-none"
                      disabled={commentState === "loading"}
                    />
                    {commentError && (
                      <div className="flex items-start gap-2 text-sm text-destructive">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="break-words">{commentError}</span>
                      </div>
                    )}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        onClick={() => void handlePostComment()}
                        disabled={commentState === "loading" || !commentBody.trim()}
                      >
                        {commentState === "loading" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        Comment
                      </Button>
                    </div>
                  </div>
                </div>

                <Separator />

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    ref={buildLaunchTriggerRef}
                    variant="outline"
                    size="sm"
                    disabled={isBuildStarting || hasActiveBuild}
                    onClick={() => setBuildDialogOpen(true)}
                  >
                    {isBuildStarting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Hammer className="h-3.5 w-3.5" />
                    )}
                    Build…
                  </Button>
                  {selectedPipeline?.environmentId && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void navigateToPipeline(selectedPipeline)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View Build
                      <span className="text-xs text-muted-foreground">
                        ({selectedPipeline.phase})
                      </span>
                    </Button>
                  )}
                  {selectedPipeline?.completionCommentStatus === "failed" && (
                    <>
                      <span className="text-xs text-destructive">
                        Linear comment failed: {selectedPipeline.completionCommentError}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={retryingCompletionComment}
                        onClick={async () => {
                          if (retryingCompletionComment) return;
                          setRetryingCompletionComment(true);
                          try {
                            replacePipeline(
                              await nodeBackend.retryBuildPipelineCompletionComment(
                                selectedPipeline.id,
                              ),
                            );
                          } catch (error) {
                            toast.error("Failed to retry Linear completion comment", {
                              description: error instanceof Error ? error.message : String(error),
                            });
                          } finally {
                            setRetryingCompletionComment(false);
                          }
                        }}
                      >
                        {retryingCompletionComment ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        {retryingCompletionComment ? "Retrying…" : "Retry comment"}
                      </Button>
                    </>
                  )}
                  {selectedPipeline?.completionCommentStatus === "posting" && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Posting Linear comment
                    </span>
                  )}
                  {selectedPipeline?.completionCommentStatus === "posted" && (
                    <span className="inline-flex items-center gap-1 text-xs text-green-500">
                      <Check className="h-3 w-3" />
                      Linear comment posted
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </ScrollArea>
        <BuildLaunchDialog
          open={buildDialogOpen}
          onOpenChange={setBuildDialogOpen}
          catalog={launchCatalog}
          busy={isBuildStarting}
          localEnvironmentAvailable={localEnvironmentAvailable}
          returnFocusRef={buildLaunchTriggerRef}
          commentContext={
            detail && detail.comments.length > 0 ? { count: detail.comments.length } : undefined
          }
          deliveryPolicy={selectedPipeline?.deliveryPolicy}
          {...launchDefaults}
          onConfirm={(selection) => void handleStartBuild(selection)}
        />
      </div>
    );
  }

  const connected = connection?.connected;
  const showPicker = connected && (boardState === "unlinked" || changingBoard);
  const ticketCount = `${issues.length} ticket${issues.length === 1 ? "" : "s"}`;

  const handleLinked = (link: LinearBoardLink) => {
    setChangingBoard(false);
    setBoardLink(link);
    setBoardState("linked");
    setSelectedStatuses(new Set());
    toast.success(`Linked to ${linearBoardName(link)}`);
    void loadIssues();
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      await nodeBackend.clearLinearBoardLink(projectId);
      setUnlinkOpen(false);
      setChangingBoard(false);
      setBoardLink(null);
      setBoardState("unlinked");
      setIssues([]);
      setSelectedStatuses(new Set());
      toast.success("Linear board unlinked");
    } catch (error) {
      toast.error("Failed to unlink the Linear board", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUnlinking(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const status = await nodeBackend.disconnectLinear();
      setDisconnectOpen(false);
      connectionRequestRef.current += 1;
      setConnection(status);
      setConnectionState("loaded");
      toast.success("Linear disconnected");
      void loadIssues();
    } catch (error) {
      toast.error("Failed to disconnect Linear", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDisconnecting(false);
    }
  };

  const handleUseConnection = async (nodeId: string) => {
    setCopyingFrom(nodeId);
    try {
      const status = await nodeBackend.copyLinearConnectionFromNode(nodeId);
      if (!status.connected) throw new Error(status.error ?? "Linear did not accept the key");
      toast.success("Linear connected");
      void loadIssues();
    } catch (error) {
      toast.error("Failed to use that Linear connection", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCopyingFrom(null);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">Linear Tickets</h2>
          {!connected ? (
            <p className="text-sm text-muted-foreground">Linear is not connected</p>
          ) : boardState === "linked" && boardLink ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span
                className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
                title="Linear board"
              >
                <Link2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{linearBoardName(boardLink)}</span>
              </span>
              <span>{ticketCount}</span>
              {!changingBoard && (
                <>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setChangingBoard(true)}
                  >
                    Change board
                  </Button>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs text-muted-foreground"
                    onClick={() => setUnlinkOpen(true)}
                  >
                    Unlink
                  </Button>
                </>
              )}
            </div>
          ) : boardState === "unlinked" ? (
            <p className="text-sm text-muted-foreground">No Linear board linked</p>
          ) : (
            <p className="text-sm text-muted-foreground">{ticketCount} available</p>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {connection?.viewer && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {connection.viewer.name}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadIssues()}
            disabled={issuesState === "loading"}
          >
            {issuesState === "loading" || connectionState === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
          <Button
            variant={connected ? "outline" : "default"}
            size="sm"
            onClick={() => setConnectOpen(true)}
          >
            <Unplug className="h-3.5 w-3.5" />
            {connected ? "Reconnect" : "Connect"}
          </Button>
          {connection?.hasToken && (
            <Button variant="ghost" size="sm" onClick={() => setDisconnectOpen(true)}>
              <Unlink className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          )}
        </div>
      </div>

      {!connected ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md rounded-md border border-border bg-muted/20 p-6 text-center">
            <Unplug className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <h3 className="text-base font-medium text-foreground">Connect Linear</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {connection?.error ?? "Connect a Linear workspace before loading tickets."}
            </p>
            <Button className="mt-4" onClick={() => setConnectOpen(true)}>
              Connect Linear
            </Button>
            {onCommandNode && (
              <LinearUseConnectionNotice
                connections={nodeConnections}
                copyingFrom={copyingFrom}
                onUse={(nodeId) => void handleUseConnection(nodeId)}
              />
            )}
          </div>
        </div>
      ) : showPicker ? (
        <div className="flex flex-1 items-center justify-center overflow-auto p-6">
          <LinearBoardPicker
            projectId={projectId}
            currentLink={changingBoard ? boardLink : null}
            onLinked={handleLinked}
            onCancel={changingBoard ? () => setChangingBoard(false) : undefined}
          />
        </div>
      ) : (
        <>
          <div className="border-b border-border px-6 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="radiogroup"
                  aria-label="Linear view"
                  className="inline-flex rounded-md border border-border p-0.5"
                >
                  {(
                    [
                      ["list", "List", List],
                      ["board", "Board", Columns3],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={issueView === value}
                      onClick={() => setView(projectId, value)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
                        issueView === value
                          ? "bg-primary/15 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                </div>
                {issueView === "list" && (
                  <span className="text-xs font-medium text-muted-foreground">Status</span>
                )}
                {issueView === "list" &&
                  statusCounts.map(([status, count]) => {
                    const checked = selectedStatuses.has(status);
                    return (
                      <label
                        key={status}
                        className={cn(
                          "inline-flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                          checked
                            ? "border-ring bg-primary/10 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => handleToggleStatus(status)}
                          className="h-3.5 w-3.5"
                        />
                        <span>{status}</span>
                        <span className="text-muted-foreground">{count}</span>
                      </label>
                    );
                  })}
                {issueView === "list" && selectedStatuses.size > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setSelectedStatuses(new Set())}>
                    Clear
                  </Button>
                )}
              </div>
              <div className="ml-auto flex items-center gap-2">
                {issueView === "board" && lanes.length > 0 && (
                  <LinearLanesMenu
                    lanes={lanes}
                    hidden={hiddenLanes}
                    onToggle={(status, visible) => setLaneHidden(projectId, status, !visible)}
                    onShowAll={() => showAllLanes(projectId)}
                  />
                )}
                <label
                  htmlFor="linear-ticket-order"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Order by
                </label>
                <Select
                  value={issueOrder}
                  onValueChange={(value) => setIssueOrder(value as IssueOrder)}
                >
                  <SelectTrigger
                    id="linear-ticket-order"
                    size="sm"
                    className="min-w-32"
                    aria-label="Order Linear tickets by"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="manual">Linear board</SelectItem>
                    <SelectItem value="priority">Priority</SelectItem>
                    <SelectItem value="createdAt">Created date</SelectItem>
                    <SelectItem value="updatedAt">Updated date</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {issueView === "board" && issuesState === "loaded" && lanes.length > 0 ? (
            <LinearIssueBoard
              lanes={lanes}
              hidden={hiddenLanes}
              onShowAll={() => showAllLanes(projectId)}
              onSelectIssue={handleSelectIssue}
              pipelinePhase={(issueId) => getIssuePipeline(pipelines, issueId)?.phase}
              // Moves need the project's board: an older node lists issues unscoped.
              onMoveIssue={
                boardState === "linked" ? (issue, to) => void handleMoveIssue(issue, to) : undefined
              }
              movingIssueIds={movingIssueIds}
            />
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-5 p-6">
                {issuesState === "loading" && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading Linear tickets
                  </div>
                )}

                {issuesState === "error" && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4">
                    <div className="flex items-start gap-2 text-sm text-destructive">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{issuesError}</span>
                    </div>
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      onClick={() => void loadIssues()}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry
                    </Button>
                  </div>
                )}

                {issuesState === "loaded" && issues.length === 0 && (
                  <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
                    <Search className="mb-2 h-6 w-6" />
                    <p className="text-sm">No Linear tickets found</p>
                  </div>
                )}

                {issuesState === "loaded" && issues.length > 0 && filteredIssues.length === 0 && (
                  <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
                    <Search className="mb-2 h-6 w-6" />
                    <p className="text-sm">No tickets match the selected statuses</p>
                  </div>
                )}

                {groupedIssues.map(([status, group]) => (
                  <section key={status} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{status}</h3>
                      <span className="text-xs text-muted-foreground">{group.length}</span>
                    </div>
                    <div className="overflow-hidden rounded-md border border-border">
                      {group.map((issue, index) => {
                        const pipeline = getIssuePipeline(pipelines, issue.id);
                        return (
                          <button
                            key={issue.id}
                            type="button"
                            className={cn(
                              "block w-full p-3 text-left transition-colors hover:bg-muted/50",
                              index > 0 && "border-t border-border",
                            )}
                            onClick={() => handleSelectIssue(issue.id)}
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0 space-y-1">
                                <div className="truncate text-sm font-medium text-foreground">
                                  {issue.title}
                                </div>
                                <IssueMetadata issue={issue} />
                              </div>
                              {pipeline && (
                                <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                  {pipeline.phase}
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </ScrollArea>
          )}
        </>
      )}

      <LinearConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        projectId={projectId}
        currentConnection={connection}
        boardLink={boardState === "linked" ? boardLink : null}
        onConnected={(status) => {
          connectionRequestRef.current += 1;
          setConnection(status);
          setConnectionState("loaded");
          if (status.connected) {
            void loadIssues();
          } else {
            setIssues([]);
            setIssuesState("loaded");
          }
        }}
      />

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Linear everywhere?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the Linear key from this machine and from every other machine that holds
              the same key, including machines that are offline now (they disconnect when they next
              sync). Machines connected with a different key stay connected. Board links are kept,
              so reconnecting restores them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnecting}
              onClick={(event) => {
                event.preventDefault();
                void handleDisconnect();
              }}
            >
              {disconnecting && <Loader2 className="h-4 w-4 animate-spin" />}
              Disconnect everywhere
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink the Linear board?</AlertDialogTitle>
            <AlertDialogDescription>
              {boardLink
                ? `${linearBoardName(boardLink)} will no longer be`
                : "The board will no longer be"}{" "}
              this project&apos;s Linear board, here and on every machine with this repository.
              Nothing changes in Linear.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unlinking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={unlinking}
              onClick={(event) => {
                event.preventDefault();
                void handleUnlink();
              }}
            >
              {unlinking && <Loader2 className="h-4 w-4 animate-spin" />}
              Unlink board
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
