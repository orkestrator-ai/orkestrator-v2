/**
 * Status wakes: a coordinator hears when work it started settles.
 *
 * A delegated tab's turn ending already wakes the coordinator (the delegation
 * wake in `coordinator-service.ts`). This module covers everything else a
 * coordinator creates or prompts and then waits on: a Multi Review reaching a
 * state that needs a decision, a build pipeline ending or stopping on an
 * error, a run that stalls, a delegated tab blocked on an approval or a
 * question (named from its pending interactions when they can be read).
 *
 * Ownership is the durable workflow association recorded when the coordinator
 * launched or prompted the resource, never anything the user started. Each
 * resource's state is reduced to one settled status with a stable key; a key
 * is sent once (the association records it), as an ordinary workflow notice
 * through the mail store, so delivery, batching, read/ack and restart
 * recovery are the mail store's. Notices about one resource are budgeted as
 * one routed pair (`statusBudgetKey`), and every notice opens or joins a short
 * coalescing window so several settling together arrive as one wake.
 *
 * Progress is not a status: individual reviewers finishing never wake anyone,
 * and build-pipeline stages only do under the opt-in `stages` mode.
 */
import { multiReviewFixIdentity } from "./multi-review-fix-identity.js";
import { createHash } from "node:crypto";
import {
  AgentMailError,
  agentMailStatusBudgetKey,
  normalizeAgentMessagingSettings,
  type AgentMailNotice,
  type AgentMailNoticeResource,
  type AgentMailNoticeTone,
  type CoordinatorStatusWakeMode,
} from "@orkestrator/protocol/agent-mail";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorDelegation,
  type CoordinatorWorkflowAssociation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { StorageService } from "./storage.js";
import type { CoordinatorRemoteAccess } from "./coordinator-remote.js";

/** How long a notice waits for others before waking the coordinator. */
export const COORDINATOR_STATUS_COALESCE_MS = 10_000;
/** How long a delegated tab must stay waiting before the coordinator hears about it. */
export const COORDINATOR_WAITING_DEBOUNCE_MS = 20_000;
/**
 * Workflow saves arrive in bursts (a running review saves on every progress
 * probe); observe each resource at most this often. Well inside the
 * coalescing window, so it adds nothing a coordinator would notice.
 */
const RESOURCE_CHANGE_DEBOUNCE_MS = 2_000;
/**
 * A resource first seen in a non-terminal settled state that has not changed
 * for this long is recorded without a wake. That is a workflow from before
 * status wakes existed, sitting at `ready` for days; reporting it now would be
 * a surprise turn about old news.
 */
const STATUS_BACKFILL_LIMIT_MS = 24 * 60 * 60 * 1_000;
const MAX_DETAIL_CHARS = 400;
const MAX_DETAILS = 8;
const MAX_LABEL_CHARS = 80;

const MODE_ORDER: Record<CoordinatorStatusWakeMode, number> = { off: 0, settled: 1, stages: 2 };

/** One settled state of a resource, reduced to what a coordinator needs to decide. */
export interface CoordinatorStatus {
  /** Stable for one settled state; the same key is never sent twice. */
  key: string;
  /** The notice's machine state. */
  state: string;
  tone: AgentMailNoticeTone;
  /** The resource will not change again (completed, failed, cancelled). */
  terminal: boolean;
  /** Completes the subject after the resource name: "is ready to address". */
  headline: string;
  /** Bounded facts: counts, an error, an excerpt. */
  details: string[];
  /** Calls that read more or act, written out with their arguments. */
  tools: string[];
  /** The least inclusive setting that still sends this status. */
  mode: CoordinatorStatusWakeMode;
}

/** The workflow kinds whose saves are observed for status wakes. */
export type CoordinatorStatusWorkflowKind = "multi-review" | "build-pipeline" | "graph-run";

export interface CoordinatorStatusResource {
  kind: AgentMailNoticeResource;
  id: string;
  environmentId?: string;
  tabId?: string;
  label?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** One line, at most `limit` characters, never empty. */
export function boundedLine(value: string, limit = MAX_DETAIL_CHARS): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** "2 P0, 1 P1" for a structured review report's issues. */
function findingCounts(report: unknown): { line: string; total: number } {
  if (!record(report)) return { line: "no structured report", total: 0 };
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const bySeverity = new Map<string, number>();
  for (const issue of issues) {
    const severity = record(issue) && typeof issue.severity === "string" ? issue.severity : "?";
    bySeverity.set(severity, (bySeverity.get(severity) ?? 0) + 1);
  }
  const gaps = count(report.testCoverageGaps);
  const parts = [...bySeverity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([severity, total]) => `${total} ${severity}`);
  const findings =
    issues.length === 0
      ? "no findings"
      : `${issues.length} finding${issues.length === 1 ? "" : "s"} (${parts.join(", ")})`;
  const coverage = gaps ? `, ${gaps} test-coverage gap${gaps === 1 ? "" : "s"}` : "";
  const verdict =
    record(report.verdict) && typeof report.verdict.ready === "string"
      ? `; verdict: ${report.verdict.ready}`
      : "";
  return { line: `${findings}${coverage}${verdict}`, total: issues.length + gaps };
}

interface StalledSession {
  key: string;
  label: string;
  since: string;
}

/** The earliest running session that has produced nothing for too long. */
function stalledSession(candidates: Array<[string, unknown]>): StalledSession | null {
  let earliest: StalledSession | null = null;
  for (const [label, session] of candidates) {
    if (!record(session)) continue;
    const since = text(session.stalledSince);
    if (!since) continue;
    if (session.status !== undefined && session.status !== "running") continue;
    const key = text(session.sessionKey) ?? text(session.id) ?? label;
    if (!earliest || since < earliest.since) earliest = { key, label, since };
  }
  return earliest;
}

/**
 * The settled status of a Multi Review snapshot, or null while it is just
 * making progress.
 *
 * Reviewers finishing one by one is progress and never wakes anyone; under
 * `stages` the coordinator hears once when all of them are done and
 * consolidation starts.
 *
 * Auto-fix and auto-PR advance the review on their own, so a state the
 * workflow is about to leave is not news: consolidation with findings goes
 * straight to the Fix (no `ready`), and a finished Fix with a queued PR is held
 * until the PR launch settles. A clean report with auto-PR on is held the same
 * way, then reported through the same PR states. The coordinator then hears `pr-started`, then
 * `pr-opened` once the environment reports an open pull request (URL and
 * state, read on the next observation), or `pr-failed`. Closed, merged and
 * unknown PR states are reported as such. A skipped PR is reported on
 * `fix-done` with its reason.
 */
export function multiReviewStatus(
  snapshot: unknown,
  workflowId: string,
  environment: { prUrl?: unknown; prState?: unknown } = {},
): CoordinatorStatus | null {
  if (!record(snapshot)) return null;
  const phase = text(snapshot.phase);
  const read = `get_multi_review { "workflowId": "${workflowId}" }`;
  const errorLine = text(snapshot.error) ? [`Error: ${boundedLine(snapshot.error as string)}`] : [];
  const fixSession = record(snapshot.fixSession) ? snapshot.fixSession : undefined;
  const autoPr = snapshot.autoPr === true;
  const recordedPrLaunch =
    autoPr && record(snapshot.autoPrLaunch) ? snapshot.autoPrLaunch : undefined;
  // A clean report's PR speaks for the review only while it rests on that
  // report. Old launched records cannot prove which Fix they contain. Other
  // legacy states keep their existing handoff behavior until a new Fix
  // supersedes them.
  const cleanReviewPr = recordedPrLaunch?.basis === "clean-review";
  const prLaunch =
    recordedPrLaunch &&
    (cleanReviewPr
      ? phase === "ready" &&
        record(snapshot.consolidatedReport) &&
        findingCounts(snapshot.consolidatedReport).total === 0
      : recordedPrLaunch.fixIdentity === undefined
        ? recordedPrLaunch.state !== "launched"
        : recordedPrLaunch.fixIdentity === multiReviewFixIdentity(fixSession))
      ? recordedPrLaunch
      : undefined;
  const prLaunchMessage = text(prLaunch?.message)
    ? boundedLine(prLaunch!.message as string)
    : undefined;
  const prUrl = text(environment.prUrl);
  /** The PR step's own status once it settled, keyed to the Fix or clean report that queued it. */
  const prStatus = (fixKey: string): CoordinatorStatus | null => {
    const finished = cleanReviewPr ? "found nothing to fix" : "fix finished";
    if (prLaunch?.state === "launched") {
      const tab = text(prLaunch.tabId);
      const tools = [
        read,
        ...(tab && text(snapshot.environmentId)
          ? [
              `get_tab_state { "environmentId": "${snapshot.environmentId as string}", "tabId": "${tab}" }`,
            ]
          : []),
      ];
      if (prUrl) {
        const state =
          environment.prState === "open" ||
          environment.prState === "closed" ||
          environment.prState === "merged"
            ? environment.prState
            : "unknown";
        const noticeState = state === "open" ? "pr-opened" : `pr-${state}`;
        return {
          key: `${noticeState}:${fixKey}`,
          state: noticeState,
          tone: state === "open" || state === "merged" ? "success" : "attention",
          terminal: false,
          headline:
            state === "open"
              ? `${finished} and its pull request is open`
              : state === "unknown"
                ? `${finished}; its pull request state is unknown`
                : `${finished}; its pull request is ${state}`,
          details: [`Pull request: ${boundedLine(prUrl)}`, "The coordinator does not merge it."],
          tools,
          mode: "settled",
        };
      }
      return {
        key: `pr-started:${fixKey}`,
        state: "pr-started",
        tone: "info",
        terminal: false,
        headline: `${finished}; PR session started`,
        details: [
          `The PR session${tab ? ` (tab ${tab})` : ""} pushes the branch and opens the pull request. Another update follows once the environment reports it.`,
        ],
        tools,
        mode: "settled",
      };
    }
    if (prLaunch?.state === "failed")
      return {
        key: `pr-failed:${fixKey}`,
        state: "pr-failed",
        tone: "failure",
        terminal: false,
        headline: `${finished} but its PR session could not start`,
        details: prLaunchMessage ? [`Error: ${prLaunchMessage}`] : [],
        tools: cleanReviewPr
          ? [read]
          : [read, `open_multi_review_fix { "workflowId": "${workflowId}" }`],
        mode: "settled",
      };
    return null;
  };
  const reviewSession = record(snapshot.reviewSession)
    ? snapshot.reviewSession
    : snapshot.reviewModel || snapshot.consolidationModel
      ? undefined
      : fixSession;
  const reviewAttempt = `${text(reviewSession?.sessionKey) ?? ""}:${text(reviewSession?.startedAt) ?? ""}`;
  if (phase === "completed") {
    // A structured Fix completes the review and queues its PR in the same save.
    if (prLaunch?.state === "pending") return null;
    const fix = record(snapshot.fixResult) ? snapshot.fixResult : undefined;
    return {
      key: "completed",
      state: "completed",
      tone: "success",
      terminal: true,
      headline: "completed",
      details: [
        ...(fix && text(fix.summary) ? [`Fix: ${boundedLine(fix.summary as string)}`] : []),
        ...(fix ? [`Files changed: ${count(fix.filesChanged)}`] : []),
        ...(prLaunch?.state === "launched"
          ? [
              `PR session started${text(prLaunch.tabId) ? ` in tab ${prLaunch.tabId as string}` : ""}.`,
            ]
          : prLaunch
            ? [`No PR session started${prLaunchMessage ? `: ${prLaunchMessage}` : "."}`]
            : []),
      ],
      tools: [read],
      mode: "off",
    };
  }
  if (phase === "failed") {
    return {
      key: "failed",
      state: "failed",
      tone: "failure",
      terminal: true,
      headline: "failed",
      details: errorLine,
      tools: [read],
      mode: "off",
    };
  }
  if (phase === "cancelled") {
    return {
      key: "cancelled",
      state: "cancelled",
      tone: "info",
      terminal: true,
      headline: "was cancelled",
      details: [],
      tools: [read],
      mode: "off",
    };
  }
  const stalled = stalledSession([
    ...(Array.isArray(snapshot.reviewers)
      ? snapshot.reviewers.map(
          (reviewer, index) =>
            [
              `reviewer ${record(reviewer) && text(reviewer.model) ? reviewer.model : index + 1}`,
              reviewer,
            ] as [string, unknown],
        )
      : []),
    ["consolidation", reviewSession],
    ["fix", fixSession],
  ]);
  if (
    stalled &&
    ["preparing", "reviewing", "consolidating", "fixing", "interactive"].includes(phase ?? "")
  ) {
    return {
      key: `stalled:${hash(`${stalled.key}:${stalled.since}`)}`,
      state: "stalled",
      tone: "attention",
      terminal: false,
      headline: `stalled (${stalled.label})`,
      details: [`No activity from the ${stalled.label} session since ${stalled.since}.`],
      tools: [read],
      mode: "settled",
    };
  }
  if (phase === "ready") {
    const findings = findingCounts(snapshot.consolidatedReport);
    const readyKey = hash(`${reviewAttempt}:${text(reviewSession?.completedAt) ?? ""}`);
    if (cleanReviewPr && prLaunch) {
      // Auto-PR moves a clean report straight on; report the PR, not the pause.
      if (prLaunch.state === "pending") return null;
      const pr = prStatus(readyKey);
      if (pr) return pr;
    }
    return {
      // A restarted consolidation reaches `ready` again with a new report.
      key: `ready:${readyKey}`,
      state: "ready",
      tone: findings.total > 0 ? "attention" : "success",
      terminal: false,
      headline: findings.total > 0 ? "is ready to address" : "found nothing to fix",
      details: [
        `Consolidated report: ${findings.line}.`,
        ...(cleanReviewPr && prLaunch
          ? [`No PR session started${prLaunchMessage ? `: ${prLaunchMessage}` : "."}`]
          : recordedPrLaunch?.state === "launched"
            ? ["An earlier PR session started; review and update it manually after this Fix."]
            : snapshot.autoFix === true && findings.total === 0
              ? ["Auto-fix is on, but there was nothing to fix, so no Fix or PR session started."]
              : autoPr
                ? [
                    "Auto-PR is on: once a Fix started with address_multi_review completes, a PR session starts automatically.",
                  ]
                : []),
      ],
      tools: [read, `address_multi_review { "workflowId": "${workflowId}" }`],
      mode: "settled",
    };
  }
  if (phase === "interactive" && snapshot.addressPromptPending !== true && fixSession) {
    const fixKey = hash(`${text(fixSession.sessionKey) ?? ""}:${text(fixSession.startedAt) ?? ""}`);
    if (fixSession.status === "idle") {
      // The PR is next; report how it went rather than a Fix the coordinator need not act on.
      if (prLaunch?.state === "pending") return null;
      const pr = prStatus(fixKey);
      if (pr) return pr;
      return {
        key: `fix-done:${fixKey}`,
        state: "fix-done",
        tone: "success",
        terminal: false,
        headline: "fix session finished its turn",
        details: [
          "The interactive fix turn ended. Read its tab to confirm every finding was addressed.",
          ...(recordedPrLaunch?.state === "launched" && !prLaunch
            ? [
                "An earlier PR session started; its pull request does not confirm inclusion of this Fix's changes. Review the Fix and update the PR manually.",
              ]
            : []),
          ...(prLaunch?.state === "skipped"
            ? [`No PR session started${prLaunchMessage ? `: ${prLaunchMessage}` : "."}`]
            : []),
        ],
        tools: [read, `open_multi_review_fix { "workflowId": "${workflowId}" }`],
        mode: "settled",
      };
    }
    if (fixSession.status === "failed") {
      return {
        key: `fix-failed:${fixKey}`,
        state: "fix-failed",
        tone: "failure",
        terminal: false,
        headline: "fix session failed",
        details: [
          ...(text(fixSession.error) ? [`Error: ${boundedLine(fixSession.error as string)}`] : []),
          ...(autoPr ? ["No PR session will start."] : []),
        ],
        tools: [read, `open_multi_review_fix { "workflowId": "${workflowId}" }`],
        mode: "settled",
      };
    }
  }
  if (phase === "consolidating") {
    const reviewers = Array.isArray(snapshot.reviewers) ? snapshot.reviewers : [];
    const completed = reviewers.filter(
      (reviewer) => record(reviewer) && reviewer.status === "completed",
    ).length;
    return {
      key: `consolidating:${hash(reviewAttempt)}`,
      state: "reviews-finished",
      tone: "info",
      terminal: false,
      headline: "reviewers finished; consolidating",
      details: [`${completed} of ${reviewers.length} reviewers produced a report.`],
      tools: [read],
      mode: "stages",
    };
  }
  return null;
}

const BUILD_STAGE_LABELS: Record<string, string> = {
  reviewing: "build",
  addressing: "review",
  verifying: "address",
  fixing: "verification",
  // Successful verification starts PR creation; a fix loops back through review.
  "creating-pr": "verification",
  "resolving-conflicts": "pull request",
};

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
    return {
      key: "complete",
      state: "completed",
      tone: "success",
      terminal: true,
      headline: "completed",
      details: [...task, ...verification],
      tools: [read],
      mode: "off",
    };
  }
  if (phase === "failed") {
    return {
      key: "failed",
      state: "failed",
      tone: "failure",
      terminal: true,
      headline: "failed",
      details: [...task, ...errorLine],
      tools: [read],
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

/** Node ids listed in a graph run notice. */
const MAX_GRAPH_RUN_NODES = 6;

/**
 * The settled status of a graph run (item 214, D6), reduced over two run
 * events only, so every way a run can end or stop for a person is covered by
 * the run record alone:
 *
 * - **ended**: a terminal status (`complete`, `failed`, `cancelled`), keyed
 *   `ended:<status>`, sent whatever the wake setting (as every terminal
 *   workflow notice is);
 * - **waiting for a person**: the run is `waiting`, or any live activation is
 *   `awaiting-human` (a human node of item 208, or an agent's `ask_human`
 *   question), keyed by the waiting positions (activation key, attempt and
 *   open question id), so the same wait is reported once and a new wait after
 *   the run resumed is reported again.
 *
 * Anything else is progress and wakes nobody. Details are content-free:
 * counts, node ids, the run's bounded error and its cause.
 */
export function graphRunStatus(run: unknown, runId: string): CoordinatorStatus | null {
  if (!record(run)) return null;
  const status = text(run.status);
  const read = `get_graph_run { "runId": "${runId}" }`;
  const plan = record(run.plan) ? run.plan : undefined;
  const template = record(plan?.template) ? text(plan.template.name) : undefined;
  const templateLine = template ? [`Graph: ${boundedLine(template, MAX_LABEL_CHARS)}`] : [];
  const usage = record(run.usage) ? run.usage : undefined;
  const sessions = typeof usage?.agentSessions === "number" ? usage.agentSessions : 0;
  const usageLine = [`${sessions} agent session${sessions === 1 ? "" : "s"} used.`];
  const mockLine = run.mock === true ? ["A mock run: no sessions, no side effects."] : [];
  if (status === "complete" || status === "failed" || status === "cancelled") {
    const errorLines = text(run.error)
      ? [
          `Error: ${boundedLine(run.error as string)}${text(run.errorCause) ? ` (${text(run.errorCause)})` : ""}`,
        ]
      : [];
    return {
      key: `ended:${status}`,
      state: status === "complete" ? "completed" : status,
      tone: status === "complete" ? "success" : status === "failed" ? "failure" : "info",
      terminal: true,
      headline:
        status === "complete" ? "completed" : status === "failed" ? "failed" : "was cancelled",
      details: [...templateLine, ...mockLine, ...usageLine, ...errorLines],
      tools: [read],
      mode: "off",
    };
  }
  const activations = Array.isArray(run.activations) ? run.activations : [];
  const waiting = activations
    .filter((activation) => record(activation) && activation.state === "awaiting-human")
    .map((activation) => activation as Record<string, unknown>);
  if (status !== "waiting" && waiting.length === 0) return null;
  const positions = waiting
    .map((activation) => {
      const session = record(activation.session) ? activation.session : undefined;
      const question = record(session?.question) ? text(session.question.id) : undefined;
      return `${text(activation.key) ?? ""}#${typeof activation.attempt === "number" ? activation.attempt : 0}#${question ?? ""}`;
    })
    .sort();
  const nodes = [
    ...new Set(waiting.map((activation) => text(activation.nodeId)).filter(Boolean)),
  ] as string[];
  const shown = nodes.slice(0, MAX_GRAPH_RUN_NODES).join(", ");
  const more =
    nodes.length > MAX_GRAPH_RUN_NODES ? ` and ${nodes.length - MAX_GRAPH_RUN_NODES} more` : "";
  return {
    key: `waiting:${hash(positions.join("\n"))}`,
    state: "waiting",
    tone: "attention",
    terminal: false,
    headline: "is waiting for a person",
    details: [
      ...templateLine,
      waiting.length > 0
        ? `${waiting.length} step${waiting.length === 1 ? "" : "s"} waiting: ${shown}${more}.`
        : "The run is waiting for a person.",
      "The user answers in the run view; the run resumes on its own once they do.",
    ],
    tools: [read],
    mode: "settled",
  };
}

/** Subject, Markdown body and structured notice for one status, all bounded. */
export function renderCoordinatorStatusNotice(
  resource: CoordinatorStatusResource,
  status: CoordinatorStatus,
): { subject: string; body: string; notice: AgentMailNotice } {
  const name =
    resource.kind === "multi-review"
      ? "Multi Review"
      : resource.kind === "build-pipeline"
        ? "Build pipeline"
        : resource.kind === "graph-run"
          ? "Graph run"
          : "Worker";
  const label = resource.label ? ` ${boundedLine(resource.label, MAX_LABEL_CHARS)}` : "";
  const subject = boundedLine(`${name}${label} ${status.headline}`, 160);
  const where =
    resource.kind === "agent-tab"
      ? `tab \`${resource.tabId ?? resource.id}\` in environment \`${resource.environmentId ?? "?"}\``
      : `\`${resource.id}\`${resource.environmentId ? ` in environment \`${resource.environmentId}\`` : ""}`;
  const body = [
    `${name} ${where} ${status.headline}.`,
    ...status.details.slice(0, MAX_DETAILS).map((detail) => `- ${boundedLine(detail)}`),
    "",
    `Read more: ${status.tools.map((tool) => `\`${tool}\``).join(", ")}.`,
    "This is a status update for work this conversation started. Decide whether it needs anything from you; if not, acknowledge it and finish the turn.",
  ].join("\n");
  return {
    subject,
    body,
    notice: {
      resource: {
        kind: resource.kind,
        id: resource.id,
        ...(resource.environmentId ? { environmentId: resource.environmentId } : {}),
        ...(resource.tabId ? { tabId: resource.tabId } : {}),
        ...(resource.label ? { label: boundedLine(resource.label, MAX_LABEL_CHARS) } : {}),
      },
      state: status.state,
      tone: status.tone,
    },
  };
}

/**
 * The text of the newest assistant message in a projection page, or undefined.
 *
 * Reads the shared native message shape (`role`, `content`, text `parts`)
 * without trusting it, since it comes from a provider transcript.
 */
export function lastAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!record(message) || message.role !== "assistant") continue;
    const parts = Array.isArray(message.parts)
      ? message.parts
          .filter(
            (part) => record(part) && part.type === "text" && typeof part.content === "string",
          )
          .map((part) => (part as { content: string }).content)
      : [];
    const content = (parts.length > 0 ? parts.join("\n") : text(message.content)) ?? "";
    if (content.trim()) return boundedLine(content);
  }
  return undefined;
}

/** What a waiting worker is blocked on, read from its pending interactions. */
export type CoordinatorWaitingBlocker = "approval" | "question" | "approval-and-question";

const APPROVAL_INTERACTION_KINDS: ReadonlySet<string> = new Set([
  "plan-approval",
  "command-approval",
  "file-approval",
  "permission",
]);
const QUESTION_INTERACTION_KINDS: ReadonlySet<string> = new Set([
  "question",
  "mcp-form",
  "mcp-url",
  "elicitation",
  "terminal-selection",
]);

/**
 * Whether a worker's open interactions are approvals, questions or both.
 *
 * Only requests the turn is actually waiting on count: a non-blocking request
 * does not hold the session at `waiting`, so it cannot be why it is. Undefined
 * when nothing blocking is open (the activity state then says only "waiting").
 */
export function waitingBlocker(interactions: unknown): CoordinatorWaitingBlocker | undefined {
  if (!Array.isArray(interactions)) return undefined;
  let approval = false;
  let question = false;
  for (const interaction of interactions) {
    if (!record(interaction) || interaction.blocking === false) continue;
    if (interaction.state !== "pending" && interaction.state !== "answering") continue;
    if (typeof interaction.kind !== "string") continue;
    if (APPROVAL_INTERACTION_KINDS.has(interaction.kind)) approval = true;
    else if (QUESTION_INTERACTION_KINDS.has(interaction.kind)) question = true;
  }
  if (approval && question) return "approval-and-question";
  if (approval) return "approval";
  return question ? "question" : undefined;
}

const WAITING_HEADLINES: Record<CoordinatorWaitingBlocker | "unknown", string> = {
  approval: "is waiting for an approval",
  question: "is waiting for an answer to a question",
  "approval-and-question": "is waiting for an approval and an answer to a question",
  unknown: "is waiting for input or an approval",
};

/** A delegated tab that has been waiting long enough to tell its coordinator. */
export function waitingStatus(
  delegation: Pick<CoordinatorDelegation, "waiting">,
  environmentId: string,
  tabId: string,
  excerpt?: string,
  blocker?: CoordinatorWaitingBlocker,
): CoordinatorStatus | null {
  const since = delegation.waiting?.since;
  if (!since) return null;
  return {
    key: `waiting:${since}`,
    state: "waiting",
    tone: "attention",
    terminal: false,
    headline: WAITING_HEADLINES[blocker ?? "unknown"],
    details: [
      `Waiting since ${since}. A person has to answer it in the worker's tab; the coordinator cannot ${blocker === "approval-and-question" ? "approve or answer" : blocker === "question" ? "answer" : "approve"} on its behalf.`,
      ...(excerpt ? [`Last message: ${boundedLine(excerpt)}`] : []),
    ],
    tools: [
      `get_tab_state { "environmentId": "${environmentId}", "tabId": "${tabId}" }`,
      `get_tab_transcript { "environmentId": "${environmentId}", "tabId": "${tabId}" }`,
    ],
    mode: "settled",
  };
}

export interface CoordinatorStatusWakeTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_TIMERS: CoordinatorStatusWakeTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CoordinatorStatusWakeOptions {
  /** Fresh turn activity of a worker tab, for waiting episodes. */
  workerActivity?: (
    environmentId: string,
    tabId: string,
  ) => Promise<AgentActivityState | "unknown">;
  /** The worker's last assistant text, best effort; omitted when unavailable. */
  lastAssistantExcerpt?: (environmentId: string, tabId: string) => Promise<string | undefined>;
  /** What the worker's pending interactions block it on, best effort. */
  waitingBlocker?: (
    environmentId: string,
    tabId: string,
  ) => Promise<CoordinatorWaitingBlocker | undefined>;
  timers?: CoordinatorStatusWakeTimers;
  coalesceMs?: number;
  waitingDebounceMs?: number;
}

/**
 * The same status for a resource on another node: every suggested call names
 * that node, and the first detail says where the work runs.
 */
export function statusOnNode(
  status: CoordinatorStatus,
  nodeId: string,
  nodeName: string,
): CoordinatorStatus {
  return {
    ...status,
    details: [`Runs on ${nodeName} (nodeId ${nodeId}).`, ...status.details],
    tools: status.tools.map((tool) => tool.replace(/^(\w+) \{ /, `$1 { "nodeId": "${nodeId}", `)),
  };
}

/** Sends status wakes for coordinator-owned resources; see the module comment. */
export class CoordinatorStatusWakes {
  private readonly timers: CoordinatorStatusWakeTimers;
  private readonly coalesceMs: number;
  private readonly waitingDebounceMs: number;
  private readonly changeTimers = new Map<string, unknown>();
  private readonly waitingTimers = new Map<string, unknown>();
  private unsubscribe: (() => void) | null = null;
  /** One pass at a time, so two observers of one state cannot both send it. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Reads of workflows and workers on other nodes, once the node services exist. */
  private remote: CoordinatorRemoteAccess | null = null;

  constructor(
    private readonly storage: StorageService,
    private readonly options: CoordinatorStatusWakeOptions = {},
  ) {
    this.timers = options.timers ?? SYSTEM_TIMERS;
    this.coalesceMs = options.coalesceMs ?? COORDINATOR_STATUS_COALESCE_MS;
    this.waitingDebounceMs = options.waitingDebounceMs ?? COORDINATOR_WAITING_DEBOUNCE_MS;
  }

  setRemoteAccess(remote: CoordinatorRemoteAccess): void {
    this.remote = remote;
  }

  /**
   * A workflow on another node was saved (its node's relayed event). Debounced
   * like a local save; cheap when no coordinator here owns it.
   */
  noteRemoteWorkflowChange(
    nodeId: string,
    kind: "multi-review" | "build-pipeline",
    id: string,
  ): void {
    const key = `${nodeId}\0${kind}\0${id}`;
    if (this.changeTimers.has(key)) return;
    this.changeTimers.set(
      key,
      this.timers.setTimeout(() => {
        this.changeTimers.delete(key);
        void this.observeWorkflow(kind, id, nodeId).catch((error: unknown) => {
          console.warn(
            "[coordinator] Could not observe a remote workflow for status wakes:",
            error instanceof Error ? error.message : error,
          );
        });
      }, RESOURCE_CHANGE_DEBOUNCE_MS),
    );
  }

  /** Observe workflow saves so a settled state is reported within seconds, not on the sweep. */
  start(): void {
    this.unsubscribe ??= this.storage.addResourceChangeListener((change) =>
      this.onResourceChange(change),
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const handle of [...this.changeTimers.values(), ...this.waitingTimers.values()]) {
      this.timers.clearTimeout(handle);
    }
    this.changeTimers.clear();
    this.waitingTimers.clear();
  }

  private onResourceChange(change: ResourceChange): void {
    if (
      change.resource !== "multi-review" &&
      change.resource !== "build-pipeline" &&
      change.resource !== "graph-run"
    ) {
      return;
    }
    // A removed run has nothing left to report.
    if (change.resource === "graph-run" && change.deleted) return;
    const kind = change.resource;
    const key = `${kind}\0${change.id}`;
    if (this.changeTimers.has(key)) return;
    this.changeTimers.set(
      key,
      this.timers.setTimeout(() => {
        this.changeTimers.delete(key);
        void this.observeWorkflow(kind, change.id).catch((error: unknown) => {
          console.warn(
            "[coordinator] Could not observe a workflow for status wakes:",
            error instanceof Error ? error.message : error,
          );
        });
      }, RESOURCE_CHANGE_DEBOUNCE_MS),
    );
  }

  /** Resolves once every observation queued so far has finished. */
  settled(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async mode(): Promise<CoordinatorStatusWakeMode> {
    const settings = normalizeAgentMessagingSettings(
      (await this.storage.loadConfig()).global.agentMessaging,
    );
    return settings.coordinatorStatusWakes;
  }

  /** Observe one workflow now (on `nodeId`, or this node). Cheap when no coordinator owns it. */
  observeWorkflow(
    kind: CoordinatorStatusWorkflowKind,
    resourceId: string,
    nodeId?: string,
  ): Promise<void> {
    return this.serialize(async () => {
      const state = await this.storage.coordinators.getCoordinatorReconciliationState();
      const owned = state.workflows.filter(
        (association) =>
          association.kind === kind &&
          association.resourceId === resourceId &&
          association.nodeId === nodeId &&
          !association.pending &&
          !association.terminalNotifiedAt,
      );
      if (owned.length === 0) return;
      const mode = await this.mode();
      for (const association of owned) {
        await this.observeAssociation(state.workspaces, association, mode);
      }
    });
  }

  /**
   * Every owned workflow and every open delegation's waiting episode, read
   * from storage. The recovery path: a missed save event, a timer lost to a
   * restart, or a notice whose bookkeeping write never landed.
   */
  reconcile(): Promise<void> {
    return this.serialize(async () => {
      const state = await this.storage.coordinators.getCoordinatorReconciliationState();
      const mode = await this.mode();
      for (const association of state.workflows) {
        if (
          (association.kind === "multi-review" ||
            association.kind === "build-pipeline" ||
            association.kind === "graph-run") &&
          !association.pending &&
          !association.terminalNotifiedAt
        ) {
          await this.observeAssociation(state.workspaces, association, mode).catch(
            (error: unknown) => {
              console.warn(
                "[coordinator] Could not deliver a workflow status wake:",
                error instanceof Error ? error.message : error,
              );
            },
          );
        }
      }
      if (MODE_ORDER[mode] < MODE_ORDER.settled) return;
      for (const association of state.workflows) {
        if (association.kind !== "environment" || association.delegation?.state !== "running") {
          continue;
        }
        await this.reconcileWaiting(state.workspaces, association).catch((error: unknown) => {
          console.warn(
            "[coordinator] Could not check a waiting worker:",
            error instanceof Error ? error.message : error,
          );
        });
      }
    });
  }

  /**
   * The environment of a review whose PR session started, so its pull request
   * can be reported once the PR monitor records it. Nothing else reads it.
   */
  private async launchedPrEnvironment(
    snapshot: unknown,
    nodeId?: string,
  ): Promise<{ prUrl?: unknown; prState?: unknown }> {
    if (
      !record(snapshot) ||
      snapshot.autoPr !== true ||
      !record(snapshot.autoPrLaunch) ||
      snapshot.autoPrLaunch.state !== "launched" ||
      !text(snapshot.environmentId)
    )
      return {};
    if (nodeId) {
      return (
        (await this.remote
          ?.environmentPr(nodeId, snapshot.environmentId as string)
          .catch(() => ({}))) ?? {}
      );
    }
    return (await this.storage.getEnvironment(snapshot.environmentId as string)) ?? {};
  }

  private async observeAssociation(
    workspaces: CoordinatorWorkspace[],
    association: CoordinatorWorkflowAssociation,
    mode: CoordinatorStatusWakeMode,
  ): Promise<void> {
    if (association.kind === "graph-run") {
      await this.observeGraphRun(workspaces, association, mode);
      return;
    }
    const kind = association.kind === "build-pipeline" ? "build-pipeline" : "multi-review";
    const remote = association.nodeId ? this.remote : null;
    if (association.nodeId && !remote) return;
    const read = remote
      ? await remote
          .workflow(association.nodeId!, kind, association.resourceId)
          .catch(() => "unavailable" as const)
      : kind === "build-pipeline"
        ? await this.storage.getBuildPipeline(association.resourceId)
        : await this.storage.getMultiReviewWorkflow(association.resourceId);
    // An unreachable node is no news; the sweep asks again.
    if (!read || read === "unavailable") return;
    const persisted = read as {
      snapshot: unknown;
      revision?: number;
      updatedAt?: string;
      environmentId?: string;
    };
    const reduced =
      kind === "build-pipeline"
        ? buildPipelineStatus(persisted.snapshot, association.resourceId)
        : multiReviewStatus(
            persisted.snapshot,
            association.resourceId,
            await this.launchedPrEnvironment(persisted.snapshot, association.nodeId),
          );
    const nodeName =
      remote && association.nodeId
        ? await remote.nodeName(association.nodeId).catch(() => association.nodeId!)
        : null;
    const status =
      reduced && nodeName ? statusOnNode(reduced, association.nodeId!, nodeName) : reduced;
    if (!status || MODE_ORDER[mode] < MODE_ORDER[status.mode]) return;
    const revision = typeof persisted.revision === "number" ? persisted.revision : 0;
    if (association.statusNotice?.key === status.key) {
      // Already sent; only the terminal bookkeeping may be missing.
      if (status.terminal)
        await this.storage.coordinators.markCoordinatorWorkflowNotified(association.id, revision);
      return;
    }
    const updatedAt = Date.parse(text(persisted.updatedAt) ?? "");
    if (
      !status.terminal &&
      !association.statusNotice &&
      Number.isFinite(updatedAt) &&
      this.timers.now() - updatedAt > STATUS_BACKFILL_LIMIT_MS
    ) {
      await this.recordNotice(association.id, status.key);
      return;
    }
    const snapshot = record(persisted.snapshot) ? persisted.snapshot : {};
    const environmentId = text(snapshot.environmentId) ?? text(persisted.environmentId);
    const label =
      remote && association.nodeId && environmentId
        ? await remote
            .workerState(association.nodeId, environmentId, "")
            .then((state) => (state === "unavailable" ? undefined : state.name))
            .catch(() => undefined)
        : environmentId
          ? (await this.storage.getEnvironment(environmentId))?.name
          : undefined;
    const delivered = await this.deliver(
      workspaces,
      association,
      {
        kind,
        id: association.resourceId,
        ...(environmentId ? { environmentId } : {}),
        ...(label || nodeName
          ? { label: `${label ?? association.resourceId}${nodeName ? ` on ${nodeName}` : ""}` }
          : {}),
      },
      status,
    );
    if (!delivered) return;
    await this.recordNotice(association.id, status.key);
    if (status.terminal)
      await this.storage.coordinators.markCoordinatorWorkflowNotified(association.id, revision);
  }

  /**
   * A graph run the coordinator launched (item 214): one notice when it ends,
   * one each time it starts waiting for a person. Graph runs are launched on
   * this node only, so there is no remote read.
   */
  private async observeGraphRun(
    workspaces: CoordinatorWorkspace[],
    association: CoordinatorWorkflowAssociation,
    mode: CoordinatorStatusWakeMode,
  ): Promise<void> {
    if (association.nodeId) return;
    const run = await this.storage.graphRuns.getGraphRun(association.resourceId);
    if (!run) return;
    const status = graphRunStatus(run, association.resourceId);
    if (!status || MODE_ORDER[mode] < MODE_ORDER[status.mode]) return;
    if (association.statusNotice?.key === status.key) {
      if (status.terminal)
        await this.storage.coordinators.markCoordinatorWorkflowNotified(
          association.id,
          run.revision,
        );
      return;
    }
    const updatedAt = Date.parse(run.updatedAt);
    if (
      !status.terminal &&
      !association.statusNotice &&
      Number.isFinite(updatedAt) &&
      this.timers.now() - updatedAt > STATUS_BACKFILL_LIMIT_MS
    ) {
      await this.recordNotice(association.id, status.key);
      return;
    }
    const label = run.environmentId
      ? (await this.storage.getEnvironment(run.environmentId))?.name
      : undefined;
    const delivered = await this.deliver(
      workspaces,
      association,
      {
        kind: "graph-run",
        id: association.resourceId,
        ...(run.environmentId ? { environmentId: run.environmentId } : {}),
        label: label ? `${run.plan.template.name} in ${label}` : run.plan.template.name,
      },
      status,
    );
    if (!delivered) return;
    await this.recordNotice(association.id, status.key);
    if (status.terminal)
      await this.storage.coordinators.markCoordinatorWorkflowNotified(association.id, run.revision);
  }

  /**
   * Note an observed activity change of a worker tab.
   *
   * Only tabs with an open delegation matter: a waiting episode starts with a
   * durable `since`, and the notice follows once it has lasted past the
   * debounce, so an approval answered within seconds never wakes anyone.
   * Working again ends the episode.
   */
  noteWorkerActivity(event: {
    environmentId: string;
    tabId: string;
    state: AgentActivityState | "unknown";
  }): Promise<void> {
    return this.serialize(async () => {
      const open = (await this.storage.coordinators.listOpenCoordinatorDelegations()).filter(
        (association) =>
          !association.nodeId &&
          association.resourceId === event.environmentId &&
          association.delegation?.workerTabId === event.tabId,
      );
      for (const association of open) {
        if (event.state === "waiting") {
          if (association.delegation?.waiting) continue;
          const since = new Date(this.timers.now()).toISOString();
          await this.storage.coordinators.updateCoordinatorWorkflowAssociation(
            association.id,
            (current) => {
              if (current.delegation?.state !== "running" || current.delegation.waiting)
                return false;
              current.delegation = { ...current.delegation, waiting: { since } };
              return true;
            },
          );
          this.scheduleWaitingCheck(association.id);
        } else if (event.state === "working" && association.delegation?.waiting) {
          this.clearWaitingTimer(association.id);
          await this.storage.coordinators.updateCoordinatorWorkflowAssociation(
            association.id,
            (current) => {
              if (!current.delegation?.waiting) return false;
              const { waiting: _waiting, ...rest } = current.delegation;
              current.delegation = rest;
              return true;
            },
          );
        }
      }
    });
  }

  private scheduleWaitingCheck(associationId: string): void {
    this.clearWaitingTimer(associationId);
    this.waitingTimers.set(
      associationId,
      this.timers.setTimeout(() => {
        this.waitingTimers.delete(associationId);
        void this.serialize(async () => {
          const state = await this.storage.coordinators.getCoordinatorReconciliationState();
          const association = state.workflows.find((item) => item.id === associationId);
          if (association?.delegation?.state !== "running") return;
          if (MODE_ORDER[await this.mode()] < MODE_ORDER.settled) return;
          await this.reconcileWaiting(state.workspaces, association);
        }).catch((error: unknown) => {
          console.warn(
            "[coordinator] Could not report a waiting worker:",
            error instanceof Error ? error.message : error,
          );
        });
      }, this.waitingDebounceMs),
    );
  }

  private clearWaitingTimer(associationId: string): void {
    const handle = this.waitingTimers.get(associationId);
    if (handle === undefined) return;
    this.timers.clearTimeout(handle);
    this.waitingTimers.delete(associationId);
  }

  /**
   * Start, end or report one delegation's waiting episode from a fresh
   * activity read. Runs on the debounce timer and on the sweep, which is what
   * finds an episode whose edge or timer a restart lost.
   */
  private async reconcileWaiting(
    workspaces: CoordinatorWorkspace[],
    association: CoordinatorWorkflowAssociation,
  ): Promise<void> {
    const delegation = association.delegation;
    if (!delegation || delegation.state !== "running") return;
    const remote = association.nodeId ? this.remote : null;
    if (association.nodeId ? !remote : !this.options.workerActivity) return;
    const activity: AgentActivityState | "unknown" = remote
      ? await remote
          .workerState(association.nodeId!, association.resourceId, delegation.workerTabId)
          .then((state) =>
            state !== "unavailable" &&
            (state.tab === "working" || state.tab === "waiting" || state.tab === "idle")
              ? state.tab
              : ("unknown" as const),
          )
          .catch(() => "unknown" as const)
      : await this.options.workerActivity!(association.resourceId, delegation.workerTabId);
    if (activity !== "waiting") {
      if (delegation.waiting && activity === "working") {
        this.clearWaitingTimer(association.id);
        await this.storage.coordinators.updateCoordinatorWorkflowAssociation(
          association.id,
          (current) => {
            if (!current.delegation?.waiting) return false;
            const { waiting: _waiting, ...rest } = current.delegation;
            current.delegation = rest;
            return true;
          },
        );
      }
      return;
    }
    if (!delegation.waiting) {
      const since = new Date(this.timers.now()).toISOString();
      await this.storage.coordinators.updateCoordinatorWorkflowAssociation(
        association.id,
        (current) => {
          if (current.delegation?.state !== "running" || current.delegation.waiting) return false;
          current.delegation = { ...current.delegation, waiting: { since } };
          return true;
        },
      );
      this.scheduleWaitingCheck(association.id);
      return;
    }
    if (delegation.waiting.notifiedAt) return;
    const elapsed = this.timers.now() - Date.parse(delegation.waiting.since);
    if (!(elapsed >= this.waitingDebounceMs)) {
      if (!this.waitingTimers.has(association.id)) this.scheduleWaitingCheck(association.id);
      return;
    }
    const environmentName = remote
      ? await remote
          .workerState(association.nodeId!, association.resourceId, delegation.workerTabId)
          .then((state) => (state === "unavailable" ? undefined : state.name))
          .catch(() => undefined)
      : (await this.storage.getEnvironment(association.resourceId))?.name;
    const [excerpt, blocker] = await Promise.all([
      remote
        ? remote
            .lastAssistantExcerpt(
              association.nodeId!,
              association.resourceId,
              delegation.workerTabId,
            )
            .catch(() => undefined)
        : this.options
            .lastAssistantExcerpt?.(association.resourceId, delegation.workerTabId)
            .catch(() => undefined),
      remote
        ? remote
            .waitingBlocker?.(association.nodeId!, association.resourceId, delegation.workerTabId)
            .catch(() => undefined)
        : this.options
            .waitingBlocker?.(association.resourceId, delegation.workerTabId)
            .catch(() => undefined),
    ]);
    const nodeName = remote
      ? await remote.nodeName(association.nodeId!).catch(() => association.nodeId!)
      : null;
    const waiting = waitingStatus(
      delegation,
      association.resourceId,
      delegation.workerTabId,
      excerpt,
      blocker,
    );
    const status =
      waiting && nodeName ? statusOnNode(waiting, association.nodeId!, nodeName) : waiting;
    if (!status) return;
    const delivered = await this.deliver(
      workspaces,
      association,
      {
        kind: "agent-tab",
        id: delegation.workerTabId,
        environmentId: association.resourceId,
        tabId: delegation.workerTabId,
        ...(environmentName || nodeName
          ? {
              label: `${environmentName ?? association.resourceId}${nodeName ? ` on ${nodeName}` : ""}`,
            }
          : {}),
      },
      status,
    );
    if (!delivered) return;
    const notifiedAt = new Date(this.timers.now()).toISOString();
    await this.storage.coordinators.updateCoordinatorWorkflowAssociation(
      association.id,
      (current) => {
        if (current.delegation?.waiting?.since !== delegation.waiting!.since) return false;
        current.delegation = {
          ...current.delegation,
          waiting: { ...current.delegation.waiting, notifiedAt },
        };
        current.statusNotice = { key: status.key, notifiedAt };
        return true;
      },
    );
  }

  private async recordNotice(associationId: string, key: string): Promise<void> {
    const notifiedAt = new Date(this.timers.now()).toISOString();
    await this.storage.coordinators.updateCoordinatorWorkflowAssociation(
      associationId,
      (current) => {
        if (current.statusNotice?.key === key) return false;
        current.statusNotice = { key, notifiedAt };
        return true;
      },
    );
  }

  /**
   * Put one status notice in the main coordinator's inbox.
   *
   * Like the terminal workflow notice it extends, it does not start a main
   * coordinator: with none open it waits, and the sweep sends the state current
   * when one opens. The request id is fixed by association, conversation and
   * state, so a retry after a crash finds the message already placed.
   */
  private async deliver(
    workspaces: CoordinatorWorkspace[],
    association: CoordinatorWorkflowAssociation,
    resource: CoordinatorStatusResource,
    status: CoordinatorStatus,
  ): Promise<boolean> {
    const workspace = workspaces.find(
      (candidate) =>
        candidate.id === association.coordinatorId && candidate.projectId === association.projectId,
    );
    const main = workspace ? coordinatorMainConversation(workspace) : undefined;
    if (!workspace || !main) return false;
    const { subject, body, notice } = renderCoordinatorStatusNotice(resource, status);
    try {
      await this.storage.sendAgentMail(
        {
          kind: "system",
          projectId: association.projectId,
          source: "workflow",
          resourceId: association.resourceId,
        },
        {
          requestId: `status:${association.id}:${main.id}:${hash(status.key)}`,
          toEnvironmentId: coordinatorRuntimeId(workspace.id, main.id),
          toTabId: main.tabId,
          subject,
          body,
        },
        {
          notice,
          // A tab id is only unique within its environment.
          statusBudgetKey: agentMailStatusBudgetKey(
            resource.kind,
            resource.kind === "agent-tab"
              ? `${resource.environmentId ?? ""}/${resource.tabId ?? resource.id}`
              : resource.id,
          ),
          coalesceMs: this.coalesceMs,
        },
      );
      return true;
    } catch (error) {
      // The same state was already placed under this request id with words
      // that have since changed (an excerpt, a timestamp): it was delivered.
      if (error instanceof AgentMailError && error.code === "idempotency-conflict") return true;
      throw error;
    }
  }
}
