import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import type {
  MultiReviewReviewerHistoryPage,
  MultiReviewReviewerTranscript,
} from "@orkestrator/protocol/multi-review";
import type { MultiReviewTabData } from "@/types/paneLayout";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  MessageRenderBoundary,
  messageRenderResetKey,
} from "@/components/chat/MessageRenderBoundary";
import { AgentThinkingIndicator } from "@/components/chat/AgentThinkingIndicator";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { ToolDetailLoaderContext } from "@/components/chat/NativeMessage.shared";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
import { StructuredReviewReportView } from "@/components/review/StructuredReviewReportView";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useElapsedTimer, useVirtuosoScrollState } from "@/hooks";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";
import { formatElapsed } from "@/lib/format-elapsed";
import { multiReviewReviewerScrollKey } from "@/lib/multi-review-keys";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import {
  hideMachineOutputText,
  showOnlyFinalStructuredReviewMessage,
} from "@/lib/structured-review-messages";
import * as backend from "@/lib/backend";
import { toPipelineTranscript } from "@/components/build-pipeline/pipeline-transcript";

/**
 * Backstop poll for the active tab. Each poll sends the previous source token,
 * so an unchanged transcript costs a small status projection rather than the
 * message tail; a workflow checkpoint (which lands when the reviewer's
 * transcript moves) refreshes immediately without waiting for the interval.
 */
export const REFRESH_INTERVAL_MS = 4_000;
export const MANUAL_REFRESH_TIMEOUT_MS = REFRESH_INTERVAL_MS * 2;

const AGENT_LABELS = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
} as const;

/**
 * The backend answers a deleted workflow or reviewer in band with these
 * messages. They are terminal for this read-only view: a transient error keeps
 * the poll running so the tab can recover, but a gone workflow would poll
 * forever.
 */
function isGoneError(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return (
    message.includes("Multi review workflow not found") ||
    message.includes("Multi review reviewer not found")
  );
}

interface MultiReviewReviewerTabProps {
  data: MultiReviewTabData & { reviewerId: string };
  isActive: boolean;
  loadTranscript?: typeof backend.getMultiReviewReviewerTranscript;
  loadToolDetails?: typeof backend.getMultiReviewReviewerToolDetails;
  loadHistoryPage?: typeof backend.getMultiReviewReviewerHistoryPage;
  stopReviewer?: typeof backend.stopMultiReviewReviewer;
  restartReviewer?: typeof backend.restartMultiReviewReviewer;
  unstickReviewer?: typeof backend.unstickMultiReviewReviewer;
  refreshIntervalMs?: number;
}

/**
 * Folds a transcript response into the snapshot the tab renders. An
 * `unchanged` answer carries no messages, so it keeps the ones already shown
 * while every status and recovery field comes from the new response. A full
 * snapshot replaces the list: it is authoritative and may be a rebased tail.
 */
export function mergeMultiReviewReviewerTranscript(
  previous: MultiReviewReviewerTranscript | null,
  next: MultiReviewReviewerTranscript,
): MultiReviewReviewerTranscript {
  if (next.transcript !== "unchanged") return next;
  // Identical content need not re-render: an unchanged transcript whose
  // reviewer and workflow state also did not move keeps the same object, so
  // the message projection below is not rebuilt on every poll.
  if (previous && sameReviewerState(previous, next)) return previous;
  // The kept tail keeps the window facts that describe it.
  const {
    truncated: _truncated,
    historyCursor: _historyCursor,
    historyEpoch: _historyEpoch,
    ...rest
  } = next;
  return {
    ...rest,
    messages: previous?.messages ?? [],
    ...(previous?.truncated ? { truncated: true } : {}),
    ...(previous?.historyCursor ? { historyCursor: previous.historyCursor } : {}),
    ...(previous?.historyEpoch ? { historyEpoch: previous.historyEpoch } : {}),
  };
}

/** Every field except the message tail, its window facts and the answer's framing. */
function reviewerStateKey(snapshot: MultiReviewReviewerTranscript): string {
  const {
    messages: _messages,
    transcript: _transcript,
    truncated: _truncated,
    historyCursor: _historyCursor,
    historyEpoch: _historyEpoch,
    ...state
  } = snapshot;
  // Both sides are backend answers of the same shape, so key order matches.
  return JSON.stringify(state);
}

function sameReviewerState(
  previous: MultiReviewReviewerTranscript,
  next: MultiReviewReviewerTranscript,
): boolean {
  return reviewerStateKey(previous) === reviewerStateKey(next);
}

/** Earlier history this tab retains at most; past it the control retires. */
export const MAX_REVIEWER_EARLIER_MESSAGES = 2_000;
/** Messages asked for per "load earlier" click. */
export const REVIEWER_HISTORY_PAGE_MESSAGES = 100;
/** Pages of already-shown rows one click may step past. */
const MAX_DUPLICATE_PAGE_SKIPS = 4;

/**
 * Earlier reviewer history loaded through pages, held apart from the polled
 * tail so an ordinary poll cannot discard it.
 */
export interface ReviewerHistoryState {
  /** Pages loaded so far, oldest first; never overlaps the tail. */
  earlier: unknown[];
  /** Cursor for the history before the oldest shown message. */
  cursor?: string;
  /** History epoch `earlier` and `cursor` belong to. */
  epoch?: string;
  /** Why no cursor is offered after following one. */
  end?: "complete" | "unavailable" | "retained-limit";
  /** Shown once when loaded pages had to be dropped. */
  notice?: string;
}

export const EMPTY_REVIEWER_HISTORY: ReviewerHistoryState = { earlier: [] };

/** A raw row's identity: flat bridge rows carry `id`, OpenCode rows `info.id`. */
function messageId(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as { id?: unknown; info?: { id?: unknown } | null };
  const id = record.id ?? record.info?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Fold a new transcript answer into the loaded history.
 *
 * An unchanged answer leaves it alone. A snapshot with no loaded pages simply
 * adopts the snapshot's cursor. With loaded pages, the new tail is stitched on
 * by message identity: rows that aged out of the tail since the last read are
 * kept as history, so nothing between the pages and the tail goes missing. A
 * different epoch or a tail that no longer overlaps what is shown (the
 * reviewer moved on further than a window while this tab was inactive, or was
 * restarted) cannot be stitched without a gap, so the pages are dropped and
 * the snapshot's own cursor is adopted.
 */
export function mergeReviewerHistory(
  history: ReviewerHistoryState,
  previousTail: readonly unknown[],
  next: MultiReviewReviewerTranscript,
  /**
   * A page request is in flight for `history.cursor`. Rows ageing out of the
   * tail are then kept as history even before any page landed, so the page
   * still joins the list without a gap.
   */
  pageInFlight = false,
): { history: ReviewerHistoryState; reset: boolean } {
  if (next.transcript === "unchanged") return { history, reset: false };
  const adopt = (notice?: string): ReviewerHistoryState => ({
    earlier: [],
    ...(next.historyCursor ? { cursor: next.historyCursor } : {}),
    ...(next.historyEpoch ? { epoch: next.historyEpoch } : {}),
    ...(notice ? { notice } : {}),
  });
  if (history.earlier.length === 0 && !pageInFlight) {
    // Nothing loaded and nothing on its way: the snapshot's window is the view.
    const same =
      history.cursor === next.historyCursor &&
      history.epoch === next.historyEpoch &&
      history.end === undefined;
    return { history: same ? history : adopt(history.notice), reset: false };
  }
  const firstId = messageId(next.messages[0]);
  const combined = [...history.earlier, ...previousTail];
  const overlap =
    firstId === undefined ? -1 : combined.findIndex((message) => messageId(message) === firstId);
  if (next.historyEpoch !== history.epoch || overlap < 0) {
    return {
      history: adopt("Earlier messages were reloaded because the reviewer's history moved on."),
      reset: true,
    };
  }
  const earlier = combined.slice(0, overlap);
  if (earlier.length === history.earlier.length) return { history, reset: false };
  if (earlier.length > MAX_REVIEWER_EARLIER_MESSAGES) {
    // Dropping the oldest rows leaves nothing a cursor could continue from.
    return {
      history: {
        earlier: earlier.slice(-MAX_REVIEWER_EARLIER_MESSAGES),
        ...(history.epoch ? { epoch: history.epoch } : {}),
        end: "retained-limit",
      },
      reset: false,
    };
  }
  return { history: { ...history, earlier }, reset: false };
}

/**
 * Add one page ahead of what is shown. Rows already on screen are dropped
 * (overlapping pages are expected around the tail's head), and the retained
 * history stays bounded.
 */
export function prependReviewerHistoryPage(
  history: ReviewerHistoryState,
  tail: readonly unknown[],
  page: Extract<MultiReviewReviewerHistoryPage, { status: "page" }>,
): ReviewerHistoryState {
  const shown = new Set(
    [...history.earlier, ...tail].map(messageId).filter((id): id is string => id !== undefined),
  );
  const fresh = page.messages.filter((message) => {
    const id = messageId(message);
    return id === undefined || !shown.has(id);
  });
  const earlier = [...fresh, ...history.earlier];
  if (earlier.length >= MAX_REVIEWER_EARLIER_MESSAGES) {
    return {
      earlier: earlier.slice(-MAX_REVIEWER_EARLIER_MESSAGES),
      ...(history.epoch ? { epoch: history.epoch } : {}),
      end: "retained-limit",
    };
  }
  return {
    earlier,
    ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
    ...(history.epoch ? { epoch: history.epoch } : {}),
    ...(page.nextCursor ? {} : { end: page.complete ? "complete" : "unavailable" }),
  };
}

export function toMultiReviewReviewerMessages(snapshot: MultiReviewReviewerTranscript) {
  const transcript = toPipelineTranscript(
    snapshot.messages,
    snapshot.agent,
    snapshot.startedAt ?? "1970-01-01T00:00:00.000Z",
  );
  // This backend-owned session has no interactive composer. Initial and schema-
  // correction requests are generated by the workflow, so keep the viewer on
  // reviewer outputs/tool calls instead of rendering pages of prompt or schema.
  const output = transcript.filter((message) => message.role !== "user");
  // The workflow's validated report is authoritative. Schema-shaped text in
  // the provider transcript is progress data and must never be shown as raw
  // JSON (or mistaken for an accepted result).
  //
  // Two passes because they catch different things. The first removes reports
  // that validate. The second removes every remaining JSON document — the
  // half-written drafts a provider streams while composing its answer, which
  // validate as nothing and would otherwise render verbatim. Whatever survives
  // is prose: the reviewer's actual commentary.
  return hideMachineOutputText(showOnlyFinalStructuredReviewMessage(output, false), {
    stripTrailingPayload: true,
  });
}

export function MultiReviewReviewerTab({
  data,
  isActive,
  loadTranscript = backend.getMultiReviewReviewerTranscript,
  loadToolDetails = backend.getMultiReviewReviewerToolDetails,
  loadHistoryPage = backend.getMultiReviewReviewerHistoryPage,
  stopReviewer = backend.stopMultiReviewReviewer,
  restartReviewer = backend.restartMultiReviewReviewer,
  unstickReviewer = backend.unstickMultiReviewReviewer,
  refreshIntervalMs = REFRESH_INTERVAL_MS,
}: MultiReviewReviewerTabProps) {
  const [snapshot, setSnapshot] = useState<MultiReviewReviewerTranscript | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [unsticking, setUnsticking] = useState(false);
  const [manualRefreshPending, setManualRefreshPending] = useState(false);
  const [history, setHistory] = useState<ReviewerHistoryState>(EMPTY_REVIEWER_HISTORY);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  /*
   * Mirrors of the committed state, so a transcript answer and a history page
   * are folded synchronously against exactly what is shown, and a reset can
   * fence a page still in flight.
   */
  const snapshotRef = useRef<MultiReviewReviewerTranscript | null>(null);
  const historyRef = useRef<ReviewerHistoryState>(EMPTY_REVIEWER_HISTORY);
  const historyGeneration = useRef(0);
  /** First shown message before a prepend, to hold the reader's place. */
  const scrollAnchor = useRef<string | null>(null);
  /** First rendered row, recorded after each render for the anchor above. */
  const firstRenderedId = useRef<string | null>(null);
  const pageInFlight = useRef(false);
  /*
   * Rows from a lightweight reviewer transcript carry a `detailRef` in place
   * of their tool body; expanding one reads that exact body from the
   * reviewer's own session.
   */
  const reviewerToolDetails = useCallback(
    (detailRef: string) => loadToolDetails(data.workflowId, data.reviewerId, detailRef),
    [data.reviewerId, data.workflowId, loadToolDetails],
  );
  const requestGeneration = useRef(0);
  const inFlightRequest = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const manualRefreshAttempt = useRef<symbol | null>(null);
  /** Token of the transcript this tab currently shows; reset with the view. */
  const sourceToken = useRef<string | undefined>(undefined);
  const replaceWorkflow = useMultiReviewStore((state) => state.replaceWorkflow);
  const workflowRevision = useMultiReviewStore(
    (state) => state.workflows.get(data.workflowId)?.backendRevision,
  );
  const containerId =
    useEnvironmentStore((state) => state.getEnvironmentById(data.environmentId)?.containerId) ??
    undefined;

  const commitSnapshot = useCallback((next: MultiReviewReviewerTranscript | null) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const commitHistory = useCallback((next: ReviewerHistoryState, reset: boolean) => {
    if (reset) {
      // Fences a page still in flight: it belongs to the history just dropped.
      historyGeneration.current += 1;
      pageInFlight.current = false;
      scrollAnchor.current = null;
    }
    historyRef.current = next;
    setHistory(next);
  }, []);

  /** Fold one transcript answer into the tail and the loaded history together. */
  const applyTranscript = useCallback(
    (next: MultiReviewReviewerTranscript) => {
      const previous = snapshotRef.current;
      const merged = mergeReviewerHistory(
        historyRef.current,
        previous?.messages ?? [],
        next,
        pageInFlight.current,
      );
      if (merged.history !== historyRef.current) commitHistory(merged.history, merged.reset);
      commitSnapshot(mergeMultiReviewReviewerTranscript(previous, next));
    },
    [commitHistory, commitSnapshot],
  );

  const fenceRequests = useCallback(() => {
    requestGeneration.current += 1;
    // A fenced view may be about to show another session; never ask the
    // backend to confirm a transcript this view might not be displaying.
    sourceToken.current = undefined;
    inFlightRequest.current = null;
    manualRefreshAttempt.current = null;
    setManualRefreshPending(false);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    const generation = requestGeneration.current;
    const current = inFlightRequest.current;
    if (current?.generation === generation) return current.promise;

    let request!: Promise<void>;
    request = (async () => {
      try {
        const next = await loadTranscript(data.workflowId, data.reviewerId, {
          knownSourceToken: sourceToken.current,
        });
        if (requestGeneration.current !== generation) return;
        sourceToken.current = next.sourceToken;
        applyTranscript(next);
        setTranscriptError(null);
      } catch (reason) {
        if (requestGeneration.current !== generation) return;
        setTranscriptError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (inFlightRequest.current?.promise === request) inFlightRequest.current = null;
      }
    })();
    inFlightRequest.current = { generation, promise: request };
    return request;
  }, [applyTranscript, data.reviewerId, data.workflowId, loadTranscript]);

  /**
   * Read the page before the oldest shown message and prepend it. An expired
   * cursor (restarted reviewer, rewritten history) drops the loaded pages and
   * re-reads the current transcript for a fresh cursor; it is never shown as
   * the start of history.
   */
  const loadEarlier = useCallback(async () => {
    const cursor = historyRef.current.cursor;
    // The ref, not the button state, so a double click cannot issue two reads.
    if (!cursor || pageInFlight.current) return;
    const generation = historyGeneration.current;
    setLoadingEarlier(true);
    setHistoryError(null);
    pageInFlight.current = true;
    try {
      let before = cursor;
      for (let skips = 0; ; skips += 1) {
        const page = await loadHistoryPage(data.workflowId, data.reviewerId, {
          before,
          limit: REVIEWER_HISTORY_PAGE_MESSAGES,
        });
        if (historyGeneration.current !== generation) return;
        if (page.status === "expired" || page.historyEpoch !== historyRef.current.epoch) {
          commitHistory(
            {
              earlier: [],
              notice:
                page.status === "expired" && page.reason === "session-replaced"
                  ? "The reviewer was restarted; earlier messages now start from its new session."
                  : "Earlier messages were reloaded because the reviewer's history changed.",
            },
            true,
          );
          // A snapshot, not an unchanged answer, is what carries a new cursor.
          fenceRequests();
          await refresh();
          return;
        }
        const tail = snapshotRef.current?.messages ?? [];
        const next = prependReviewerHistoryPage(historyRef.current, tail, page);
        const added = next.earlier.length > historyRef.current.earlier.length;
        // A page of rows already on screen (the tail's head, typically) is
        // stepped past rather than spending the click on nothing; bounded.
        if (
          !added &&
          page.nextCursor &&
          page.nextCursor !== before &&
          skips < MAX_DUPLICATE_PAGE_SKIPS
        ) {
          before = page.nextCursor;
          continue;
        }
        if (added) scrollAnchor.current = firstRenderedId.current;
        commitHistory(next, false);
        return;
      }
    } catch (reason) {
      if (historyGeneration.current !== generation) return;
      setHistoryError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (historyGeneration.current === generation) pageInFlight.current = false;
      setLoadingEarlier(false);
    }
  }, [commitHistory, data.reviewerId, data.workflowId, fenceRequests, loadHistoryPage, refresh]);

  /**
   * A manual refresh is a request for a snapshot newer than the click. If an
   * automatic poll is already running, wait for it and then read once more;
   * returning the existing promise made the refresh action silently do
   * nothing whenever a slow transcript poll happened to overlap the click.
   */
  const manualRefresh = useCallback(async () => {
    if (manualRefreshAttempt.current !== null) return;
    const attempt = Symbol("manual reviewer transcript refresh");
    manualRefreshAttempt.current = attempt;
    setManualRefreshPending(true);
    const generation = requestGeneration.current;
    let timeoutId: number | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutId = window.setTimeout(() => resolve("timeout"), MANUAL_REFRESH_TIMEOUT_MS);
    });
    const timedOut = async (request: Promise<void>): Promise<boolean> =>
      (await Promise.race([request.then(() => "settled" as const), timeout])) === "timeout";
    try {
      const current = inFlightRequest.current;
      if (current?.generation === generation && (await timedOut(current.promise))) {
        if (requestGeneration.current === generation) fenceRequests();
        return;
      }
      if (requestGeneration.current !== generation) return;
      if ((await timedOut(refresh())) && requestGeneration.current === generation) fenceRequests();
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (manualRefreshAttempt.current === attempt) {
        manualRefreshAttempt.current = null;
        setManualRefreshPending(false);
      }
    }
  }, [fenceRequests, refresh]);

  /**
   * The workflow, not this tab, owns the reviewer's lifecycle. Stopping only
   * asks the backend to retire it; the transcript view then re-reads the
   * authoritative snapshot rather than assuming the new status locally.
   */
  const stop = useCallback(async () => {
    setStopping(true);
    setActionError(null);
    try {
      await stopReviewer(data.workflowId, data.reviewerId);
      // A poll may have captured `running` before the backend committed the stop
      // and still be awaiting provider messages. Fence that response out, then
      // force a new authoritative read instead of letting the in-flight guard
      // turn this refresh into a no-op.
      fenceRequests();
      await refresh();
    } catch (reason) {
      // Transcript polling continues after a refused action, but a successful
      // read must not erase the action failure before the user can read it.
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStopping(false);
    }
  }, [data.reviewerId, data.workflowId, fenceRequests, refresh, stopReviewer]);

  const restart = useCallback(async () => {
    if (restarting || unsticking || stopping) return;
    setRestarting(true);
    setActionError(null);
    try {
      replaceWorkflow(await restartReviewer(data.workflowId, data.reviewerId));
      fenceRequests();
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRestarting(false);
    }
  }, [
    data.reviewerId,
    data.workflowId,
    fenceRequests,
    refresh,
    replaceWorkflow,
    restartReviewer,
    restarting,
    stopping,
    unsticking,
  ]);

  const unstick = useCallback(async () => {
    if (unsticking || restarting || stopping) return;
    setUnsticking(true);
    setActionError(null);
    try {
      replaceWorkflow(await unstickReviewer(data.workflowId, data.reviewerId));
      fenceRequests();
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUnsticking(false);
    }
  }, [
    data.reviewerId,
    data.workflowId,
    fenceRequests,
    refresh,
    replaceWorkflow,
    restarting,
    stopping,
    unsticking,
    unstickReviewer,
  ]);

  useEffect(() => {
    commitSnapshot(null);
    commitHistory(EMPTY_REVIEWER_HISTORY, true);
    setHistoryError(null);
    setLoadingEarlier(false);
    setTranscriptError(null);
    setActionError(null);
    setStopping(false);
    setRestarting(false);
    setUnsticking(false);
    fenceRequests();
  }, [commitHistory, commitSnapshot, data.reviewerId, data.workflowId, fenceRequests]);

  // Becoming inactive, unmounting, or replacing the transcript reader makes
  // every outstanding result stale. This lifecycle is intentionally separate
  // from the status-driven polling effect below: an ordinary running/completed
  // snapshot must not fence out a manual read queued behind the request that
  // produced it.
  useEffect(() => {
    if (!isActive) return;
    return fenceRequests;
  }, [fenceRequests, isActive, refresh]);

  // Activation and every status change (including the final one) read once.
  // Keyed on snapshot?.status: `snapshot` gets a new identity on real changes.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!isActive) return;
    void refresh();
  }, [isActive, refresh, snapshot?.status, transcriptError]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  // The backstop poll runs through the read coordinator: only for an active
  // tab of a running/pending reviewer, paused while the document is hidden
  // and reconciled once when it becomes visible again. Reads apply into this
  // instance's fenced state, so the key is instance-scoped.
  const pollInstance = useId();
  const gone = transcriptError !== null && isGoneError(transcriptError);
  const settled = Boolean(
    snapshot && snapshot.status !== "running" && snapshot.status !== "pending",
  );
  useCoordinatedRead<void>({
    key: {
      resource: "multi-review-reviewer-transcript",
      target: `${data.workflowId}\u0000${data.reviewerId}`,
      view: pollInstance,
    },
    enabled: isActive,
    readOnSubscribe: false,
    demand: {
      active: isActive && !gone && !settled,
      intervalMs: refreshIntervalMs,
      priority: "standard",
    },
    read: () => refresh(),
  });

  // The workflow's revision moves when the backend checkpoints reviewer
  // progress, which is exactly when this transcript has something new. Read
  // then instead of waiting out the interval; bursts coalesce onto the single
  // in-flight request.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!isActive || workflowRevision === undefined) return;
    void refresh();
  }, [workflowRevision]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  const messages = useMemo(() => {
    if (!snapshot) return [];
    if (history.earlier.length === 0) return toMultiReviewReviewerMessages(snapshot);
    const tailIds = new Set(snapshot.messages.map(messageId).filter(Boolean));
    const earlier = history.earlier.filter((message) => {
      const id = messageId(message);
      return id === undefined || !tailIds.has(id);
    });
    return toMultiReviewReviewerMessages({
      ...snapshot,
      messages: [...earlier, ...snapshot.messages],
    });
  }, [history.earlier, snapshot]);

  const scrollKey = multiReviewReviewerScrollKey(data.workflowId, data.reviewerId);
  const { virtuosoRef, scrollProps, scrollToIndex } = useVirtuosoScrollState({
    isActive,
    persistKey: scrollKey,
    environmentId: data.environmentId,
    stickToBottomOnActivation: true,
  });

  // Hold the reader on the message they were reading when a page lands above
  // it; the list otherwise keeps its offset and the new rows push it away.
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    if (!anchor) return;
    scrollAnchor.current = null;
    const index = messages.findIndex((message) => message.id === anchor);
    if (index > 0) scrollToIndex(index);
  }, [messages, scrollToIndex]);
  useLayoutEffect(() => {
    firstRenderedId.current = messages[0]?.id ?? null;
  }, [messages]);

  const running = snapshot?.status === "running";
  const stalled = Boolean(snapshot?.stalledSince && running);
  const turnStartedAtMs = snapshot?.startedAt ? Date.parse(snapshot.startedAt) : Number.NaN;
  // Hidden tabs stay mounted. Tick only while visible so a stale running
  // snapshot cannot keep the virtualized transcript rerendering every second.
  const { elapsedSeconds } = useElapsedTimer(
    running && isActive,
    data.reviewerId,
    Number.isFinite(turnStartedAtMs) ? turnStartedAtMs : undefined,
  );
  // A refused action stays visible until the user acts again, so an ordinary
  // transcript failure must not displace it. A gone workflow or reviewer is the
  // exception: it makes the action failure moot and is terminal for this view,
  // so reporting the stale action error instead would hide why polling stopped.
  const error =
    transcriptError !== null && isGoneError(transcriptError)
      ? transcriptError
      : (actionError ?? transcriptError);
  const label = snapshot ? AGENT_LABELS[snapshot.agent] : "Reviewer";
  const stoppable =
    snapshot?.workflowPhase === "reviewing" &&
    (snapshot.status === "running" || snapshot.status === "pending");
  const restartable =
    snapshot?.workflowPhase === "reviewing" ||
    snapshot?.workflowPhase === "consolidating" ||
    snapshot?.workflowPhase === "ready" ||
    snapshot?.workflowPhase === "failed";
  const unstickable =
    snapshot?.workflowPhase === "reviewing" && running && snapshot.dispatchState === "sent";
  const lifecycleActionPending = stopping || restarting || unsticking;
  const statusLine = snapshot
    ? snapshot.status === "cancelled"
      ? "Stopped · excluded from the consolidated report"
      : stalled
        ? "No activity for a while · stop it to continue without this reviewer"
        : `${snapshot.model}${snapshot.reasoningEffort ? ` · ${snapshot.reasoningEffort}` : ""} · Read only`
    : "Loading read-only transcript…";
  // Same transcript-footer status native tabs use. This view has no composer
  // and no live turn projection, so "running" is the only busy signal. A stall
  // is still running, but the header already warns there is no activity — keep
  // the elapsed clock and drop the thinking shimmer so the two rows agree.
  const thinkingStatus = running ? (
    <div className="px-2 py-2 @sm:px-4">
      <div className="chat-status-row mx-auto max-w-3xl min-w-0">
        <div className="flex items-center gap-2 text-muted-foreground">
          {stalled ? (
            <span role="status" className="text-xs text-amber-500">
              No activity for a while
            </span>
          ) : (
            <AgentThinkingIndicator agentName={label} />
          )}
          {elapsedSeconds !== null && elapsedSeconds > 0 && (
            <span className="text-xs text-muted-foreground/50">
              {formatElapsed(elapsedSeconds)}
            </span>
          )}
        </div>
      </div>
    </div>
  ) : null;
  const reportOrError = snapshot?.report ? (
    <div className="px-3 py-3 @sm:px-6">
      <StructuredReviewReportView
        className="mx-auto max-w-3xl"
        report={snapshot.report}
        heading="Reviewer report"
        collapsibleSections
        showRawJson={false}
      />
    </div>
  ) : error && messages.length > 0 ? (
    <div className="mx-3 mb-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive @sm:mx-6">
      {error}
    </div>
  ) : null;
  const historyNotice =
    history.end === "unavailable"
      ? "Earlier messages are not available from this reviewer's session."
      : history.end === "retained-limit"
        ? "Showing the most earlier history this view keeps."
        : !history.cursor && !history.end && history.earlier.length === 0 && snapshot?.truncated
          ? "Earlier messages are not shown in this view."
          : null;
  const transcriptHeader =
    history.cursor || historyNotice || history.notice || historyError ? (
      <div className="mx-auto flex max-w-3xl flex-col items-center justify-center gap-2 px-2 py-3 text-xs text-muted-foreground">
        {history.notice ? <span>{history.notice}</span> : null}
        {historyNotice ? <span>{historyNotice}</span> : null}
        {historyError ? (
          <span role="alert" className="text-destructive">
            {historyError}
          </span>
        ) : null}
        {history.cursor ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loadingEarlier}
            onClick={() => void loadEarlier()}
          >
            {loadingEarlier ? "Loading…" : "Load earlier messages"}
          </Button>
        ) : null}
      </div>
    ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="@container flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{label} review</h1>
          <p className={`truncate text-xs ${stalled ? "text-amber-500" : "text-muted-foreground"}`}>
            {statusLine}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : snapshot?.status === "completed" ? (
            <CheckCircle2 className="size-4 text-emerald-500" />
          ) : snapshot?.status === "failed" ? (
            <AlertCircle className="size-4 text-destructive" />
          ) : null}
          {stoppable && (
            <Button
              variant="outline"
              size="sm"
              className="px-2 @xl:px-3"
              disabled={lifecycleActionPending}
              aria-label="Stop this reviewer"
              title="Stop this reviewer; the Multi Review continues without it"
              onClick={() => void stop()}
            >
              {stopping ? (
                <Loader2 className="size-3.5 animate-spin @xl:mr-2" />
              ) : (
                <Square className="size-3.5 @xl:mr-2" />
              )}
              <span className="hidden @xl:inline">Stop</span>
            </Button>
          )}
          {restartable && (
            <Button
              variant="outline"
              size="sm"
              className="px-2 @xl:px-3"
              disabled={lifecycleActionPending}
              aria-label="Restart reviewer"
              title="Restart this reviewer from the beginning in a fresh session"
              onClick={() => void restart()}
            >
              {restarting ? (
                <Loader2 className="size-3.5 animate-spin @xl:mr-2" />
              ) : (
                <RotateCcw className="size-3.5 @xl:mr-2" />
              )}
              <span className="hidden @xl:inline">Restart</span>
            </Button>
          )}
          {unstickable && (
            <Button
              variant="outline"
              size="sm"
              className="px-2 @xl:px-3"
              disabled={lifecycleActionPending}
              aria-label="Unstick reviewer"
              title='Stop the current turn, then send "Please continue"'
              onClick={() => void unstick()}
            >
              {unsticking ? (
                <Loader2 className="size-3.5 animate-spin @xl:mr-2" />
              ) : (
                <Play className="size-3.5 @xl:mr-2" />
              )}
              <span className="hidden @xl:inline">Unstick</span>
            </Button>
          )}
        </div>
      </header>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="@container flex min-h-0 flex-1 flex-col"
            data-testid="multi-review-reviewer-transcript-body"
          >
            <ToolDetailLoaderContext.Provider value={reviewerToolDetails}>
              <VirtualizedMessageList
                messages={messages}
                computeItemKey={(_index, message) => message.id}
                resolvePreviousMessage={findPreviousNativeMessage}
                renderMessage={(_index, message, previous) => (
                  // This read-only view re-reads the whole provider transcript every
                  // few seconds while the reviewer streams, so a frame can hold a
                  // message shape no renderer has seen before. One such message must
                  // degrade to its own row — not hand the entire tab to the view
                  // error boundary — and retries as soon as a poll reports that this
                  // message changed. Keyed on content, not identity: every poll
                  // rebuilds all message objects, so identity would retry a row that
                  // fails deterministically on every interval for the whole review.
                  <MessageRenderBoundary resetKey={messageRenderResetKey(message)}>
                    <NativeMessage
                      message={message}
                      previousMessage={previous}
                      assistantLabel={label}
                      containerId={containerId}
                      agentExpansionScope={data.environmentId}
                      platform={snapshot?.agent}
                    />
                  </MessageRenderBoundary>
                )}
                emptyState={
                  <div className="px-6 py-12 text-center text-sm text-muted-foreground">
                    {error
                      ? error
                      : running
                        ? "The review is running. Its authoritative transcript will appear here as it is synchronized."
                        : snapshot
                          ? "No text transcript was produced for this review."
                          : "Loading reviewer transcript…"}
                  </div>
                }
                header={transcriptHeader}
                footer={
                  thinkingStatus || reportOrError ? (
                    <>
                      {thinkingStatus}
                      {reportOrError}
                    </>
                  ) : undefined
                }
                scrollProps={scrollProps}
                virtuosoRef={virtuosoRef}
                find={{
                  isActive,
                  getSearchText: getNativeMessageSearchText,
                }}
              />
            </ToolDetailLoaderContext.Provider>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem disabled={manualRefreshPending} onSelect={() => void manualRefresh()}>
            {manualRefreshPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh transcript
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
