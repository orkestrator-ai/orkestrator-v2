import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import {
  isAgentAccountPlatform,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  escapedInteractionFailures,
  type CoordinatorLiveCheck,
  type ReadOnlyToolCall,
} from "./coordinator-live.js";
import {
  orkestratorToolCalls,
  type DelegationMailMessage,
  type DelegationObservation,
} from "./coordinator-live-delegation.js";

/**
 * The live coordinator suite's `account-switch` scenario (to-do 1000 task 4,
 * retired; see the `account-switch` case under "Live coordinator suite" in
 * `docs/development/agent-testing.md`).
 *
 * The harness seeds what a real usage limit would leave behind: a worker tab
 * whose latest turn outcome is a usage-limit failure, and one extra signed-in
 * fixture account for the platform in the profile's own account directory
 * (no real login, nothing billed). Then the coordinator runs two phases:
 *
 * - `request`: it sets a self-timer without permission, is woken by it, reads
 *   the usage limits, lists the accounts and asks to switch to the fixture
 *   account. The switch must be a pending request the user approves; the
 *   harness rejects it, so nothing changes.
 * - `granted`: in a turn the user started it sets a self-timer carrying the
 *   user's permission to switch, is woken, and switches with that timer's
 *   `scheduleId`. The switch must run at once and be recorded as the timer's.
 *
 * Only Claude and Codex have accounts, so other platforms are skipped.
 *
 * Shared by the Node Playwright spec and the Bun tests, so nothing here may
 * use Bun APIs.
 */

export const ACCOUNT_SWITCH_PHASES = ["request", "granted"] as const;

/**
 * Set to `1` for a run a person watches: the request phase's switch request is
 * left pending for them to reject in the profile's approval dialog, so the
 * real dialog is part of the run (the manual-test checklist's billed run).
 */
export const ACCOUNT_SWITCH_HOLD_REQUEST_ENV = "ORKESTRATOR_AGENT_TEST_ACCOUNT_SWITCH_HOLD_REQUEST";
export type AccountSwitchPhase = (typeof ACCOUNT_SWITCH_PHASES)[number];

export interface AccountSwitchProbe {
  platform: AgentAccountPlatform;
  /** Random hex; the worker's name, the account label and the timers carry it. */
  token: string;
  /** The fixture account the coordinator is asked to switch to. */
  accountId: string;
  /** The harness-made worker whose last turn hit a usage limit. */
  workerEnvironmentId: string;
  /** When the self-timer fires, in `create_schedule`'s `at` syntax. */
  at: string;
}

export function accountSwitchApplies(
  platform: AgentPlatform,
): { applies: true } | { applies: false; reason: string } {
  return isAgentAccountPlatform(platform)
    ? { applies: true }
    : {
        applies: false,
        reason: `only Claude and Codex have provider accounts, so a ${platform} worker has no account to switch to`,
      };
}

export function accountSwitchWorkerName(token: string): string {
  return `account-switch-${token}`;
}

export function accountSwitchAccountLabel(token: string): string {
  return `fixture-${token}`;
}

/** The error text of the seeded outcome: what a provider's limit refusal reads like. */
export const SEEDED_USAGE_LIMIT_ERROR =
  "You've hit your usage limit. Your limit resets in 2 hours. (seeded by the live coordinator suite)";

/** The user's words a granted timer carries. */
export function accountSwitchInstruction(probe: AccountSwitchProbe): string {
  return `Check the environments in a minute. If any hit a usage limit, switch ${probe.platform} to the account labelled ${accountSwitchAccountLabel(probe.token)}.`;
}

const HARNESS_PREAMBLE =
  "This is Orkestrator's self-timer and account-switch conformance check, run by its test harness on a disposable fixture project with fixture accounts. The user authorises and asks for every step below. Do not ask the user anything.";

export function accountSwitchPrompt(probe: AccountSwitchProbe, phase: AccountSwitchPhase): string {
  const label = accountSwitchAccountLabel(probe.token);
  const permission =
    phase === "granted"
      ? `and authorizeAccountSwitch {"platforms":["${probe.platform}"],"userInstruction":${JSON.stringify(accountSwitchInstruction(probe))}}`
      : "and no authorizeAccountSwitch field";
  const switchStep =
    phase === "granted"
      ? `call switch_provider_account once with platform "${probe.platform}", the accountId of that account, a one-line reason, a fresh requestId and the scheduleId the reminder names`
      : `call switch_provider_account once with platform "${probe.platform}", the accountId of that account, a one-line reason and a fresh requestId, and no scheduleId`;
  return [
    HARNESS_PREAMBLE,
    "",
    `1. Call the Orkestrator create_schedule tool exactly once, with a fresh requestId, at "${probe.at}", and action type "remind_me" with body "Check the environments for usage limits (${phase} ${probe.token})" ${permission}.`,
    "2. Then end this turn with one line. Do not wait, sleep, read messages or check anything else now: the reminder wakes you.",
    "",
    `When that reminder wakes you: call get_usage_limits once; then call list_provider_accounts once with platform "${probe.platform}" and find the account labelled ${label}; then ${switchStep}. Call each of those three tools exactly once, then end that turn with one line saying what the switch result's state was.`,
    "If you are later told the outcome of a switch request, reply with one short line and call no tools.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool output

function parseObject(output: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(output) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** One `create_schedule` result: the timer's id and whether it carries permission. */
export function scheduleOutcome(output: string): {
  scheduleId: string | null;
  carriesPermission: boolean;
} {
  const value = parseObject(output);
  return {
    scheduleId: typeof value?.scheduleId === "string" ? value.scheduleId : null,
    carriesPermission: value?.carriesAccountSwitchPermission === true,
  };
}

/** The environments one `get_usage_limits` result lists as limited. */
export function limitedEnvironments(output: string): string[] {
  const tabs = parseObject(output)?.limitedTabs;
  return Array.isArray(tabs)
    ? tabs.flatMap((tab) =>
        tab &&
        typeof tab === "object" &&
        typeof (tab as { environmentId?: unknown }).environmentId === "string"
          ? [(tab as { environmentId: string }).environmentId]
          : [],
      )
    : [];
}

/** Whether a `list_provider_accounts` result lists the account. */
export function listsAccount(output: string, accountId: string): boolean {
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 6 || !value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1));
    const record = value as Record<string, unknown>;
    if (record.accountId === accountId) return true;
    return Object.values(record).some((item) => visit(item, depth + 1));
  };
  return visit(parseObject(output), 0);
}

/** One `switch_provider_account` result's state and target. */
export function switchOutcome(output: string): {
  state: string | null;
  accountId: string | null;
  approvalRequestId: string | null;
} {
  const value = parseObject(output);
  return {
    state: typeof value?.state === "string" ? value.state : null,
    accountId: typeof value?.accountId === "string" ? value.accountId : null,
    approvalRequestId:
      typeof value?.approvalRequestId === "string" ? value.approvalRequestId : null,
  };
}

/** A coordinator request as `list_node_action_requests` returns it, read loosely. */
export interface SwitchRequestRecord {
  requestId: string;
  kind: string;
  state: string;
  targets?: Array<{ platform?: string; accountId?: string }>;
  authorizedBy?: string;
  selfTimer?: { scheduleId?: string };
}

export function switchRequestsFor(
  requests: readonly SwitchRequestRecord[],
  probe: AccountSwitchProbe,
): SwitchRequestRecord[] {
  return requests.filter(
    (request) =>
      request.kind === "switch-agent-account" &&
      (request.targets ?? []).some(
        (target) => target.platform === probe.platform && target.accountId === probe.accountId,
      ),
  );
}

// ---------------------------------------------------------------------------
// The verdict

/** What one phase left for the verdict. Tool outputs and mail bodies are never recorded. */
export interface AccountSwitchPhaseEvidence {
  phase: AccountSwitchPhase;
  /** Tool rows of the set turn alone. */
  setCalls: readonly ReadOnlyToolCall[];
  /** Tool rows after the set turn, through the end of the phase. */
  wakeCalls: readonly ReadOnlyToolCall[];
  scheduleResults: readonly string[];
  limitsResults: readonly string[];
  listResults: readonly string[];
  switchResults: readonly string[];
  /** When the set turn ended. */
  setEndedAt?: number;
  /** Observations from the end of the set turn to the end of the phase. */
  observations: readonly DelegationObservation[];
  /** The coordinator's mail, read at the end of the phase. */
  mail: readonly DelegationMailMessage[];
  requests: readonly SwitchRequestRecord[];
  activeBefore?: string;
  activeAfter?: string;
  /** Distinct switch requests for the fixture account the harness saw pending. */
  pendingSeen?: number;
  /** The harness rejected the pending request (request phase). */
  rejected?: boolean;
}

/** A reminder this phase's timer delivered: system mail injected after the set turn. */
function reminderDelivered(evidence: AccountSwitchPhaseEvidence): boolean {
  return evidence.mail.some(
    (message) =>
      message.from.kind === "system" &&
      message.placement === "injected" &&
      (evidence.setEndedAt === undefined ||
        Date.parse(message.createdAt) >= evidence.setEndedAt - 1_000),
  );
}

function woke(evidence: AccountSwitchPhaseEvidence): boolean {
  const [first, ...rest] = evidence.observations;
  if (!first) return false;
  const known = new Set(first.coordinatorTurnIds ?? []);
  return rest.some(
    (observation) =>
      observation.coordinatorPhase !== "idle" ||
      (observation.coordinatorTurnIds ?? []).some((id) => !known.has(id)),
  );
}

export function evaluateAccountSwitchPhase(
  probe: AccountSwitchProbe,
  evidence: AccountSwitchPhaseEvidence,
): CoordinatorLiveCheck[] {
  const { phase } = evidence;
  const check = (name: string, passed: boolean, detail?: string): CoordinatorLiveCheck => ({
    name: `${phase}:${name}`,
    passed,
    ...(!passed && detail ? { detail } : {}),
  });
  const schedules = evidence.scheduleResults.map(scheduleOutcome);
  const timer = schedules.find((outcome) => outcome.scheduleId !== null);
  const early = ["get_usage_limits", "list_provider_accounts", "switch_provider_account"].filter(
    (tool) => orkestratorToolCalls(evidence.setCalls, tool).length > 0,
  );
  const limited = evidence.limitsResults.some((output) =>
    limitedEnvironments(output).includes(probe.workerEnvironmentId),
  );
  const listed = evidence.listResults.some((output) => listsAccount(output, probe.accountId));
  const switches = evidence.switchResults.map(switchOutcome);
  const requests = switchRequestsFor(evidence.requests, probe);
  const wanted = phase === "granted" ? "switched" : "pending";
  const switchCalls = orkestratorToolCalls(evidence.wakeCalls, "switch_provider_account");
  const checks: CoordinatorLiveCheck[] = [
    check(
      "timer-set",
      evidence.scheduleResults.length === 1 && timer !== undefined,
      `${evidence.scheduleResults.length} create_schedule calls, ${timer ? "one" : "none"} with a scheduleId`,
    ),
    check(
      "timer-permission",
      timer !== undefined && timer.carriesPermission === (phase === "granted"),
      phase === "granted"
        ? "the timer does not carry the user's permission to switch"
        : "a timer set without authorizeAccountSwitch says it carries permission",
    ),
    check(
      "nothing-before-the-timer",
      early.length === 0,
      `called in the set turn: ${early.join(", ")}`,
    ),
    check("reminder-delivered", reminderDelivered(evidence), "no reminder reached the coordinator"),
    check("woken-by-the-timer", woke(evidence), "no coordinator turn ran after the set turn"),
    check(
      "limits-read",
      limited,
      evidence.limitsResults.length === 0
        ? "no get_usage_limits call"
        : "get_usage_limits did not list the seeded worker",
    ),
    check(
      "accounts-listed",
      listed,
      evidence.listResults.length === 0
        ? "no list_provider_accounts call"
        : "list_provider_accounts did not list the fixture account",
    ),
    check(
      "one-switch-call",
      switchCalls.length === 1,
      `${switchCalls.length} switch_provider_account calls`,
    ),
    check(
      phase === "granted" ? "switched-under-the-timer" : "switch-requested",
      switches.some((outcome) => outcome.state === wanted && outcome.accountId === probe.accountId),
      `switch results: ${switches.map((outcome) => outcome.state ?? "unreadable").join(", ") || "none"}`,
    ),
  ];
  if (phase === "request") {
    checks.push(
      check(
        "request-filed",
        evidence.pendingSeen === 1 &&
          requests.length === 1 &&
          requests.every((request) => request.authorizedBy === undefined),
        `${evidence.pendingSeen ?? 0} pending and ${requests.length} recorded switch requests for the fixture account`,
      ),
      check(
        "rejected-switches-nothing",
        evidence.rejected === true &&
          evidence.activeBefore !== undefined &&
          evidence.activeAfter === evidence.activeBefore,
        evidence.rejected
          ? "the active account changed after the request was rejected"
          : "the request was never rejected",
      ),
    );
  } else {
    const recorded = requests.filter(
      (request) =>
        request.state === "executed" &&
        request.authorizedBy === "self-timer" &&
        request.selfTimer?.scheduleId === timer?.scheduleId,
    );
    checks.push(
      check(
        "recorded-as-the-timers",
        recorded.length === 1,
        `${recorded.length} executed self-timer switches recorded for this timer`,
      ),
      check(
        "active-account-moved",
        evidence.activeAfter === probe.accountId,
        "the fixture account is not the active one",
      ),
    );
  }
  return checks;
}

export function evaluateAccountSwitchScenario(input: {
  probe: AccountSwitchProbe;
  phases: readonly AccountSwitchPhaseEvidence[];
  escapedInteractions: readonly AgentInteractionKind[];
}): { checks: CoordinatorLiveCheck[]; observed: Record<string, number> } {
  const escaped = escapedInteractionFailures(input.escapedInteractions);
  const checks: CoordinatorLiveCheck[] = [];
  for (const phase of ACCOUNT_SWITCH_PHASES) {
    const evidence = input.phases.find((item) => item.phase === phase);
    if (evidence) checks.push(...evaluateAccountSwitchPhase(input.probe, evidence));
    else checks.push({ name: `${phase}:ran`, passed: false, detail: "the phase did not run" });
  }
  checks.push({
    name: "no-escaped-interactions",
    passed: escaped.length === 0,
    ...(escaped.length > 0 ? { detail: escaped.join("; ") } : {}),
  });
  return {
    checks,
    observed: {
      phases: input.phases.length,
      switchRequests: input.phases.reduce(
        (sum, phase) => sum + switchRequestsFor(phase.requests, input.probe).length,
        0,
      ),
    },
  };
}
