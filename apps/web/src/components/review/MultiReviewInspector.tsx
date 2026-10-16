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
import { PLATFORM_ICON_CLASS } from "@/components/icons/AgentIcons";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as backend from "@/lib/backend";
import type { RuntimeParts } from "@/lib/review/runtime-summary";
import { hideReviewPackagePlanText } from "@/lib/structured-review-messages";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { cn } from "@/lib/utils";
import {
  REFRESH_INTERVAL_MS,
  mergeMultiReviewReviewerTranscript,
  toMultiReviewReviewerMessages,
  toMultiReviewSessionMessages,
} from "./MultiReviewReviewerTab";
import { MultiReviewFlowStateIcon, type MultiReviewFlowNodeModel } from "./MultiReviewFlowGraph";
import { reviewSeverityStyles } from "./StructuredReviewReportView";
import {
  provisionalFindingLabel,
  type MultiReviewFlowState,
  type MultiReviewMergedFinding,
} from "./multi-review-flow";

const PILL_CLASS: Record<MultiReviewFlowState, string> = {
  "not-started": "border-border text-muted-foreground",
  running: "border-cyan-400/25 bg-cyan-400/8 text-cyan-300",
  paused: "border-amber-400/30 bg-amber-400/8 text-amber-300",
  complete: "border-success/30 bg-success/8 text-green-300",
  failed: "border-failure/30 bg-failure/8 text-failure",
  cancelling: "border-border text-muted-foreground",
  cancelled: "border-border text-muted-foreground",
};

function tokensInWords(runtime: RuntimeParts | null): string | null {
  if (runtime?.tokens) return `${runtime.tokens} tokens`;
  if (runtime?.tokensPending) return "Tokens pending";
  return null;
}

/** Icon, name, status pill and token count of the selected node, with its actions. */
export function MultiReviewInspectorHeader({
  node,
  actions,
}: {
  node: MultiReviewFlowNodeModel;
  actions: ReactNode;
}) {
  const tokens = tokensInWords(node.runtime);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <MultiReviewFlowStateIcon
        kind={node.kind}
        state={node.state}
        stalled={node.stalled}
        className="size-4"
      />
      <h2 className="min-w-0 truncate text-sm font-semibold">{node.title}</h2>
      <span
        data-testid="multi-review-inspector-status"
        className={cn(
          "shrink-0 rounded-full border px-2 py-px text-[11px]",
          node.stalled && node.state === "running"
            ? "border-amber-500/30 bg-amber-500/8 text-amber-500"
            : PILL_CLASS[node.state],
        )}
      >
        {node.statusLabel}
      </span>
      {tokens ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{tokens}</span>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>
    </div>
  );
}

export interface TranscriptTailLine {
  key: string;
  kind: string;
  text: string;
}

const MAX_TAIL_LINES = 80;
const MAX_TAIL_LINE_CHARS = 240;

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_TAIL_LINE_CHARS
    ? `${collapsed.slice(0, MAX_TAIL_LINE_CHARS - 1)}…`
    : collapsed;
}

type TailPart = NativeMessage["parts"][number];

const TOOL_ARGUMENT_KEYS = [
  "file_path",
  "filePath",
  "path",
  "pattern",
  "command",
  "query",
  "url",
  "description",
] as const;

function toolSubject(part: TailPart): string {
  if (part.toolTitle && part.toolTitle.toLowerCase() !== part.toolName?.toLowerCase()) {
    return part.toolTitle;
  }
  for (const key of TOOL_ARGUMENT_KEYS) {
    const value = part.toolArgs?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return part.content;
}

function collectTailLines(part: TailPart, key: string, lines: TranscriptTailLine[]): void {
  switch (part.type) {
    // The display adapters group consecutive tool rows (and sub-agents); the
    // tail wants the steps themselves.
    case "tool-group":
    case "agent-group":
      part.parts.forEach((child, index) => collectTailLines(child, `${key}.${index}`, lines));
      return;
    case "task-group":
      collectTailLines(part.task, key, lines);
      return;
    case "tool-invocation": {
      const kind = (part.toolName ?? "tool").replace(/^mcp__\w+__/, "").toLowerCase();
      lines.push({ key, kind, text: oneLine(toolSubject(part)) });
      return;
    }
    case "subagent":
      lines.push({ key, kind: "agent", text: oneLine(part.subagentName ?? part.content) });
      return;
    case "text":
    case "thinking": {
      const text = oneLine(part.content);
      if (text) lines.push({ key, kind: part.type === "thinking" ? "think" : "say", text });
      return;
    }
    default:
      return;
  }
}

/**
 * One short line per step of the reviewer's output: a keyword (`read`, `grep`,
 * `think`, `say`) and its subject; the log shows `say` lines without their
 * keyword, in white. It is a glance at what the reviewer is doing,
 * not a transcript; Open session shows the real one.
 */
export function transcriptTailLines(
  messages: readonly NativeMessage[],
  limit = MAX_TAIL_LINES,
): TranscriptTailLine[] {
  const lines: TranscriptTailLine[] = [];
  for (const message of messages) {
    message.parts.forEach((part, index) => collectTailLines(part, `${message.id}:${index}`, lines));
  }
  return lines.slice(-limit);
}

/** What a tail read answers: a bounded tail, or `unchanged` with no messages. */
interface TranscriptTailSnapshot {
  messages: unknown[];
  transcript?: "snapshot" | "unchanged";
  sourceToken?: string;
}

/**
 * A transcript read model reduced to a bounded tail of short lines.
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
  const lines = useMemo(
    () => (snapshot ? transcriptTailLines(toMessages(snapshot)) : []),
    [snapshot, toMessages],
  );
  return { snapshot, lines, error: current?.error ?? null };
}

/** Distance from the bottom within which the tail keeps following new lines. */
const FOLLOW_THRESHOLD_PX = 24;

/** The tail's scrolling log, following new lines unless the reader scrolled up. */
function TranscriptTailLog({
  label,
  followKey,
  lines,
  live,
  empty,
  error,
}: {
  label: string;
  /** Changing it starts following again (another node). */
  followKey: string;
  lines: TranscriptTailLine[];
  live: boolean;
  empty: string;
  error: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useEffect(() => {
    following.current = true;
  }, [followKey]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={scrollRef}
      data-testid="multi-review-transcript-tail"
      aria-label={label}
      role="log"
      aria-live="off"
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
      }}
      className="h-56 overflow-y-auto overscroll-contain rounded-lg border border-divider bg-flow-canvas px-3 py-2.5 font-mono text-[11.5px] leading-[1.8] text-zinc-400"
    >
      {lines.length === 0 ? (
        <p className={cn(error ? "text-failure" : "text-muted-foreground")}>{empty}</p>
      ) : (
        lines.map((line) =>
          // Narrative needs no keyword: it reads in white against the grey steps.
          line.kind === "say" ? (
            <div
              key={line.key}
              data-tail-kind="say"
              className="truncate text-foreground"
              title={line.text}
            >
              {line.text}
            </div>
          ) : (
            <div key={line.key} data-tail-kind={line.kind} className="truncate" title={line.text}>
              <span className="mr-2 text-cyan-300">{line.kind}</span>
              {line.text}
            </div>
          ),
        )
      )}
      {live && lines.length > 0 ? (
        <div aria-hidden="true" className="animate-pulse text-cyan-300 motion-reduce:animate-none">
          ▍
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
  loadTranscript = backend.getMultiReviewReviewerTranscript,
}: {
  workflowId: string;
  reviewerId: string;
  hasSession: boolean;
  live: boolean;
  isActive: boolean;
  loadTranscript?: typeof backend.getMultiReviewReviewerTranscript;
}) {
  const read = useCallback(
    (workflow: string, reviewer: string, knownSourceToken?: string) =>
      loadTranscript(workflow, reviewer, { knownSourceToken }),
    [loadTranscript],
  );
  const { snapshot, lines, error } = useTranscriptTail({
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
      lines={lines}
      live={live}
      empty={empty}
      error={Boolean(error)}
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
  loadTranscript = backend.getMultiReviewStepTranscript,
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
  loadTranscript?: typeof backend.getMultiReviewStepTranscript;
}) {
  const read = useCallback(
    (workflow: string, target: string, knownSourceToken?: string) =>
      loadTranscript(workflow, target as MultiReviewStepKind, { knownSourceToken }),
    [loadTranscript],
  );
  const { snapshot, lines, error } = useTranscriptTail({
    resource: "multi-review-step-transcript",
    workflowId,
    targetId: step,
    enabled: isActive && access.kind === "own",
    live,
    read,
    merge: mergeMultiReviewStepTranscript,
    toMessages: toMultiReviewStepMessages,
  });
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
      lines={session === "own" ? lines : []}
      live={live}
      empty={empty}
      error={session === "own" && Boolean(error)}
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

/**
 * Issues the reviewers have reported, merged, with who raised each. Rows no
 * accepted report confirms yet (reported through `report_finding`) are marked
 * provisional, or unconfirmed once their reviewer ended without a report.
 */
export function MultiReviewFindingsPane({
  findings,
  reviewerCount,
  provisionalCount = 0,
}: {
  findings: MultiReviewMergedFinding[];
  reviewerCount: number;
  provisionalCount?: number;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-h-0 flex-col">
      <div className="mb-3 flex items-baseline gap-2.5">
        <h2 id={headingId} className="text-sm font-semibold">
          Findings so far
        </h2>
        <span className="text-xs text-muted-foreground" data-testid="multi-review-findings-count">
          {findingCountSummary(findings, reviewerCount, provisionalCount)}
        </span>
      </div>
      {findings.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {reviewerCount === 0
            ? "Findings appear here as reviewers report them."
            : "The completed reviewers reported no issues."}
        </p>
      ) : (
        <ul className="max-h-96 min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
      )}
    </section>
  );
}
