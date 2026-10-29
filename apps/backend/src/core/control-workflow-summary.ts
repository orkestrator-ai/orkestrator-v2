import { multiReviewFixIdentity } from "./multi-review-fix-identity.js";

/** Bounded control response; never include provider configuration or controller fences. */
export function workflowSummary(workflow: Record<string, unknown>): Record<string, unknown> {
  return {
    id: workflow.id,
    projectId: workflow.projectId,
    environmentId: workflow.environmentId,
    taskId: workflow.taskId,
    phase: workflow.phase,
    error: workflow.error,
    presentationError: workflow.presentationError,
    addressPromptPending: workflow.addressPromptPending,
    fixTabId: workflow.fixTabId,
    ...("autoFix" in workflow || "autoPr" in workflow
      ? { automation: multiReviewAutomation(workflow) }
      : {}),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    revision: workflow.revision ?? workflow.backendRevision,
  };
}

const MAX_AUTOMATION_MESSAGE_CHARS = 400;

/**
 * A Multi Review's auto-fix and auto-PR, the automatic PR launch's state, and
 * one sentence on what happens next, so a coordinator can tell whether it is
 * expected to act. Only Multi Review snapshots carry `autoFix`/`autoPr`.
 */
export function multiReviewAutomation(workflow: Record<string, unknown>): Record<string, unknown> {
  const autoFix = workflow.autoFix === true;
  const autoPr = workflow.autoPr === true;
  const launch = isRecord(workflow.autoPrLaunch) ? workflow.autoPrLaunch : undefined;
  const message =
    typeof launch?.message === "string"
      ? launch.message.slice(0, MAX_AUTOMATION_MESSAGE_CHARS)
      : undefined;
  const prLaunch = launch
    ? {
        state: launch.state,
        ...(typeof launch.tabId === "string" ? { tabId: launch.tabId } : {}),
        ...(typeof launch.attempts === "number" ? { attempts: launch.attempts } : {}),
        ...(message ? { message } : {}),
      }
    : undefined;
  return { autoFix, autoPr, ...(prLaunch ? { prLaunch } : {}), next: automationNext(workflow) };
}

function automationNext(workflow: Record<string, unknown>): string {
  const autoFix = workflow.autoFix === true;
  const autoPr = workflow.autoPr === true;
  const recordedLaunch = isRecord(workflow.autoPrLaunch) ? workflow.autoPrLaunch : undefined;
  const fix = isRecord(workflow.fixSession) ? workflow.fixSession : undefined;
  const phase = workflow.phase;
  const customFix = isRecord(workflow.fixLaunch) && workflow.fixLaunch.kind === "custom";
  const cleanReviewPr = recordedLaunch?.basis === "clean-review";
  const launch =
    cleanReviewPr &&
    (phase !== "ready" ||
      !isRecord(workflow.consolidatedReport) ||
      hasFindings(workflow.consolidatedReport))
      ? undefined
      : recordedLaunch;
  const earlierPr =
    recordedLaunch?.state === "launched" &&
    (cleanReviewPr ||
      recordedLaunch.fixIdentity === undefined ||
      recordedLaunch.fixIdentity !== multiReviewFixIdentity(fix));
  const manualPr = "; review its result and start or update the PR manually";
  const thenPr = customFix
    ? manualPr
    : recordedLaunch?.state === "launched"
      ? "; the earlier PR does not confirm inclusion of this Fix's changes, so review and update it manually"
      : autoPr
        ? "; a PR session starts once that Fix completes"
        : "";
  // A new handoff or running Fix takes precedence over a retained PR launch.
  if (phase === "interactive" && workflow.addressPromptPending === true)
    return `The Fix handoff is being delivered${thenPr}.`;
  if (phase === "interactive" && fix?.status === "running") return `The Fix is running${thenPr}.`;
  if (phase === "failed" || phase === "cancelled") return "Nothing else runs automatically.";
  if (phase === "cancelling") return "Cancelling; nothing else runs automatically.";
  if (phase === "interactive" && customFix)
    return `The custom Fix ${fix?.status === "failed" ? "failed" : fix?.status === "idle" ? "turn ended" : "is starting"}${manualPr}.`;
  // On the graph engine (item 301) a system step opens the pull request.
  const graph = workflow.engine === "graph";
  if (launch?.state === "pending")
    return graph
      ? `${cleanReviewPr ? "Consolidation found nothing to fix" : "The Fix completed"}; the graph run is writing the description and opening the pull request.`
      : cleanReviewPr
        ? "Consolidation found nothing to fix; the PR session is starting."
        : "The Fix completed; the PR session is starting.";
  if (phase === "interactive" && earlierPr)
    return "The Fix turn ended; the earlier PR does not confirm inclusion of this Fix's changes. Review the result and update the PR manually.";
  if (launch?.state === "launched" && graph)
    return "The graph run's pull request step pushed the branch and opened the pull request. Nothing else runs automatically.";
  if (launch?.state === "launched")
    return `The PR session started${typeof launch.tabId === "string" ? ` in tab ${launch.tabId}` : ""}; it pushes the branch and opens the pull request. Nothing else runs automatically.`;
  if (launch?.state === "skipped" || launch?.state === "failed") {
    const reason =
      typeof launch.message === "string"
        ? `: ${launch.message.slice(0, MAX_AUTOMATION_MESSAGE_CHARS)}`
        : ".";
    return graph
      ? `The graph run did not open the pull request${reason}`
      : `No PR session ${launch.state === "failed" ? "could start" : "was started"}${reason}`;
  }
  if (phase === "completed") return "Nothing else runs automatically.";
  if (phase === "ready")
    return autoFix && !hasFindings(workflow.consolidatedReport)
      ? "Consolidation found nothing to fix, so no Fix or PR session starts."
      : `Waiting for address_multi_review to start the Fix${thenPr}.`;
  if (phase === "interactive") {
    if (fix?.status === "failed") return "The Fix failed; no PR session starts.";
    if (fix?.status === "idle")
      return autoPr
        ? "The Fix turn ended without proof it completed, so no PR session starts."
        : "The Fix turn ended. Nothing else runs automatically.";
    return `The Fix is starting${thenPr}.`;
  }
  return autoFix
    ? `The Fix starts automatically if consolidation reports findings${autoPr ? ", then a PR session once the Fix completes; a clean report starts the PR session directly" : ""}.`
    : autoPr
      ? `Stops at ready if consolidation reports findings; address_multi_review starts the Fix${thenPr}. A clean report starts the PR session directly.`
      : `Stops at ready; address_multi_review starts the Fix${thenPr}.`;
}

/** Auto-fix starts only for a report with issues or coverage gaps. */
function hasFindings(report: unknown): boolean {
  if (!isRecord(report)) return false;
  return [report.issues, report.testCoverageGaps].some(
    (items) => Array.isArray(items) && items.length > 0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizedWorkflow(value: unknown): Record<string, unknown> | null {
  const transported = isRecord(value) && isRecord(value.record) ? value.record : value;
  if (!isRecord(transported)) return null;
  if (!isRecord(transported.snapshot)) return transported;
  const snapshot = transported.snapshot;
  return {
    ...snapshot,
    id: snapshot.id ?? transported.id,
    projectId: snapshot.projectId ?? transported.projectId,
    environmentId: snapshot.environmentId ?? transported.environmentId,
    updatedAt: transported.updatedAt ?? snapshot.updatedAt,
    revision: transported.revision ?? snapshot.revision ?? snapshot.backendRevision,
  };
}
