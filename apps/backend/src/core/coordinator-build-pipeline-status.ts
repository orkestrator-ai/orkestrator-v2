/**
 * The settled status of a build pipeline snapshot, for a coordinator's
 * status wake (`coordinator-status-wakes.ts`). A completed or failed build
 * names how its newest Verify judged each acceptance criterion and on which
 * commit (`build-pipeline-criteria-report.ts`), so the coordinator can tell
 * the user what was proved without reading the ticket.
 *
 * A cancelled build is reported as cancelled, never as failed: a cancel is
 * someone's decision to stop the work, and a coordinator that read it as a
 * failure restarted it (to-do 7545 task 4).
 */
import {
  BUILD_CANCELLED_ERROR,
  isCancelledBuildPipeline,
  pipelineDeliverySummary,
  type BuildPipeline,
  type ResumableBuildPhase,
} from "@orkestrator/protocol/build-pipeline";
import { isDeliveryPolicy } from "@orkestrator/protocol/ticket-sections";
import { sessionPhaseForBuildPhase } from "./build-pipeline-stages.js";
import {
  buildPipelineCriteriaReport,
  criteriaNoticeLines,
} from "./build-pipeline-criteria-report.js";
import { boundedLine } from "./coordinator-waiting-status.js";
import { hash, MAX_DETAILS, record, stalledSession, text } from "./coordinator-status-support.js";
import type { CoordinatorStatus } from "./coordinator-status-wakes.js";

const BUILD_STAGE_LABELS: Record<string, string> = {
  reviewing: "build",
  addressing: "review",
  verifying: "address",
  fixing: "verification",
  // Successful verification starts PR creation; a fix loops back through review.
  "creating-pr": "verification",
  "resolving-conflicts": "pull request",
};

/**
 * What a cancelled build's notice tells its coordinator. Coordinators and
 * users both cancel through `cancel_build_pipeline`, and the pipeline does not
 * record which one did, so the coordinator is told how to tell: a cancel it did
 * not make itself is the user's.
 */
export const BUILD_CANCELLED_NOTICE =
  "It was stopped on purpose, not by an error. If you did not cancel it yourself, the user did: that is their decision to stop this work. Do not restart, resume or rebuild it, and do not start another build for this ticket, unless the user asks you to.";

/** The settled status of a build pipeline snapshot, or null while it is just making progress. */
export function buildPipelineStatus(
  snapshot: unknown,
  pipelineId: string,
): CoordinatorStatus | null {
  if (!record(snapshot)) return null;
  const phase = text(snapshot.phase);
  const read = `get_build_pipeline { "pipelineId": "${pipelineId}" }`;
  const task = text(snapshot.taskTitle)
    ? [`Task: ${boundedLine(snapshot.taskTitle as string)}`]
    : [];
  const iteration =
    typeof snapshot.iteration === "number" ? Math.max(0, Math.trunc(snapshot.iteration)) : 0;
  const errorLine = text(snapshot.error) ? [`Error: ${boundedLine(snapshot.error as string)}`] : [];
  const verification =
    snapshot.verificationResult === "pass" || snapshot.verificationResult === "fail"
      ? [`Last verification: ${snapshot.verificationResult}.`]
      : [];
  if (phase === "complete") {
    const delivery =
      record(snapshot.delivery) && isDeliveryPolicy(snapshot.delivery.policy)
        ? [
            pipelineDeliverySummary({
              policy: snapshot.delivery.policy,
              ...(typeof snapshot.delivery.uncommittedPaths === "number"
                ? { uncommittedPaths: snapshot.delivery.uncommittedPaths }
                : {}),
            }),
          ].filter((line): line is string => Boolean(line))
        : [];
    const used = task.length + verification.length + delivery.length;
    const criteria = criteriaNoticeLines(buildPipelineCriteriaReport(snapshot), MAX_DETAILS - used);
    return {
      key: "complete",
      state: "completed",
      tone: "success",
      terminal: true,
      headline: "completed",
      details: [...task, ...verification, ...criteria, ...delivery],
      tools: [read],
      mode: "off",
    };
  }
  if (
    phase === "failed" &&
    isCancelledBuildPipeline(
      snapshot as Pick<BuildPipeline, "phase" | "error" | "failureContext" | "cancelledAt">,
    )
  ) {
    const error = text(snapshot.error);
    // Only an unconfirmed stop says more than "Build cancelled".
    const unconfirmed =
      error && error !== BUILD_CANCELLED_ERROR ? [`Error: ${boundedLine(error)}`] : [];
    return {
      // A build restarted from the UI and cancelled again is a new cancel.
      key: `cancelled:${hash(text(snapshot.cancelledAt) ?? "")}`,
      state: "cancelled",
      tone: "info",
      terminal: true,
      headline: "was cancelled",
      details: [...task, ...unconfirmed, BUILD_CANCELLED_NOTICE],
      tools: [read],
      mode: "off",
    };
  }
  if (phase === "failed") {
    // A step failure (not a cancel, not setup) can be carried on from that step.
    const failure = record(snapshot.failureContext)
      ? text(snapshot.failureContext.phase)
      : undefined;
    const restartable =
      !snapshot.cancelledAt &&
      !(text(snapshot.error)?.startsWith("Build cancelled") ?? false) &&
      failure !== undefined &&
      sessionPhaseForBuildPhase(failure as ResumableBuildPhase) !== null;
    return {
      key: "failed",
      state: "failed",
      tone: "failure",
      terminal: true,
      headline: "failed",
      details: [
        ...task,
        ...errorLine,
        ...criteriaNoticeLines(
          buildPipelineCriteriaReport(snapshot),
          MAX_DETAILS - task.length - errorLine.length,
        ),
      ],
      tools: restartable
        ? [read, `restart_build_pipeline_step { "pipelineId": "${pipelineId}", "requestId": "…" }`]
        : [read],
      mode: "off",
    };
  }
  // A pause the user (or the coordinator) asked for is not news to them; a
  // pause the supervisor took on an error needs a decision.
  if (phase === "paused" && snapshot.pauseCause === "supervisor") {
    return {
      key: `paused:${text(snapshot.pausedFromPhase) ?? ""}:${iteration}:${hash(text(snapshot.error) ?? "")}`,
      state: "paused",
      tone: "attention",
      terminal: false,
      headline: "paused and needs a decision",
      details: [...task, ...errorLine],
      tools: [read, `resume_build_pipeline { "pipelineId": "${pipelineId}" }`],
      mode: "settled",
    };
  }
  const fanout = record(snapshot.reviewFanout) ? snapshot.reviewFanout : undefined;
  const fanoutStall =
    phase === "reviewing" && fanout
      ? stalledSession([
          ...(Array.isArray(fanout.reviewers)
            ? fanout.reviewers.map(
                (reviewer, index) => [`reviewer ${index + 1}`, reviewer] as [string, unknown],
              )
            : []),
          ["consolidation", fanout.consolidation],
        ])
      : null;
  if (fanoutStall)
    return {
      key: `stalled:${hash(`${fanoutStall.key}:${fanoutStall.since}`)}`,
      state: "stalled",
      tone: "attention",
      terminal: false,
      headline: `stalled (${fanoutStall.label})`,
      details: [
        ...task,
        `No activity from the ${fanoutStall.label} session since ${fanoutStall.since}.`,
      ],
      tools: [read],
      mode: "settled",
    };
  const stall = record(snapshot.stallWarning) ? snapshot.stallWarning : undefined;
  if (stall && phase !== "paused") {
    return {
      key: `stalled:${hash(`${text(stall.sessionId) ?? ""}:${text(stall.detectedAt) ?? ""}`)}`,
      state: "stalled",
      tone: "attention",
      terminal: false,
      headline: "stage looks stalled",
      details: [
        ...task,
        `No transcript activity in the ${phase ?? "current"} stage since ${text(stall.detectedAt) ?? "a while"}.`,
      ],
      tools: [read],
      mode: "settled",
    };
  }
  const finishedStage = phase ? BUILD_STAGE_LABELS[phase] : undefined;
  if (finishedStage) {
    return {
      key: `stage:${phase}:${iteration}`,
      state: "stage-completed",
      tone: "info",
      terminal: false,
      headline: `finished its ${finishedStage} stage; now ${phase}`,
      details: [...task, ...verification],
      tools: [read],
      mode: "stages",
    };
  }
  return null;
}
