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
import type { MultiReviewReviewerTranscript } from "@orkestrator/protocol/multi-review";
import { PLATFORM_ICON_CLASS } from "@/components/icons/AgentIcons";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as backend from "@/lib/backend";
import type { RuntimeParts } from "@/lib/review/runtime-summary";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { cn } from "@/lib/utils";
import {
  REFRESH_INTERVAL_MS,
  mergeMultiReviewReviewerTranscript,
  toMultiReviewReviewerMessages,
} from "./MultiReviewReviewerTab";
import { MultiReviewFlowStateIcon, type MultiReviewFlowNodeModel } from "./MultiReviewFlowGraph";
import { reviewSeverityStyles } from "./StructuredReviewReportView";
import type { MultiReviewFlowState, MultiReviewMergedFinding } from "./multi-review-flow";

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
 * `think`, `say`) and its subject. It is a glance at what the reviewer is doing,
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

/**
 * The reviewer read model the reviewer tab polls, reduced to a bounded tail.
 * Each read sends the last source token, so an unchanged transcript costs a
 * status projection; a workflow checkpoint reads at once instead of waiting
 * for the interval, and only a live reviewer in an active tab is polled.
 */
function useReviewerTranscriptTail({
  workflowId,
  reviewerId,
  enabled,
  live,
  loadTranscript,
}: {
  workflowId: string;
  reviewerId: string;
  enabled: boolean;
  live: boolean;
  loadTranscript: typeof backend.getMultiReviewReviewerTranscript;
}) {
  const viewKey = `${workflowId}\u0000${reviewerId}`;
  // Each answer is tagged with the reviewer it was read for, so switching
  // reviewers shows nothing stale and needs no reset pass.
  const [read, setRead] = useState<{
    viewKey: string;
    snapshot: MultiReviewReviewerTranscript | null;
    error: string | null;
  }>({ viewKey, snapshot: null, error: null });
  const snapshotRef = useRef<MultiReviewReviewerTranscript | null>(null);
  const sourceToken = useRef<string | undefined>(undefined);
  const readKey = useRef(viewKey);
  const inFlight = useRef<{ viewKey: string; promise: Promise<void> } | null>(null);
  const workflowRevision = useMultiReviewStore(
    (state) => state.workflows.get(workflowId)?.backendRevision,
  );

  const refresh = useCallback((): Promise<void> => {
    const requestKey = `${workflowId}\u0000${reviewerId}`;
    if (readKey.current !== requestKey) {
      // Another reviewer: never confirm a token this view no longer shows.
      readKey.current = requestKey;
      sourceToken.current = undefined;
      snapshotRef.current = null;
      inFlight.current = null;
    }
    if (inFlight.current?.viewKey === requestKey) return inFlight.current.promise;
    // Assigned before the body can settle, so `finally` always sees it.
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const next = await loadTranscript(workflowId, reviewerId, {
          knownSourceToken: sourceToken.current,
        });
        if (readKey.current !== requestKey || !next) return;
        sourceToken.current = next.sourceToken;
        const merged = mergeMultiReviewReviewerTranscript(snapshotRef.current, next);
        snapshotRef.current = merged;
        setRead({ viewKey: requestKey, snapshot: merged, error: null });
      } catch (reason) {
        if (readKey.current !== requestKey) return;
        const error = reason instanceof Error ? reason.message : String(reason);
        setRead({ viewKey: requestKey, snapshot: snapshotRef.current, error });
      } finally {
        if (inFlight.current?.promise === promise) inFlight.current = null;
      }
    })();
    inFlight.current = { viewKey: requestKey, promise };
    return promise;
  }, [loadTranscript, reviewerId, workflowId]);

  // Selection, activation and every workflow checkpoint read once; bursts
  // coalesce onto the request already in flight.
  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh, workflowRevision]);

  const pollInstance = useId();
  useCoordinatedRead<void>({
    key: {
      resource: "multi-review-reviewer-transcript",
      target: `${workflowId}\u0000${reviewerId}`,
      view: pollInstance,
    },
    enabled,
    readOnSubscribe: false,
    demand: { active: enabled && live, intervalMs: REFRESH_INTERVAL_MS, priority: "standard" },
    read: () => refresh(),
  });

  const current = read.viewKey === viewKey ? read : null;
  const snapshot = current?.snapshot ?? null;
  const lines = useMemo(
    () => (snapshot ? transcriptTailLines(toMultiReviewReviewerMessages(snapshot)) : []),
    [snapshot],
  );
  return { snapshot, lines, error: current?.error ?? null };
}

/** Distance from the bottom within which the tail keeps following new lines. */
const FOLLOW_THRESHOLD_PX = 24;

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
  const { snapshot, lines, error } = useReviewerTranscriptTail({
    workflowId,
    reviewerId,
    enabled: isActive && hasSession,
    live,
    loadTranscript,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useEffect(() => {
    following.current = true;
  }, [reviewerId]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

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
    <div
      ref={scrollRef}
      data-testid="multi-review-transcript-tail"
      aria-label="Latest reviewer activity"
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
        lines.map((line) => (
          <div key={line.key} className="truncate" title={line.text}>
            <span className="mr-2 text-cyan-300">{line.kind}</span>
            {line.text}
          </div>
        ))
      )}
      {live && lines.length > 0 ? (
        <div aria-hidden="true" className="animate-pulse text-cyan-300 motion-reduce:animate-none">
          ▍
        </div>
      ) : null}
    </div>
  );
}

function ReviewerAvatar({ source }: { source: MultiReviewMergedFinding["sources"][number] }) {
  return (
    <span
      title={`Reviewer ${source.index + 1} · ${source.agent} · ${source.model}`}
      className={cn(
        "-ml-1 grid size-[18px] place-items-center rounded-[5px] border-2 border-background bg-elevated font-mono text-[9.5px] font-bold first:ml-0",
        PLATFORM_ICON_CLASS[source.agent],
      )}
    >
      {source.index + 1}
    </span>
  );
}

/** Issues the completed reviewers have reported, merged, with who raised each. */
export function MultiReviewFindingsPane({
  findings,
  reviewerCount,
}: {
  findings: MultiReviewMergedFinding[];
  reviewerCount: number;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-h-0 flex-col">
      <div className="mb-3 flex items-baseline gap-2.5">
        <h2 id={headingId} className="text-sm font-semibold">
          Findings so far
        </h2>
        <span className="text-xs text-muted-foreground" data-testid="multi-review-findings-count">
          {findings.length} · from {reviewerCount} {reviewerCount === 1 ? "reviewer" : "reviewers"}
        </span>
      </div>
      {findings.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {reviewerCount === 0
            ? "Findings appear here as each reviewer completes."
            : "The completed reviewers reported no issues."}
        </p>
      ) : (
        <ul className="max-h-96 min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {findings.map((finding) => (
            <li
              key={finding.key}
              className="flex items-start gap-2.5 border-t border-divider/70 py-2 first:border-t-0"
            >
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-[5px] border px-1.5 text-[10.5px] leading-4",
                  reviewSeverityStyles[finding.severity],
                )}
              >
                {finding.severity}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium break-words">{finding.title}</p>
                <p className="truncate font-mono text-[11.5px] text-muted-foreground">
                  {finding.line ? `${finding.file}:${finding.line}` : finding.file}
                </p>
              </div>
              <span
                className="mt-0.5 flex shrink-0"
                aria-label={`Raised by ${finding.sources.map((source) => `Reviewer ${source.index + 1}`).join(", ")}`}
              >
                {finding.sources.map((source) => (
                  <ReviewerAvatar key={source.reviewerId} source={source} />
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
