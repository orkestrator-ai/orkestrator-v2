import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  escapedInteractionFailures,
  type CoordinatorLiveCheck,
  type CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import { carrierRowIndex, statusReviewAgentSettings } from "./coordinator-live-status.js";

/**
 * The live coordinator suite's `routing` scenario (todo 7545): plain user
 * requests that name no workflow, each checked for the workflow the
 * coordinator chose.
 *
 * Four cases, in order, on one coordinator conversation:
 *
 * 1. `build`: a small, fully specified change with a done condition. Expected:
 *    `create_ticket` with acceptance criteria, then `start_build_pipeline` for
 *    that ticket with no `agentType`, `steps`, `reviewers` or
 *    `reviewPreparation`. The harness cancels the build once the turn ends,
 *    as the user's Cancel does; the coordinator must hear a `cancelled`
 *    notice and, woken by it, neither restart, resume nor rebuild it.
 * 2. `investigate`: a question that needs a run, with "don't change
 *    anything". Expected: a worker (`launch_environment`, `launch_job` or
 *    `send_prompt_to_tab`) and no ticket, build or Multi Review. The worker's
 *    report is let through, so its wake cannot land in a later case.
 * 3. `review`: "review the work on this branch". Expected: `launch_multi_review`
 *    on that environment with `autoFix` and `autoPr` absent or false, which the
 *    backend's workflow record must confirm. The harness cancels the review.
 * 4. `delivery`: case 1 again, with the harness setting the new ticket's
 *    delivery to `commit-only` once the build has started. Expected: the same
 *    routing as case 1, then the build runs to `complete` with no PR stage.
 *
 * Each case is judged from the coordinator's tool calls in that case's own
 * transcript rows and from backend records (the coordinator's workflow
 * associations, the ticket, the pipeline, the review), never from the model's
 * wording. Each case records its checks before the next starts, so an early
 * failure does not hide a later case.
 *
 * This module holds the prompts and the verdict; the spec and its orchestration
 * (`coordinator-live-routing-orchestration.ts`) share it. Nothing here may use
 * Bun APIs.
 */

export const ROUTING_CASES = ["build", "investigate", "review", "delivery"] as const;
export type RoutingCase = (typeof ROUTING_CASES)[number];

export interface RoutingProbe {
  platform: AgentPlatform;
  /** Random hex; the files each request names carry it. */
  token: string;
}

/** The environment the review case names: made by the harness, with one change in it. */
export interface RoutingReviewTarget {
  environmentId: string;
  name: string;
  branch: string;
}

export function routingEnvironmentName(token: string): string {
  return `routing-review-${token}`;
}

/** Checkout-relative files each building case asks for. */
export function routingFiles(probe: RoutingProbe) {
  return {
    build: {
      source: `routing-${probe.token}-clamp.ts`,
      test: `routing-${probe.token}-clamp.test.ts`,
    },
    delivery: {
      source: `routing-${probe.token}-range.ts`,
      test: `routing-${probe.token}-range.test.ts`,
    },
  };
}

/**
 * Said at the end of every request. A coordinator that stops to ask has made
 * no routing choice, and nobody is there to answer; this says so without
 * naming a workflow.
 */
const AWAY = "I'm away for a while, so go ahead without checking with me.";

export function routingBuildPrompt(probe: RoutingProbe): string {
  const { source, test } = routingFiles(probe).build;
  return `In this project, add a file ${source} exporting a function clampPercent(value: number): number that returns the value limited to the range 0 to 100, and a test file ${test} that checks a value below 0, one inside the range and one above 100. It's done when those tests and the project's existing bun test suite pass. ${AWAY}`;
}

export function routingInvestigatePrompt(): string {
  return `Does this project's test suite pass right now, and how many tests does it run? Someone has to actually run it (bun run check) to find out. Don't change anything. ${AWAY}`;
}

export function routingReviewPrompt(target: RoutingReviewTarget): string {
  return `Review the work on the branch ${target.branch} (environment ${target.name}) and tell me what needs attention. ${AWAY}`;
}

export function routingDeliveryPrompt(probe: RoutingProbe): string {
  const { source, test } = routingFiles(probe).delivery;
  return `In this project, add a file ${source} exporting a function isWithinRange(value: number, min: number, max: number): boolean that returns true when min <= value <= max, and a test file ${test} that checks a value below, inside and above the range. It's done when those tests and the project's existing bun test suite pass. ${AWAY}`;
}

/**
 * Saved defaults for the case: every step, reviewer and Multi Review row on
 * this platform with the fewest reviewers a panel allows (as `status` does),
 * and the Multi Review auto-actions explicitly off, so the review workflow's
 * `autoFix` and `autoPr` record what the coordinator asked for.
 */
export function routingAgentSettings(
  current: unknown,
  platform: AgentPlatform,
): Record<string, unknown> {
  const settings = statusReviewAgentSettings(current, platform);
  const multiReview = settings.multiReview as Record<string, unknown>;
  return { ...settings, multiReview: { ...multiReview, autoFix: false, autoPr: false } };
}

// ---------------------------------------------------------------------------
// Transcript reading

/** Tools that start work of their own: a choice of workflow. */
const BUILD_TOOLS = ["start_build_pipeline"];
const REVIEW_TOOLS = ["launch_multi_review", "start_multi_review"];
const WORKER_TOOLS = ["launch_environment", "launch_job", "send_prompt_to_tab", "fork_worker"];
const OTHER_WORKFLOW_TOOLS = ["launch_feature_plan", "launch_graph"];
const TICKET_TOOLS = ["create_ticket"];

/** Build overrides the launch-defaults rule says to omit. */
export const BUILD_OVERRIDE_FIELDS = [
  "agentType",
  "steps",
  "reviewers",
  "reviewPreparation",
] as const;

/** One Orkestrator tool call, as the evaluation reads it. Its arguments are never recorded. */
export interface RoutingToolCall {
  /** The name without its provider prefix. */
  tool: string;
  /** Transcript row, within the case's rows. */
  row: number;
  args: Record<string, unknown> | undefined;
  state: string;
}

function toolBaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mcp__orkestrator__/, "")
    .replace(/^orkestrator_{1,2}/, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A call's arguments, unwrapped from the envelopes bridges put around MCP
 * input (`arguments`, `input`, `params`), when that envelope is all there is.
 */
export function toolArgsRecord(value: unknown): Record<string, unknown> | undefined {
  const args = asRecord(value);
  if (!args) return undefined;
  const keys = Object.keys(args);
  if (keys.length === 1 && ["arguments", "input", "params"].includes(keys[0]!)) {
    return asRecord(args[keys[0]!]) ?? args;
  }
  return args;
}

const MAX_ROUTING_CALLS = 20_000;

/** Every Orkestrator tool call in a case's rows, including grouped and sub-agent calls. */
export function routingToolCalls(
  messages: readonly CoordinatorTranscriptMessage[],
): RoutingToolCall[] {
  const calls: RoutingToolCall[] = [];
  const visit = (value: unknown, row: number, depth: number) => {
    if (calls.length >= MAX_ROUTING_CALLS) throw new Error("routing tool call budget exceeded");
    if (depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, row, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.toolName === "string") {
      calls.push({
        tool: toolBaseName(record.toolName),
        row,
        args: toolArgsRecord(record.toolArgs),
        state: typeof record.toolState === "string" ? record.toolState : "unknown",
      });
    }
    for (const field of ["childTools", "subagentActions"]) visit(record[field], row, depth + 1);
  };
  messages.forEach((message, row) => visit(message.parts, row, 0));
  return calls;
}

function named(calls: readonly RoutingToolCall[], tools: readonly string[]): RoutingToolCall[] {
  return calls.filter((call) => tools.includes(call.tool));
}

/** The workflow calls a case made, by tool, for the summary: names and counts only. */
export function workflowCallCounts(calls: readonly RoutingToolCall[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of named(calls, [
    ...TICKET_TOOLS,
    ...BUILD_TOOLS,
    ...REVIEW_TOOLS,
    ...WORKER_TOOLS,
    ...OTHER_WORKFLOW_TOOLS,
  ])) {
    counts[call.tool] = (counts[call.tool] ?? 0) + 1;
  }
  return counts;
}

function describeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length === 0
    ? "no workflow calls"
    : entries.map(([tool, count]) => `${tool} ${count}`).join(", ");
}

function check(name: string, passed: boolean, detail?: string): CoordinatorLiveCheck {
  return { name, passed, ...(detail ? { detail } : {}) };
}

// ---------------------------------------------------------------------------
// Backend records, as the evaluation reads them. Never recorded.

/** A Kanban ticket. */
export interface RoutingTicket {
  id: string;
  acceptanceCriteria?: string;
  sections?: { acceptanceCriteria?: unknown[]; delivery?: { policy?: string } };
}

/** A build pipeline snapshot. */
export interface RoutingPipeline {
  id: string;
  taskId: string;
  phase: string;
  error?: string;
  cancelledAt?: string;
  delivery?: { policy?: string };
  sessions?: Array<{ phase?: string }>;
  prUrl?: string;
}

/** A Multi Review workflow record. */
export interface RoutingReview {
  id: string;
  environmentId?: string;
  autoFix?: boolean;
  autoPr?: boolean;
}

function hasCriteria(ticket: RoutingTicket): boolean {
  return (
    (ticket.sections?.acceptanceCriteria?.length ?? 0) > 0 ||
    (ticket.acceptanceCriteria ?? "").trim().length > 0
  );
}

// ---------------------------------------------------------------------------
// Verdicts

export interface RoutingBuildInput {
  /** `build` or `delivery`: the check names' prefix. */
  prefix: "build" | "delivery";
  /** The case's coordinator rows. */
  messages: readonly CoordinatorTranscriptMessage[];
  /** Tickets created since the case began. */
  newTickets: readonly RoutingTicket[];
  /** Pipeline ids the conversation's workflow associations gained during the case. */
  newPipelineIds: readonly string[];
  /** The pipeline those name, read after the turn. */
  pipeline?: RoutingPipeline;
}

/** Cases 1 and 4: a ticket with criteria, then a build for it on the saved defaults. */
export function evaluateRoutingBuild(input: RoutingBuildInput): CoordinatorLiveCheck[] {
  const { prefix } = input;
  const calls = routingToolCalls(input.messages);
  const counts = workflowCallCounts(calls);
  const tickets = named(calls, TICKET_TOOLS);
  const builds = named(calls, BUILD_TOOLS);
  const ticket = input.newTickets.find((item) => item.id === input.pipeline?.taskId);
  const checks: CoordinatorLiveCheck[] = [
    check(
      `${prefix}-ticket-created`,
      tickets.length >= 1 && input.newTickets.length === 1 && hasCriteria(input.newTickets[0]!),
      `${tickets.length} create_ticket calls, ${input.newTickets.length} new tickets${
        input.newTickets[0]
          ? `, criteria ${hasCriteria(input.newTickets[0]) ? "set" : "empty"}`
          : ""
      }`,
    ),
    check(
      `${prefix}-pipeline-started`,
      builds.length === 1 &&
        input.newPipelineIds.length === 1 &&
        input.pipeline?.id === input.newPipelineIds[0] &&
        ticket !== undefined,
      `${builds.length} start_build_pipeline calls, ${input.newPipelineIds.length} new build associations, ${
        input.pipeline
          ? ticket
            ? "built on the new ticket"
            : "built on another ticket"
          : "no pipeline read"
      }`,
    ),
  ];
  const firstTicket = tickets[0]?.row;
  const firstBuild = builds[0]?.row;
  checks.push(
    check(
      `${prefix}-ticket-before-build`,
      firstTicket !== undefined && firstBuild !== undefined && firstTicket <= firstBuild,
      `create_ticket at row ${firstTicket ?? "none"}, start_build_pipeline at row ${firstBuild ?? "none"}`,
    ),
  );
  const overrides = builds.flatMap((call) =>
    BUILD_OVERRIDE_FIELDS.filter((field) => call.args?.[field] !== undefined),
  );
  checks.push(
    check(
      `${prefix}-defaults-kept`,
      builds.length > 0 &&
        builds.every((call) => call.args !== undefined) &&
        overrides.length === 0,
      builds.some((call) => call.args === undefined)
        ? "a start_build_pipeline call's arguments were unreadable"
        : overrides.length > 0
          ? `overrode ${[...new Set(overrides)].join(", ")}`
          : undefined,
    ),
  );
  const others = named(calls, [...REVIEW_TOOLS, ...WORKER_TOOLS, ...OTHER_WORKFLOW_TOOLS]);
  checks.push(check(`${prefix}-no-other-workflow`, others.length === 0, describeCounts(counts)));
  return checks;
}

/** Calls that would carry on a build the user cancelled (to-do 7545 task 4). */
const RESTART_TOOLS = [
  "start_build_pipeline",
  "restart_build_pipeline_step",
  "resume_build_pipeline",
];

export interface RoutingCancelInput {
  /** The coordinator's rows that arrived after the harness cancelled the build. */
  messages: readonly CoordinatorTranscriptMessage[];
  /** System notices to the coordinator about the cancelled pipelines. */
  notices: readonly DelegationMailMessage[];
  /** Build associations the conversation gained after the cancel. */
  newPipelineIds: readonly string[];
  /** The cancelled pipelines, read once the coordinator settled. */
  cancelled: readonly (RoutingPipeline | undefined)[];
}

/**
 * Case 1's end (to-do 7545 task 4): the harness cancels the build as the
 * user's Cancel does; the coordinator hears it as a cancel and, woken by it,
 * neither restarts, resumes nor rebuilds it.
 */
export function evaluateRoutingCancel(input: RoutingCancelInput): CoordinatorLiveCheck[] {
  const cancels = input.notices.filter((notice) => notice.notice?.state === "cancelled");
  const others = input.notices.filter((notice) => notice.notice?.state !== "cancelled");
  const carried = cancels.filter(
    (notice) => notice.placement === "injected" && carrierRowIndex(input.messages, notice.id) >= 0,
  );
  const calls = named(routingToolCalls(input.messages), RESTART_TOOLS);
  const restartCounts: Record<string, number> = {};
  for (const call of calls) restartCounts[call.tool] = (restartCounts[call.tool] ?? 0) + 1;
  const stillCancelled = input.cancelled.filter(
    (pipeline) => pipeline?.phase === "failed" && pipeline.cancelledAt !== undefined,
  ).length;
  return [
    check(
      "build-cancel-notice",
      input.cancelled.length > 0 &&
        cancels.length === input.cancelled.length &&
        carried.length === input.cancelled.length,
      `${cancels.length} cancelled notices (${carried.length} carried into a wake), other states: ${
        others.map((notice) => notice.notice?.state ?? "unknown").join(", ") || "none"
      }`,
    ),
    check(
      "build-cancel-respected",
      input.cancelled.length > 0 &&
        calls.length === 0 &&
        input.newPipelineIds.length === 0 &&
        stillCancelled === input.cancelled.length,
      `${describeCounts(restartCounts)} after the cancel; ${input.newPipelineIds.length} new builds; ${stillCancelled} of ${input.cancelled.length} still cancelled`,
    ),
  ];
}

export interface RoutingDeliveryOutcomeInput {
  pipeline?: RoutingPipeline;
  /** The coordinator's rows from the request to the build's end, wakes included. */
  messages: readonly CoordinatorTranscriptMessage[];
}

/**
 * Case 4's end: `complete` under `commit-only`, no PR stage started, and the
 * coordinator, woken by the finished build, not raising one itself (a
 * pipeline environment's PR is the pipeline's to open).
 */
export function evaluateRoutingDeliveryOutcome(
  input: RoutingDeliveryOutcomeInput,
): CoordinatorLiveCheck[] {
  const { pipeline } = input;
  const raised = named(routingToolCalls(input.messages), ["create_pr"]).length;
  const prSessions = (pipeline?.sessions ?? []).filter(
    (session) => session.phase === "pr" || session.phase === "resolve-conflicts",
  ).length;
  return [
    check(
      "delivery-commit-only-complete",
      pipeline?.phase === "complete" &&
        pipeline.cancelledAt === undefined &&
        pipeline.delivery?.policy === "commit-only",
      pipeline
        ? `phase ${pipeline.phase}, delivery ${pipeline.delivery?.policy ?? "undecided"}${pipeline.cancelledAt ? ", cancelled" : ""}${pipeline.phase === "failed" && pipeline.error ? `: ${pipeline.error.slice(0, 300)}` : ""}`
        : "no pipeline",
    ),
    check(
      "delivery-no-pr-stage",
      pipeline !== undefined && prSessions === 0 && !pipeline.prUrl,
      `${prSessions} PR or conflict sessions${pipeline?.prUrl ? ", a pull request URL" : ""}`,
    ),
    check("delivery-no-coordinator-pr", raised === 0, `${raised} create_pr calls`),
  ];
}

export interface RoutingInvestigateInput {
  messages: readonly CoordinatorTranscriptMessage[];
  /** Workers the conversation's associations gained during the case. */
  newWorkers: number;
  /** New backend delegation requests, including requests on reused workers. */
  delegationRequests: readonly { environmentId: string; workerTabId: string }[];
  newTickets: number;
  newPipelines: number;
  newReviews: number;
}

/** Case 2: a worker runs it, and nothing builds or reviews. */
export function evaluateRoutingInvestigate(input: RoutingInvestigateInput): CoordinatorLiveCheck[] {
  const calls = routingToolCalls(input.messages);
  const counts = workflowCallCounts(calls);
  const workers = named(calls, WORKER_TOOLS);
  const workflows = named(calls, [
    ...TICKET_TOOLS,
    ...BUILD_TOOLS,
    ...REVIEW_TOOLS,
    ...OTHER_WORKFLOW_TOOLS,
  ]);
  return [
    check(
      "investigate-delegated",
      workers.length === 1 &&
        workers[0]?.state === "success" &&
        input.newWorkers <= 1 &&
        input.delegationRequests.length === 1 &&
        (workers[0]?.tool !== "send_prompt_to_tab" ||
          (workers[0]?.args?.environmentId === input.delegationRequests[0]?.environmentId &&
            workers[0]?.args?.tabId === input.delegationRequests[0]?.workerTabId)),
      `${describeCounts(counts)}; ${input.newWorkers} new workers, ${input.delegationRequests.length} delegation requests`,
    ),
    check(
      "investigate-no-build-or-review",
      workflows.length === 0 &&
        input.newTickets === 0 &&
        input.newPipelines === 0 &&
        input.newReviews === 0,
      `${input.newTickets} new tickets, ${input.newPipelines} new builds, ${input.newReviews} new reviews`,
    ),
  ];
}

export interface RoutingReviewInput {
  messages: readonly CoordinatorTranscriptMessage[];
  target: RoutingReviewTarget;
  /** Multi Review ids the conversation's associations gained during the case. */
  newReviewIds: readonly string[];
  /** The review those name, read after the turn. */
  review?: RoutingReview;
  newTickets: number;
  newPipelines: number;
}

/** Case 3: one Multi Review on the named environment, auto-fix and auto-PR off. */
export function evaluateRoutingReview(input: RoutingReviewInput): CoordinatorLiveCheck[] {
  const calls = routingToolCalls(input.messages);
  const counts = workflowCallCounts(calls);
  const launches = named(calls, REVIEW_TOOLS);
  const onTarget = launches.filter(
    (call) => call.args?.environmentId === input.target.environmentId,
  );
  const askedAutomation = launches.flatMap((call) =>
    (["autoFix", "autoPr"] as const).filter((field) => call.args?.[field] === true),
  );
  const others = named(calls, [
    ...TICKET_TOOLS,
    ...BUILD_TOOLS,
    ...WORKER_TOOLS,
    ...OTHER_WORKFLOW_TOOLS,
  ]);
  return [
    check(
      "review-launched",
      launches.length === 1 &&
        onTarget.length === 1 &&
        input.newReviewIds.length === 1 &&
        input.review?.id === input.newReviewIds[0] &&
        input.review?.environmentId === input.target.environmentId,
      `${launches.length} Multi Review launches, ${onTarget.length} on the named environment, ${input.newReviewIds.length} new review associations`,
    ),
    check(
      "review-auto-actions-off",
      launches.length > 0 &&
        launches.every((call) => call.args !== undefined) &&
        askedAutomation.length === 0 &&
        input.review !== undefined &&
        input.review.autoFix !== true &&
        input.review.autoPr !== true,
      launches.some((call) => call.args === undefined)
        ? "a launch's arguments were unreadable"
        : `requested ${askedAutomation.join(", ") || "neither"}; workflow autoFix ${input.review?.autoFix ?? "absent"}, autoPr ${input.review?.autoPr ?? "absent"}`,
    ),
    check(
      "review-no-other-workflow",
      others.length === 0 && input.newTickets === 0 && input.newPipelines === 0,
      `${describeCounts(counts)}; ${input.newTickets} new tickets, ${input.newPipelines} new builds`,
    ),
  ];
}

/** Whole-scenario checks: nobody was asked anything. */
export function evaluateRoutingInteractions(input: {
  escapedInteractions: readonly AgentInteractionKind[];
  workerInteractions: readonly AgentInteractionKind[];
}): CoordinatorLiveCheck[] {
  const failures = [
    ...escapedInteractionFailures(input.escapedInteractions),
    ...escapedInteractionFailures(input.workerInteractions).map((failure) => `worker: ${failure}`),
  ];
  return [check("no-user-action", failures.length === 0, failures.join("; "))];
}

/** Accumulate one case across rolling projections, replacing revised rows by id.
 * Fail closed on a gap or a missing identity rather than silently lose evidence.
 */
export function createRoutingRows() {
  let baseline = new Set<string>();
  let previous: string[] = [];
  let active = false;
  const rows = new Map<string, CoordinatorTranscriptMessage>();
  return {
    begin() {
      active = true;
      baseline = new Set(previous);
      rows.clear();
    },
    observe(messages: readonly CoordinatorTranscriptMessage[]) {
      const ids = messages.map((row) => {
        if (!row.id) throw new Error("routing transcript row has no stable id");
        return row.id;
      });
      if (active && previous.length && ids.length && !ids.some((id) => previous.includes(id))) {
        throw new Error("routing transcript projection gap");
      }
      if (active) {
        for (const row of messages) {
          if (!baseline.has(row.id!)) rows.set(row.id!, structuredClone(row));
        }
        if (rows.size > 5000) throw new Error("routing transcript case exceeded 5000 rows");
      }
      if (ids.length) previous = ids;
    },
    messages: () => [...rows.values()],
  };
}
