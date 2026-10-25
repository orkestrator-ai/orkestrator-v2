import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { MULTI_REVIEW_MIN_REVIEWERS } from "@orkestrator/protocol/multi-review";
import {
  escapedInteractionFailures,
  isApprovalKind,
  transcriptAssistantText,
  transcriptToolCalls,
  type CoordinatorLiveCheck,
  type CoordinatorTranscriptMessage,
  type ReadOnlyToolCall,
} from "./coordinator-live.js";
import {
  coordinatorWaitCounts,
  isCarrierText,
  orkestratorToolCalls,
  transcriptUserTexts,
  type DelegationMailMessage,
} from "./coordinator-live-delegation.js";

/**
 * The live coordinator suite's `status` scenario: the status wakes a real
 * provider gets for work it started, with default messaging settings.
 *
 * Review part: the coordinator launches a Multi Review on an environment the
 * harness prepared (one committed file with a real defect). Consolidation
 * reaching `ready` must wake it once with an attention-toned notice; it then
 * calls `address_multi_review`, and the Fix turn finishing must wake it once
 * more (`fix-done`). An interactive Fix ends there: `completed` is reached only
 * by a structured Fix, which a coordinator's `address_multi_review` does not
 * start.
 *
 * Approval part: the coordinator delegates a task to an ordinary environment
 * whose execution policy asks for approvals, by `send_prompt_to_tab`. The
 * worker's command needs an approval, which the harness holds; after 20
 * seconds of waiting the coordinator must be woken once by a `waiting` notice,
 * and only then does the harness deny the approval and let the worker report.
 * Cursor never asks for approvals, so the part does not apply to it.
 *
 * What stays with `coordinator-status-wakes.test.ts`, because no provider is
 * involved: which states notify under each setting, dedupe and coalescing
 * (seven reviews settling together are one wake), ownership (a review the user
 * started never wakes a coordinator), budgets and restart recovery, and the
 * build pipeline's notices, which reach a coordinator through the same notice
 * and carrier as a Multi Review's.
 *
 * Shared with the Playwright spec, which runs under Node: no Bun APIs here.
 */

/** Synthetic values one status run plants. */
export interface StatusProbe {
  platform: AgentPlatform;
  /** Random hex carried by every name and marker. */
  token: string;
  /** The environment the coordinator reviews, prepared by the harness. */
  revieweeEnvironmentId: string;
  /** The environment the coordinator delegates the approval task to. */
  waiterEnvironmentId: string;
  waiterTabId: string;
  /** A file outside every checkout that the worker's command would create. */
  outsidePath: string;
}

export const STATUS_REVIEW_DONE_MARKER = "COORDINATOR_STATUS_REVIEW_DONE";
export const STATUS_WAITING_MARKER = "COORDINATOR_STATUS_WAITING_SEEN";
export const STATUS_WAITER_DONE_MARKER = "COORDINATOR_STATUS_WAITER_DONE";

/** The delegated tab's notice states once it has been waiting. */
export const STATUS_WAITING_STATE = "waiting";

export function statusEnvironmentNames(token: string) {
  return { reviewee: `status-review-${token}`, waiter: `status-waiter-${token}` };
}

/**
 * The file the reviewee commits: a percentage never divided by 100, so every
 * reviewer has something to report without a long turn.
 */
export const STATUS_REVIEWEE_FILE = {
  path: "discount.ts",
  content: [
    "/** Applies a percentage discount to a price in cents. */",
    "export function applyDiscount(priceCents: number, percent: number): number {",
    "  if (percent > 100) throw new Error('percent must be at most 100');",
    "  return priceCents - priceCents * percent;",
    "}",
    "",
  ].join("\n"),
} as const;

/** Cursor never asks for an approval, so nothing can hold a worker waiting on one. */
export function approvalWaitApplies(platform: AgentPlatform): boolean {
  return platform !== "cursor";
}

/**
 * Saved Multi Review defaults for the case: the coordinator omits the rows,
 * as the Multi Review button would, and the backend resolves them to this
 * platform's model with the fewest reviewers a panel allows. A profile is
 * authorised for one credential, so a default naming another platform could
 * not run.
 */
export function statusReviewAgentSettings(
  current: unknown,
  platform: AgentPlatform,
): Record<string, unknown> {
  const settings =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const multiReview =
    settings.multiReview && typeof settings.multiReview === "object"
      ? (settings.multiReview as Record<string, unknown>)
      : {};
  return {
    ...settings,
    defaultAgent: platform,
    multiReview: { ...multiReview, reviewerCount: MULTI_REVIEW_MIN_REVIEWERS },
  };
}

/** `create_environment` arguments for the environment under review. */
export function revieweeEnvironmentInput(input: {
  projectId: string;
  token: string;
}): Record<string, unknown> {
  return {
    projectId: input.projectId,
    name: statusEnvironmentNames(input.token).reviewee,
    environmentType: "local",
    networkAccessMode: "restricted",
  };
}

/**
 * `create_environment` arguments for the worker held on an approval: an
 * ordinary environment whose startup agent answers once and goes idle, with an
 * execution policy that asks. Codex asks only to step outside its sandbox, so
 * its policy keeps the provider sandbox on; every other provider asks for a
 * shell command whatever the sandbox.
 */
export function waiterEnvironmentInput(input: {
  projectId: string;
  token: string;
  platform: AgentPlatform;
}): Record<string, unknown> {
  return {
    projectId: input.projectId,
    name: statusEnvironmentNames(input.token).waiter,
    environmentType: "local",
    networkAccessMode: "restricted",
    initialPrompt:
      "Reply with the single word ready and end your turn. Do not use any tools and do not send any messages.",
    agentSettings: {
      defaultAgent: input.platform,
      platforms: { [input.platform]: { mode: "native" } },
      executionPolicy: {
        approvals: "ask",
        ...(input.platform === "codex" ? { sandbox: "provider" } : {}),
      },
    },
    pendingAgentLaunch: true,
    initialAgentPlatform: input.platform,
    initialConversationMode: "build",
  };
}

const HARNESS_PREAMBLE =
  "This is Orkestrator's status-wake conformance check, run by its test harness on a disposable fixture project. The user authorises and asks for every step below. Do not ask the user anything.";

const NO_WAITING =
  "Never wait, sleep, poll, read messages, check message status or call get_multi_review to see whether something finished: you are woken when it does.";

/** The review part's one prompt; later turns follow its standing orders. */
export function statusReviewPrompt(probe: StatusProbe): string {
  return [
    HARNESS_PREAMBLE,
    "",
    `1. Call the Orkestrator launch_multi_review tool once with a fresh requestId, environmentId "${probe.revieweeEnvironmentId}", autoFix false and autoPr false. Leave out reviewers, reviewModel, fixModel, targetBranch and reviewInstruction so the saved defaults apply.`,
    "2. Then finish this turn at once with a one-line summary.",
    "",
    "Later turns:",
    "- When a notice says this Multi Review is ready to address, call the Orkestrator address_multi_review tool once with its workflowId, then end the turn with a one-line summary. Do this even if the notice reports no findings.",
    `- When a notice says its fix session finished its turn, end that turn with exactly one line: ${STATUS_REVIEW_DONE_MARKER} ${probe.token}`,
    "- Any other wake: reply with one short line and end the turn without calling any tools.",
    NO_WAITING,
  ].join("\n");
}

/** What the coordinator forwards to the worker held on an approval. */
export function waiterTaskPrompt(probe: StatusProbe): string {
  const quoted = `'${probe.outsidePath.replaceAll("'", "'\\''")}'`;
  return [
    "This is a test worker task from Orkestrator's test harness.",
    `Run exactly this one shell command once with your shell tool: touch ${quoted}`,
    ...(probe.platform === "codex"
      ? [
          "It writes outside your workspace, so run it with escalated sandbox permissions and ask for approval to do so.",
        ]
      : []),
    "It needs an approval; wait for the answer. Whatever the answer, do not retry it and do not try another tool or path.",
    `Then call the Orkestrator send_message tool once with toEnvironmentId "coordinator" and body "STATUS-WAITER-${probe.token} <approved or denied>", and end your turn.`,
  ].join(" ");
}

/** The approval part's one prompt. */
export function statusWaitingPrompt(probe: StatusProbe): string {
  return [
    HARNESS_PREAMBLE,
    "",
    `1. Call the Orkestrator send_prompt_to_tab tool once with a fresh requestId, environmentId "${probe.waiterEnvironmentId}", tabId "${probe.waiterTabId}", conversationMode "build" and this exact prompt: ${JSON.stringify(waiterTaskPrompt(probe))}`,
    "2. Then finish this turn at once with a one-line summary.",
    "",
    "Later turns:",
    `- When a notice says that worker is waiting for an approval, do not try to approve or answer anything. End that turn with exactly one line: ${STATUS_WAITING_MARKER} ${probe.token}`,
    `- When that worker's report or a notice that it finished arrives, end that turn with exactly one line: ${STATUS_WAITER_DONE_MARKER} ${probe.token}`,
    "- Any other wake: reply with one short line and end the turn without calling any tools.",
    NO_WAITING,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Evidence

function check(name: string, passed: boolean, detail?: string): CoordinatorLiveCheck {
  return { name, passed, ...(detail ? { detail: detail.slice(0, 500) } : {}) };
}

/** System notices to the coordinator about one resource, in creation order. */
export function noticesAbout(
  mail: readonly DelegationMailMessage[],
  coordinatorEnvironmentId: string,
  matches: (resource: NonNullable<DelegationMailMessage["notice"]>["resource"]) => boolean,
): DelegationMailMessage[] {
  return mail
    .filter(
      (message) =>
        message.toEnvironmentId === coordinatorEnvironmentId &&
        message.from.kind === "system" &&
        matches(message.notice?.resource),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Index of the transcript row whose carrier holds `messageId`, or -1. */
export function carrierRowIndex(
  messages: readonly CoordinatorTranscriptMessage[],
  messageId: string,
): number {
  return messages.findIndex((message) => {
    const [text = ""] = transcriptUserTexts([message]);
    return isCarrierText(text) && text.includes(messageId);
  });
}

/** Index of each transcript row that calls `tool`, in order. */
export function toolCallRows(
  messages: readonly CoordinatorTranscriptMessage[],
  tool: string,
): number[] {
  return messages.flatMap((message, index) =>
    orkestratorToolCalls(transcriptToolCalls([message]), tool).length > 0 ? [index] : [],
  );
}

/** Whether an assistant row after `row` carries `marker` with the run's token. */
function markerAfter(
  messages: readonly CoordinatorTranscriptMessage[],
  row: number,
  marker: string,
  token: string,
): boolean {
  if (row < 0) return false;
  return transcriptAssistantText(messages.slice(row + 1)).includes(`${marker} ${token}`);
}

function stateCounts(notices: readonly DelegationMailMessage[]): string {
  const counts = new Map<string, number>();
  for (const notice of notices) {
    const state = notice.notice?.state ?? "unknown";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].map(([state, count]) => `${state} x${count}`).join(", ") || "none";
}

/**
 * One notice in `state`, delivered, carried by a transcript row, toned as
 * `tones` allows; returns its carrier row (or -1) with the check.
 */
function oneWake(input: {
  name: string;
  notices: readonly DelegationMailMessage[];
  state: string;
  tones: readonly string[];
  messages: readonly CoordinatorTranscriptMessage[];
  after?: number;
}): { check: CoordinatorLiveCheck; row: number } {
  const matching = input.notices.filter((notice) => notice.notice?.state === input.state);
  const notice = matching[0];
  const row = notice ? carrierRowIndex(input.messages, notice.id) : -1;
  const tone = notice?.notice?.tone;
  const passed =
    matching.length === 1 &&
    notice!.placement === "injected" &&
    row >= 0 &&
    (input.after === undefined || row > input.after) &&
    tone !== undefined &&
    input.tones.includes(tone);
  return {
    row,
    check: check(
      input.name,
      passed,
      `${matching.length} ${input.state} notices${
        notice
          ? `; ${notice.placement}${notice.placementReason ? ` (${notice.placementReason})` : ""}, tone ${tone ?? "none"}, carrier row ${row}${input.after !== undefined ? ` after row ${input.after}` : ""}`
          : ""
      }`,
    ),
  };
}

function launchedAsync(results: readonly string[]): number {
  return results.filter((result) => /delivery\\?"?\s*:\s*\\?"async/.test(result)).length;
}

function waitFailures(calls: readonly ReadOnlyToolCall[]): string[] {
  const waits = coordinatorWaitCounts(calls);
  const reviewReads = orkestratorToolCalls(calls, "get_multi_review").length;
  return [
    ...(waits.sleepCalls > 0 ? [`sleep ${waits.sleepCalls}`] : []),
    ...(waits.readMessagesCalls > 0 ? [`read_messages ${waits.readMessagesCalls}`] : []),
    ...(waits.getMessageStatusCalls > 0
      ? [`get_message_status ${waits.getMessageStatusCalls}`]
      : []),
    ...(waits.listEnvironmentsCalls > 0
      ? [`list_environments ${waits.listEnvironmentsCalls}`]
      : []),
    ...(reviewReads > 0 ? [`get_multi_review ${reviewReads}`] : []),
  ];
}

export interface StatusReviewInput {
  probe: StatusProbe;
  coordinatorEnvironmentId: string;
  /** The part's coordinator rows, from its first prompt on. */
  messages: readonly CoordinatorTranscriptMessage[];
  /** `launch_multi_review` results, fetched from behind each row's detail reference. */
  launchResults: readonly string[];
  /** The coordinator's mailbox, read after the part settled. */
  mail: readonly DelegationMailMessage[];
  escapedInteractions: readonly AgentInteractionKind[];
}

/**
 * The review part's checks: an async launch, one `ready` wake, the coordinator
 * acting on it with `address_multi_review`, one `fix-done` wake, no other
 * state twice, no polling, and nobody answering anything.
 */
export function evaluateStatusReview(input: StatusReviewInput): CoordinatorLiveCheck[] {
  const { probe, messages } = input;
  const calls = transcriptToolCalls(messages);
  const launches = orkestratorToolCalls(calls, "launch_multi_review");
  const asyncResults = launchedAsync(input.launchResults);
  const notices = noticesAbout(
    input.mail,
    input.coordinatorEnvironmentId,
    (resource) =>
      resource?.kind === "multi-review" && resource.environmentId === probe.revieweeEnvironmentId,
  );
  const workflows = new Set(notices.map((notice) => notice.notice?.resource?.id));
  const checks: CoordinatorLiveCheck[] = [
    check(
      "review-launch-async",
      launches.length === 1 && asyncResults === 1,
      `${launches.length} launch_multi_review calls, ${asyncResults} results with delivery async`,
    ),
  ];
  const ready = oneWake({
    name: "review-ready-wake",
    notices,
    state: "ready",
    tones: ["attention", "success"],
    messages,
  });
  checks.push(ready.check);
  const addressRows = toolCallRows(messages, "address_multi_review");
  const addressRow = addressRows.find((row) => row > ready.row) ?? -1;
  checks.push(
    check(
      "review-addressed-after-ready",
      addressRows.length === 1 && ready.row >= 0 && addressRow > ready.row,
      `${addressRows.length} address_multi_review calls${addressRows.length > 0 ? ` at rows ${addressRows.join(", ")}` : ""}; ready carrier row ${ready.row}`,
    ),
  );
  const fixDone = oneWake({
    name: "review-fix-done-wake",
    notices,
    state: "fix-done",
    tones: ["success"],
    messages,
    after: addressRow,
  });
  checks.push(fixDone.check);
  const repeated = [...new Set(notices.map((notice) => notice.notice?.state))].filter(
    (state) => notices.filter((notice) => notice.notice?.state === state).length > 1,
  );
  checks.push(
    check(
      "review-one-wake-per-state",
      repeated.length === 0 && workflows.size === 1,
      `${workflows.size} workflows; notices: ${stateCounts(notices)}`,
    ),
  );
  checks.push(
    check(
      "review-done-line",
      markerAfter(messages, fixDone.row, STATUS_REVIEW_DONE_MARKER, probe.token),
      `fix-done carrier row ${fixDone.row}`,
    ),
  );
  const waits = waitFailures(calls);
  checks.push(check("review-no-polling", waits.length === 0, waits.join(", ")));
  const interactions = escapedInteractionFailures(input.escapedInteractions);
  checks.push(check("review-no-user-action", interactions.length === 0, interactions.join("; ")));
  return checks;
}

/** The approval the harness held, as it saw it. */
export interface HeldApproval {
  kind: AgentInteractionKind;
  /** When the harness first saw it pending. */
  seenAt: number;
  /** When the harness denied it; absent when it never did. */
  releasedAt?: number;
}

export interface StatusWaitingInput {
  probe: StatusProbe;
  coordinatorEnvironmentId: string;
  /** The part's coordinator rows, from its prompt on. */
  messages: readonly CoordinatorTranscriptMessage[];
  mail: readonly DelegationMailMessage[];
  held: readonly HeldApproval[];
  escapedInteractions: readonly AgentInteractionKind[];
  /** Interactions of any other worker, which the harness denied at once. */
  workerInteractions: readonly AgentInteractionKind[];
}

/**
 * How long a worker must wait before its coordinator hears, less one harness
 * poll: the harness sees a request up to one read after it opened.
 */
export const STATUS_WAITING_MIN_MS = 20_000 - 2_000;

/**
 * The approval part's checks: the delegation, an approval held at the
 * harness, one `waiting` wake after 20 seconds and before the approval was
 * answered, the coordinator acting on it without answering, then the
 * worker's report, no polling, and no other interaction reaching anybody.
 */
export function evaluateStatusWaiting(input: StatusWaitingInput): CoordinatorLiveCheck[] {
  const { probe, messages } = input;
  const calls = transcriptToolCalls(messages);
  const sends = orkestratorToolCalls(calls, "send_prompt_to_tab");
  const checks: CoordinatorLiveCheck[] = [
    check(
      "waiting-delegated",
      sends.length === 1 && sends[0]!.args.includes(probe.waiterEnvironmentId),
      `${sends.length} send_prompt_to_tab calls`,
    ),
  ];
  const approvals = input.held.filter((item) => isApprovalKind(item.kind));
  const first = approvals[0];
  checks.push(
    check(
      "waiting-approval-held",
      approvals.length >= 1 && input.held.length === approvals.length,
      `held: ${input.held.map((item) => item.kind).join(", ") || "nothing reached the harness"}`,
    ),
  );
  const notices = noticesAbout(
    input.mail,
    input.coordinatorEnvironmentId,
    (resource) =>
      resource?.kind === "agent-tab" && resource.environmentId === probe.waiterEnvironmentId,
  );
  const waiting = oneWake({
    name: "waiting-wake",
    notices,
    state: STATUS_WAITING_STATE,
    tones: ["attention"],
    messages,
  });
  checks.push(waiting.check);
  const notice = notices.find((item) => item.notice?.state === STATUS_WAITING_STATE);
  const createdAt = notice ? Date.parse(notice.createdAt) : Number.NaN;
  const waitedMs = first && Number.isFinite(createdAt) ? createdAt - first.seenAt : Number.NaN;
  const beforeAnswer =
    first !== undefined &&
    Number.isFinite(createdAt) &&
    (first.releasedAt === undefined || createdAt <= first.releasedAt);
  checks.push(
    check(
      "waiting-after-debounce",
      Number.isFinite(waitedMs) && waitedMs >= STATUS_WAITING_MIN_MS && beforeAnswer,
      Number.isFinite(waitedMs)
        ? `notice ${Math.round(waitedMs / 1_000)}s after the approval was seen; before it was answered ${beforeAnswer}`
        : "no waiting notice or no held approval",
    ),
  );
  checks.push(
    check(
      "waiting-acknowledged",
      markerAfter(messages, waiting.row, STATUS_WAITING_MARKER, probe.token),
      `waiting carrier row ${waiting.row}`,
    ),
  );
  // The worker's report, or the notice of a turn that ended without one.
  const report = input.mail
    .filter(
      (message) =>
        message.toEnvironmentId === input.coordinatorEnvironmentId &&
        ((message.from.kind === "tab" &&
          message.from.environmentId === probe.waiterEnvironmentId) ||
          (message.from.kind === "system" &&
            message.notice?.resource?.environmentId === probe.waiterEnvironmentId &&
            message.notice.state !== STATUS_WAITING_STATE)),
    )
    .find((message) => message.placement === "injected");
  const reportRow = report ? carrierRowIndex(messages, report.id) : -1;
  checks.push(
    check(
      "waiting-report",
      reportRow > waiting.row &&
        markerAfter(messages, reportRow, STATUS_WAITER_DONE_MARKER, probe.token),
      report
        ? `report from ${report.from.kind}, carrier row ${reportRow}`
        : "no delivered report or finished notice",
    ),
  );
  const waits = waitFailures(calls);
  checks.push(check("waiting-no-polling", waits.length === 0, waits.join(", ")));
  const interactions = [
    ...escapedInteractionFailures(input.escapedInteractions),
    ...escapedInteractionFailures(input.workerInteractions).map((failure) => `worker: ${failure}`),
  ];
  checks.push(check("waiting-no-user-action", interactions.length === 0, interactions.join("; ")));
  return checks;
}
