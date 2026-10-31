import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import {
  escapedInteractionFailures,
  type CoordinatorLiveCheck,
  type CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import {
  gateCommand,
  transcriptUserTexts,
  type DelegationMailMessage,
  type DelegationObservation,
  type DelegationRecord,
} from "./coordinator-live-delegation.js";

/**
 * The `deliver-now` scenario (todo 0740): a coordinator corrects a busy
 * worker with `send_message` `deliverNow: true`.
 *
 * The coordinator launches one worker that touches a start file and then
 * parks on a gate file, so its turn stays running for as long as the harness
 * wants. Once the start file exists and the worker reads as working, the
 * harness asks the coordinator for the correction, and opens the gate only
 * after the correction has been injected. The worker's report says which body
 * it was told to use, so it shows whether the correction reached that turn.
 *
 * On Claude a second case does the same to a `claude-tmux` tab the
 * coordinator opens in that worker's environment: a terminal agent cannot
 * take mail mid-turn, so the result is `unsupported, queued` and the mail
 * waits for that turn to end.
 *
 * This module holds the prompts and the verdict; the spec and its
 * orchestration (`coordinator-live-deliver-now-orchestration.ts`) share it.
 * Nothing here may use Bun APIs.
 */

export interface DeliverNowProbe {
  platform: AgentPlatform;
  /** Random hex; the worker name and every body carry it. */
  token: string;
  /** The worker creates it when its gated step starts. */
  startedPath: string;
  /** The harness creates it to let the worker finish. */
  gatePath: string;
  /** The same pair for the terminal worker. */
  terminalStartedPath: string;
  terminalGatePath: string;
}

/**
 * Whether the platform's native agent can take mail mid-turn. Without it a
 * correction is `unsupported, queued` by design, so the case is skipped.
 */
export function deliverNowApplies(platform: AgentPlatform): boolean {
  return nativeAgentCapabilities(platform).actions?.steer === true;
}

/** Only Claude has a terminal agent under tmux. */
export function deliverNowTerminalApplies(platform: AgentPlatform): boolean {
  return platform === "claude";
}

export function deliverNowWorkerName(probe: DeliverNowProbe): string {
  return `deliver-now-${probe.token}`;
}

export function deliverNowBodies(probe: DeliverNowProbe) {
  const corrected = `DELIVER-NOW-CORRECTED-${probe.token}`;
  const terminal = `DELIVER-NOW-TERMINAL-${probe.token}`;
  return {
    corrected,
    uncorrected: `DELIVER-NOW-UNCORRECTED-${probe.token}`,
    correction: `Course correction: when you send your report, use exactly ${corrected} as its body.`,
    terminal,
    terminalCorrection: `Course correction for the terminal check: ${terminal}. No reply is needed.`,
  };
}

const HARNESS_PREAMBLE =
  "This is Orkestrator's deliverNow conformance check, run by its test harness on a disposable fixture project. The user authorises and asks for every step below. Do not ask the user anything.";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The worker's task: start, park on the gate, then report what it was told. */
export function deliverNowWorkerPrompt(probe: DeliverNowProbe): string {
  const bodies = deliverNowBodies(probe);
  return [
    "This is a test worker. Do exactly these steps in order and nothing else.",
    `1. Run this shell command: touch ${shellQuote(probe.startedPath)}`,
    `2. Run this shell command, which waits for the test harness: ${gateCommand(probe.gatePath)} If it prints nothing, run it again until it prints gate-open.`,
    `3. If a message from the coordinator reached you during this turn and told you which body to use for your report, call the Orkestrator send_message tool with toEnvironmentId "coordinator" and exactly that body. Otherwise call it with toEnvironmentId "coordinator" and body "${bodies.uncorrected}".`,
    "4. End your turn.",
  ].join(" ");
}

/** The delegating turn: launch the worker and end the turn at once. */
export function deliverNowDelegatingPrompt(probe: DeliverNowProbe): string {
  return [
    HARNESS_PREAMBLE,
    "",
    "1. Call the Orkestrator get_launch_options tool once.",
    `2. Then call the Orkestrator launch_environment tool once with name "${deliverNowWorkerName(probe)}", environmentType "local", agent "${probe.platform}", no model or reasoning fields, the baseBranch and baseCommit from coordinatorBase, a fresh requestId, and this exact prompt: ${JSON.stringify(deliverNowWorkerPrompt(probe))}.`,
    "3. Then finish this turn at once with a one-line summary. Do not wait, sleep, read messages or check message status.",
    "",
    "Later turns: when you are woken by a worker message or a notice, reply with one short line and end that turn without calling any tools.",
  ].join("\n");
}

/** The correction, sent while the worker is parked on its gate. */
export function deliverNowCorrectionPrompt(
  probe: DeliverNowProbe,
  workerEnvironmentId: string,
): string {
  return [
    HARNESS_PREAMBLE,
    `The worker in environment ${workerEnvironmentId} is in the middle of its turn and needs a course correction now. Call the Orkestrator send_message tool exactly once with toEnvironmentId "${workerEnvironmentId}", deliverNow true, a fresh requestId, and this exact body: ${JSON.stringify(deliverNowBodies(probe).correction)}`,
    "Do not call any other tool and do not wait for the worker. Then end this turn with one line giving the deliverNow value the result returned.",
  ].join("\n");
}

/** The terminal worker: a Claude CLI under tmux in the same environment. */
export function deliverNowTerminalWorkerPrompt(probe: DeliverNowProbe): string {
  return [
    "This is a test worker. Do exactly these steps in order and nothing else.",
    `1. Run this shell command: touch ${shellQuote(probe.terminalStartedPath)}`,
    `2. Run this shell command, which waits for the test harness: ${gateCommand(probe.terminalGatePath)} If it prints nothing, run it again until it prints gate-open.`,
    "3. Reply with the single word done and end your turn. Do not send any messages.",
  ].join(" ");
}

export function deliverNowTerminalLaunchPrompt(
  probe: DeliverNowProbe,
  workerEnvironmentId: string,
): string {
  return [
    HARNESS_PREAMBLE,
    `Call the Orkestrator launch_terminal tool exactly once with environmentId "${workerEnvironmentId}", tabType "claude-tmux", title "deliver-now-terminal-${probe.token}", no model or reasoning fields, a fresh requestId, and this exact prompt: ${JSON.stringify(deliverNowTerminalWorkerPrompt(probe))}`,
    "Do not call any other tool. Then end this turn with a one-line summary.",
  ].join("\n");
}

export function deliverNowTerminalCorrectionPrompt(
  probe: DeliverNowProbe,
  workerEnvironmentId: string,
  tabId: string,
): string {
  return [
    HARNESS_PREAMBLE,
    `The terminal agent in tab ${tabId} of environment ${workerEnvironmentId} is in the middle of its turn. Call the Orkestrator send_message tool exactly once with toEnvironmentId "${workerEnvironmentId}", toTabId "${tabId}", deliverNow true, a fresh requestId, and this exact body: ${JSON.stringify(deliverNowBodies(probe).terminalCorrection)}`,
    "Do not call any other tool and do not wait. Then end this turn with one line giving the deliverNow value the result returned.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool output

/** The `deliverNow` outcome in one `send_message` result, or null. */
export function deliverNowOutcome(output: string): string | null {
  return /"deliverNow"\s*:\s*"([^"]{1,40})"/.exec(output)?.[1] ?? null;
}

/** The tab a `launch_terminal` result names, or null. */
export function launchedTabId(output: string): string | null {
  return /"tabId"\s*:\s*"([^"]{1,200})"/.exec(output)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Verdict

export interface DeliverNowTerminalInput {
  tabId?: string;
  /** `send_message` outputs from the terminal correction turn. */
  correctionResults: string[];
  /** Every read of the terminal tab's mailbox while it was gated, then the last. */
  mailReads: DelegationMailMessage[][];
  gateOpenedAt?: number;
}

export interface DeliverNowScenarioInput {
  probe: DeliverNowProbe;
  coordinatorEnvironmentId: string;
  workerEnvironmentId?: string;
  /** `send_message` outputs from the correction turn. */
  correctionResults: string[];
  correctionEndedAt?: number;
  /** When the harness opened the worker's gate. */
  gateOpenedAt?: number;
  /** End of the window in which coordinator turns are counted as wakes. */
  wakeWindowEndedAt?: number;
  /** First sample after the correction settled; avoids millisecond timestamp ties. */
  wakeObservationStart?: number;
  observations: readonly DelegationObservation[];
  /** Final mail, with bodies. */
  mail: readonly DelegationMailMessage[];
  /** The worker's transcript after its turn ended. */
  workerMessages: readonly CoordinatorTranscriptMessage[];
  delegations: readonly DelegationRecord[];
  escapedInteractions: readonly AgentInteractionKind[];
  workerInteractions: readonly AgentInteractionKind[];
  /** Present only where the terminal case applies. */
  terminal?: DeliverNowTerminalInput;
}

function check(name: string, passed: boolean, detail?: string): CoordinatorLiveCheck {
  return { name, passed, ...(detail ? { detail } : {}) };
}

function at(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** One `send_message` whose result is exactly `expected`. */
function outcomeCheck(name: string, results: readonly string[], expected: string) {
  const outcomes = results.map(deliverNowOutcome);
  return check(
    name,
    results.length === 1 && outcomes[0] === expected,
    `${results.length} send_message results, deliverNow ${outcomes.map(String).join(", ") || "none"}; expected ${expected}`,
  );
}

export function evaluateDeliverNowScenario(input: DeliverNowScenarioInput): CoordinatorLiveCheck[] {
  const bodies = deliverNowBodies(input.probe);
  const worker = input.workerEnvironmentId;
  const checks: CoordinatorLiveCheck[] = [
    check("worker-launched", worker !== undefined),
    outcomeCheck("correction-steered", input.correctionResults, "steered"),
  ];

  // The correction was injected by a steer, before the harness let the turn end.
  const correction = input.mail.find(
    (message) => message.toEnvironmentId === worker && message.body?.includes(bodies.corrected),
  );
  const injectedAt = at(correction?.injectedAt);
  checks.push(
    check(
      "steered-into-running-turn",
      correction?.placement === "injected" &&
        correction.injectedVia === "steer" &&
        input.gateOpenedAt !== undefined &&
        injectedAt <= input.gateOpenedAt,
      correction
        ? `placement ${correction.placement}, injectedVia ${correction.injectedVia ?? "none"}, injected ${
            Number.isFinite(injectedAt) && input.gateOpenedAt !== undefined
              ? `${Math.round((input.gateOpenedAt - injectedAt) / 1_000)}s before the gate opened`
              : "at an unknown time"
          }`
        : "no correction reached the worker's mailbox",
    ),
  );

  // From the first time the worker was seen working until the gate opened, it
  // never read idle: there was one turn, and the correction reached it.
  const gated = input.observations.filter(
    (observation) =>
      worker !== undefined &&
      input.gateOpenedAt !== undefined &&
      // Taken when its reads finished: one at the gate's instant may postdate it.
      observation.at < input.gateOpenedAt,
  );
  const firstWorking = gated.findIndex((observation) =>
    ["working", "waiting"].includes(observation.workerPhases?.[worker ?? ""] ?? ""),
  );
  const idleWhileGated =
    firstWorking < 0
      ? -1
      : gated
          .slice(firstWorking)
          .filter((observation) => observation.workerPhases?.[worker ?? ""] === "idle").length;
  checks.push(
    check(
      "worker-busy-until-gate",
      firstWorking >= 0 && idleWhileGated === 0,
      firstWorking < 0
        ? "the worker was never seen working before the gate opened"
        : `${idleWhileGated} idle reads while the worker was parked on the gate`,
    ),
  );

  const userTexts = transcriptUserTexts(input.workerMessages);
  checks.push(
    check(
      "correction-in-worker-transcript",
      userTexts.some((text) => text.includes(bodies.corrected)),
      `${userTexts.length} user rows in the worker's transcript`,
    ),
  );

  // The report shows the correction changed what the running turn did.
  const reports = input.mail.filter(
    (message) =>
      message.toEnvironmentId === input.coordinatorEnvironmentId &&
      message.from.kind === "tab" &&
      message.from.environmentId === worker,
  );
  const corrected = reports.filter((message) => message.body?.trim() === bodies.corrected).length;
  const uncorrected = reports.filter((message) =>
    message.body?.includes(bodies.uncorrected),
  ).length;
  checks.push(
    check(
      "report-reflects-correction",
      corrected === 1 && uncorrected === 0,
      `${reports.length} worker reports: ${corrected} corrected, ${uncorrected} uncorrected`,
    ),
  );

  // One wake, when the turn ended: the delegation woke the coordinator after
  // the gate opened, and the coordinator started exactly one turn after the
  // correction turn.
  const delegation = input.delegations.find((record) => record.environmentId === worker);
  const wokenAt = at(delegation?.wokenAt);
  let turnsAfterCorrection = 0;
  let previous = "idle";
  const knownTurns = new Set<string>();
  const wakeTurns = new Set<string>();
  for (const [index, observation] of input.observations.entries()) {
    const beforeWake =
      input.wakeObservationStart !== undefined
        ? index < input.wakeObservationStart
        : input.correctionEndedAt !== undefined && observation.at <= input.correctionEndedAt;
    if (beforeWake) {
      for (const id of observation.coordinatorTurnIds ?? []) knownTurns.add(id);
    }
    if (
      input.correctionEndedAt === undefined ||
      input.wakeWindowEndedAt === undefined ||
      beforeWake ||
      observation.at > input.wakeWindowEndedAt
    )
      continue;
    if (previous === "idle" && observation.coordinatorPhase !== "idle") turnsAfterCorrection += 1;
    for (const id of observation.coordinatorTurnIds ?? []) {
      if (!knownTurns.has(id)) wakeTurns.add(id);
    }
    previous = observation.coordinatorPhase;
  }
  // Phase edges catch a running turn before its usage record is published;
  // durable usage records catch entire turns completed between phase samples.
  turnsAfterCorrection = Math.max(turnsAfterCorrection, wakeTurns.size);
  checks.push(
    check(
      "one-wake-at-turn-end",
      delegation?.state === "completed" &&
        input.gateOpenedAt !== undefined &&
        wokenAt >= input.gateOpenedAt &&
        turnsAfterCorrection === 1,
      `delegation ${delegation?.state ?? "missing"}, woken ${
        Number.isFinite(wokenAt) ? "" : "never"
      }${
        Number.isFinite(wokenAt) && input.gateOpenedAt !== undefined
          ? `${wokenAt >= input.gateOpenedAt ? "after" : "before"} the gate opened`
          : ""
      }, ${turnsAfterCorrection} coordinator turns after the correction`,
    ),
  );

  if (input.terminal) checks.push(...evaluateTerminal(input.terminal, bodies.terminal));

  const interactions = [
    ...escapedInteractionFailures(input.escapedInteractions),
    ...escapedInteractionFailures(input.workerInteractions).map((failure) => `worker: ${failure}`),
  ];
  checks.push(check("no-user-action", interactions.length === 0, interactions.join("; ")));
  return checks;
}

function evaluateTerminal(input: DeliverNowTerminalInput, marker: string): CoordinatorLiveCheck[] {
  const find = (read: readonly DelegationMailMessage[]) =>
    read.find((message) => message.toTabId === input.tabId && message.body?.includes(marker));
  const final = find(input.mailReads.at(-1) ?? []);
  const held = input.mailReads
    .slice(0, -1)
    .map(find)
    .some(
      (message) =>
        message?.placement === "pending-inject" && message.placementReason === "steer-unsupported",
    );
  const injectedAt = at(final?.injectedAt);
  return [
    check("terminal-launched", input.tabId !== undefined),
    outcomeCheck("terminal-unsupported-queued", input.correctionResults, "unsupported, queued"),
    check(
      "terminal-held-for-turn-end",
      held,
      held ? undefined : "never seen pending with the steer-unsupported hold note",
    ),
    check(
      "terminal-delivered-at-turn-end",
      final?.placement === "injected" &&
        final.injectedVia !== "steer" &&
        input.gateOpenedAt !== undefined &&
        injectedAt >= input.gateOpenedAt,
      final
        ? `placement ${final.placement}, injectedVia ${final.injectedVia ?? "none"}`
        : "the correction never reached the terminal tab's mailbox",
    ),
  ];
}
