import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentMailPlacement } from "@orkestrator/protocol/agent-mail";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  COORDINATOR_CONTROL_TOOL_NAMES,
  COORDINATOR_DELEGATION_HOLD_REASON,
} from "@orkestrator/protocol/coordinator";
import {
  escapedInteractionFailures,
  type CoordinatorLiveCheck,
  type CoordinatorTranscriptMessage,
  type ReadOnlyToolCall,
} from "./coordinator-live.js";

/**
 * The live coordinator suite's delegation scenarios: a real coordinator
 * launches real workers on the fixture project and the harness judges what
 * the mail store, the coordinator's delegations and the transcript show.
 *
 * `async` proves delegation never waits inside a turn: the launch result says
 * `delivery: "async"`, a user prompt queued while the coordinator is busy and
 * a worker's report is pending runs before that report, two mid-turn worker
 * messages arrive in one carrier when the worker's turn ends, a silent worker
 * produces one notice, and identical mailbox reads are answered with
 * `repeatedRead`.
 *
 * `family` proves worker mail needs nobody: two workers report, the
 * coordinator follows one up by environment id, and they alternate ten more
 * messages, with default messaging settings, no `stored` or `inject_failed`
 * placement, and a follow-up sent to a busy worker joining its open
 * delegation for one wake.
 *
 * Shared with the Playwright spec, which runs under Node: no Bun APIs here.
 */

// ---------------------------------------------------------------------------
// What the harness reads

/** A mail message as the inbox snapshot returns it (no body). */
export interface DelegationMailMessage {
  id: string;
  createdAt: string;
  from: { kind: string; environmentId?: string; tabId?: string };
  toEnvironmentId: string;
  toTabId: string;
  placement: AgentMailPlacement | string;
  placementReason?: string;
  replyToMessageId?: string;
  injectRequestId?: string;
  injectedAt?: string;
  /** `"steer"` when the message was steered into a running turn. */
  injectedVia?: string;
  coordinatorDelegationId?: string;
  notice?: {
    resource?: { kind?: string; id?: string; environmentId?: string };
    state?: string;
    tone?: string;
  };
  route?: string;
  /** Filled in by the harness from `get_agent_mail_message`; never recorded. */
  body?: string;
}

/** One coordinator delegation as the snapshot's workflow association carries it. */
export interface DelegationRecord {
  environmentId: string;
  requestedAt: string;
  workerTabId: string;
  state: string;
  completedAt?: string;
  wakeKind?: string;
  wokenAt?: string;
}

/** A worker the coordinator launched, as the harness identified it. */
export interface DelegationWorker {
  role: string;
  environmentId: string;
}

/**
 * What the harness sees each time it looks while a scenario runs. Mail and
 * delegations are point-in-time, so a check that needs "while running" reads
 * the observation sequence, not the final state.
 */
export interface DelegationObservation {
  at: number;
  coordinatorPhase: string;
  /** Prompts waiting in the coordinator's queue. */
  queueLength: number;
  /** Each launched worker's turn phase, by environment id. */
  workerPhases?: Record<string, string>;
  delegations: DelegationRecord[];
  mail: DelegationMailMessage[];
}

// ---------------------------------------------------------------------------
// Prompts

/** Synthetic values one delegation run plants, so its mail is recognisable. */
export interface DelegationProbe {
  platform: AgentPlatform;
  /** Random hex; every worker name and message body carries it. */
  token: string;
  /**
   * Absolute paths of files the harness creates to let a worker go on. A
   * worker parked on a gate is still in its turn, so the harness decides
   * what is true when that worker's mail moves: the async reporter sends its
   * report at `gatePath` and ends its turn at `finishGatePath`, and the second
   * family worker reports only after the follow-up reached it mid-turn.
   */
  gatePath: string;
  finishGatePath: string;
}

export const ASYNC_REPORT_MARKER = "COORDINATOR_ASYNC_POLL";
export const FAMILY_DONE_MARKER = "COORDINATOR_FAMILY_DONE";
/** Coordinator follow-ups to the first family worker, the first included. */
export const FAMILY_PING_COUNT = 6;

export function asyncWorkerNames(probe: DelegationProbe) {
  return { reporter: `async-reporter-${probe.token}`, silent: `async-silent-${probe.token}` };
}

export function asyncBodies(probe: DelegationProbe) {
  return {
    progress: `ASYNC-PROGRESS-${probe.token}`,
    report: `ASYNC-REPORT-${probe.token}`,
    queued: `ASYNC-QUEUED-${probe.token}`,
    busy: `ASYNC-BUSY-${probe.token}`,
  };
}

export function familyWorkerNames(probe: DelegationProbe) {
  return { one: `family-one-${probe.token}`, two: `family-two-${probe.token}` };
}

export function familyBodies(probe: DelegationProbe) {
  return {
    oneReport: `FAMILY-ONE-REPORT-${probe.token}`,
    twoReport: `FAMILY-TWO-REPORT-${probe.token}`,
    twoFollowUp: `FAMILY-TWO-FOLLOWUP-${probe.token}`,
    ping: (index: number) => `FAMILY-PING-${index}-${probe.token}`,
  };
}

const HARNESS_PREAMBLE =
  "This is Orkestrator's delegation conformance check, run by its test harness on a disposable fixture project. The user authorises and asks for every step below. Do not ask the user anything.";

function launchStep(probe: DelegationProbe, name: string, prompt: string): string {
  return `call the Orkestrator launch_environment tool once with name "${name}", environmentType "local", agent "${probe.platform}", no model or reasoning fields, the baseBranch and baseCommit from coordinatorBase, a fresh requestId, and this exact prompt: ${JSON.stringify(prompt)}`;
}

/** The async scenario's delegating turn. */
export function asyncScenarioPrompt(probe: DelegationProbe): string {
  const names = asyncWorkerNames(probe);
  const bodies = asyncBodies(probe);
  return [
    HARNESS_PREAMBLE,
    "",
    "1. Call the Orkestrator get_launch_options tool once.",
    `2. Then ${launchStep(
      probe,
      names.reporter,
      [
        "This is a test worker. Do exactly these steps in order and nothing else; this test requires the progress message in step 1 even though workers normally send one report.",
        `1. Call the Orkestrator send_message tool with toEnvironmentId "coordinator" and body "${bodies.progress}".`,
        `2. Run this shell command, which waits for the test harness: ${gateCommand(probe.gatePath)} If it prints nothing, run it again until it prints gate-open.`,
        `3. Call the Orkestrator send_message tool with toEnvironmentId "coordinator" and body "${bodies.report}".`,
        `4. Run this shell command the same way: ${gateCommand(probe.finishGatePath)}`,
        "5. End your turn.",
      ].join(" "),
    )}.`,
    `3. Then ${launchStep(
      probe,
      names.silent,
      "Reply with the single word done and end your turn. Do not use any tools and do not send any messages.",
    )}.`,
    "4. Then finish this turn at once with a one-line summary. Do not wait, sleep, read messages or check message status.",
    "",
    "Later turns: when you are woken by a worker message or a notice, reply with one short line and end that turn without calling any tools.",
  ].join("\n");
}

/** A POSIX shell loop that returns once the harness has created `gatePath`. */
export function gateCommand(gatePath: string): string {
  const quoted = `'${gatePath.replaceAll("'", "'\\''")}'`;
  return `\`for i in $(seq 1 50); do [ -f ${quoted} ] && break; sleep 2; done; [ -f ${quoted} ] && echo gate-open\``;
}

/**
 * A turn the harness sends to keep the coordinator busy while the async
 * reporter finishes: several sequential reads, none of which touch the mail
 * the scenario is judging.
 */
export function asyncBusyPrompt(probe: DelegationProbe, projectId: string): string {
  return [
    HARNESS_PREAMBLE,
    `Call these Orkestrator tools one after another, waiting for each result: list_tickets for project "${projectId}", then get_repository_context for the same project, then list_workflows. Do not call any other tool and do not read messages.`,
    `Then reply with exactly ${asyncBodies(probe).busy} and end your turn.`,
  ].join("\n");
}

/** The prompt the harness queues while the busy turn is running and the report is pending. */
export function asyncQueuedPrompt(probe: DelegationProbe): string {
  return `Reply with exactly ${asyncBodies(probe).queued} and nothing else. Do not call any tools.`;
}

/**
 * The poll-guard turn, sent once the workers have settled. Five reads rather
 * than four: a first read may change the page (acknowledging what it
 * returns), and the guard counts identical answers, so the fourth identical
 * read is the fourth or fifth call.
 */
export function asyncPollPrompt(mailbox: { environmentId: string; tabId: string }): string {
  const args = JSON.stringify({ ...mailbox, unreadOnly: false, offset: 0, limit: 50 });
  return [
    HARNESS_PREAMBLE,
    `Call the Orkestrator read_messages tool five times in a row with exactly these arguments each time: ${args}. Do not call any other tool in between and do not acknowledge or reply to any message. This is a check of the polling guard, so make all five calls even if a result tells you to stop.`,
    "Finish with exactly one line in this format, and nothing after it:",
    `${ASYNC_REPORT_MARKER} {"repeatedRead":<true if any result carried repeatedRead, else false>}`,
  ].join("\n");
}

/** The family scenario: one prompt drives the whole exchange. */
export function familyScenarioPrompt(probe: DelegationProbe): string {
  const names = familyWorkerNames(probe);
  const bodies = familyBodies(probe);
  const answerRule =
    'Later you may receive messages from the coordinator. Answer each one by calling the Orkestrator send_message tool once with toEnvironmentId "coordinator" and, as the body, exactly the text that message asks you to reply with. Then end your turn. Do nothing else.';
  return [
    HARNESS_PREAMBLE,
    "",
    "1. Call the Orkestrator get_launch_options tool once.",
    `2. Then ${launchStep(
      probe,
      names.one,
      `Call the Orkestrator send_message tool once with toEnvironmentId "coordinator" and body "${bodies.oneReport}", then end your turn. ${answerRule}`,
    )}.`,
    `3. Then ${launchStep(
      probe,
      names.two,
      `First run this shell command, which waits for the test harness: ${gateCommand(probe.gatePath)} If it prints nothing, run it again until it prints gate-open. Then call the Orkestrator send_message tool once with toEnvironmentId "coordinator" and body "${bodies.twoReport}", then end your turn. ${answerRule}`,
    )}.`,
    `4. Straight after step 3, in this same turn, call the Orkestrator send_message tool once with toEnvironmentId set to the environment id launch_environment returned for ${names.two} (no toTabId) and body "Reply with ${bodies.twoFollowUp}".`,
    "5. Then finish this turn at once with a one-line summary. Do not wait, sleep, read messages or check message status.",
    "",
    "Later turns, when you are woken by worker mail:",
    `- Once you have ${names.one}'s report (${bodies.oneReport}), send ${names.one} a message with send_message, toEnvironmentId set to its environment id (no toTabId), and body "Reply with ${bodies.ping(1)}". Then end your turn.`,
    `- Each time ${names.one} replies with ${bodies.ping(1).replace("-1-", "-<n>-")} for n below ${FAMILY_PING_COUNT}, send it "Reply with ${bodies.ping(1).replace("-1-", "-<n+1>-")}" the same way and end your turn.`,
    `- When ${names.one} replies with ${bodies.ping(FAMILY_PING_COUNT)}, send nothing more and finish that turn with exactly one line: ${FAMILY_DONE_MARKER}`,
    `- Send nothing more to ${names.two} after step 4. Any other wake (another worker's report, a notice): reply with one short line and end the turn without calling any tools.`,
    "Never wait, sleep, poll or read messages; you are woken when there is something to do.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Transcript evidence

function toolBaseName(name: string): string {
  // `mcp__orkestrator__read_messages`, `orkestrator_read_messages`,
  // `orkestrator__read_messages`, `read_messages`.
  return name
    .toLowerCase()
    .replace(/^mcp__orkestrator__/, "")
    .replace(/^orkestrator_{1,2}/, "");
}

/** Calls to one Orkestrator tool, whatever prefix the provider gives it. */
export function orkestratorToolCalls(
  calls: readonly ReadOnlyToolCall[],
  tool: string,
): ReadOnlyToolCall[] {
  return calls.filter((call) => toolBaseName(call.name) === tool);
}

/**
 * Orkestrator's own tools carry prompts and message bodies as arguments, so a
 * worker prompt that tells the worker to `sleep` is not the coordinator
 * waiting. Only other tools (shells, code-mode cells) count.
 */
const ORKESTRATOR_TOOLS: ReadonlySet<string> = new Set(COORDINATOR_CONTROL_TOOL_NAMES);

const WAITING_COMMAND = /(?:^|[^\w-])(?:sleep|watch)\s+-?\d/;

/**
 * How a coordinator waited, if it did: shell `sleep`/`watch`, and polling
 * reads. Feeds the Codex `sleep` and `list_environments` poll-guard decisions
 * in `coordinator-read-only-adapters.md` and `coordinator-consistency-gaps.md`.
 */
export function coordinatorWaitCounts(calls: readonly ReadOnlyToolCall[]): {
  sleepCalls: number;
  listEnvironmentsCalls: number;
  readMessagesCalls: number;
  getMessageStatusCalls: number;
} {
  return {
    sleepCalls: calls.filter(
      (call) => !ORKESTRATOR_TOOLS.has(toolBaseName(call.name)) && WAITING_COMMAND.test(call.args),
    ).length,
    listEnvironmentsCalls: orkestratorToolCalls(calls, "list_environments").length,
    readMessagesCalls: orkestratorToolCalls(calls, "read_messages").length,
    getMessageStatusCalls: orkestratorToolCalls(calls, "get_message_status").length,
  };
}

/** Text of each user row, in transcript order. */
export function transcriptUserTexts(messages: readonly CoordinatorTranscriptMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const parts: string[] = [];
    if (typeof message.content === "string") parts.push(message.content);
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      const record = part as { type?: unknown; content?: unknown; text?: unknown };
      if (typeof record.content === "string") parts.push(record.content);
      else if (typeof record.text === "string") parts.push(record.text);
    }
    texts.push(parts.join("\n"));
  }
  return texts;
}

/** Whether a user row is a mail carrier, as the bridges echo it back. */
export function isCarrierText(text: string): boolean {
  return text.includes("<orkestrator-peer-message");
}

// ---------------------------------------------------------------------------
// Mail evidence

/**
 * Counts authoritative transcript carrier rows. Missing echoes leave the count
 * unverified (null): neither per-message injectRequestId nor nearby injection
 * timestamps identify the dispatch which carried a batch.
 */
export function carrierCount(
  messages: readonly DelegationMailMessage[],
  userTexts: readonly string[],
): number | null {
  const delivered = messages.filter((message) => message.placement === "injected");
  const rows = new Set<number>();
  for (const message of delivered) {
    const matching = userTexts.flatMap((text, index) =>
      isCarrierText(text) && text.includes(message.id) ? [index] : [],
    );
    if (matching.length === 0) return null;
    for (const row of matching) rows.add(row);
  }
  return rows.size;
}

/** Decode only structured MCP results, never text mentioning the guard field. */
function repeatedReadResult(text: string): boolean {
  const decode = (value: unknown, depth: number): boolean => {
    if (depth > 4) return false;
    if (typeof value === "string") {
      try {
        return decode(JSON.parse(value), depth + 1);
      } catch {
        return false;
      }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const result = value as Record<string, unknown>;
    if (result.isError === true || result.error !== undefined) return false;
    if (result.repeatedRead === true) return true;
    if (Array.isArray(result.content)) {
      return result.content.some(
        (block) => block?.type === "text" && decode(block.text, depth + 1),
      );
    }
    return result.structuredContent !== undefined && decode(result.structuredContent, depth + 1);
  };
  return decode(text, 0);
}

function canonicalArguments(text: string): string | null {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, sort(item)]),
      );
    return value;
  };
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? JSON.stringify(sort(value))
      : null;
  } catch {
    return null;
  }
}

function fromWorker(message: DelegationMailMessage, environmentId: string): boolean {
  return message.from.kind === "tab" && message.from.environmentId === environmentId;
}

function noticeAbout(message: DelegationMailMessage, environmentId: string): boolean {
  return (
    message.from.kind === "system" && message.notice?.resource?.environmentId === environmentId
  );
}

function placements(messages: readonly DelegationMailMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.placement, (counts.get(message.placement) ?? 0) + 1);
  }
  return [...counts]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([placement, count]) => `${placement} x${count}`)
    .join(", ");
}

const DELIVERED: ReadonlySet<string> = new Set(["injected"]);

/**
 * Mail from a worker that was already delivered while the harness saw that
 * worker's delegation running: the hold failed.
 */
export function deliveredWhileRunning(
  observations: readonly DelegationObservation[],
  workerEnvironmentId: string,
  coordinatorEnvironmentId: string,
): number {
  const leaked = new Set<string>();
  for (const observation of observations) {
    const running = observation.delegations.some(
      (delegation) =>
        delegation.environmentId === workerEnvironmentId && delegation.state === "running",
    );
    if (!running) continue;
    for (const message of observation.mail) {
      if (
        message.toEnvironmentId === coordinatorEnvironmentId &&
        fromWorker(message, workerEnvironmentId) &&
        DELIVERED.has(message.placement)
      ) {
        leaked.add(message.id);
      }
    }
  }
  return leaked.size;
}

function check(name: string, passed: boolean, detail?: string): CoordinatorLiveCheck {
  return { name, passed, ...(detail ? { detail: detail.slice(0, 500) } : {}) };
}

// ---------------------------------------------------------------------------
// The async scenario

export interface AsyncScenarioInput {
  probe: DelegationProbe;
  coordinatorEnvironmentId: string;
  workers: { reporter?: DelegationWorker; silent?: DelegationWorker };
  /** Phases the harness saw during the delegating turn, in order. */
  delegatingTurnPhases: readonly string[];
  /** When the harness saw the delegating turn settle (an observation's `at`). */
  delegatingTurnEndedAt: number;
  /** Tool calls the delegating turn made (before it first went idle). */
  delegatingTurnCalls: readonly ReadOnlyToolCall[];
  /** `launch_environment` results, fetched from behind each row's detail reference. */
  launchResults: readonly string[];
  /** Whether the queued prompt was accepted into the coordinator's prompt queue. */
  queuedAccepted: boolean;
  /** The coordinator transcript after the workers settled. */
  messages: readonly CoordinatorTranscriptMessage[];
  /** Final mail state, with bodies of mail to the coordinator. */
  mail: readonly DelegationMailMessage[];
  observations: readonly DelegationObservation[];
  delegations: readonly DelegationRecord[];
  /** `read_messages` results of the poll turn, in call order. */
  pollResults: readonly string[];
  /** Calls from the poll turn only, aligned with pollResults. */
  pollCalls: readonly ReadOnlyToolCall[];
  pollReport?: { repeatedRead: boolean } | { error: string };
  escapedInteractions: readonly AgentInteractionKind[];
  /** Interactions that reached the harness from a worker. */
  workerInteractions: readonly AgentInteractionKind[];
}

export function parseAsyncPollReport(text: string): { repeatedRead: boolean } | { error: string } {
  const raw = [...text.matchAll(new RegExp(`${ASYNC_REPORT_MARKER}\\s*(\\{[^\\n]*\\})`, "g"))].at(
    -1,
  )?.[1];
  if (!raw) return { error: `the poll turn has no ${ASYNC_REPORT_MARKER} line` };
  try {
    const value = JSON.parse(raw) as { repeatedRead?: unknown };
    if (typeof value.repeatedRead !== "boolean") {
      return { error: `the ${ASYNC_REPORT_MARKER} line has no boolean repeatedRead` };
    }
    return { repeatedRead: value.repeatedRead };
  } catch {
    return { error: `the ${ASYNC_REPORT_MARKER} line is not valid JSON` };
  }
}

/** Every async check, in the todo's order. */
export function evaluateAsyncScenario(input: AsyncScenarioInput): CoordinatorLiveCheck[] {
  const checks: CoordinatorLiveCheck[] = [];
  const coordinator = input.coordinatorEnvironmentId;
  const bodies = asyncBodies(input.probe);

  // 1. Running, then idle.
  const phases = input.delegatingTurnPhases;
  const ran = phases.some((phase) => phase !== "idle" && phase !== "error");
  checks.push(
    check(
      "running-then-idle",
      ran && phases.at(-1) === "idle" && !phases.includes("error"),
      `phases ${[...new Set(phases)].join(" → ")}`,
    ),
  );

  // 2. Async launch, and no wait inside the turn.
  const launches = orkestratorToolCalls(input.delegatingTurnCalls, "launch_environment");
  const asyncResults = input.launchResults.filter((result) =>
    // Raw or JSON-escaped once more inside a text block.
    /delivery\\?"?\s*:\s*\\?"async/.test(result),
  ).length;
  checks.push(
    check(
      "launch-async",
      input.workers.reporter !== undefined &&
        input.workers.silent !== undefined &&
        launches.length >= 2 &&
        asyncResults >= 2,
      `${launches.length} launch_environment calls, ${asyncResults} results with delivery async`,
    ),
  );
  const waits = coordinatorWaitCounts(input.delegatingTurnCalls);
  const waited =
    waits.sleepCalls +
    waits.readMessagesCalls +
    waits.getMessageStatusCalls +
    waits.listEnvironmentsCalls;
  // The reporter cannot finish before the harness opens its gate, so a turn
  // that waited for it would not have settled with it still running.
  const turnEnd = input.observations.find(
    (observation) => observation.at === input.delegatingTurnEndedAt,
  );
  const reporterRunningAtIdle =
    turnEnd?.delegations.some(
      (delegation) =>
        delegation.environmentId === input.workers.reporter?.environmentId &&
        delegation.state === "running",
    ) === true;
  checks.push(
    check(
      "no-wait-in-turn",
      waited === 0 && reporterRunningAtIdle,
      `sleep ${waits.sleepCalls}, read_messages ${waits.readMessagesCalls}, get_message_status ${waits.getMessageStatusCalls}, list_environments ${waits.listEnvironmentsCalls}; reporter still running when the turn ended ${reporterRunningAtIdle}`,
    ),
  );

  // 3. A user prompt queued while the coordinator is busy and worker mail is
  // pending runs before that mail. Only exercised when the harness saw all
  // three at once; otherwise the queue had nothing to overtake.
  const reporter = input.workers.reporter?.environmentId ?? "";
  const reports = input.mail.filter(
    (message) => message.toEnvironmentId === coordinator && fromWorker(message, reporter),
  );
  const reportIds = new Set(reports.map((message) => message.id));
  const overlapped = input.observations.some(
    (observation) =>
      observation.coordinatorPhase !== "idle" &&
      observation.queueLength > 0 &&
      observation.delegations.some(
        (delegation) => delegation.environmentId === reporter && delegation.state !== "running",
      ) &&
      observation.mail.some(
        (message) => reportIds.has(message.id) && message.placement !== "injected",
      ),
  );
  const users = transcriptUserTexts(input.messages);
  const queuedAt = users.findIndex((text) => text.includes(bodies.queued) && !isCarrierText(text));
  const reportCarrierAt = users.findIndex(
    (text) => isCarrierText(text) && [...reportIds].some((id) => text.includes(id)),
  );
  // A bridge that does not echo the carrier as a user row leaves the store's
  // timestamps: the queued prompt must have left the queue before the
  // report was injected.
  const drainedAt = input.observations.find(
    (observation, index) =>
      index > 0 && observation.queueLength === 0 && input.observations[index - 1]!.queueLength > 0,
  )?.at;
  const injectedAt = Math.min(
    ...reports.flatMap((message) =>
      message.injectedAt ? [Date.parse(message.injectedAt)] : [Number.POSITIVE_INFINITY],
    ),
  );
  const ordered =
    queuedAt >= 0 &&
    (reportCarrierAt >= 0
      ? queuedAt < reportCarrierAt
      : drainedAt !== undefined && Number.isFinite(injectedAt) && drainedAt <= injectedAt);
  checks.push(
    check(
      "queued-before-mail",
      input.queuedAccepted && overlapped && ordered,
      `queued accepted ${input.queuedAccepted}; busy with the report pending and the prompt queued ${overlapped}; queued row ${queuedAt}, report carrier row ${reportCarrierAt}${
        reportCarrierAt < 0
          ? `, queue drained ${drainedAt !== undefined && Number.isFinite(injectedAt) ? `${injectedAt - drainedAt} ms before injection` : "not observed before injection"}`
          : ""
      }`,
    ),
  );

  // 4. Two mid-turn messages held, one carrier, no notice.
  const reportBodies = reports.map((message) => message.body ?? "");
  const reportCarriers = carrierCount(reports, users);
  const leaked = deliveredWhileRunning(input.observations, reporter, coordinator);
  const seenHeld = input.observations.some((observation) =>
    observation.mail.some(
      (message) =>
        reportIds.has(message.id) &&
        message.placement === "inject-held" &&
        message.placementReason === COORDINATOR_DELEGATION_HOLD_REASON,
    ),
  );
  const reporterNotices = input.mail.filter(
    (message) => message.toEnvironmentId === coordinator && noticeAbout(message, reporter),
  ).length;
  checks.push(
    check(
      "held-then-one-carrier",
      reporter !== "" &&
        reports.length === 2 &&
        reportBodies.some((body) => body.includes(bodies.progress)) &&
        reportBodies.some((body) => body.includes(bodies.report)) &&
        reports.every((message) => message.placement === "injected") &&
        reportCarriers === 1 &&
        seenHeld &&
        leaked === 0 &&
        reporterNotices === 0,
      `${reports.length} messages (${placements(reports)}), seen held ${seenHeld}, ${reportCarriers} carriers, ${leaked} delivered while running, ${reporterNotices} notices`,
    ),
  );

  // 5. A silent worker: exactly one notice.
  const silent = input.workers.silent?.environmentId ?? "";
  const silentNotices = input.mail.filter(
    (message) => message.toEnvironmentId === coordinator && noticeAbout(message, silent),
  );
  const silentMail = input.mail.filter(
    (message) => message.toEnvironmentId === coordinator && fromWorker(message, silent),
  ).length;
  checks.push(
    check(
      "silent-worker-one-notice",
      silent !== "" &&
        silentNotices.length === 1 &&
        silentNotices[0]!.placement === "injected" &&
        silentMail === 0,
      `${silentNotices.length} notices (${placements(silentNotices)}), ${silentMail} messages from the worker`,
    ),
  );

  // One wake per delegation.
  const delegationWakes = input.delegations.map((delegation) => ({
    delegation,
    carriers: carrierCount(
      input.mail.filter(
        (message) =>
          message.toEnvironmentId === coordinator &&
          (fromWorker(message, delegation.environmentId) ||
            noticeAbout(message, delegation.environmentId)),
      ),
      users,
    ),
  }));
  checks.push(
    check(
      "one-wake-per-delegation",
      delegationWakes.length === 2 &&
        delegationWakes.every(
          ({ delegation, carriers }) =>
            carriers === 1 && delegation.state === "completed" && delegation.wokenAt !== undefined,
        ),
      delegationWakes
        .map(
          ({ delegation, carriers }) =>
            `${delegation.state}${delegation.wokenAt ? " woken" : ""} (${delegation.wakeKind ?? "no wake kind"}), ${carriers} carriers`,
        )
        .join("; "),
    ),
  );

  // 6. Identical reads answered with repeatedRead.
  const repeatedAt = input.pollResults.findIndex(repeatedReadResult);
  const pollCalls = orkestratorToolCalls(input.pollCalls, "read_messages");
  const pollArgs = pollCalls.map((call) => canonicalArguments(call.args));
  const identical =
    pollArgs.length === input.pollResults.length &&
    pollArgs.length === 5 &&
    pollArgs[0] !== null &&
    pollArgs.every((args) => args === pollArgs[0]) &&
    pollCalls.every((call) => call.state === "succeeded");
  const reported = input.pollReport && !("error" in input.pollReport) ? input.pollReport : null;
  checks.push(
    check(
      "repeated-read-guard",
      identical && repeatedAt >= 3 && repeatedAt <= 4,
      `${input.pollResults.length} read_messages calls, identical arguments ${identical}, first repeatedRead at call ${repeatedAt + 1}; agent reported ${
        reported
          ? String(reported.repeatedRead)
          : ((input.pollReport as { error?: string } | undefined)?.error ?? "nothing")
      }`,
    ),
  );

  // Nobody had to answer anything.
  const interactions = [
    ...escapedInteractionFailures(input.escapedInteractions),
    ...escapedInteractionFailures(input.workerInteractions).map((failure) => `worker: ${failure}`),
  ];
  checks.push(check("no-user-action", interactions.length === 0, interactions.join("; ")));
  return checks;
}

// ---------------------------------------------------------------------------
// The family scenario

export interface FamilyScenarioInput {
  probe: DelegationProbe;
  coordinatorEnvironmentId: string;
  workers: { one?: DelegationWorker; two?: DelegationWorker };
  /** Every coordinator tool call across the run. */
  calls: readonly ReadOnlyToolCall[];
  /** The coordinator's assistant text across the run. */
  assistantText: string;
  /** The coordinator's user rows, where the bridges echo each carrier. */
  userTexts: readonly string[];
  /** Final mail state with bodies. */
  mail: readonly DelegationMailMessage[];
  observations: readonly DelegationObservation[];
  escapedInteractions: readonly AgentInteractionKind[];
  workerInteractions: readonly AgentInteractionKind[];
  /** Turns the harness sent: always one, the prompt that starts the family. */
  harnessPrompts: number;
}

const FAMILY_BAD_PLACEMENTS: ReadonlySet<string> = new Set(["stored", "inject_failed"]);

export function evaluateFamilyScenario(input: FamilyScenarioInput): CoordinatorLiveCheck[] {
  const checks: CoordinatorLiveCheck[] = [];
  const coordinator = input.coordinatorEnvironmentId;
  const bodies = familyBodies(input.probe);
  const one = input.workers.one?.environmentId ?? "";
  const two = input.workers.two?.environmentId ?? "";
  const family = new Set([coordinator, one, two].filter(Boolean));
  const familyMail = input.mail.filter(
    (message) =>
      family.has(message.toEnvironmentId) &&
      (message.from.kind === "system" ||
        family.has(message.from.environmentId ?? "") ||
        message.from.kind === "coordinator"),
  );
  const toCoordinator = (worker: string) =>
    familyMail.filter(
      (message) => message.toEnvironmentId === coordinator && fromWorker(message, worker),
    );
  const toWorker = (worker: string) =>
    familyMail.filter(
      (message) => message.toEnvironmentId === worker && message.from.kind === "coordinator",
    );

  checks.push(
    check(
      "both-workers-launched",
      one !== "" && two !== "",
      `${[one, two].filter(Boolean).length} of 2 workers found`,
    ),
  );

  const oneReports = toCoordinator(one);
  const twoReports = toCoordinator(two);
  const hasBody = (messages: readonly DelegationMailMessage[], body: string) =>
    messages.some((message) => (message.body ?? "").includes(body));
  checks.push(
    check(
      "both-workers-report",
      hasBody(oneReports, bodies.oneReport) && hasBody(twoReports, bodies.twoReport),
      `${oneReports.length} messages from the first worker, ${twoReports.length} from the second`,
    ),
  );

  // The busy follow-up joins the open delegation: one delegation, one wake.
  const followUps = toWorker(two);
  const twoReplied = hasBody(twoReports, bodies.twoFollowUp);
  const twoCarriers = carrierCount(twoReports, input.userTexts);
  const twoRequests = new Set(
    input.observations.flatMap((observation) =>
      observation.delegations
        .filter((delegation) => delegation.environmentId === two)
        .map((delegation) => delegation.requestedAt),
    ),
  );
  // Busy means mid-turn: the follow-up waiting, undelivered, while the
  // worker's turn ran. An open delegation alone is not enough, because a
  // follow-up that lands before the worker's first turn starts is simply
  // delivered first.
  const followUpId = followUps[0]?.id;
  const busyAtFollowUp =
    followUpId !== undefined &&
    input.observations.some((observation) => {
      const phase = observation.workerPhases?.[two];
      return (
        phase !== undefined &&
        phase !== "idle" &&
        phase !== "error" &&
        observation.mail.some(
          (message) => message.id === followUpId && message.placement !== "injected",
        ) &&
        observation.delegations.some(
          (delegation) => delegation.environmentId === two && delegation.state === "running",
        )
      );
    });
  const followUpTrail = followUpId
    ? [
        ...new Set(
          input.observations.flatMap((observation) =>
            observation.mail
              .filter((message) => message.id === followUpId)
              .map(
                (message) =>
                  `${message.placement}${message.placementReason ? ` (${message.placementReason})` : ""} while ${observation.workerPhases?.[two] ?? "unknown"}`,
              ),
          ),
        ),
      ].join(" → ")
    : "none";
  checks.push(
    check(
      "busy-follow-up-joins-delegation",
      followUps.length === 1 &&
        busyAtFollowUp &&
        twoReplied &&
        twoRequests.size === 1 &&
        twoCarriers === 1,
      `${followUps.length} follow-ups, held mid-turn ${busyAtFollowUp} (${followUpTrail}), replied ${twoReplied}, ${twoRequests.size} delegations, ${twoCarriers} carriers to the coordinator`,
    ),
  );

  // The follow-up by environment id, and ten more alternating messages.
  const pings = toWorker(one);
  const sendCalls = orkestratorToolCalls(input.calls, "send_message");
  const byEnvironmentOnly = sendCalls.filter(
    (call) => call.args.includes(one) && !/toTabId"?\s*:\s*"[^"]/.test(call.args),
  ).length;
  const expectedPings = Array.from({ length: FAMILY_PING_COUNT }, (_, index) =>
    bodies.ping(index + 1),
  );
  const pingsAsked = expectedPings.filter((body) => hasBody(pings, body)).length;
  const pingsAnswered = expectedPings.filter((body) => hasBody(oneReports, body)).length;
  checks.push(
    check(
      "follow-up-by-environment-id",
      pings.length >= 1 && byEnvironmentOnly >= 1 && pingsAnswered >= 1,
      `${byEnvironmentOnly} send_message calls to the first worker by environment id alone, ${pings.length} delivered`,
    ),
  );
  // Distinct requests/replies, ordered by persisted message creation times.
  // Equal or absent timestamps do not establish the causal exchange.
  let previousReply = Number.NEGATIVE_INFINITY;
  const used = new Set<string>();
  const alternating = expectedPings.every((body) => {
    const requests = pings.filter((message) => message.body?.includes(body));
    const replies = oneReports.filter((message) => message.body?.includes(body));
    if (requests.length !== 1 || replies.length !== 1) return false;
    const request = requests[0]!;
    const reply = replies[0]!;
    const requestedAt = Date.parse(request.createdAt);
    const repliedAt = Date.parse(reply.createdAt);
    if (
      used.has(request.id) ||
      used.has(reply.id) ||
      request.placement !== "injected" ||
      reply.placement !== "injected" ||
      !Number.isFinite(requestedAt) ||
      !Number.isFinite(repliedAt) ||
      requestedAt <= previousReply ||
      repliedAt <= requestedAt
    )
      return false;
    used.add(request.id);
    used.add(reply.id);
    previousReply = repliedAt;
    return true;
  });
  const exchanged = pingsAsked + pingsAnswered;
  checks.push(
    check(
      "ten-more-alternating",
      pingsAsked === FAMILY_PING_COUNT &&
        pingsAnswered === FAMILY_PING_COUNT &&
        alternating &&
        input.assistantText.includes(FAMILY_DONE_MARKER),
      `${pingsAsked} asked and ${pingsAnswered} answered; alternating ${alternating}; of ${FAMILY_PING_COUNT} (${Math.max(0, exchanged - 2)} after the first follow-up and reply); done line ${input.assistantText.includes(FAMILY_DONE_MARKER)}`,
    ),
  );

  // Every family message delivered without anyone's help.
  const bad = familyMail.filter((message) => FAMILY_BAD_PLACEMENTS.has(message.placement));
  const undelivered = familyMail.filter((message) => message.placement !== "injected");
  checks.push(
    check(
      "no-stored-or-failed",
      bad.length === 0,
      `${familyMail.length} family messages: ${placements(familyMail)}${
        undelivered.length > 0
          ? `; not injected: ${undelivered.map((message) => `${message.placement}${message.placementReason ? ` (${message.placementReason})` : ""}`).join(", ")}`
          : ""
      }`,
    ),
  );
  const interactions = [
    ...escapedInteractionFailures(input.escapedInteractions),
    ...escapedInteractionFailures(input.workerInteractions).map((failure) => `worker: ${failure}`),
    ...(input.harnessPrompts === 1 ? [] : [`the harness sent ${input.harnessPrompts} prompts`]),
  ];
  checks.push(check("no-user-action", interactions.length === 0, interactions.join("; ")));
  return checks;
}

/** Failure messages from a scenario's checks; empty when it qualifies. */
export function delegationFailures(checks: readonly CoordinatorLiveCheck[]): string[] {
  return checks
    .filter((item) => !item.passed)
    .map((item) => (item.detail ? `${item.name}: ${item.detail}` : item.name));
}
