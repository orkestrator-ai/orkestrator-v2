import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Circle,
  ClipboardList,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Square,
} from "lucide-react";
import type { ReviewFindingPool } from "@orkestrator/protocol/structured-review";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useOptionalTerminalContext } from "@/contexts";
import { reviewSeverityStyles, StructuredReviewReportView } from "./StructuredReviewReportView";
import type { LoopedReviewTabData } from "@/types/paneLayout";
import {
  hasReviewFindings,
  isLoopedReviewActivePhase,
  useLoopedReviewStore,
  type ArchivedReviewPool,
  type LoopedReviewPass,
  type LoopedReviewRound,
  type LoopedReviewSession,
  type LoopedReviewSessionPhase,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";
import { hydrateLoopedReviewWorkflow } from "@/lib/looped-review-persistence";
import * as backend from "@/lib/backend";

interface LoopedReviewTabProps {
  data: LoopedReviewTabData;
  isActive: boolean;
  hydrateWorkflow?: typeof hydrateLoopedReviewWorkflow;
  commands?: LoopedReviewCommands;
}

interface LoopedReviewCommands {
  pause: (workflowId: string) => Promise<LoopedReviewWorkflow>;
  resume: (workflowId: string) => Promise<LoopedReviewWorkflow>;
  retry: (workflowId: string) => Promise<LoopedReviewWorkflow>;
  cancel: (workflowId: string) => Promise<LoopedReviewWorkflow>;
  providerSession: typeof backend.getLoopedReviewProviderSession;
}

const defaultCommands: LoopedReviewCommands = {
  pause: backend.pauseLoopedReview,
  resume: backend.resumeLoopedReview,
  retry: backend.retryLoopedReview,
  cancel: backend.cancelLoopedReview,
  providerSession: backend.getLoopedReviewProviderSession,
};

/**
 * Where each key moves the stage selection.
 *
 * Both axes are bound, matching the build pipeline's stage rail: the ARIA tabs
 * pattern expects the orientation's own arrows, and binding the other pair too
 * costs nothing and spares a user who guessed the wrong axis.
 */
const STAGE_TAB_KEYS: Record<string, number | "first" | "last"> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
  Home: "first",
  End: "last",
};

function phaseLabel(workflow: LoopedReviewWorkflow): string {
  const labels: Record<LoopedReviewWorkflow["phase"], string> = {
    preparing: "Preparing immutable review package",
    discovering: "Discovering findings",
    reconciling: "Reconciling this pass",
    fixing: "Fixing active pool",
    "creating-pr": "Creating pull request",
    cancelling: "Cancelling provider work",
    paused: "Paused",
    failed: "Needs attention",
    cancelled: "Cancelled",
    completed: "Completed",
  };
  return labels[workflow.phase];
}

function sessionLabel(phase: LoopedReviewSessionPhase, round: number, pass?: number): string {
  if (phase === "preparation") return `Round ${round} · Package preparation`;
  if (phase === "discovery") return `Round ${round} · Review pass ${pass}`;
  if (phase === "fix") return `Round ${round} · Fix session`;
  return "Final · PR creation";
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function poolSummary(pool: ReviewFindingPool): string {
  if (!hasReviewFindings(pool)) return "No findings";
  return `${countLabel(pool.issues.length, "issue")} · ${countLabel(pool.coverageGaps.length, "gap")}`;
}

/**
 * Only `https://` links are ever rendered as an href. The PR URL originates
 * from agent output and is read back from an on-disk snapshot, so a
 * `javascript:` value would be one click from script execution in the Electron
 * renderer. The backend canonicalises the URL today; this is the second lock.
 */
function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** The rail's run state, mirroring the workflow rather than only nested status. */
type StageState = "running" | "paused" | "stopped" | "error" | "done";

/**
 * One entry in the stage rail.
 *
 * The looped review is navigated the same way a build is: a left rail of
 * stages, one panel at a time. The rail is built from the persisted rounds,
 * passes and archived pools rather than from `sessions`, because a snapshot can
 * carry a completed round whose provider sessions have already been released.
 */
type ReviewStage =
  | { kind: "overview"; id: string; label: string; sublabel: string }
  | {
      kind: "round";
      id: string;
      label: string;
      sublabel: string;
      state: StageState;
      round: LoopedReviewRound;
    }
  | {
      kind: "pass";
      id: string;
      label: string;
      sublabel: string;
      state: StageState;
      round: LoopedReviewRound;
      pass: LoopedReviewPass;
    }
  | { kind: "archive"; id: string; label: string; sublabel: string; archive: ArchivedReviewPool };

const roundStageId = (round: number) => `round:${round}`;
const passStageId = (round: number, pass: number) => `pass:${round}:${pass}`;
const archiveStageId = (archive: ArchivedReviewPool) =>
  `archive:${archive.round}:${archive.fixedAt}:${archive.fixSessionId}`;

function roundState(workflow: LoopedReviewWorkflow, round: LoopedReviewRound): StageState {
  if (round.status === "failed") return "error";
  if (round.status === "completed") return "done";
  if (round.round === workflow.currentRound && workflow.phase === "paused") return "paused";
  if (round.round === workflow.currentRound && workflow.phase === "cancelled") return "stopped";
  return "running";
}

function passState(workflow: LoopedReviewWorkflow, pass: LoopedReviewPass): StageState {
  if (pass.status === "failed") return "error";
  if (pass.status === "completed") return "done";
  const isActivePass = workflow.activeSessionId === pass.sessionId;
  // Old snapshots can predate the backend's persisted failed-pass status. The
  // workflow and active-session fence still identify the pass that stopped, so
  // the renderer must not show it spinning forever after a failure.
  if (isActivePass && workflow.phase === "failed") return "error";
  if (isActivePass && workflow.phase === "paused") return "paused";
  if (isActivePass && workflow.phase === "cancelled") return "stopped";
  return "running";
}

function stageStatusLabel(state: StageState, status: string): string {
  if (state === "paused") return `paused · ${status}`;
  if (state === "stopped") return `cancelled · ${status}`;
  if (state === "error" && status !== "failed") return `failed · ${status}`;
  return status;
}

function buildStages(workflow: LoopedReviewWorkflow): ReviewStage[] {
  const stages: ReviewStage[] = [
    {
      kind: "overview",
      id: "overview",
      label: "Overview",
      sublabel: poolSummary(workflow.activePool),
    },
  ];

  const archivesByRound = new Map<number, ArchivedReviewPool[]>();
  for (const archive of workflow.archivedPools) {
    const bucket = archivesByRound.get(archive.round);
    if (bucket) bucket.push(archive);
    else archivesByRound.set(archive.round, [archive]);
  }

  for (const round of workflow.rounds) {
    const state = roundState(workflow, round);
    stages.push({
      kind: "round",
      id: roundStageId(round.round),
      label: `Round ${round.round}`,
      sublabel: `${stageStatusLabel(state, round.status)} · allowance ${round.allowance}`,
      state,
      round,
    });
    for (const pass of round.passes) {
      const state = passState(workflow, pass);
      const status = stageStatusLabel(state, pass.status);
      stages.push({
        kind: "pass",
        id: passStageId(round.round, pass.pass),
        label: `Round ${round.round} · Pass ${pass.pass}`,
        sublabel: pass.report
          ? `${status} · ${countLabel(pass.report.issues.length, "issue")}`
          : status,
        state,
        round,
        pass,
      });
    }
    for (const archive of archivesByRound.get(round.round) ?? []) {
      stages.push({
        kind: "archive",
        id: archiveStageId(archive),
        label: `Round ${round.round} · Fix`,
        sublabel: poolSummary(archive.pool),
        archive,
      });
    }
    archivesByRound.delete(round.round);
  }

  // An archived pool whose round has been trimmed from the snapshot still has to
  // be reachable — it holds the findings a fix session claimed to have resolved.
  for (const round of [...archivesByRound.keys()].sort((a, b) => a - b)) {
    for (const archive of archivesByRound.get(round) ?? []) {
      stages.push({
        kind: "archive",
        id: archiveStageId(archive),
        label: `Round ${round} · Fix`,
        sublabel: poolSummary(archive.pool),
        archive,
      });
    }
  }

  return stages;
}

/**
 * The stage the rail follows while the user has not pinned one.
 *
 * The active provider session is the authoritative "what is happening now",
 * exactly as the build pipeline follows its current session. A snapshot with no
 * live session falls back to the newest report — the thing a returning user
 * came to read — and finally to the overview.
 */
function followedStageId(
  stages: ReviewStage[],
  activeSession: LoopedReviewSession | undefined,
): string {
  const ids = new Set(stages.map((stage) => stage.id));
  if (activeSession) {
    const { phase, round, pass } = activeSession;
    const candidate =
      phase === "discovery" && pass !== undefined
        ? passStageId(round, pass)
        : phase === "fix"
          ? (stages.findLast((stage) => stage.kind === "archive" && stage.archive.round === round)
              ?.id ?? roundStageId(round))
          : phase === "preparation"
            ? roundStageId(round)
            : "overview";
    if (ids.has(candidate)) return candidate;
  }
  return (
    stages.findLast((stage) => stage.kind === "pass" && Boolean(stage.pass.report))?.id ??
    "overview"
  );
}

function StageStateIcon({ state }: { state: StageState }) {
  if (state === "running") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  }
  if (state === "paused") {
    return <Pause className="h-3.5 w-3.5 text-amber-400" />;
  }
  if (state === "stopped") {
    return <Square className="h-3.5 w-3.5 text-muted-foreground" />;
  }
  if (state === "error") {
    return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
  }
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
}

/** The panel surface every stage draws on, matching the report card. */
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/50 bg-card/40 p-4 shadow-sm @sm:p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

function CardHeading({ children, meta }: { children: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold tracking-tight text-foreground">{children}</h2>
      {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
    </div>
  );
}

function PoolView({ pool }: { pool: ReviewFindingPool }) {
  if (!hasReviewFindings(pool))
    return <p className="text-sm text-muted-foreground">No pooled findings.</p>;
  return (
    <div className="space-y-3">
      {pool.issues.map((issue) => (
        <article
          key={issue.poolId}
          className={cn("rounded-lg border p-3.5", reviewSeverityStyles[issue.severity])}
        >
          <p className="text-xs opacity-80">
            {issue.poolId} · {issue.severity} · {issue.confidence}% · {issue.category}
          </p>
          <h3 className="mt-2 text-sm font-semibold text-foreground">{issue.title}</h3>
          <p className="mt-1 break-all font-mono text-xs text-foreground/65">
            {issue.file}
            {issue.line ? `:${issue.line}` : ""}
            {issue.symbol ? ` · ${issue.symbol}` : ""}
          </p>
          <dl className="mt-3 grid gap-2 text-sm text-foreground/85">
            <div>
              <dt className="inline font-medium text-foreground">Description: </dt>
              <dd className="inline">{issue.description}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-foreground">Evidence: </dt>
              <dd className="inline">{issue.evidence}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-foreground">Suggested fix: </dt>
              <dd className="inline">{issue.suggestion}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-foreground">Verification: </dt>
              <dd className="inline">{issue.verification}</dd>
            </div>
          </dl>
          {issue.alternativeFixes && issue.alternativeFixes.length > 0 && (
            <div className="mt-3 border-t border-current/15 pt-2">
              <p className="text-xs font-medium text-foreground">Alternative fixes</p>
              <ul className="mt-1.5 space-y-1.5 text-sm text-foreground/90">
                {/* Model output can legitimately repeat itself, so position is
                    the only stable key. */}
                {issue.alternativeFixes.map((alternative, index) => (
                  <li key={index} className="flex gap-2">
                    <span className="mt-[0.55rem] size-1 shrink-0 rounded-full bg-current/50" />
                    <span className="min-w-0">{alternative}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>
      ))}
      {pool.coverageGaps.map((gap) => (
        <article
          key={gap.poolId}
          className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-3.5"
        >
          <p className="break-all font-mono text-xs text-foreground/65">
            {gap.poolId} · {gap.file}
          </p>
          <p className="mt-1.5 text-sm text-foreground/85">{gap.untestedBehavior}</p>
        </article>
      ))}
    </div>
  );
}

export function LoopedReviewTab({
  data,
  isActive,
  hydrateWorkflow = hydrateLoopedReviewWorkflow,
  commands = defaultCommands,
}: LoopedReviewTabProps) {
  const instanceId = useId();
  const terminal = useOptionalTerminalContext();
  const workflow = useLoopedReviewStore((state) => state.workflows.get(data.workflowId));
  const replaceWorkflow = useLoopedReviewStore((state) => state.replaceWorkflow);
  const [hydrating, setHydrating] = useState(!workflow);
  // Hydration and command failures are tracked apart because `workflow` is a
  // fresh object on every backend revision: a running review re-runs the
  // hydration effect constantly, and a single shared error slot meant an
  // unrelated resource event erased the failure the user was still reading.
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  // Distinguishes "the user picked this stage" from "we auto-followed the
  // workflow", exactly as the build pipeline's rail does: without it the first
  // automatic pick pins the panel there for the rest of the run.
  const pinnedStageRef = useRef(false);
  const restoreGeneration = useRef(0);
  // React state does not update until the current event returns, so `disabled`
  // cannot stop a second click dispatched in the same tick. Without this, a
  // double click opens two provider tabs.
  const commandInFlight = useRef(false);

  const restoreWorkflow = useCallback(async () => {
    const generation = ++restoreGeneration.current;
    setHydrating(true);
    setHydrationError(null);
    try {
      const restored = await hydrateWorkflow(data.workflowId);
      if (restoreGeneration.current !== generation) return;
      setHydrating(false);
      if (!restored) {
        setHydrationError("The authoritative looped-review workflow could not be found.");
      }
    } catch (reason) {
      if (restoreGeneration.current !== generation) return;
      setHydrating(false);
      setHydrationError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [data.workflowId, hydrateWorkflow]);

  // The cleanup increments the generation fence, so reading the latest
  // `.current` at cleanup time is the point: it must invalidate whatever
  // restore is in flight, not the value captured when the effect ran.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (workflow) {
      ++restoreGeneration.current;
      setHydrating(false);
      setHydrationError(null);
      return;
    }
    void restoreWorkflow();
    return () => {
      // Reading the latest .current is the point: this is a generation fence
      // that must invalidate whatever restore is in flight at cleanup time, not
      // whichever value was current when the effect ran.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      ++restoreGeneration.current;
    };
  }, [restoreWorkflow, workflow]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  // Becoming visible *again* re-reads the authoritative record: a hidden tab can
  // miss resource events entirely. Only the false→true transition triggers it —
  // the mount effect above already covers first paint, and hydrating twice on
  // mount would double every read. The generation fence makes an out-of-order
  // response safe either way.
  const wasActive = useRef(isActive);
  useEffect(() => {
    const reactivated = isActive && !wasActive.current;
    wasActive.current = isActive;
    if (reactivated) void restoreWorkflow();
  }, [isActive, restoreWorkflow]);

  const runCommand = async (command: () => Promise<LoopedReviewWorkflow>) => {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    setCommandPending(true);
    setCommandError(null);
    try {
      replaceWorkflow(await command());
    } catch (reason) {
      setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      commandInFlight.current = false;
      setCommandPending(false);
    }
  };

  const openProviderSession = async (session: LoopedReviewSession) => {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    setCommandPending(true);
    setCommandError(null);
    try {
      const resolved = await commands.providerSession(workflow!.id, session.id);
      if (!resolved) throw new Error("The provider session is no longer available");
      const created = terminal?.createTab?.(workflow!.agent, {
        agentLaunchMode: "native",
        displayTitle: `${sessionLabel(session.phase, session.round, session.pass)} · Provider`,
        isReviewTab: true,
        resumeSessionId: resolved.providerSessionId,
        requireExistingResumeSession: true,
      });
      if (!created) throw new Error("A provider-session tab could not be opened");
    } catch (reason) {
      setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      commandInFlight.current = false;
      setCommandPending(false);
    }
  };

  const sessionById = useMemo(
    () => new Map(workflow?.sessions.map((session) => [session.id, session]) ?? []),
    [workflow?.sessions],
  );

  const activeSession = workflow?.activeSessionId
    ? sessionById.get(workflow.activeSessionId)
    : undefined;
  const stages = useMemo(() => (workflow ? buildStages(workflow) : []), [workflow]);
  const followedId = useMemo(() => followedStageId(stages, activeSession), [activeSession, stages]);

  const selectStage = useCallback((stageId: string) => {
    pinnedStageRef.current = true;
    setSelectedStageId(stageId);
  }, []);

  useEffect(() => {
    if (stages.length === 0) {
      setSelectedStageId(null);
      pinnedStageRef.current = false;
      return;
    }
    const selectionExists =
      selectedStageId !== null && stages.some((stage) => stage.id === selectedStageId);
    // A pinned stage that vanished from the snapshot is no longer a choice the
    // user can hold on to, so release the pin and follow the workflow again.
    if (!selectionExists) pinnedStageRef.current = false;
    if (selectionExists && pinnedStageRef.current) return;
    if (followedId !== selectedStageId) setSelectedStageId(followedId);
  }, [followedId, selectedStageId, stages]);

  if (hydrating)
    return (
      <div className="flex h-full items-center justify-center bg-background" role="status">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Restoring looped review…
        </span>
      </div>
    );
  if (!workflow)
    return (
      <div className="grid h-full place-items-center bg-background p-6">
        <div className="max-w-md rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-center">
          <AlertCircle className="mx-auto size-6 text-destructive" />
          <p className="mt-3 font-semibold">Looped review unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {hydrationError ?? "The workflow snapshot is missing."}
          </p>
          <Button
            className="mt-4"
            variant="outline"
            disabled={hydrating}
            onClick={() => void restoreWorkflow()}
          >
            <RefreshCw className="mr-2 size-4" />
            Retry restore
          </Button>
        </div>
      </div>
    );

  const selectedStage = stages.find((stage) => stage.id === selectedStageId) ?? stages[0];
  const history = workflow.sessions.flatMap((session) =>
    (session.interactionTranscript ?? []).map((entry) => ({
      session,
      entry: entry as {
        id: string;
        title: string;
        body?: string;
        kind: string;
        outcome: string;
      },
    })),
  );
  const prUrl = safeHttpUrl(workflow.pr.url);
  const active = isLoopedReviewActivePhase(workflow.phase);
  // A `useId` value is legal in an id and in an ARIA reference whatever
  // punctuation React puts in it; only a CSS selector would object, which is
  // why the keyboard handler below reaches for `getElementById`.
  const panelId = `${instanceId}panel`;
  const stageTabId = (stageId: string) => `${instanceId}stage-${stageId}`;

  /**
   * Move the selection to another stage from the keyboard.
   *
   * Taking `role="tab"` is a promise that arrow keys move between stages and
   * that only the selected stage is in the page tab sequence — a promise
   * `aria-orientation="vertical"` repeats.
   */
  const moveStageFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = STAGE_TAB_KEYS[event.key];
    if (step === undefined || stages.length === 0) return;
    // Consumed even when the selection does not move: a tablist owns these keys,
    // and letting one fall through to scroll the rail instead is the
    // inconsistency the pattern exists to remove.
    event.preventDefault();
    const current = stages.findIndex((stage) => stage.id === selectedStageId);
    const next =
      step === "first"
        ? 0
        : step === "last"
          ? stages.length - 1
          : (Math.max(current, 0) + step + stages.length) % stages.length;
    const target = stages[next];
    if (!target || target.id === selectedStageId) return;
    selectStage(target.id);
    document.getElementById(stageTabId(target.id))?.focus();
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label="Looped code review workflow"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/40 bg-zinc-900/40 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">Looped Code Review</div>
          <div
            className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {active ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : workflow.phase === "completed" ? (
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
            ) : workflow.phase === "failed" ? (
              <AlertCircle className="h-3 w-3 text-destructive" />
            ) : (
              <Circle className="h-3 w-3" />
            )}
            <span>{phaseLabel(workflow)}</span>
            <span>·</span>
            <span>Round {workflow.currentRound}</span>
            <span>·</span>
            <span>
              pass {workflow.currentPass || "—"}/{workflow.currentAllowance}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {workflow.agent} · {workflow.model}
            {workflow.reasoningEffort ? ` · ${workflow.reasoningEffort}` : ""}
            {` · target ${workflow.targetBranch}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {activeSession && (
            <Button
              size="sm"
              variant="outline"
              disabled={commandPending}
              onClick={() => void openProviderSession(activeSession)}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Provider session
            </Button>
          )}
          {workflow.phase === "failed" && (
            <Button
              size="sm"
              variant="outline"
              disabled={commandPending}
              onClick={() => void runCommand(() => commands.retry(workflow.id))}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry phase
            </Button>
          )}
          {active && (
            <Button
              size="sm"
              variant="outline"
              disabled={commandPending}
              onClick={() => void runCommand(() => commands.pause(workflow.id))}
            >
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              Pause
            </Button>
          )}
          {workflow.phase === "paused" && (
            <Button
              size="sm"
              variant="outline"
              disabled={commandPending}
              onClick={() => void runCommand(() => commands.resume(workflow.id))}
            >
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Resume
            </Button>
          )}
          {(active || workflow.phase === "paused" || workflow.phase === "failed") && (
            <Button
              size="sm"
              variant="ghost"
              disabled={commandPending}
              onClick={() => void runCommand(() => commands.cancel(workflow.id))}
            >
              <Square className="mr-1.5 h-3.5 w-3.5" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {(commandError ?? hydrationError) && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{commandError ?? hydrationError}</span>
        </div>
      )}
      {workflow.phase === "paused" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-200/90">
          <Pause className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">Workflow paused</span>
          <span className="min-w-0 flex-1 text-amber-200/70">
            Backend progress is paused at {workflow.pausedFromPhase ?? "the current phase"}.
          </span>
        </div>
      )}
      {workflow.phase === "cancelling" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-200/90">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span className="font-medium">Cancellation in progress</span>
          <span className="min-w-0 flex-1 text-amber-200/70">
            Waiting for provider work from {workflow.cancellingFromPhase ?? "the active phase"} to
            stop.
          </span>
        </div>
      )}
      {workflow.phase === "cancelled" && (
        <div className="flex items-center gap-2 border-b border-border/40 bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          <Circle className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">Workflow cancelled</span>
        </div>
      )}
      {workflow.phase === "failed" && workflow.failure && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">Phase failed · {workflow.failure.code}</span>
          <span className="min-w-0 flex-1">{workflow.failure.message}</span>
          <span className="text-destructive/70">
            Retry starts only the {workflow.failure.retryPhase} phase again.
          </span>
        </div>
      )}
      {workflow.pr.status === "failed" && workflow.pr.error && (
        <div className="flex flex-wrap items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">Pull request not created</span>
          <span className="min-w-0 flex-1">{workflow.pr.error}</span>
        </div>
      )}
      {workflow.phase === "completed" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/5 px-4 py-2 text-xs text-emerald-200/90">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">Review complete</span>
          {prUrl && (
            <a
              className="min-w-0 truncate underline underline-offset-2 transition-colors hover:text-emerald-100"
              href={prUrl}
              target="_blank"
              rel="noreferrer"
            >
              {workflow.pr.url}
            </a>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ScrollArea className="w-60 shrink-0 border-r border-border/40 bg-zinc-900/40">
          <div
            className="space-y-1 p-2"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Review stages"
            onKeyDown={moveStageFocus}
          >
            {stages.map((stage, index) => {
              const isSelected = selectedStage?.id === stage.id;
              return (
                <button
                  key={stage.id}
                  id={stageTabId(stage.id)}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-controls={panelId}
                  // One stop for the whole rail, then arrow keys within it —
                  // otherwise Tab walks every stage before reaching the panel.
                  tabIndex={isSelected || (selectedStageId === null && index === 0) ? 0 : -1}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-lg border px-2 py-2 text-left transition-colors",
                    isSelected
                      ? "border-zinc-700/70 bg-zinc-800/85"
                      : "border-transparent hover:bg-zinc-800/55",
                  )}
                  onClick={() => selectStage(stage.id)}
                >
                  {stage.kind === "overview" ? (
                    <ClipboardList className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : stage.kind === "archive" ? (
                    <Archive className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <StageStateIcon state={stage.state} />
                  )}
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block truncate text-xs font-medium",
                        isSelected ? "text-foreground" : "text-foreground/80",
                      )}
                    >
                      {stage.label}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {stage.sublabel}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>

        <ScrollArea
          className="@container min-w-0 flex-1"
          id={panelId}
          role="tabpanel"
          // A tabpanel is named by its own tab; only the no-selection case,
          // which has no tab to point at, needs a literal label.
          {...(selectedStage
            ? { "aria-labelledby": stageTabId(selectedStage.id) }
            : { "aria-label": "Looped review stage" })}
        >
          <div className="mx-auto max-w-3xl space-y-4 p-4 @sm:p-6">
            {selectedStage?.kind === "overview" && (
              <section aria-label="Looped review overview" className="space-y-4">
                <Card>
                  <CardHeading meta={poolSummary(workflow.activePool)}>
                    Active finding pool
                  </CardHeading>
                  <div className="mt-3">
                    <PoolView pool={workflow.activePool} />
                  </div>
                </Card>
                {history.length > 0 && (
                  <Card>
                    <CardHeading>
                      Unattended interaction history ({workflow.autoDeclineCount ?? 0}{" "}
                      auto-declined)
                    </CardHeading>
                    <div className="mt-3 space-y-2">
                      {history.map(({ session, entry }) => (
                        <article
                          key={`${session.id}:${entry.id}`}
                          className="rounded-lg border border-border/60 bg-background/30 p-3"
                        >
                          <p className="text-sm font-medium">{entry.title}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {sessionLabel(session.phase, session.round, session.pass)} ·{" "}
                            {entry.kind} · {entry.outcome}
                          </p>
                          {entry.body && (
                            <p className="mt-2 text-sm text-muted-foreground">{entry.body}</p>
                          )}
                        </article>
                      ))}
                    </div>
                  </Card>
                )}
              </section>
            )}

            {selectedStage?.kind === "round" && (
              <section
                aria-label={`Review round ${selectedStage.round.round}`}
                className="space-y-4"
              >
                <Card>
                  <CardHeading
                    meta={`${selectedStage.round.status} · allowance ${selectedStage.round.allowance}`}
                  >
                    Round {selectedStage.round.round}
                  </CardHeading>
                  {selectedStage.round.package ? (
                    <dl className="mt-3 grid gap-x-5 gap-y-2 @md:grid-cols-2">
                      <div>
                        <dt className="text-xs text-muted-foreground">Base ref</dt>
                        <dd className="break-all font-mono text-xs">
                          {selectedStage.round.package.baseRef}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Head ref</dt>
                        <dd className="break-all font-mono text-xs">
                          {selectedStage.round.package.headRef}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Changed files</dt>
                        <dd className="text-xs">
                          {countLabel(
                            "kind" in selectedStage.round.package
                              ? selectedStage.round.package.changedFileCount
                              : selectedStage.round.package.changedFiles.length,
                            "changed file",
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Diff size</dt>
                        <dd className="text-xs">
                          {("kind" in selectedStage.round.package
                            ? selectedStage.round.package.diffCharacters
                            : selectedStage.round.package.completeDiff.length
                          ).toLocaleString()}{" "}
                          diff characters
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">
                      No review package has been prepared for this round yet.
                    </p>
                  )}
                  {/* The user cannot judge a review without knowing the package
                      it ran against was truncated — omitted files, skipped
                      validation. */}
                  {selectedStage.round.package &&
                    selectedStage.round.package.limitations.length > 0 && (
                      <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                        <h3 className="text-sm font-medium text-amber-300">
                          Review package limitations
                        </h3>
                        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                          {selectedStage.round.package.limitations.map((limitation, index) => (
                            <li key={index}>{limitation}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                </Card>

                <Card>
                  <CardHeading>Review passes</CardHeading>
                  {selectedStage.round.passes.length === 0 ? (
                    <p className="mt-3 text-sm text-muted-foreground">No completed passes yet.</p>
                  ) : (
                    <div className="mt-3 space-y-1.5">
                      {selectedStage.round.passes.map((pass) => (
                        <button
                          key={pass.pass}
                          type="button"
                          className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background/30 px-3 py-2 text-left transition-colors hover:bg-zinc-800/55"
                          onClick={() =>
                            selectStage(passStageId(selectedStage.round.round, pass.pass))
                          }
                        >
                          <StageStateIcon state={passState(workflow, pass)} />
                          <span className="min-w-0 flex-1 truncate text-xs font-medium">
                            Pass {pass.pass}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {pass.report
                              ? `${pass.status} · ${countLabel(pass.report.issues.length, "issue")}`
                              : pass.status}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </Card>
              </section>
            )}

            {selectedStage?.kind === "pass" && (
              <section className="space-y-4">
                <Card>
                  <CardHeading meta={selectedStage.pass.status}>
                    Round {selectedStage.round.round} · Pass {selectedStage.pass.pass}
                  </CardHeading>
                  {sessionById.get(selectedStage.pass.sessionId) && (
                    <p className="mt-1.5 break-all font-mono text-xs text-muted-foreground">
                      session {sessionById.get(selectedStage.pass.sessionId)!.providerSessionId}
                    </p>
                  )}
                </Card>
                {/* Every report needs its own accessible name; without a heading
                    they all render as the identical default label. */}
                {selectedStage.pass.report ? (
                  <StructuredReviewReportView
                    report={selectedStage.pass.report}
                    heading={`Round ${selectedStage.round.round}, pass ${selectedStage.pass.pass} report`}
                    collapsibleSections
                    showRawJson={false}
                  />
                ) : (
                  <Card>
                    <p className="text-sm text-muted-foreground">
                      This pass has not produced a structured report yet.
                    </p>
                  </Card>
                )}
              </section>
            )}

            {selectedStage?.kind === "archive" && (
              <section
                aria-label={`Archived findings from round ${selectedStage.archive.round}`}
                className="space-y-4"
              >
                <Card>
                  <CardHeading meta={poolSummary(selectedStage.archive.pool)}>
                    Archived pool · round {selectedStage.archive.round}
                  </CardHeading>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Fix session {selectedStage.archive.fixSessionId}
                  </p>
                  {selectedStage.archive.fixSummary && (
                    <p className="mt-3 text-sm text-foreground/85">
                      {selectedStage.archive.fixSummary}
                    </p>
                  )}
                  {selectedStage.archive.fixNotes && selectedStage.archive.fixNotes.length > 0 && (
                    <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {/* Archived notes never reorder, and a model can
                          legitimately repeat itself, so the position is the only
                          stable key. */}
                      {selectedStage.archive.fixNotes.map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card>
                  <CardHeading>Findings fixed in this round</CardHeading>
                  <div className="mt-3">
                    <PoolView pool={selectedStage.archive.pool} />
                  </div>
                </Card>
              </section>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
