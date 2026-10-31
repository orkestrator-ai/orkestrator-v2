import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  MultiReviewStepKind,
  MultiReviewStepTranscript,
} from "@orkestrator/protocol/multi-review";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import {
  MessageRenderBoundary,
  messageRenderResetKey,
} from "@/components/chat/MessageRenderBoundary";
import { NativeMessage as NativeMessageView } from "@/components/chat/NativeMessage";
import { ToolDetailLoaderContext } from "@/components/chat/NativeMessage.shared";
import { PLATFORM_ICON_CLASS } from "@/components/icons/AgentIcons";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import { useScrollOffsetAcrossHide } from "@/hooks/useScrollOffsetAcrossHide";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as backend from "@/lib/backend";
import { hideReviewPackagePlanText } from "@/lib/structured-review-messages";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { cn } from "@/lib/utils";
import {
  REFRESH_INTERVAL_MS,
  mergeMultiReviewReviewerTranscript,
  toMultiReviewReviewerMessages,
  toMultiReviewSessionMessages,
} from "./MultiReviewReviewerTab";
import { FlowInspectorHeader } from "@/components/flow-graph/FlowInspector";
import { withIdleIcon, type MultiReviewFlowNodeModel } from "./MultiReviewFlowGraph";
import { reviewSeverityStyles } from "./StructuredReviewReportView";
import { provisionalFindingLabel, type MultiReviewMergedFinding } from "./multi-review-flow";

/** Icon, name, status pill and token count of the selected node, with its actions. */
export function MultiReviewInspectorHeader({
  node,
  actions,
}: {
  node: MultiReviewFlowNodeModel;
  actions: ReactNode;
}) {
  return (
    <FlowInspectorHeader node={withIdleIcon(node)} actions={actions} testIdPrefix="multi-review" />
  );
}

/** The tail renders at most this many messages, the latest. */
const MAX_TAIL_MESSAGES = 40;

/** What a tail read answers: a bounded tail, or `unchanged` with no messages. */
interface TranscriptTailSnapshot {
  messages: unknown[];
  transcript?: "snapshot" | "unchanged";
  sourceToken?: string;
}

/**
 * A transcript read model reduced to a bounded tail of display messages.
 *
 * Each read sends the last source token, so an unchanged transcript costs a
 * status projection; selection and every workflow checkpoint read at once,
 * and only a live node in an active tab is polled, through the read
 * coordinator. `read`, `merge` and `toMessages` must be stable.
 */
function useTranscriptTail<T extends TranscriptTailSnapshot>({
  resource,
  workflowId,
  targetId,
  enabled,
  live,
  read: readTail,
  merge,
  toMessages,
}: {
  resource: string;
  workflowId: string;
  targetId: string;
  enabled: boolean;
  live: boolean;
  read: (workflowId: string, targetId: string, knownSourceToken?: string) => Promise<T>;
  merge: (previous: T | null, next: T) => T;
  toMessages: (snapshot: T) => NativeMessage[];
}) {
  const viewKey = `${workflowId}\u0000${targetId}`;
  // Each answer is tagged with the node it was read for, so switching nodes
  // shows nothing stale and needs no reset pass.
  const [read, setRead] = useState<{
    viewKey: string;
    snapshot: T | null;
    error: string | null;
  }>({ viewKey, snapshot: null, error: null });
  const snapshotRef = useRef<T | null>(null);
  const sourceToken = useRef<string | undefined>(undefined);
  const readKey = useRef(viewKey);
  const inFlight = useRef<{ viewKey: string; promise: Promise<void>; invalidated: boolean } | null>(
    null,
  );
  const workflowRevision = useMultiReviewStore(
    (state) => state.workflows.get(workflowId)?.backendRevision,
  );

  const refresh = useCallback(
    (invalidate = false): Promise<void> => {
      const requestKey = `${workflowId}\u0000${targetId}`;
      if (readKey.current !== requestKey) {
        // Another node: never confirm a token this view no longer shows.
        readKey.current = requestKey;
        sourceToken.current = undefined;
        snapshotRef.current = null;
        inFlight.current = null;
      }
      if (inFlight.current?.viewKey === requestKey) {
        if (invalidate) inFlight.current.invalidated = true;
        return inFlight.current.promise;
      }
      // Publish the request before starting its body, including if readTail
      // throws synchronously. Identity also fences late answers after reselecting a node.
      const request = { viewKey: requestKey, promise: Promise.resolve(), invalidated: false };
      request.promise = Promise.resolve().then(async () => {
        try {
          do {
            request.invalidated = false;
            try {
              const next = await readTail(workflowId, targetId, sourceToken.current);
              if (inFlight.current !== request || !next) return;
              sourceToken.current = next.sourceToken;
              const merged = merge(snapshotRef.current, next);
              snapshotRef.current = merged;
              setRead({ viewKey: requestKey, snapshot: merged, error: null });
            } catch (reason) {
              if (inFlight.current !== request) return;
              const error = reason instanceof Error ? reason.message : String(reason);
              setRead({ viewKey: requestKey, snapshot: snapshotRef.current, error });
            }
          } while (inFlight.current === request && request.invalidated);
        } finally {
          if (inFlight.current === request) inFlight.current = null;
        }
      });
      inFlight.current = request;
      return request.promise;
    },
    [merge, readTail, targetId, workflowId],
  );

  // Selection, activation and every workflow checkpoint read once; bursts
  // coalesce into one fresh read after any request already in flight.
  useEffect(() => {
    if (!enabled) return;
    void refresh(true);
  }, [enabled, refresh, workflowRevision]);

  const pollInstance = useId();
  useCoordinatedRead<void>({
    key: { resource, target: viewKey, view: pollInstance },
    enabled,
    readOnSubscribe: false,
    demand: { active: enabled && live, intervalMs: REFRESH_INTERVAL_MS, priority: "standard" },
    read: () => refresh(),
  });

  const current = read.viewKey === viewKey ? read : null;
  const snapshot = current?.snapshot ?? null;
  const messages = useMemo(
    () => (snapshot ? toMessages(snapshot).slice(-MAX_TAIL_MESSAGES) : []),
    [snapshot, toMessages],
  );
  return { snapshot, messages, error: current?.error ?? null };
}

/** Distance from the bottom within which the tail keeps following new lines. */
const FOLLOW_THRESHOLD_PX = 24;

/**
 * The tail's scrolling log: the session's latest messages and tool calls,
 * rendered as a chat transcript is, following new output unless the reader
 * scrolled up. It fills the inspector's remaining height, never under 28rem;
 * its explicit zero-length basis keeps a long transcript scrolling here rather
 * than growing the inspector (a percentage basis becomes content-sized while
 * the grid measures its intrinsic height).
 */
function TranscriptTailLog({
  label,
  followKey,
  messages,
  live,
  empty,
  error,
  assistantLabel,
  platform,
  containerId,
  expansionScope,
  loadToolDetails,
}: {
  label: string;
  /** Changing it starts following again (another node). */
  followKey: string;
  messages: NativeMessage[];
  live: boolean;
  empty: string;
  error: boolean;
  /** Who the session's messages are from. */
  assistantLabel?: string;
  platform?: AgentPlatform;
  containerId?: string;
  /** Keeps this tail's expanded tool rows apart from other transcripts'. */
  expansionScope: string;
  loadToolDetails?: (detailRef: string) => Promise<NativeAgentToolDetails>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const isHidden = useScrollOffsetAcrossHide(scrollRef);

  useEffect(() => {
    following.current = true;
  }, [followKey]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // A completed transcript receives no new messages when its pane shrinks.
    // Keep its latest entry visible, unless the reader has scrolled up.
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={scrollRef}
      data-testid="multi-review-transcript-tail"
      aria-label={label}
      role="log"
      aria-live="off"
      tabIndex={0}
      onScroll={(event) => {
        if (isHidden()) return;
        const element = event.currentTarget;
        following.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
      }}
      className="@container h-0 min-h-[28rem] flex-[1_1_0px] overflow-y-auto overscroll-contain rounded-lg border border-divider bg-background py-2"
    >
      {messages.length === 0 ? (
        <p className={cn("px-3 text-xs", error ? "text-failure" : "text-muted-foreground")}>
          {empty}
        </p>
      ) : (
        <ToolDetailLoaderContext.Provider value={loadToolDetails}>
          {messages.map((message, index) => (
            // A tail re-read can hold a message shape no renderer has seen;
            // it degrades to its own row rather than taking the panel down.
            <MessageRenderBoundary key={message.id} resetKey={messageRenderResetKey(message)}>
              <NativeMessageView
                message={message}
                previousMessage={findPreviousNativeMessage(messages, index)}
                assistantLabel={assistantLabel}
                containerId={containerId}
                agentExpansionScope={expansionScope}
                platform={platform}
                loadToolDetails={loadToolDetails}
              />
            </MessageRenderBoundary>
          ))}
        </ToolDetailLoaderContext.Provider>
      )}
      {live && messages.length > 0 ? (
        // Same column as the messages above, so it sits under the text it follows.
        <div aria-hidden="true" className="px-2 @sm:px-4">
          <div className="chat-status-row mx-auto max-w-3xl min-w-0">
            <span className="agent-thinking-shimmer text-xs">Working…</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ReviewerTranscriptTail({
  workflowId,
  reviewerId,
  hasSession,
  live,
  isActive,
  assistantLabel,
  containerId,
  loadTranscript = backend.getMultiReviewReviewerTranscript,
  loadToolDetails = backend.getMultiReviewReviewerToolDetails,
}: {
  workflowId: string;
  reviewerId: string;
  hasSession: boolean;
  live: boolean;
  isActive: boolean;
  assistantLabel?: string;
  containerId?: string;
  loadTranscript?: typeof backend.getMultiReviewReviewerTranscript;
  loadToolDetails?: typeof backend.getMultiReviewReviewerToolDetails;
}) {
  const read = useCallback(
    (workflow: string, reviewer: string, knownSourceToken?: string) =>
      loadTranscript(workflow, reviewer, { knownSourceToken }),
    [loadTranscript],
  );
  const toolDetails = useCallback(
    (detailRef: string) => loadToolDetails(workflowId, reviewerId, detailRef),
    [loadToolDetails, reviewerId, workflowId],
  );
  const { snapshot, messages, error } = useTranscriptTail({
    resource: "multi-review-reviewer-transcript",
    workflowId,
    targetId: reviewerId,
    enabled: isActive && hasSession,
    live,
    read,
    merge: mergeMultiReviewReviewerTranscript,
    toMessages: toMultiReviewReviewerMessages,
  });

  const empty = !hasSession
    ? "The transcript appears here once this reviewer starts."
    : error
      ? error
      : !snapshot
        ? "Loading transcript…"
        : live
          ? "Waiting for the reviewer's first output…"
          : "No text transcript was produced for this review.";

  return (
    <TranscriptTailLog
      label="Latest reviewer activity"
      followKey={reviewerId}
      messages={messages}
      live={live}
      empty={empty}
      error={Boolean(error)}
      assistantLabel={assistantLabel}
      platform={snapshot?.agent}
      containerId={containerId}
      expansionScope={`multi-review:${workflowId}:reviewer:${reviewerId}:tail`}
      loadToolDetails={toolDetails}
    />
  );
}

/**
 * Folds a step tail answer into what is shown: `unchanged` keeps the messages
 * already held and takes every other field from the new answer.
 */
export function mergeMultiReviewStepTranscript(
  previous: MultiReviewStepTranscript | null,
  next: MultiReviewStepTranscript,
): MultiReviewStepTranscript {
  if (next.transcript !== "unchanged") return next;
  const { truncated: _truncated, ...rest } = next;
  return {
    ...rest,
    messages: previous?.messages ?? [],
    ...(previous?.truncated ? { truncated: true } : {}),
  };
}

/**
 * A step session's output for the tail, with the workflow's own prompts and
 * every schema-shaped document hidden exactly as a reviewer's are: the step's
 * accepted result is authoritative, and a half-written plan, report or fix
 * result is progress data, never something to show as raw JSON.
 */
export function toMultiReviewStepMessages(snapshot: MultiReviewStepTranscript): NativeMessage[] {
  return hideReviewPackagePlanText(
    toMultiReviewSessionMessages(
      snapshot.messages,
      snapshot.agent ?? "codex",
      snapshot.startedAt ?? "1970-01-01T00:00:00.000Z",
    ),
  );
}

const STEP_LABEL: Record<MultiReviewStepKind, string> = {
  prepare: "review package generation",
  consolidate: "consolidation",
  fix: "Fix",
};

/** The transcript tail of a preparation, consolidation or Fix session. */
export function StepTranscriptTail({
  workflowId,
  step,
  access,
  live,
  isActive,
  assistantLabel,
  containerId,
  loadTranscript = backend.getMultiReviewStepTranscript,
  loadToolDetails = backend.getMultiReviewStepToolDetails,
}: {
  workflowId: string;
  step: MultiReviewStepKind;
  /**
   * Whether the step has a session whose transcript is its own, from the
   * workflow snapshot. Only an `own` session is read; the backend checks again.
   */
  access: { kind: MultiReviewStepTranscript["session"]; step?: MultiReviewStepKind | null };
  live: boolean;
  isActive: boolean;
  assistantLabel?: string;
  containerId?: string;
  loadTranscript?: typeof backend.getMultiReviewStepTranscript;
  loadToolDetails?: typeof backend.getMultiReviewStepToolDetails;
}) {
  const read = useCallback(
    (workflow: string, target: string, knownSourceToken?: string) =>
      loadTranscript(workflow, target as MultiReviewStepKind, { knownSourceToken }),
    [loadTranscript],
  );
  const { snapshot, messages, error } = useTranscriptTail({
    resource: "multi-review-step-transcript",
    workflowId,
    targetId: step,
    enabled: isActive && access.kind === "own",
    live,
    read,
    merge: mergeMultiReviewStepTranscript,
    toMessages: toMultiReviewStepMessages,
  });
  const toolDetails = useCallback(
    (detailRef: string) => loadToolDetails(workflowId, step, detailRef),
    [loadToolDetails, step, workflowId],
  );
  // The backend's answer wins once there is one: the snapshot may be behind.
  const session = access.kind === "own" && snapshot ? snapshot.session : access.kind;
  const sessionStep =
    access.kind === "own" && snapshot ? snapshot.sessionStep : (access.step ?? undefined);

  const empty =
    session === "none"
      ? "The transcript appears here once this step starts."
      : session === "other-step"
        ? sessionStep
          ? `This step's session is now running ${STEP_LABEL[sessionStep]}. Open session to read the whole conversation.`
          : "This step shares its session with another step. Open session to read the whole conversation."
        : error
          ? error
          : !snapshot
            ? "Loading transcript…"
            : live
              ? "Waiting for the step's first output…"
              : "No text transcript was produced for this step.";

  return (
    <TranscriptTailLog
      label={`Latest ${STEP_LABEL[step]} activity`}
      followKey={step}
      messages={session === "own" ? messages : []}
      live={live}
      empty={empty}
      error={session === "own" && Boolean(error)}
      assistantLabel={assistantLabel}
      platform={snapshot?.agent ?? undefined}
      containerId={containerId}
      expansionScope={`multi-review:${workflowId}:step:${step}:tail`}
      loadToolDetails={toolDetails}
    />
  );
}

const STANDING_TITLE = {
  confirmed: "",
  provisional: " · provisional",
  failed: " · unconfirmed, reviewer failed",
  stopped: " · unconfirmed, reviewer stopped",
} as const;

function ReviewerAvatar({ source }: { source: MultiReviewMergedFinding["sources"][number] }) {
  return (
    <span
      title={`Reviewer ${source.index + 1} · ${source.agent} · ${source.model}${STANDING_TITLE[source.standing]}`}
      data-finding-standing={source.standing}
      className={cn(
        "-ml-1 grid size-[18px] place-items-center rounded-[5px] border-2 border-background bg-elevated font-mono text-[9.5px] font-bold first:ml-0",
        source.standing !== "confirmed" && "border-dashed border-muted-foreground/60 opacity-75",
        PLATFORM_ICON_CLASS[source.agent],
      )}
    >
      {source.index + 1}
    </span>
  );
}

function findingCountSummary(
  findings: readonly MultiReviewMergedFinding[],
  reviewerCount: number,
  provisionalCount: number,
): string {
  const confirmed = findings.length - provisionalCount;
  const base = `${confirmed} · from ${reviewerCount} ${reviewerCount === 1 ? "reviewer" : "reviewers"}`;
  return provisionalCount > 0 ? `${base} · ${provisionalCount} provisional` : base;
}

/** Most severe first. */
const SEVERITIES: readonly MultiReviewMergedFinding["severity"][] = ["P0", "P1", "P2"];

function FindingsList({ findings }: { findings: MultiReviewMergedFinding[] }) {
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {findings.map((finding) => {
        const standing = provisionalFindingLabel(finding);
        return (
          <li
            key={finding.key}
            data-finding-provisional={finding.provisional ? "" : undefined}
            className="flex items-start gap-2.5 border-t border-divider/70 py-2 first:border-t-0"
          >
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded-[5px] border px-1.5 text-[10.5px] leading-4",
                reviewSeverityStyles[finding.severity],
                finding.provisional && "border-dashed opacity-80",
              )}
            >
              {finding.severity}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-[13px] font-medium break-words",
                  finding.provisional && "text-foreground/80",
                )}
              >
                {finding.title}
              </p>
              <p className="flex min-w-0 items-baseline gap-2 font-mono text-[11.5px] text-muted-foreground">
                <span className="min-w-0 truncate">
                  {finding.line ? `${finding.file}:${finding.line}` : finding.file}
                </span>
                {standing ? (
                  <span
                    data-testid="multi-review-finding-standing"
                    className="shrink-0 rounded-[4px] border border-dashed border-muted-foreground/50 px-1 font-sans text-[10.5px] leading-4 text-muted-foreground"
                  >
                    {standing}
                  </span>
                ) : null}
              </p>
            </div>
            <span
              className="mt-0.5 flex shrink-0"
              aria-label={`${finding.provisional ? "Reported provisionally" : "Raised"} by ${finding.sources.map((source) => `Reviewer ${source.index + 1}`).join(", ")}`}
            >
              {finding.sources.map((source) => (
                <ReviewerAvatar key={source.reviewerId} source={source} />
              ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Issues the reviewers have reported, merged, with who raised each: a
 * floating count per severity that opens the list, and closes it again on a
 * click outside or Escape. Rows no accepted report confirms yet (reported
 * through `report_finding`) are marked provisional, or unconfirmed once their
 * reviewer ended without a report.
 */
export function MultiReviewFindingsBadge({
  findings,
  reviewerCount,
  provisionalCount = 0,
  isActive = true,
  className,
}: {
  findings: MultiReviewMergedFinding[];
  reviewerCount: number;
  provisionalCount?: number;
  isActive?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  if (!isActive && open) setOpen(false);
  const panelId = useId();
  const headingId = useId();

  useEffect(() => {
    if (!open || !isActive) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !(event.target instanceof Node) ||
        !rootRef.current?.contains(event.target)
      )
        return;
      event.preventDefault();
      setOpen(false);
      rootRef.current?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, isActive]);

  // The sticky badge can sit near either viewport edge. Keep the list on the
  // roomier side and bound its own scroll area, including after page scrolling.
  useLayoutEffect(() => {
    if (!open || !isActive) return;
    const position = () => {
      const root = rootRef.current;
      const panel = panelRef.current;
      if (!root || !panel) return;
      const box = root.getBoundingClientRect();
      let top = 16;
      let bottom = window.innerHeight - 16;
      // Ancestor scroll areas also clip the panel: leave their fixed headers
      // clear even when the badge is at the bottom of a long stacked pipeline.
      for (let parent = root.parentElement; parent; parent = parent.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
        const bounds = parent.getBoundingClientRect();
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
      const below = bottom - box.bottom - 8;
      const above = box.top - top - 8;
      const maxHeight = Math.min(448, window.innerHeight * 0.7);
      const upwards = below < maxHeight && above > below;
      panel.style.top = upwards ? "auto" : "100%";
      panel.style.bottom = upwards ? "100%" : "auto";
      panel.style.marginTop = upwards ? "0" : "8px";
      panel.style.marginBottom = upwards ? "8px" : "0";
      panel.style.maxHeight = `${Math.max(0, Math.min(maxHeight, upwards ? above : below))}px`;
    };
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open, isActive]);

  const counts = SEVERITIES.map(
    (severity) =>
      [severity, findings.filter((finding) => finding.severity === severity).length] as const,
  );
  const countLabel = counts.map(([severity, count]) => `${count} ${severity}`).join(", ");

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Issues so far: ${countLabel}`}
        title="Issues so far"
        data-testid="multi-review-findings-badge"
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1 rounded-full border border-border bg-flow-node/95 p-1 shadow-[0_8px_24px_rgb(0_0_0/0.45)] transition-colors hover:bg-elevated-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {counts.map(([severity, count]) => (
          <span
            key={severity}
            className={cn(
              "rounded-full border px-2 font-mono text-[11px] leading-5 tabular-nums",
              reviewSeverityStyles[severity],
              count === 0 && "opacity-40",
            )}
          >
            {severity} {count}
          </span>
        ))}
      </button>
      {open ? (
        <section
          ref={panelRef}
          id={panelId}
          aria-labelledby={headingId}
          data-testid="multi-review-findings"
          className="absolute top-full right-0 z-30 mt-2 flex max-h-[min(28rem,70vh)] w-[min(34rem,calc(100vw-2rem))] flex-col rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-[0_12px_32px_rgb(0_0_0/0.5)]"
        >
          <div className="mb-2 flex items-baseline gap-2.5">
            <h2 id={headingId} className="text-sm font-semibold">
              Issues so far
            </h2>
            <span
              className="text-xs text-muted-foreground"
              data-testid="multi-review-findings-count"
            >
              {findingCountSummary(findings, reviewerCount, provisionalCount)}
            </span>
          </div>
          {findings.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {reviewerCount === 0
                ? "Issues appear here as reviewers report them."
                : "The completed reviewers reported no issues."}
            </p>
          ) : (
            <FindingsList findings={findings} />
          )}
        </section>
      ) : null}
    </div>
  );
}
