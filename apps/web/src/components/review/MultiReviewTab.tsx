import { ReviewValidationStatus } from "./ReviewValidationStatus";
import { WorkflowResultStatus } from "./WorkflowResultStatus";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ExternalLink,
  GitPullRequest,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Wrench,
} from "lucide-react";
import {
  multiReviewStepSessionAccess,
  type MultiReviewPhase,
  type MultiReviewStepKind,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { MultiReviewTabData } from "@/types/paneLayout";
import { Button } from "@/components/ui/button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StructuredReviewReportView } from "./StructuredReviewReportView";
import { StackedEyes } from "./MultiReviewLaunchDialog";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useMultiReviewPrPhase } from "./useMultiReviewPrPhase";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { hydrateMultiReviewWorkflow } from "@/lib/multi-review-persistence";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { MultiReviewReviewerTab } from "./MultiReviewReviewerTab";
import * as backend from "@/lib/backend";
import { MultiReviewFixPromptDialog } from "./MultiReviewFixPromptDialog";
import { MultiReviewRestartDialog } from "./MultiReviewRestartDialog";
import { useReviewModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { formatElapsedWithHours } from "@/lib/format-elapsed";
import { formatTokenCount } from "@/lib/context-usage";
import { formatRuntimeParts, runtimeParts, type RuntimeParts } from "@/lib/review/runtime-summary";
import {
  flowNodeElementId,
  MultiReviewFlowGraph,
  type MultiReviewFlowNodeModel,
} from "./MultiReviewFlowGraph";
import {
  MultiReviewFindingsBadge,
  MultiReviewInspectorHeader,
  ReviewerTranscriptTail,
  StepTranscriptTail,
} from "./MultiReviewInspector";
import {
  defaultFlowSelection,
  flowPendingLabel,
  latestActivityAt,
  mergeReviewerFindings,
  multiReviewElapsedSeconds,
  multiReviewFlowEdges,
  multiReviewTotalTokens,
  reviewerFlowState,
  severityCounts,
} from "./multi-review-flow";
import {
  autoPrLaunchNotice,
  consolidationStep,
  findingCountLabel,
  fixStep,
  modelDetail,
  multiReviewFixSessionTabOptions,
  multiReviewReviewSession,
  multiReviewReviewSessionTabOptions,
  multiReviewStepError,
  multiReviewStepRuntimeParts,
  openFixSessionError,
  pullRequestDetail,
  pullRequestStep,
  reviewerColumnLabel,
  reviewerProgressSummary,
  reviewerPendingLabel,
  reviewerProvisionalSummary,
  reviewerStatusLabel,
  reviewerStatusNote,
  reviewerStatusWord,
  reviewerTranscriptLabel,
  reviewPackageGenerationStep,
  stepOpenTitle,
  stepStatusWord,
  validationChips,
  type FixSessionOpenOutcome,
  type MultiReviewStepKey,
  type MultiReviewStepStatus,
} from "./multi-review-steps";

interface MultiReviewCommands {
  address: (workflowId: string) => Promise<MultiReviewWorkflow>;
  customFix?: (
    workflowId: string,
    fixModel: MultiReviewWorkflow["fixModel"],
    instruction: string,
  ) => Promise<MultiReviewWorkflow>;
  retry: (workflowId: string) => Promise<MultiReviewWorkflow>;
  cancel: (workflowId: string) => Promise<MultiReviewWorkflow>;
  stopValidation?: (workflowId: string) => Promise<MultiReviewWorkflow>;
  stopReviewer: (workflowId: string, reviewerId: string) => Promise<MultiReviewWorkflow>;
  restartReviewer?: (workflowId: string, reviewerId: string) => Promise<MultiReviewWorkflow>;
  restartStep?: (
    workflowId: string,
    kind: MultiReviewStepKind,
    model?: MultiReviewWorkflow["fixModel"],
  ) => Promise<MultiReviewWorkflow>;
  pauseStep?: (workflowId: string, kind: MultiReviewStepKind) => Promise<MultiReviewWorkflow>;
  resumeStep?: (workflowId: string, kind: MultiReviewStepKind) => Promise<MultiReviewWorkflow>;
  unstickReviewer?: (workflowId: string, reviewerId: string) => Promise<MultiReviewWorkflow>;
}

const defaultCommands: MultiReviewCommands = {
  address: backend.addressMultiReview,
  customFix: (workflowId, fixModel, instruction) =>
    backend.startMultiReviewCustomFix({ workflowId, fixModel, instruction }),
  retry: backend.retryMultiReview,
  cancel: backend.cancelMultiReview,
  stopValidation: backend.stopMultiReviewValidation,
  stopReviewer: backend.stopMultiReviewReviewer,
  restartReviewer: backend.restartMultiReviewReviewer,
  restartStep: backend.restartMultiReviewStep,
  pauseStep: backend.pauseMultiReviewStep,
  resumeStep: backend.resumeMultiReviewStep,
  unstickReviewer: backend.unstickMultiReviewReviewer,
};

interface MultiReviewTabProps {
  data: MultiReviewTabData;
  isActive: boolean;
  hydrateWorkflow?: typeof hydrateMultiReviewWorkflow;
  commands?: MultiReviewCommands;
  openReviewer?: (reviewerId: string, index: number) => void;
  /** Reads the selected reviewer's transcript tail for the inspector. */
  loadReviewerTranscript?: typeof backend.getMultiReviewReviewerTranscript;
  /** Reads the selected step's transcript tail for the inspector. */
  loadStepTranscript?: typeof backend.getMultiReviewStepTranscript;
  loadPrSessionState?: typeof backend.getNativeAgentSessionStateUpdate;
}

function phaseCopy(workflow: MultiReviewWorkflow): string {
  const labels = {
    preparing: "Discovering validation, running checks, and preparing shared evidence",
    reviewing: "Independent read-only reviews are running",
    consolidating: "The review preparation model is consolidating findings",
    ready: "Consolidated report ready",
    fixing: "The fix model is addressing every finding",
    interactive: "The fix model is working interactively",
    paused: "Multi Review paused",
    completed: "All findings were addressed",
    cancelling: "Cancelling Multi Review",
    cancelled: "Multi Review cancelled",
    failed: "Multi Review needs attention",
  } as const;
  if (
    workflow.phase === "interactive" &&
    workflow.addressPromptPending !== true &&
    workflow.fixSession?.status === "idle" &&
    workflow.stepRuntimes?.fix?.completedAt !== undefined
  ) {
    return "The fix session finished and is ready for follow-up";
  }
  if (
    workflow.phase === "interactive" &&
    workflow.addressPromptPending !== true &&
    workflow.fixSession?.status === "failed"
  ) {
    return workflow.fixSession.error ?? "The fix session stopped with an error";
  }
  return labels[workflow.phase];
}

/** Phases in which the backend is doing work rather than waiting for the user. */
function isBusyPhase(phase: MultiReviewPhase): boolean {
  return (
    phase === "preparing" ||
    phase === "reviewing" ||
    phase === "consolidating" ||
    phase === "fixing" ||
    phase === "cancelling"
  );
}

const AUTO_PR_NOTICE_TONE_CLASS = {
  muted: "border-border/60 bg-muted/30 text-muted-foreground",
  success: "border-emerald-500/25 bg-emerald-500/5 text-foreground/85",
  warning: "border-amber-500/30 bg-amber-500/8 text-amber-500",
} as const;

function AutoPrLaunchNotice({
  launch,
}: {
  launch: NonNullable<MultiReviewWorkflow["autoPrLaunch"]>;
}) {
  const notice = autoPrLaunchNotice(launch);
  return (
    <div
      data-testid="multi-review-auto-pr-notice"
      className={`rounded-lg border p-3 text-sm ${AUTO_PR_NOTICE_TONE_CLASS[notice.tone]}`}
    >
      {notice.text}
    </div>
  );
}

const NOTE_TONE_CLASS = {
  muted: "text-muted-foreground",
  warning: "text-amber-500",
  destructive: "text-destructive",
} as const;

type ReviewTileActivation = { kind: "pointer"; pointerId: number } | { kind: "keyboard" } | null;

/**
 * Keep the browser-only trusted-click exception independently testable: DOM
 * test environments cannot manufacture events whose `isTrusted` flag is true.
 */
export function allowsReviewTileActivation(
  requireDirectActivation: boolean,
  hasDirectActivation: boolean,
  clickDetail: number,
  isTrusted: boolean,
): boolean {
  return !requireDirectActivation || hasDirectActivation || (clickDetail === 0 && isTrusted);
}

const INSPECTOR_BUTTON_CLASS = "h-7 gap-1.5 px-2.5 text-xs";

/**
 * Open session for the selected node.
 *
 * Preparation and consolidation are backend-owned sessions: with
 * `requireDirectActivation` their tab opens only for a pointer or keyboard
 * input that began on this button, so a gesture that mounted the review (and
 * whose click lands here) cannot pull the session into the pane layout.
 */
function SessionOpenButton({
  label,
  title,
  enabled,
  onOpen,
  requireDirectActivation = false,
}: {
  label: string;
  title?: string;
  enabled: boolean;
  onOpen: () => void;
  requireDirectActivation?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const directActivationRef = useRef<ReviewTileActivation>(null);

  useEffect(() => {
    if (!requireDirectActivation) return;

    const clearFinishedPointerOutsideButton = (event: PointerEvent) => {
      const activation = directActivationRef.current;
      if (activation?.kind !== "pointer" || activation.pointerId !== event.pointerId) return;

      const target = event.target;
      if (!(target instanceof Node) || !buttonRef.current?.contains(target)) {
        directActivationRef.current = null;
      }
    };
    const clearCancelledPointer = (event: PointerEvent) => {
      const activation = directActivationRef.current;
      if (activation?.kind === "pointer" && activation.pointerId === event.pointerId) {
        directActivationRef.current = null;
      }
    };

    window.addEventListener("pointerup", clearFinishedPointerOutsideButton);
    window.addEventListener("pointercancel", clearCancelledPointer);
    return () => {
      window.removeEventListener("pointerup", clearFinishedPointerOutsideButton);
      window.removeEventListener("pointercancel", clearCancelledPointer);
    };
  }, [requireDirectActivation]);

  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="outline"
      size="sm"
      className={INSPECTOR_BUTTON_CLASS}
      disabled={!enabled}
      aria-label={label}
      title={title}
      onPointerDown={(event) => {
        if (event.isPrimary === false || event.button !== 0) return;
        directActivationRef.current = { kind: "pointer", pointerId: event.pointerId };
      }}
      onPointerCancel={(event) => {
        const activation = directActivationRef.current;
        if (activation?.kind === "pointer" && activation.pointerId === event.pointerId) {
          directActivationRef.current = null;
        }
      }}
      onBlur={() => {
        if (directActivationRef.current?.kind === "keyboard") directActivationRef.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          directActivationRef.current = { kind: "keyboard" };
        }
      }}
      onClick={(event) => {
        const hasDirectActivation = directActivationRef.current !== null;
        directActivationRef.current = null;
        // A trusted detail-zero click is an assistive-technology activation.
        // Pointer and keyboard activation are armed above; synthetic and
        // carry-over clicks are deliberately ignored.
        if (
          !allowsReviewTileActivation(
            requireDirectActivation,
            hasDirectActivation,
            event.detail,
            event.nativeEvent.isTrusted,
          )
        ) {
          return;
        }
        onOpen();
      }}
    >
      <ExternalLink className="size-3.5" />
      Open session
    </Button>
  );
}

/** A node in the graph, plus what the inspector shows when it is selected. */
interface MultiReviewFlowNodeView {
  node: MultiReviewFlowNodeModel;
  actions: ReactNode;
  body: ReactNode;
  activityAt?: number;
}

type InspectorBodyTab = "transcript" | "report";

/**
 * The inspector's lower section: the node's transcript, and the report it
 * filed once there is one. The transcript stays mounted behind the report so
 * returning to it keeps its scroll position and follow state.
 */
function InspectorTranscriptTabs({
  transcript,
  report,
  tab,
  onTabChange,
}: {
  transcript: ReactNode;
  report: ReactNode;
  tab: InspectorBodyTab;
  onTabChange: (tab: InspectorBodyTab) => void;
}) {
  if (!report) return transcript;
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as InspectorBodyTab)}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
    >
      <TabsList aria-label="Inspector views" className="h-7 rounded-md p-0.5">
        <TabsTrigger className="h-6 px-2 text-xs" value="transcript">
          Transcript
        </TabsTrigger>
        <TabsTrigger className="h-6 px-2 text-xs" value="report">
          Report
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="transcript"
        forceMount
        className="flex min-h-0 min-w-0 flex-col data-[state=inactive]:hidden"
      >
        {transcript}
      </TabsContent>
      <TabsContent value="report" className="min-w-0">
        {report}
      </TabsContent>
    </Tabs>
  );
}

function StepFacts({
  model,
  runtime,
  status,
}: {
  model: MultiReviewWorkflow["fixModel"];
  runtime: RuntimeParts | null;
  status: MultiReviewStepStatus;
}) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
      <dt className="text-muted-foreground">Model</dt>
      <dd className="truncate">{modelDetail(model, true)}</dd>
      <dt className="text-muted-foreground">Runtime</dt>
      <dd className="font-mono tabular-nums">
        {runtime
          ? formatRuntimeParts(runtime)
          : status.state === "not-started"
            ? "Not started yet"
            : "Not recorded"}
      </dd>
    </dl>
  );
}

function MultiReviewOverviewTab({
  data,
  isActive,
  hydrateWorkflow = hydrateMultiReviewWorkflow,
  commands = defaultCommands,
  openReviewer,
  loadReviewerTranscript,
  loadStepTranscript,
  loadPrSessionState,
}: MultiReviewTabProps) {
  const createTab = useOptionalTerminalContext()?.createTab;
  const workflow = useMultiReviewStore((state) => state.workflows.get(data.workflowId));
  const replaceWorkflow = useMultiReviewStore((state) => state.replaceWorkflow);
  const [error, setError] = useState<string | null>(null);
  const [presentationNotice, setPresentationNotice] = useState<string | null>(null);
  const [openAfterDelivery, setOpenAfterDelivery] = useState(false);
  const [pending, setPending] = useState(false);
  const [stoppingReviewerId, setStoppingReviewerId] = useState<string | null>(null);
  const [stoppingValidation, setStoppingValidation] = useState(false);
  const [reviewerAction, setReviewerAction] = useState<{
    reviewerId: string;
    kind: "restart" | "unstick";
  } | null>(null);
  const [restartingStep, setRestartingStep] = useState<MultiReviewStepKind | null>(null);
  const [stepLifecycleAction, setStepLifecycleAction] = useState<{
    kind: MultiReviewStepKind;
    action: "pause" | "resume";
  } | null>(null);
  const [restartDialogStep, setRestartDialogStep] = useState<MultiReviewStepKind | null>(null);
  const [restartDialogError, setRestartDialogError] = useState<string | null>(null);
  const [customFixPromptOpen, setCustomFixPromptOpen] = useState(false);
  const [customFixPending, setCustomFixPending] = useState(false);
  const [customFixError, setCustomFixError] = useState<string | null>(null);
  const modelCatalog = useReviewModelCatalog(
    workflow?.projectId ?? "",
    customFixPromptOpen || restartDialogStep !== null,
  );
  const [reviewPanelNow, setReviewPanelNow] = useState(() => Date.now());
  /** The node the user picked; null follows the running node. */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Each node remembers whether its transcript or its report was last shown.
  const [inspectorTabs, setInspectorTabs] = useState<Record<string, InspectorBodyTab>>({});
  /** The tab's root, which the graph's fullscreen covers. */
  const [tabRoot, setTabRoot] = useState<HTMLDivElement | null>(null);
  const panelId = useId();
  const mountedRef = useRef(false);
  const isActiveRef = useRef(isActive);

  const hasRunningReviewer = workflow?.reviewers.some(
    (reviewer) => reviewer.status === "running" && reviewer.startedAt,
  );
  const hasRunningFixSession =
    workflow?.fixSession?.status === "running" ||
    workflow?.reviewSession?.status === "running" ||
    (workflow?.phase === "interactive" &&
      workflow.stepRuntimes?.fix !== undefined &&
      workflow.stepRuntimes.fix.completedAt === undefined);
  const hasRunningValidation =
    workflow?.validationRun?.status === "planned" || workflow?.validationRun?.status === "running";
  // The header measures review, validation and Fix; PR work has no workflow timing record.
  const hasLiveClock = Boolean(
    hasRunningReviewer ||
    hasRunningFixSession ||
    hasRunningValidation ||
    (workflow && isBusyPhase(workflow.phase)),
  );

  useEffect(() => {
    if (!isActive || !hasLiveClock) return;
    // The clock is the external system this effect subscribes to. Resuming it
    // reads the time at once, so the header never shows the time it paused at
    // for a second; reading it while rendering would be impure.
    // oxlint-disable-next-line react/set-state-in-effect
    setReviewPanelNow(Date.now());
    const interval = window.setInterval(() => setReviewPanelNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasLiveClock, isActive]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // The user navigated away after requesting the handoff. Delivery continues
  // in the backend, but a hidden review tab must never change pane focus.
  const [wasActive, setWasActive] = useState(isActive);
  if (wasActive !== isActive) {
    setWasActive(isActive);
    if (!isActive) setOpenAfterDelivery(false);
  }

  /** Reads the workflow without clearing the last error; `hydrate` does both. */
  const fetchWorkflow = useCallback(
    () =>
      // The executor turns a synchronous throw into a rejection, as `await` did.
      new Promise<Awaited<ReturnType<typeof hydrateWorkflow>>>((resolve) =>
        resolve(hydrateWorkflow(data.workflowId)),
      ).then(
        (result) => {
          if (!result) setError("The authoritative Multi Review workflow could not be found.");
        },
        (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
      ),
    [data.workflowId, hydrateWorkflow],
  );

  const hydrate = () => {
    setError(null);
    void fetchWorkflow();
  };

  // Every (re)activation reads the workflow again, starting without an error.
  const [hydratedFor, setHydratedFor] = useState({ fetchWorkflow, isActive });
  if (hydratedFor.fetchWorkflow !== fetchWorkflow || hydratedFor.isActive !== isActive) {
    setHydratedFor({ fetchWorkflow, isActive });
    setError(null);
  }

  useEffect(() => {
    void fetchWorkflow();
  }, [fetchWorkflow, isActive]);

  const openFixSession = useCallback(
    (target: MultiReviewWorkflow | undefined): FixSessionOpenOutcome => {
      if (!target) return "no-session";
      const options = multiReviewFixSessionTabOptions(target);
      if (!options) return "no-session";
      if (!createTab) return "environment-unavailable";
      return createTab(target.fixModel.agent, options) ? "opened" : "tab-rejected";
    },
    [createTab],
  );

  const presentFixSession = useCallback(
    (target: MultiReviewWorkflow | undefined, source: "automatic" | "manual") => {
      setPresentationNotice(null);
      const outcome = openFixSession(target);
      if (outcome === "opened") {
        setError(null);
        return;
      }
      if (outcome === "no-session") {
        setError(openFixSessionError(outcome, source));
        return;
      }
      setError(null);
      setPresentationNotice(openFixSessionError(outcome, source));
    },
    [openFixSession],
  );

  const presentReviewSession = useCallback(
    (target: MultiReviewWorkflow | undefined, step: "prepare" | "consolidate") => {
      setPresentationNotice(null);
      if (!target) {
        setError("The review preparation session is no longer available");
        return;
      }
      const session = multiReviewReviewSession(target, step);
      const options = multiReviewReviewSessionTabOptions(target, step);
      if (!session || !options) {
        setError("The review preparation session is no longer available");
        return;
      }
      if (!createTab) {
        setError("The environment is not ready to open the review preparation session.");
        return;
      }
      // Consolidation may run on its own provider (Restart in…), so open the
      // tab with the agent that owns the session rather than the prepare model.
      if (!createTab(session.agent, options)) {
        setError(
          "The review preparation tab could not be opened. Close another tab if the workspace is at its limit, then try again.",
        );
        return;
      }
      setError(null);
    },
    [createTab],
  );

  useEffect(() => {
    if (!openAfterDelivery || !workflow || workflow.addressPromptPending === true) return;
    // Consumes the one-shot request in the step that acts on it: opening the
    // Fix tab (`createTab`) is a side effect that cannot run while rendering,
    // and the request must not survive to open a second tab.
    // oxlint-disable-next-line react/set-state-in-effect
    setOpenAfterDelivery(false);
    if (isActive && workflow.phase === "interactive") presentFixSession(workflow, "automatic");
  }, [isActive, openAfterDelivery, presentFixSession, workflow]);

  const run = async (command: () => Promise<NonNullable<typeof workflow>>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      replaceWorkflow(await command());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  /**
   * Stopping one reviewer is deliberately not the workflow-wide `run` gate: the
   * remaining reviewers keep working, and the backend answers with the
   * authoritative snapshot that already excludes this one.
   */
  const stopReviewer = async (reviewerId: string) => {
    if (stoppingReviewerId !== null || reviewerAction !== null || pending || !workflow) return;
    setStoppingReviewerId(reviewerId);
    setError(null);
    try {
      replaceWorkflow(await commands.stopReviewer(workflow.id, reviewerId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStoppingReviewerId(null);
    }
  };

  const stopValidation = async () => {
    if (stoppingValidation || pending || !workflow || !commands.stopValidation) return;
    setStoppingValidation(true);
    setError(null);
    try {
      replaceWorkflow(await commands.stopValidation(workflow.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStoppingValidation(false);
    }
  };

  const runReviewerAction = async (
    reviewerId: string,
    kind: "restart" | "unstick",
    command: MultiReviewCommands["restartReviewer"] | MultiReviewCommands["unstickReviewer"],
  ) => {
    if (!workflow || !command || reviewerAction !== null || stoppingReviewerId !== null || pending)
      return;
    setReviewerAction({ reviewerId, kind });
    setError(null);
    try {
      replaceWorkflow(await command(workflow.id, reviewerId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReviewerAction(null);
    }
  };

  const restartStep = async (
    kind: MultiReviewStepKind,
    model?: MultiReviewWorkflow["fixModel"],
  ) => {
    if (
      !workflow ||
      !commands.restartStep ||
      restartingStep !== null ||
      stepLifecycleAction !== null ||
      pending
    )
      return;
    setRestartingStep(kind);
    setError(null);
    setRestartDialogError(null);
    try {
      replaceWorkflow(
        await (model
          ? commands.restartStep(workflow.id, kind, model)
          : commands.restartStep(workflow.id, kind)),
      );
      if (model) setRestartDialogStep(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      if (model) setRestartDialogError(message);
    } finally {
      setRestartingStep(null);
    }
  };

  const runStepLifecycle = async (
    kind: MultiReviewStepKind,
    action: "pause" | "resume",
    command: MultiReviewCommands["pauseStep"] | MultiReviewCommands["resumeStep"],
  ) => {
    if (!workflow || !command || stepLifecycleAction !== null || restartingStep !== null || pending)
      return;
    setStepLifecycleAction({ kind, action });
    setError(null);
    try {
      replaceWorkflow(await command(workflow.id, kind));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStepLifecycleAction(null);
    }
  };

  // The backend commits the handoff intent and owns provider adoption, dispatch,
  // and retries. Presentation waits for the authoritative delivery acknowledgement
  // so the provider session is live and the address turn is ordered first.
  const addressAll = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    setPresentationNotice(null);
    try {
      // The workflow id is enough to record the intent. Eligibility, provider
      // adoption and prompt dispatch all belong to the backend; a stale local
      // snapshot or an unavailable tab presenter must never suppress the click.
      const handedOff = await commands.address(data.workflowId);
      replaceWorkflow(handedOff);
      if (mountedRef.current && isActiveRef.current) setOpenAfterDelivery(true);
    } catch (reason) {
      if (mountedRef.current) {
        setOpenAfterDelivery(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  const openInteractiveFixSession = async () => {
    if (pending || !workflow) return;
    setPending(true);
    setError(null);
    setPresentationNotice(null);
    try {
      // Opening is presentation-only. A pending dispatch is owned and retried
      // by the backend supervisor even when no review component is mounted.
      presentFixSession(workflow, "manual");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  const startCustomFix = async (selection: MultiReviewWorkflow["fixModel"], prompt: string) => {
    if (customFixPending) return;
    if (!workflow?.consolidatedReport) {
      setCustomFixError("The consolidated review report is no longer available.");
      return;
    }
    setCustomFixPending(true);
    setCustomFixError(null);
    try {
      const customFix = commands.customFix ?? defaultCommands.customFix!;
      replaceWorkflow(await customFix(workflow.id, selection, prompt));
      if (mountedRef.current) {
        setCustomFixError(null);
        setCustomFixPromptOpen(false);
        if (isActiveRef.current) setOpenAfterDelivery(true);
      }
    } catch (reason) {
      if (mountedRef.current) {
        setCustomFixError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (mountedRef.current) setCustomFixPending(false);
    }
  };

  // The PR node reads the environment's pull request and the launched PR tab.
  const prUrl = useEnvironmentStore(
    (state) => state.getEnvironmentById(data.environmentId)?.prUrl ?? null,
  );
  const prState = useEnvironmentStore(
    (state) => state.getEnvironmentById(data.environmentId)?.prState ?? null,
  );
  // Tool rows in the inspector's transcript tails open files in this container.
  const containerId =
    useEnvironmentStore((state) => state.getEnvironmentById(data.environmentId)?.containerId) ??
    undefined;
  const cleanReviewPr =
    workflow?.phase === "ready" &&
    workflow.consolidatedReport?.issues.length === 0 &&
    workflow.consolidatedReport.testCoverageGaps.length === 0;
  // A delivered launch survives restarts as history, not as the rerun's outcome.
  const currentPrLaunch =
    workflow?.autoPrLaunch?.basis === "clean-review" && !cleanReviewPr
      ? undefined
      : workflow?.autoPrLaunch;
  const prTabId = workflow?.autoPrLaunch?.tabId;
  const prTabAgent = usePaneLayoutStore((state) =>
    prTabId
      ? state.findPaneWithTab(prTabId, data.environmentId)?.tabs.find((tab) => tab.id === prTabId)
          ?.nativeAgentData?.platform
      : undefined,
  );
  const prTabOpen = usePaneLayoutStore((state) =>
    prTabId ? state.findPaneWithTab(prTabId, data.environmentId) !== null : false,
  );
  const prAgentPhase = useMultiReviewPrPhase({
    environmentId: data.environmentId,
    tabId: prTabId,
    agent: prTabAgent,
    active: isActive && currentPrLaunch?.state === "launched" && !prUrl,
    loadSessionState: loadPrSessionState,
  });
  const openPrTab = useCallback(() => {
    if (!prTabId) return;
    const layout = usePaneLayoutStore.getState();
    const pane = layout.findPaneWithTab(prTabId, data.environmentId);
    if (!pane) return;
    layout.setActivePane(pane.id, data.environmentId);
    layout.setActiveTab(pane.id, prTabId, data.environmentId);
  }, [data.environmentId, prTabId]);
  const viewPullRequest = useCallback(async () => {
    if (!prUrl) return;
    try {
      await backend.openInBrowser(prUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [prUrl]);

  if (!workflow) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          {error ? (
            <AlertCircle className="mx-auto mb-3 size-6 text-destructive" />
          ) : (
            <Loader2 className="mx-auto mb-3 size-6 animate-spin text-primary" />
          )}
          <p className="text-sm text-muted-foreground">{error ?? "Restoring Multi Review…"}</p>
          {error && (
            <Button className="mt-4" variant="outline" size="sm" onClick={hydrate}>
              <RefreshCw className="mr-2 size-3.5" />
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  const busy = isBusyPhase(workflow.phase);
  const reviewSessionStalled =
    (workflow.phase === "preparing" || workflow.phase === "consolidating") &&
    (
      workflow.reviewSession ??
      (workflow.reviewModel || workflow.consolidationModel ? undefined : workflow.fixSession)
    )?.stalledSince !== undefined;
  const fixSessionStalled =
    workflow.phase === "fixing" && workflow.fixSession?.stalledSince !== undefined;
  const packageStatus = reviewPackageGenerationStep(workflow);
  const consolidationStatus = consolidationStep(workflow);
  const fixStatus = fixStep(workflow);
  const reviewSelection = workflow.reviewModel ?? workflow.fixModel;
  const consolidationSelection = workflow.consolidationModel ?? reviewSelection;
  const hasReviewSession = Boolean(multiReviewReviewSession(workflow)?.providerSessionId);
  const hasPreparationSession = Boolean(
    multiReviewReviewSession(workflow, "prepare")?.providerSessionId,
  );
  const hasFixSession = Boolean(workflow.fixSession?.providerSessionId);
  const canCancel =
    workflow.phase !== "completed" &&
    workflow.phase !== "cancelled" &&
    workflow.phase !== "cancelling" &&
    workflow.phase !== "interactive";
  const lifecyclePending = stepLifecycleAction !== null;

  const inspectorTranscriptTabs = (nodeId: string, transcript: ReactNode, report: ReactNode) => (
    <InspectorTranscriptTabs
      transcript={transcript}
      report={report}
      tab={inspectorTabs[nodeId] ?? "transcript"}
      onTabChange={(tab) => setInspectorTabs((previous) => ({ ...previous, [nodeId]: tab }))}
    />
  );

  const stepView = ({
    key,
    kind,
    title,
    status,
    stalled,
    model,
    runtimeLabel,
    openLabel,
    openTitle,
    canOpen,
    onOpen,
    requireDirectActivation = false,
    canPause,
    canResume,
    showPauseAction = true,
    activityAt,
    details,
    report,
  }: {
    key: MultiReviewStepKey;
    kind: MultiReviewStepKind;
    title: string;
    status: MultiReviewStepStatus;
    stalled: boolean;
    model: MultiReviewWorkflow["fixModel"];
    runtimeLabel: string;
    openLabel: string;
    openTitle: string;
    canOpen: boolean;
    onOpen: () => void;
    requireDirectActivation?: boolean;
    canPause: boolean;
    canResume: boolean;
    showPauseAction?: boolean;
    activityAt?: number;
    details?: ReactNode;
    report?: ReactNode;
  }): MultiReviewFlowNodeView => {
    const runtime = multiReviewStepRuntimeParts(
      workflow,
      key,
      status.state === "running",
      reviewPanelNow,
    );
    const canRestart = status.state !== "not-started" && Boolean(commands.restartStep);
    const restarting = restartingStep === kind;
    const restart = () => void restartStep(kind);
    const restartIn = () => {
      setRestartDialogError(null);
      setRestartDialogStep(kind);
    };
    const pause = () => void runStepLifecycle(kind, "pause", commands.pauseStep);
    const resume = () => void runStepLifecycle(kind, "resume", commands.resumeStep);
    const access = multiReviewStepSessionAccess(workflow, kind);
    return {
      node: {
        id: key,
        kind: key,
        title,
        state: status.state,
        stalled,
        statusLabel: status.label,
        detail: modelDetail(model, true),
        runtime,
        runtimeLabel,
        pendingLabel:
          status.state === "not-started" ? flowPendingLabel("step", status.label) : undefined,
        statusWord: stepStatusWord(status, stalled),
        validation: key === "package" ? validationChips(workflow.validationRun) : undefined,
        error: multiReviewStepError(workflow, key, status),
        canOpen,
        onOpen,
        contextMenu: (
          <>
            <ContextMenuItem
              disabled={!canRestart || restarting || lifecyclePending}
              onSelect={restart}
            >
              {restarting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              Restart
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canRestart || restarting || lifecyclePending}
              onSelect={restartIn}
            >
              <RotateCcw />
              Restart in…
            </ContextMenuItem>
            {canResume ? (
              <ContextMenuItem disabled={lifecyclePending || restarting} onSelect={resume}>
                {lifecyclePending ? <Loader2 className="animate-spin" /> : <Play />}
                Resume
              </ContextMenuItem>
            ) : showPauseAction ? (
              <ContextMenuItem
                disabled={!canPause || lifecyclePending || restarting}
                onSelect={pause}
              >
                {lifecyclePending ? <Loader2 className="animate-spin" /> : <Pause />}
                Pause
              </ContextMenuItem>
            ) : null}
          </>
        ),
      },
      actions: (
        <>
          <SessionOpenButton
            label={openLabel}
            title={openTitle}
            enabled={canOpen}
            onOpen={onOpen}
            requireDirectActivation={requireDirectActivation}
          />
          {canRestart ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className={INSPECTOR_BUTTON_CLASS}
                disabled={restarting || lifecyclePending}
                onClick={restart}
              >
                {restarting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="size-3.5" />
                )}
                Restart
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={INSPECTOR_BUTTON_CLASS}
                disabled={restarting || lifecyclePending}
                onClick={restartIn}
              >
                Restart in…
              </Button>
            </>
          ) : null}
          {canResume ? (
            <Button
              variant="outline"
              size="sm"
              className={INSPECTOR_BUTTON_CLASS}
              disabled={lifecyclePending || restarting}
              onClick={resume}
            >
              <Play className="size-3.5" />
              Resume
            </Button>
          ) : showPauseAction && canPause ? (
            <Button
              variant="outline"
              size="sm"
              className={INSPECTOR_BUTTON_CLASS}
              disabled={lifecyclePending || restarting}
              onClick={pause}
            >
              <Pause className="size-3.5" />
              Pause
            </Button>
          ) : null}
        </>
      ),
      body: (
        <div className="flex flex-1 flex-col space-y-4">
          <StepFacts model={model} runtime={runtime} status={status} />
          {details}
          {inspectorTranscriptTabs(
            key,
            <StepTranscriptTail
              key={kind}
              workflowId={workflow.id}
              step={kind}
              access={{
                kind: access.kind,
                step: access.kind === "other-step" ? access.step : undefined,
              }}
              live={status.state === "running"}
              isActive={isActive}
              assistantLabel={title}
              containerId={containerId}
              loadTranscript={loadStepTranscript}
            />,
            report,
          )}
        </div>
      ),
      activityAt,
    };
  };

  const packageView = stepView({
    key: "package",
    kind: "prepare",
    title: "Review package",
    status: packageStatus,
    stalled: workflow.phase === "preparing" && reviewSessionStalled,
    model: reviewSelection,
    runtimeLabel: "Review package generation runtime",
    openLabel: "Open review package generation session",
    openTitle: stepOpenTitle(
      packageStatus,
      hasPreparationSession,
      "review package generation",
      "Review package generation has not started yet",
    ),
    canOpen: packageStatus.state !== "not-started" && hasPreparationSession && Boolean(createTab),
    onOpen: () => presentReviewSession(workflow, "prepare"),
    requireDirectActivation: true,
    canPause: workflow.phase === "preparing" && Boolean(commands.pauseStep),
    canResume:
      workflow.phase === "paused" &&
      workflow.pausedStep === "prepare" &&
      Boolean(commands.resumeStep),
    activityAt: latestActivityAt(workflow.stepRuntimes?.prepare, workflow.validationRun),
    details: workflow.validationRun ? (
      <ReviewValidationStatus
        environmentId={data.environmentId}
        run={workflow.validationRun}
        now={reviewPanelNow}
        onStop={
          commands.stopValidation &&
          workflow.phase === "preparing" &&
          (workflow.validationRun.status === "planned" ||
            workflow.validationRun.status === "running")
            ? () => void stopValidation()
            : undefined
        }
        stopping={
          stoppingValidation ||
          (workflow.phase === "preparing" &&
            (workflow.validationRun.status === "planned" ||
              workflow.validationRun.status === "running") &&
            workflow.validationStopRequested === true)
        }
      />
    ) : null,
  });

  const consolidationView = stepView({
    key: "consolidation",
    kind: "consolidate",
    title: "Consolidation",
    status: consolidationStatus,
    stalled: workflow.phase === "consolidating" && reviewSessionStalled,
    model: consolidationSelection,
    runtimeLabel: "Consolidation runtime",
    openLabel: "Open consolidation session",
    openTitle: stepOpenTitle(
      consolidationStatus,
      hasReviewSession,
      "consolidation",
      "Consolidation starts after the independent reviews finish",
    ),
    canOpen: consolidationStatus.state !== "not-started" && hasReviewSession && Boolean(createTab),
    onOpen: () => presentReviewSession(workflow, "consolidate"),
    requireDirectActivation: true,
    canPause: workflow.phase === "consolidating" && Boolean(commands.pauseStep),
    canResume:
      workflow.phase === "paused" &&
      workflow.pausedStep === "consolidate" &&
      Boolean(commands.resumeStep),
    activityAt: latestActivityAt(workflow.stepRuntimes?.consolidate),
    details: workflow.consolidatedReport ? (
      <p className="text-xs text-foreground/85">
        {findingCountLabel(workflow.consolidatedReport.issues.length, "issue")} ·{" "}
        {findingCountLabel(workflow.consolidatedReport.testCoverageGaps.length, "coverage gap")}.
      </p>
    ) : null,
    report: workflow.consolidatedReport ? (
      <StructuredReviewReportView
        report={workflow.consolidatedReport}
        heading="Consolidated Multi Review"
        collapsibleSections
        sectionExpansionKey={`multi-review/${workflow.id}/consolidated-report-section`}
      />
    ) : null,
  });

  const fixView = stepView({
    key: "fix",
    kind: "fix",
    title: "Fix",
    status: fixStatus,
    stalled: workflow.phase === "fixing" && fixSessionStalled,
    model: workflow.fixModel,
    runtimeLabel: "Fix runtime",
    openLabel: "Open fix model session",
    openTitle: stepOpenTitle(
      fixStatus,
      hasFixSession,
      "fix",
      "The fix session starts once the consolidated findings are sent to the fix model",
    ),
    canOpen: fixStatus.state !== "not-started" && hasFixSession && Boolean(createTab),
    onOpen: () => presentFixSession(workflow, "manual"),
    canPause: workflow.phase === "fixing" && Boolean(commands.pauseStep),
    canResume:
      workflow.phase === "paused" && workflow.pausedStep === "fix" && Boolean(commands.resumeStep),
    showPauseAction: false,
    activityAt: latestActivityAt(workflow.stepRuntimes?.fix),
    details: workflow.fixResult ? (
      <p className="text-xs text-foreground/85">{workflow.fixResult.summary}</p>
    ) : null,
  });

  const prStatus = pullRequestStep({
    autoPr: workflow.autoPr === true,
    launch: currentPrLaunch,
    prUrl: prUrl,
    prState: prState,
    agentPhase: prAgentPhase,
    upstreamComplete: cleanReviewPr
      ? consolidationStatus.state === "complete"
      : fixStatus.state === "complete",
  });
  const canOpenPrTab = workflow.autoPrLaunch?.state === "launched" && prTabOpen;
  const prLaunchNotice = currentPrLaunch ? autoPrLaunchNotice(currentPrLaunch).text : null;
  const prView: MultiReviewFlowNodeView = {
    node: {
      id: "pr",
      kind: "pr",
      title: "Pull request",
      state: prStatus.state,
      stalled: false,
      statusLabel: prStatus.label,
      detail: pullRequestDetail(prUrl, workflow.targetBranch),
      runtime: null,
      runtimeLabel: "Pull request",
      pendingLabel: prStatus.pendingLabel,
      statusWord: prStatus.statusWord,
      error: prStatus.error,
      canOpen: canOpenPrTab,
      onOpen: openPrTab,
      contextMenu: (
        <>
          <ContextMenuItem disabled={!canOpenPrTab} onSelect={openPrTab}>
            <ExternalLink />
            Open PR session
          </ContextMenuItem>
          <ContextMenuItem disabled={!prUrl} onSelect={() => void viewPullRequest()}>
            <GitPullRequest />
            View pull request
          </ContextMenuItem>
        </>
      ),
    },
    actions: (
      <>
        <SessionOpenButton
          label="Open PR session"
          title={
            canOpenPrTab
              ? "Show the PR agent's tab"
              : workflow.autoPrLaunch?.state === "launched"
                ? "The PR agent's tab is no longer open"
                : "The PR agent has not been launched"
          }
          enabled={canOpenPrTab}
          onOpen={openPrTab}
        />
        {prUrl ? (
          <Button
            variant="outline"
            size="sm"
            className={INSPECTOR_BUTTON_CLASS}
            title={prUrl}
            onClick={() => void viewPullRequest()}
          >
            <GitPullRequest className="size-3.5" />
            View pull request
          </Button>
        ) : null}
      </>
    ),
    body: (
      <div className="space-y-3">
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Target</dt>
          <dd className="truncate font-mono">{workflow.targetBranch}</dd>
          <dt className="text-muted-foreground">Pull request</dt>
          <dd className="truncate">
            {prUrl ? <span className="font-mono">{prUrl}</span> : "None detected yet"}
          </dd>
          <dt className="text-muted-foreground">Automatic</dt>
          <dd>{workflow.autoPr === true ? "On" : "Off"}</dd>
        </dl>
        <p className="text-xs text-foreground/85">{prLaunchNotice ?? prStatus.label}</p>
        {workflow.autoPrLaunch && !currentPrLaunch ? (
          <p className="text-xs text-muted-foreground">
            The previous automatic PR launch ({workflow.autoPrLaunch.state}) belongs to an earlier
            review.
          </p>
        ) : null}
      </div>
    ),
  };

  const reviewerRestartable =
    (workflow.phase === "reviewing" ||
      workflow.phase === "consolidating" ||
      workflow.phase === "ready" ||
      workflow.phase === "fixing" ||
      workflow.phase === "interactive" ||
      workflow.phase === "completed" ||
      workflow.phase === "failed") &&
    workflow.activeRequest?.kind !== "prepare" &&
    !(workflow.reviewSnapshotStale === true && workflow.reviewPackage);
  const reviewerActionsBlocked = reviewerAction !== null || stoppingReviewerId !== null || pending;

  const reviewerViews = workflow.reviewers.map((reviewer, index): MultiReviewFlowNodeView => {
    const name = `Reviewer ${index + 1}`;
    const note = reviewerStatusNote(reviewer);
    const stalled = reviewer.status === "running" && Boolean(reviewer.stalledSince);
    const runtime = runtimeParts(reviewer, reviewer.status === "running", reviewPanelNow);
    const stoppable =
      workflow.phase === "reviewing" &&
      (reviewer.status === "pending" || reviewer.status === "running");
    const canUnstick =
      workflow.phase === "reviewing" &&
      reviewer.status === "running" &&
      Boolean(reviewer.providerSessionId) &&
      reviewer.dispatchState === "sent";
    const pendingAction = reviewerAction?.reviewerId === reviewer.id ? reviewerAction.kind : null;
    const canOpen = Boolean(reviewer.providerSessionId) && Boolean(openReviewer || createTab);
    const open = () => {
      if (openReviewer) {
        openReviewer(reviewer.id, index);
        return;
      }
      createTab?.("multi-review", {
        multiReviewId: workflow.id,
        multiReviewReviewerId: reviewer.id,
        displayTitle: name,
      });
    };
    const restart = () => void runReviewerAction(reviewer.id, "restart", commands.restartReviewer);
    const unstick = () => void runReviewerAction(reviewer.id, "unstick", commands.unstickReviewer);
    const stop = () => void stopReviewer(reviewer.id);
    const findings = reviewer.report
      ? `${findingCountLabel(reviewer.report.issues.length, "issue")}, ${findingCountLabel(reviewer.report.testCoverageGaps.length, "coverage gap")}`
      : undefined;
    const provisional = reviewerProvisionalSummary(reviewer);
    return {
      node: {
        id: `reviewer:${reviewer.id}`,
        kind: "reviewer",
        title: `${name} · ${reviewer.agent}`,
        state: reviewerFlowState(reviewer.status),
        stalled,
        statusLabel: reviewerStatusLabel(reviewer, workflow.reviewers),
        detail: modelDetail(reviewer, false),
        runtime,
        runtimeLabel: `${name} runtime and token usage`,
        pendingLabel:
          reviewer.status === "pending"
            ? reviewerPendingLabel(reviewer, workflow.reviewers)
            : undefined,
        statusWord: reviewerStatusWord(reviewer),
        error: reviewer.status === "failed" ? reviewer.error : undefined,
        // A failed or stopped reviewer can still have filed a partial report.
        severity: reviewer.report ? severityCounts(reviewer.report.issues) : undefined,
        findingsLabel: findings,
        canOpen,
        onOpen: open,
        contextMenu: (
          <>
            <ContextMenuItem
              disabled={!reviewerRestartable || reviewerActionsBlocked || !commands.restartReviewer}
              onSelect={restart}
            >
              {pendingAction === "restart" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              Restart
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canUnstick || reviewerActionsBlocked || !commands.unstickReviewer}
              onSelect={unstick}
            >
              {pendingAction === "unstick" ? <Loader2 className="animate-spin" /> : <Play />}
              Unstick
            </ContextMenuItem>
            <ContextMenuItem disabled={!stoppable || reviewerActionsBlocked} onSelect={stop}>
              {stoppingReviewerId === reviewer.id ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Square />
              )}
              Stop
            </ContextMenuItem>
          </>
        ),
      },
      actions: (
        <>
          <SessionOpenButton
            label={reviewerTranscriptLabel(reviewer, index)}
            title={canOpen ? "Open this reviewer's read-only transcript in a new tab" : undefined}
            enabled={canOpen}
            onOpen={open}
          />
          {reviewerRestartable && commands.restartReviewer ? (
            <Button
              variant="outline"
              size="sm"
              className={INSPECTOR_BUTTON_CLASS}
              aria-label={`Restart ${name}`}
              title="Restart this reviewer from the beginning in a fresh session"
              disabled={reviewerActionsBlocked}
              onClick={restart}
            >
              {pendingAction === "restart" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              Restart
            </Button>
          ) : null}
          {canUnstick && commands.unstickReviewer ? (
            <Button
              variant="outline"
              size="sm"
              className={INSPECTOR_BUTTON_CLASS}
              aria-label={`Unstick ${name}`}
              title='Stop the current turn, then send "Please continue"'
              disabled={reviewerActionsBlocked}
              onClick={unstick}
            >
              {pendingAction === "unstick" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              Unstick
            </Button>
          ) : null}
          {stoppable ? (
            <Button
              variant="outline"
              size="sm"
              className={`${INSPECTOR_BUTTON_CLASS} hover:text-destructive`}
              aria-label={`Stop ${name}`}
              title="Stop this reviewer; the review continues without it"
              disabled={reviewerActionsBlocked}
              onClick={stop}
            >
              {stoppingReviewerId === reviewer.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Square className="size-3.5" />
              )}
              Stop
            </Button>
          ) : null}
        </>
      ),
      body: (
        <div className="flex flex-1 flex-col space-y-3">
          <p className="truncate text-xs text-muted-foreground">
            {modelDetail(reviewer, true)} · Read only
            {runtime ? ` · ${formatRuntimeParts(runtime)}` : ""}
          </p>
          {reviewer.resultSubmission && reviewer.resultSubmission !== "preparing" ? (
            <WorkflowResultStatus state={reviewer.resultSubmission} kind="review-report" />
          ) : null}
          {/* The workflow error generalizes a shared cause; this is the only
          place the reviewer's own outcome is legible. */}
          {note ? (
            <p
              className={`max-h-16 overflow-x-hidden overflow-y-auto overscroll-contain break-words whitespace-normal pr-1 text-xs [overflow-wrap:anywhere] ${NOTE_TONE_CLASS[note.tone]}`}
              data-testid={`multi-reviewer-note-${reviewer.id}`}
              title={note.text}
            >
              {note.text}
            </p>
          ) : null}
          {inspectorTranscriptTabs(
            `reviewer:${reviewer.id}`,
            <ReviewerTranscriptTail
              key={reviewer.id}
              workflowId={workflow.id}
              reviewerId={reviewer.id}
              hasSession={Boolean(reviewer.providerSessionId)}
              live={reviewer.status === "running" || reviewer.status === "pending"}
              isActive={isActive}
              assistantLabel={name}
              containerId={containerId}
              loadTranscript={loadReviewerTranscript}
            />,
            reviewer.report ? (
              <StructuredReviewReportView
                report={reviewer.report}
                heading="Reviewer report"
                collapsibleSections
                showRawJson={false}
                sectionExpansionKey={`multi-review/${workflow.id}/reviewer/${reviewer.id}/report-section`}
              />
            ) : null,
          )}
          {findings ? <p className="text-xs text-muted-foreground">{findings}</p> : null}
          {provisional ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid={`multi-reviewer-provisional-${reviewer.id}`}
            >
              {provisional}
            </p>
          ) : null}
        </div>
      ),
      activityAt: latestActivityAt(reviewer),
    };
  });

  const views = [packageView, ...reviewerViews, consolidationView, fixView, prView];
  const stage = { package: 0, reviewer: 1, consolidation: 2, fix: 3, pr: 4 } as const;
  const defaultSelectionId = defaultFlowSelection(
    views.map((view) => ({
      id: view.node.id,
      state: view.node.state,
      stage: stage[view.node.kind],
      activityAt: view.activityAt,
    })),
  );
  // A reviewer that left the panel (or a stale pick) falls back to the default.
  const selected =
    views.find((view) => view.node.id === selectedNodeId) ??
    views.find((view) => view.node.id === defaultSelectionId) ??
    packageView;
  const edges = multiReviewFlowEdges({
    package: packageView.node.state,
    reviewers: reviewerViews.map((view) => view.node.state),
    consolidation: consolidationView.node.state,
    fix: fixView.node.state,
    pr: prView.node.state,
    prFromConsolidation: cleanReviewPr,
  });
  const { findings, reviewerCount, provisionalCount } = mergeReviewerFindings(workflow.reviewers);
  const elapsedSeconds = multiReviewElapsedSeconds(workflow, hasLiveClock, reviewPanelNow);
  const totalTokens = multiReviewTotalTokens(workflow);
  const headerStalled = reviewSessionStalled || fixSessionStalled;

  const notices: ReactNode[] = [];
  if (headerStalled) {
    notices.push(
      <section
        key="stalled"
        role="status"
        aria-live="polite"
        className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/8 p-4"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/12 text-amber-500">
          <AlertTriangle className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-amber-500">
            {reviewSessionStalled
              ? "Review preparation model appears stalled"
              : "Fix model appears stalled"}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            No new activity has arrived. Cancel now, or wait for the workflow to stop automatically
            and then retry.
          </p>
        </div>
      </section>,
    );
  }
  if (workflow.reviewSnapshotStale === true && !workflow.reviewPackage) {
    notices.push(
      <div
        key="snapshot-stale"
        className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-500"
      >
        The repository worktree changed after this Multi Review started. The review continued, so
        reviewer reports may reflect different worktree states.
      </div>,
    );
  }
  if (error || workflow.error) {
    notices.push(
      <div
        key="error"
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
      >
        {error ?? workflow.error}
      </div>,
    );
  }
  if (presentationNotice || workflow.presentationError) {
    notices.push(
      <div
        key="presentation"
        className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-500"
      >
        {presentationNotice ?? workflow.presentationError}
      </div>,
    );
  }
  if (
    workflow.phase === "interactive" &&
    workflow.addressPromptPending !== true &&
    workflow.fixSession?.providerSessionId &&
    !presentationNotice &&
    !workflow.presentationError
  ) {
    notices.push(
      <div
        key="fix-ready"
        className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground"
      >
        The fix request was delivered. The fix session is ready to open.
      </div>,
    );
  }
  if (workflow.addressPromptPending === true && !workflow.error) {
    notices.push(
      <div
        key="address-pending"
        className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground"
      >
        The fix request was recorded and is being delivered in the background.
      </div>,
    );
  }
  if (
    workflow.autoPrLaunch &&
    (workflow.autoPrLaunch.basis !== "clean-review" ||
      (workflow.phase === "ready" &&
        workflow.consolidatedReport?.issues.length === 0 &&
        workflow.consolidatedReport.testCoverageGaps.length === 0))
  ) {
    notices.push(<AutoPrLaunchNotice key="auto-pr" launch={workflow.autoPrLaunch} />);
  }

  return (
    <div ref={setTabRoot} className="relative flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-divider px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
            <StackedEyes className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Multi Review</h1>
            <p
              className={`truncate text-xs ${headerStalled ? "text-amber-500" : "text-muted-foreground"}`}
            >
              <span>
                {reviewSessionStalled
                  ? "No activity from the review preparation model"
                  : fixSessionStalled
                    ? "No activity from the fix model"
                    : phaseCopy(workflow)}
              </span>
              {elapsedSeconds !== null ? (
                <span data-testid="multi-review-elapsed">
                  {" · "}
                  <span className="font-mono tabular-nums">
                    {formatElapsedWithHours(elapsedSeconds)}
                  </span>
                </span>
              ) : null}
              {totalTokens !== null ? (
                <span data-testid="multi-review-total-tokens">
                  {" · "}
                  <span className="font-mono tabular-nums">
                    {formatTokenCount(totalTokens)}
                  </span>{" "}
                  tokens
                </span>
              ) : null}
            </p>
            {workflow.activeRequest?.resultSubmission && (
              <WorkflowResultStatus
                state={workflow.activeRequest.resultSubmission}
                kind={
                  workflow.activeRequest.kind === "prepare"
                    ? "validation-plan"
                    : workflow.activeRequest.kind === "consolidate"
                      ? "consolidated-review"
                      : "fix-result"
                }
                className="mt-0.5"
              />
            )}
          </div>
        </div>
        {busy && <Loader2 className="size-4 shrink-0 animate-spin text-primary" />}
      </header>

      {/* A stable gutter keeps the graph's width, and so its zoom, from
          changing when the inspector grows enough to need a scrollbar. */}
      <div
        data-testid="multi-review-overview-scroll"
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
        <div className="@container flex min-h-full flex-col">
          {notices.length > 0 ? (
            <div className="space-y-2 border-b border-divider px-4 py-3 sm:px-6">{notices}</div>
          ) : null}
          <MultiReviewFlowGraph
            packageNode={packageView.node}
            reviewerNodes={reviewerViews.map((view) => view.node)}
            consolidationNode={consolidationView.node}
            fixNode={fixView.node}
            prNode={prView.node}
            edges={edges}
            reviewLabel={reviewerColumnLabel(workflow.reviewers)}
            reviewTitle={reviewerProgressSummary(workflow.reviewers)}
            selectedId={selected.node.id}
            onSelect={setSelectedNodeId}
            panelId={panelId}
            viewKey={workflow.id}
            fullscreenContainer={tabRoot}
            isActive={isActive}
          />
          {/* The body's row takes the rest of the window, so a transcript can
              fill it down to the footer. */}
          <div className="grid min-h-80 flex-1 grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr] px-4 py-4 sm:px-6">
            {/* Sits beside the inspector header, and stays in view while the
                inspector scrolls. */}
            <MultiReviewFindingsBadge
              isActive={isActive}
              findings={findings}
              reviewerCount={reviewerCount}
              provisionalCount={provisionalCount}
              className="sticky top-3 z-20 col-start-2 row-span-2 row-start-1 ml-3 self-start"
            />
            <section
              role="tabpanel"
              id={panelId}
              aria-labelledby={flowNodeElementId(panelId, selected.node.id)}
              data-testid="multi-review-inspector"
              className="col-span-full row-span-2 row-start-1 grid min-w-0 grid-cols-subgrid grid-rows-subgrid"
            >
              <div className="col-start-1 row-start-1 min-w-0">
                <MultiReviewInspectorHeader node={selected.node} actions={selected.actions} />
              </div>
              {/* Full width: the badge only overlaps it once stuck. */}
              <div className="col-span-full row-start-2 flex min-w-0 flex-col">{selected.body}</div>
            </section>
          </div>
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 bg-background/90 px-4 py-3 sm:px-5">
        {workflow.phase === "failed" && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void run(() => commands.retry(workflow.id))}
          >
            <RefreshCw className="mr-2 size-4" />
            Retry failed stage
          </Button>
        )}
        {canCancel && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void run(() => commands.cancel(workflow.id))}
          >
            <Square className="mr-2 size-4" />
            {workflow.phase === "ready" || workflow.phase === "failed" ? "Abandon" : "Cancel"}
          </Button>
        )}
        {workflow.phase === "interactive" &&
          workflow.addressPromptPending !== true &&
          workflow.fixSession?.providerSessionId && (
            <Button
              variant="outline"
              disabled={pending || !createTab}
              onClick={() => {
                void openInteractiveFixSession();
              }}
            >
              Open fix session
            </Button>
          )}
        {workflow.phase === "ready" && (
          <>
            <Button disabled={pending} onClick={() => void addressAll()}>
              <Wrench className="mr-2 size-4" />
              Fix
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                setCustomFixError(null);
                setCustomFixPromptOpen(true);
              }}
              aria-label="Custom fix prompt"
              title="Custom fix prompt"
            >
              ...
            </Button>
          </>
        )}
      </footer>
      <MultiReviewFixPromptDialog
        open={customFixPromptOpen}
        onOpenChange={(open) => {
          setCustomFixPromptOpen(open);
          if (!open) setCustomFixError(null);
        }}
        catalog={modelCatalog}
        defaultSelection={workflow.fixModel}
        error={customFixError}
        busy={customFixPending}
        onSubmit={startCustomFix}
      />
      {restartDialogStep ? (
        <MultiReviewRestartDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRestartDialogStep(null);
              setRestartDialogError(null);
            }
          }}
          kind={restartDialogStep}
          catalog={modelCatalog}
          defaultSelection={
            restartDialogStep === "fix"
              ? workflow.fixModel
              : restartDialogStep === "consolidate"
                ? consolidationSelection
                : reviewSelection
          }
          error={restartDialogError}
          busy={restartingStep === restartDialogStep}
          onSubmit={(selection) => void restartStep(restartDialogStep, selection)}
        />
      ) : null}
    </div>
  );
}

export function MultiReviewTab(props: MultiReviewTabProps) {
  if (props.data.reviewerId) {
    return (
      <MultiReviewReviewerTab
        data={{ ...props.data, reviewerId: props.data.reviewerId }}
        isActive={props.isActive}
      />
    );
  }
  return <MultiReviewOverviewTab {...props} />;
}
