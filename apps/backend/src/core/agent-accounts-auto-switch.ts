/**
 * Automatic account switching: keeps a machine on the included account with room
 * whose general weekly limit resets soonest, leaving an account while its 5-hour
 * limit is out and coming back when that resets, and decides what a turn one of
 * those limits stopped does next. It runs in the backend, so it needs no client and no coordinator.
 * See docs/architecture/agent-accounts.md ("Automatic switching").
 *
 * The rule itself is in `@orkestrator/protocol/agent-account-auto-switch`. This
 * class owns the reads, the switch and the waits. Nothing here sees a credential:
 * every switch only records which existing login is active.
 */
import {
  MAX_USAGE_LIMIT_RESENDS,
  confirmedLimitResetsAt,
  decideAutoSwitch,
  explainNoRoom,
  limitConfirmedUsedUp,
  nextFiveHourRefresh,
  rankAutoSwitchAccounts,
  usageLimitReading,
  type AgentAccountAutoSwitchLastKept,
  type AgentAccountAutoSwitchSettings,
  type AutoSwitchAccount,
  type AutoSwitchReason,
  type UsageLimitReading,
  type UsageLimitStopVerdict,
} from "@orkestrator/protocol/agent-account-auto-switch";
import {
  AGENT_ACCOUNT_PLATFORMS,
  isAgentAccountPlatform,
  type AgentAccountPlatform,
  type AgentAccountSummary,
  type AgentAccountsSnapshot,
  type AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";
import { usageLimitFailure, type TurnFailureKind } from "@orkestrator/protocol/agent-usage-limits";
import type { CoordinatorAccountKeptReason } from "@orkestrator/protocol/coordinator-notices";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("agent-accounts");

/**
 * The backstop for work no turn-end edge reports, such as an unattended stage. A
 * 5-hour limit can go from room to refusal in minutes, so this has to be short
 * enough to catch it between the threshold and the refusal.
 */
export const AUTO_SWITCH_EVALUATE_INTERVAL_MS = 5 * 60_000;
/** Look just after an account's 5-hour limit resets, once the provider has caught up. */
const FIVE_HOUR_WAKE_GRACE_MS = 15_000;
/** A 5-hour limit resets within this; a reading saying otherwise only costs a check. */
const FIVE_HOUR_WAKE_MAX_MS = 6 * 60 * 60_000;
/** Turn-end edges come in bursts; each evaluation reads every included account's usage. */
const AUTO_SWITCH_EDGE_SPACING_MS = 60_000;
/** A stop waits this long for a reading while the usage endpoint will not answer. */
export const USAGE_LIMIT_READ_WAIT_MS = 10 * 60_000;
/** A stop waits this long for the other turns keeping its bridge on the old account. */
export const USAGE_LIMIT_BRIDGE_WAIT_MS = 30 * 60_000;
/** A workflow polls every few seconds; a waiting stop is decided again at this pace. */
export const USAGE_LIMIT_RECHECK_MS = 15_000;
/** One account running out stops several turns; they share one confirmation. */
const CONFIRMATION_REUSE_MS = 2 * 60_000;
/**
 * A stop seen this soon after a move may belong to the account just left, when
 * its bridge has already been replaced and can no longer say so.
 */
const RECENT_MOVE_MS = 5 * 60_000;
const MAX_TRACKED_STOPS = 256;
/**
 * After asking for an account's sign-in to be renewed, wait this long before
 * asking again; each failure in a row doubles it, up to the cap. One renewal
 * lets the next usage read establish current headroom. Regular checks share
 * this backoff even when later usage is stale again.
 */
export const LOGIN_RENEWAL_RETRY_MS = 30 * 60_000;
export const LOGIN_RENEWAL_MAX_RETRY_MS = 6 * 60 * 60_000;
/**
 * A limit stop renews an idle account's sign-in whatever the backoff says, so the
 * choice of where to go rests on fresh readings. Several turns stop together, so
 * one account is still renewed at most this often.
 */
export const URGENT_LOGIN_RENEWAL_SPACING_MS = 2 * 60_000;

export interface AutoSwitchNotice {
  platform: AgentAccountPlatform;
  from: string;
  to: string;
  reason: AutoSwitchReason;
  at: string;
  /** The coordinator this move was made for, whose own notice already says so. */
  quietProjectId?: string;
}

/** A session stopped on a usage limit, as `CoordinatorUsageLimitNotices` hears of it. */
export interface UsageLimitStopReport {
  platform: string;
  environmentId: string;
  requestId: string;
  verdict: UsageLimitStopVerdict;
  /** The login the turn ran on; absent for one this machine's accounts do not cover. */
  account?: AgentAccountSummary;
  resetsAt?: number;
  resetHint?: string;
  session?: UsageLimitStopSession;
}

/** What the caller knows about the stopped session. */
export interface UsageLimitStopSession {
  tabId?: string;
  /** A workflow's own name for the session, such as "Build Session". */
  label?: string;
}

export type LimitedAccountMove =
  { moved: true; to: string } | { moved: false; reason: CoordinatorAccountKeptReason };

/** Backend-only fence for decisions that outlive a manual selection or settings change. */
export type AutoSwitchSnapshot = AgentAccountsSnapshot & { selectionRevision?: number };

export interface AgentAccountAutoSwitcherDeps {
  settings(): Promise<AgentAccountAutoSwitchSettings>;
  snapshot(): Promise<AutoSwitchSnapshot>;
  readUsage(
    platform: AgentAccountPlatform,
    accountId: string,
    options: { force: boolean },
  ): Promise<PlanUsageSnapshot>;
  /**
   * Have the provider's own CLI renew one account's lapsed sign-in, so its usage
   * can be read. True when the account holds a live token afterwards. Without it
   * an idle account keeps its last reading.
   */
  renewLogin?(platform: AgentAccountPlatform, accountId: string): Promise<boolean>;
  /** Gives way, answering false, when a manual switch got in first. */
  switchAccount(
    platform: AgentAccountPlatform,
    accountId: string,
    automatic: { expectedActive: string; reason: AutoSwitchReason; expectedIdentity?: string },
  ): Promise<boolean>;
  sessionAccount(
    environmentId: string,
    platform: AgentAccountPlatform,
  ): Promise<AgentSessionAccount | null>;
  /** Whether other turns are keeping this environment's bridge from being replaced. */
  bridgeBusy(environmentId: string, platform: AgentAccountPlatform): Promise<boolean>;
  notify(notice: AutoSwitchNotice): Promise<void> | void;
  /** A limit stopped work and no account had room: record why, for Settings to show. */
  noteKept?(
    platform: AgentAccountPlatform,
    kept: AgentAccountAutoSwitchLastKept,
    expected: AutoSwitchSnapshot,
  ): Promise<void> | void;
  /** Called once per stopped turn, whatever happens to it next. */
  onLimitStop?(report: UsageLimitStopReport): Promise<void> | void;
  now?(): number;
}

export interface UsageLimitStopInput {
  platform: AgentAccountPlatform;
  environmentId: string;
  /** The stopped turn. Its waits are bounded under this key. */
  requestId: string;
  /** The turn's error text. It says a limit was hit, never which. */
  error: string | undefined;
  /**
   * `usage-limit` when the bridge reported the provider's own signal; the error
   * text is the fallback (`usageLimitFailure`). Like the text, it never says which limit.
   */
  failureKind?: TurnFailureKind;
  /** How many times this work has already been resent. */
  resends: number;
  /** When the turn is known to have been running by. Absent says nothing about its account. */
  turnStartedAt?: string;
  /** Whether a sibling turn this machine's bridge view cannot see is still running on the bridge. */
  siblingTurnRunning?: () => boolean;
  session?: UsageLimitStopSession;
}

function label(snapshot: AgentAccountsSnapshot, platform: string, id: string): string {
  const account = snapshot.accounts.find((entry) => entry.platform === platform && entry.id === id);
  return account?.label ?? id;
}

/** Cached usage must be recent enough to describe the current short quota window. */
export const AUTO_SWITCH_MAX_READING_AGE_MS = 5 * 60_000;

function boundedUsageReading(
  platform: AgentAccountPlatform,
  snapshot: PlanUsageSnapshot,
  now: number,
): UsageLimitReading {
  const age = now - Date.parse(snapshot.fetchedAt);
  return usageLimitReading(
    platform,
    !Number.isFinite(age) || age < 0 || age > AUTO_SWITCH_MAX_READING_AGE_MS
      ? { ...snapshot, stale: true }
      : snapshot,
    now,
  );
}

export class AgentAccountAutoSwitcher {
  /** One decision at a time per provider: a switch moves what the next one reads. */
  private readonly queues = new Map<AgentAccountPlatform, Promise<unknown>>();
  private readonly lastEvaluated = new Map<AgentAccountPlatform, number>();
  /** Accounts a fresh reading proved used up, keyed `<platform>:<id>`. */
  private readonly confirmed = new Map<
    string,
    { until: number; reset: number; resetsAt?: number; identity: string }
  >();
  /** The last move, per provider. */
  private readonly recentMoves = new Map<
    AgentAccountPlatform,
    { from: string; to: string; at: number }
  >();
  /** When each stopped turn first had to wait. */
  private readonly waitingSince = new Map<
    string,
    { since: number; checkedAt: number; bridgeSince?: number; confirmedUntil?: number }
  >();
  /** Stopped turns already reported, so a turn that waits is reported once. */
  private readonly reportedStops = new Set<string>();
  /** When a probe last read each account freshly, keyed `<platform>:<id>`. */
  private readonly probed = new Map<string, number>();
  /** When each account's sign-in was last asked for, may next be, and the failures in a row. */
  private readonly renewals = new Map<string, { at: number; next: number; failures: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Per provider, the check due when an account's 5-hour limit resets. */
  private readonly fiveHourWakes = new Map<AgentAccountPlatform, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly deps: AgentAccountAutoSwitcherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private serialized<T>(platform: AgentAccountPlatform, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(platform) ?? Promise.resolve()).then(run, run);
    this.queues.set(
      platform,
      next.catch(() => undefined),
    );
    return next;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      for (const platform of AGENT_ACCOUNT_PLATFORMS) this.nudge(platform);
    }, AUTO_SWITCH_EVALUATE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const wake of this.fiveHourWakes.values()) clearTimeout(wake);
    this.fiveHourWakes.clear();
  }

  /** Whether automatic switching is on here, for callers that would otherwise read a provider. */
  async automatic(platform: AgentAccountPlatform): Promise<boolean> {
    return (await this.deps.settings())[platform]?.enabled === true;
  }

  /** The ticks changed, or the machine's accounts did: look now. */
  nudge(platform: AgentAccountPlatform): void {
    void this.evaluate(platform).catch(() => {
      log.warn("auto-switch.check-failed", { platform });
    });
  }

  /** A turn ended on this machine, which is when the limits have moved. */
  noteTurnEnded(platform: AgentAccountPlatform): void {
    const last = this.lastEvaluated.get(platform);
    if (last !== undefined && this.now() - last < AUTO_SWITCH_EDGE_SPACING_MS) return;
    this.lastEvaluated.set(platform, this.now());
    this.nudge(platform);
  }

  /**
   * The between-turns rule: on the best account, or moved to it. A turn already
   * running finishes where it is, because a switch never touches a live bridge.
   */
  async evaluate(platform: AgentAccountPlatform): Promise<void> {
    if (this.stopped) return;
    await this.serialized(platform, async () => {
      const state = await this.automaticState(platform);
      if (!state) return;
      const accounts = await this.readings(platform, state, new Set(), "cached");
      const decision = decideAutoSwitch(accounts, state.activeId);
      const moved =
        decision.action === "switch" &&
        (await this.moveTo(platform, state.snapshot, state.activeId, {
          accountId: decision.accountId,
          reason: decision.reason,
        }));
      this.armFiveHourWake(platform, accounts, moved ? decision.accountId : state.activeId);
    });
  }

  /**
   * The timer would notice an account's 5-hour limit resetting within minutes; this
   * looks as it happens, so the machine is back on the soonest weekly reset straight
   * away. Only one is due per provider, and each check replaces it.
   */
  private armFiveHourWake(
    platform: AgentAccountPlatform,
    accounts: readonly AutoSwitchAccount[],
    activeId: string,
  ): void {
    const previous = this.fiveHourWakes.get(platform);
    if (previous) clearTimeout(previous);
    this.fiveHourWakes.delete(platform);
    if (!this.timer) return;
    const refresh = nextFiveHourRefresh(accounts, activeId);
    if (refresh === undefined) return;
    const wake = setTimeout(
      () => {
        this.fiveHourWakes.delete(platform);
        this.nudge(platform);
      },
      Math.min(Math.max(0, refresh - this.now()) + FIVE_HOUR_WAKE_GRACE_MS, FIVE_HOUR_WAKE_MAX_MS),
    );
    wake.unref?.();
    this.fiveHourWakes.set(platform, wake);
  }

  /**
   * What a turn a limit error ended does next.
   *
   * The error text cannot say which limit it was, so nothing moves on the text
   * alone. A fresh reading of the account the turn ran on has to show the general
   * weekly limit used up or the 5-hour limit at the threshold. A Fable or other
   * model-specific limit reads below that and the turn stays stopped, as does one
   * with nowhere to go.
   */
  async handleLimitStop(input: UsageLimitStopInput): Promise<UsageLimitStopVerdict> {
    const limit = usageLimitFailure(input);
    if (!limit) return "stop";
    // Read before deciding, because a move changes what the session reads next.
    const account = this.reportedStops.has(input.requestId)
      ? undefined
      : await this.stoppedOnAccount(input).catch(() => undefined);
    const verdict =
      input.resends >= MAX_USAGE_LIMIT_RESENDS
        ? ("stop" as const)
        : await this.serialized(input.platform, () => this.decideStop(input));
    if (verdict !== "wait") this.waitingSince.delete(input.requestId);
    await this.reportStop(input, verdict, account, limit.resetHint);
    return verdict;
  }

  /**
   * A turn a limit stopped that nothing here will resend: a coordinator's own,
   * one on a provider without accounts, or one on a machine not switching. It
   * still happened, so whoever should hear about it does.
   */
  async noteUnresentStop(input: {
    platform: string;
    environmentId: string;
    requestId: string;
    error: string | undefined;
    failureKind?: TurnFailureKind;
    turnStartedAt?: string;
    session?: UsageLimitStopSession;
  }): Promise<void> {
    const limit = usageLimitFailure(input);
    if (!limit) return;
    const account =
      !this.reportedStops.has(input.requestId) && isAgentAccountPlatform(input.platform)
        ? await this.stoppedOnAccount({ ...input, platform: input.platform }).catch(() => undefined)
        : undefined;
    await this.reportStop(input, "stop", account, limit.resetHint);
  }

  /** The login a stopped turn ran on, allowing for a move a sibling's stop already made. */
  private async stoppedOnAccount(
    input: Pick<UsageLimitStopInput, "platform" | "environmentId" | "turnStartedAt">,
  ): Promise<AgentAccountSummary | undefined> {
    const session = await this.deps.sessionAccount(input.environmentId, input.platform);
    if (session?.source !== "account" || !session.account) return undefined;
    const move = this.recentMoves.get(input.platform);
    if (
      move?.to !== session.account.id ||
      this.now() - move.at >= RECENT_MOVE_MS ||
      !(Date.parse(input.turnStartedAt ?? "") < move.at)
    ) {
      return session.account;
    }
    const snapshot = await this.deps.snapshot();
    return (
      snapshot.accounts.find(
        (entry) => entry.platform === input.platform && entry.id === move.from,
      ) ?? session.account
    );
  }

  private async reportStop(
    input: {
      platform: string;
      environmentId: string;
      requestId: string;
      session?: UsageLimitStopSession;
    },
    verdict: UsageLimitStopVerdict,
    account: AgentAccountSummary | undefined,
    resetHint: string | undefined,
  ): Promise<void> {
    if (this.reportedStops.has(input.requestId)) return;
    if (this.reportedStops.size >= MAX_TRACKED_STOPS) {
      const oldest = this.reportedStops.values().next().value;
      if (oldest !== undefined) this.reportedStops.delete(oldest);
    }
    this.reportedStops.add(input.requestId);
    const proof = account ? this.confirmed.get(`${input.platform}:${account.id}`) : undefined;
    const resetsAt =
      proof &&
      proof.identity === JSON.stringify(account?.identity) &&
      proof.resetsAt !== undefined &&
      proof.resetsAt > this.now()
        ? proof.resetsAt
        : undefined;
    try {
      await this.deps.onLimitStop?.({
        platform: input.platform,
        environmentId: input.environmentId,
        requestId: input.requestId,
        verdict,
        ...(account ? { account } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(resetHint ? { resetHint } : {}),
        ...(input.session ? { session: input.session } : {}),
      });
    } catch {
      this.reportedStops.delete(input.requestId);
      // What the turn does next never depends on who could be told.
      log.warn("limit-stop-notice.failed", { platform: input.platform });
    }
  }

  /**
   * Move this machine off a limited account so a coordinator can run, through
   * the same path as every automatic switch: it never pins, and it gives way to
   * a pin, to automatic switching being off, and to having nowhere to go.
   * `isLimited` matches by identity, so every entry of one login counts as limited.
   */
  moveOffLimitedAccount(
    platform: AgentAccountPlatform,
    isLimited: (account: AgentAccountSummary) => boolean,
    options: { quietProjectId?: string } = {},
  ): Promise<LimitedAccountMove> {
    return this.serialized(platform, async (): Promise<LimitedAccountMove> => {
      const settings = await this.deps.settings();
      if (settings[platform]?.enabled !== true) return { moved: false, reason: "auto-switch-off" };
      const snapshot = await this.deps.snapshot();
      const mode = snapshot.autoSwitch?.[platform]?.mode;
      if (mode === "pinned") return { moved: false, reason: "account-pinned" };
      if (mode !== "automatic") return { moved: false, reason: "auto-switch-off" };
      const activeId = snapshot.active[platform];
      const limited = new Set(
        snapshot.accounts
          .filter((account) => account.platform === platform && isLimited(account))
          .map((account) => account.id),
      );
      const accounts = await this.readings(platform, { snapshot, activeId }, limited, "probe");
      const best = rankAutoSwitchAccounts(accounts, activeId, "after-refusal")[0];
      if (!best) {
        const from = limited.has(activeId) ? activeId : (limited.values().next().value ?? activeId);
        await this.noteKept(platform, from, accounts, snapshot, limited);
        return { moved: false, reason: "no-account-with-headroom" };
      }
      const to = label(snapshot, platform, best.account.id);
      if (best.account.id === activeId) return { moved: true, to };
      const moved = await this.moveTo(platform, snapshot, activeId, {
        accountId: best.account.id,
        reason: "limit",
        ...(options.quietProjectId ? { quietProjectId: options.quietProjectId } : {}),
      });
      return moved ? { moved: true, to } : { moved: false, reason: "switch-refused" };
    });
  }

  private async decideStop(input: UsageLimitStopInput): Promise<UsageLimitStopVerdict> {
    const { platform, environmentId, requestId } = input;
    const waiting = this.waitingSince.get(requestId);
    if (waiting && this.now() - waiting.checkedAt < USAGE_LIMIT_RECHECK_MS) return "wait";
    const state = await this.automaticState(platform);
    if (!state) return "stop";
    if (waiting?.confirmedUntil !== undefined) {
      if (this.now() >= waiting.confirmedUntil) return "stop";
      return this.resendOnceBridgeIsFree(input);
    }
    const session = await this.deps.sessionAccount(environmentId, platform);
    // An isolated container keeps its own login; this machine's accounts say nothing about it.
    if (session?.source !== "account" || !session.account) return "stop";
    const ranOn = session.account.id;
    const confirmation = await this.confirmUsedUp(platform, ranOn);
    if (confirmation === "unreadable") {
      return this.waitFor(requestId, USAGE_LIMIT_READ_WAIT_MS);
    }
    if (confirmation === "room") {
      // The session now reads the account just moved to, which has room. Only a
      // turn already running before the move can have run on the account left,
      // and only that account's own fresh reading can say which limit stopped it.
      // A turn sent after the move ran here, so its limit is some other one, and a
      // resend is always sent after a move.
      const move = this.recentMoves.get(platform);
      if (
        move?.to !== ranOn ||
        this.now() - move.at >= RECENT_MOVE_MS ||
        state.activeId !== ranOn ||
        input.resends > 0 ||
        !(Date.parse(input.turnStartedAt ?? "") < move.at)
      ) {
        return "stop";
      }
      const left = await this.confirmUsedUp(platform, move.from);
      if (left === "unreadable") return this.waitFor(requestId, USAGE_LIMIT_READ_WAIT_MS);
      return left === "used-up"
        ? this.resendOnceBridgeIsFree(input, `${platform}:${move.from}`)
        : "stop";
    }

    const stopped = new Set([ranOn]);
    const accounts = await this.readings(platform, state, stopped, "probe");
    const best = rankAutoSwitchAccounts(accounts, state.activeId, "after-refusal")[0];
    if (!best) {
      await this.noteKept(platform, ranOn, accounts, state.snapshot, stopped);
      return "stop";
    }
    if (best.account.id !== state.activeId) {
      const moved = await this.moveTo(platform, state.snapshot, state.activeId, {
        accountId: best.account.id,
        reason: "limit",
      });
      if (!moved) return "stop";
    }
    return this.resendOnceBridgeIsFree(input, `${platform}:${ranOn}`);
  }

  private async resendOnceBridgeIsFree(
    input: UsageLimitStopInput,
    proofKey?: string,
  ): Promise<UsageLimitStopVerdict> {
    const held =
      input.siblingTurnRunning?.() === true ||
      (await this.deps.bridgeBusy(input.environmentId, input.platform));
    if (!held) return "resend";
    this.waitFor(input.requestId, USAGE_LIMIT_BRIDGE_WAIT_MS);
    const waiting = this.waitingSince.get(input.requestId)!;
    waiting.bridgeSince ??= this.now();
    // Attribution and limit proof belong to the stopped request, not the
    // replacement bridge. A reset restores quota but does not continue the
    // stopped turn. Keep its attribution for this bridge wait only.
    if (proofKey && this.confirmed.has(proofKey)) {
      waiting.confirmedUntil ??= waiting.bridgeSince + USAGE_LIMIT_BRIDGE_WAIT_MS;
    }
    return this.now() - waiting.bridgeSince < USAGE_LIMIT_BRIDGE_WAIT_MS ? "wait" : "stop";
  }

  /** Record why the machine stayed. What the turn does next never depends on it. */
  private async noteKept(
    platform: AgentAccountPlatform,
    fromAccountId: string,
    accounts: readonly AutoSwitchAccount[],
    expected: AutoSwitchSnapshot,
    stoppedIds: ReadonlySet<string>,
  ): Promise<void> {
    if (!this.deps.noteKept) return;
    try {
      await this.deps.noteKept(
        platform,
        {
          fromAccountId,
          at: new Date(this.now()).toISOString(),
          blocked: explainNoRoom(accounts, expected.active[platform], "after-refusal", stoppedIds),
        },
        expected,
      );
    } catch {
      log.warn("kept-note.failed", { platform });
    }
  }

  private waitFor(requestId: string, limitMs: number): UsageLimitStopVerdict {
    const now = this.now();
    let waiting = this.waitingSince.get(requestId);
    if (!waiting) {
      if (this.waitingSince.size >= MAX_TRACKED_STOPS) {
        const oldest = this.waitingSince.keys().next().value;
        if (oldest !== undefined) this.waitingSince.delete(oldest);
      }
      waiting = { since: now, checkedAt: now };
      this.waitingSince.set(requestId, waiting);
    }
    waiting.checkedAt = now;
    return now - waiting.since < limitMs ? "wait" : "stop";
  }

  private async confirmUsedUp(
    platform: AgentAccountPlatform,
    accountId: string,
  ): Promise<"used-up" | "room" | "unreadable"> {
    const key = `${platform}:${accountId}`;
    const account = (await this.deps.snapshot()).accounts.find(
      (entry) => entry.platform === platform && entry.id === accountId,
    );
    const identity = JSON.stringify(account?.identity);
    const proof = this.confirmed.get(key);
    if (proof && proof.identity === identity && this.now() < proof.until) {
      return "used-up";
    }
    let snapshot: PlanUsageSnapshot;
    try {
      snapshot = await this.deps.readUsage(platform, accountId, { force: true });
    } catch {
      return "unreadable";
    }
    const reading = boundedUsageReading(platform, snapshot, this.now());
    if (!limitConfirmedUsedUp(reading)) {
      if (reading.freshness !== "fresh") return "unreadable";
      this.confirmed.delete(key);
      return "room";
    }
    const resetsAt = confirmedLimitResetsAt(reading);
    if (this.confirmed.size >= MAX_TRACKED_STOPS) this.confirmed.clear();
    this.confirmed.set(key, {
      until: Math.min(this.now() + CONFIRMATION_REUSE_MS, resetsAt ?? Infinity),
      reset: resetsAt ?? this.now() + USAGE_LIMIT_BRIDGE_WAIT_MS,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      identity,
    });
    return "used-up";
  }

  private async moveTo(
    platform: AgentAccountPlatform,
    snapshot: AgentAccountsSnapshot,
    activeId: string,
    target: { accountId: string; reason: AutoSwitchReason; quietProjectId?: string },
  ): Promise<boolean> {
    // Usage reads/renewals await I/O: sign-out may have happened since ranking.
    const latest = await this.deps.snapshot();
    const candidate = latest.accounts.find(
      (entry) => entry.platform === platform && entry.id === target.accountId,
    );
    if (!candidate?.signedIn) return false;
    const moved = await this.deps.switchAccount(platform, target.accountId, {
      expectedActive: activeId,
      expectedIdentity: JSON.stringify(
        snapshot.accounts.find(
          (entry) => entry.platform === platform && entry.id === target.accountId,
        )?.identity,
      ),
      reason: target.reason,
    });
    if (!moved) return false;
    this.recentMoves.set(platform, { from: activeId, to: target.accountId, at: this.now() });
    try {
      await this.deps.notify({
        platform,
        from: label(snapshot, platform, activeId),
        to: label(snapshot, platform, target.accountId),
        reason: target.reason,
        at: new Date(this.now()).toISOString(),
        ...(target.quietProjectId ? { quietProjectId: target.quietProjectId } : {}),
      });
    } catch {
      // The switch stands. `lastSwitch` still records it for anyone who looks.
      log.warn("switch-notice.failed", { audience: "platform", platform });
    }
    return true;
  }

  /** The machine's accounts and active id, or nothing while it is off or pinned. */
  private async automaticState(platform: AgentAccountPlatform) {
    const settings = await this.deps.settings();
    if (settings[platform]?.enabled !== true) return undefined;
    const snapshot = await this.deps.snapshot();
    if (snapshot.autoSwitch?.[platform]?.mode !== "automatic") return undefined;
    return { snapshot, activeId: snapshot.active[platform] };
  }

  /**
   * Renew one account's sign-in, at most once per backoff window. An urgent
   * renewal, for a limit stop, waits only out the short spacing.
   */
  private async renewLogin(
    platform: AgentAccountPlatform,
    accountId: string,
    urgent = false,
  ): Promise<boolean> {
    const renew = this.deps.renewLogin;
    if (!renew) return false;
    const key = `${platform}:${accountId}`;
    const previous = this.renewals.get(key);
    const due = urgent
      ? (previous?.at ?? -Infinity) + URGENT_LOGIN_RENEWAL_SPACING_MS
      : previous?.next;
    if (due !== undefined && this.now() < due) return false;
    const at = this.now();
    let renewed = false;
    try {
      renewed = await renew(platform, accountId);
    } catch {
      log.warn("login-renewal.failed", { platform });
    }
    const failures = renewed ? 0 : (previous?.failures ?? 0) + 1;
    const wait = Math.min(
      LOGIN_RENEWAL_RETRY_MS * 2 ** Math.max(0, failures - 1),
      LOGIN_RENEWAL_MAX_RETRY_MS,
    );
    if (!this.renewals.has(key) && this.renewals.size >= MAX_TRACKED_STOPS) this.renewals.clear();
    this.renewals.set(key, { at, next: this.now() + wait, failures });
    return renewed;
  }

  /**
   * Every account's reading. `cached` serves a recent reading and renews an
   * account whose reading is stale or unknown. `probe` is for a limit stop, where the
   * choice should rest on how things are now: it reads every account afresh and
   * renews the sign-in of each login no entry could read freshly. Every fresh read
   * is saved as that account's last known usage, which Settings shows too.
   */
  private async readings(
    platform: AgentAccountPlatform,
    state: NonNullable<Awaited<ReturnType<AgentAccountAutoSwitcher["automaticState"]>>>,
    confirmedOut: ReadonlySet<string>,
    mode: "cached" | "probe",
  ): Promise<AutoSwitchAccount[]> {
    const includedIds = state.snapshot.autoSwitch?.[platform]?.includedAccountIds ?? [];
    // Several turns stop together: one probe's fresh readings serve the rest.
    const probedRecently = (accountId: string) =>
      this.now() - (this.probed.get(`${platform}:${accountId}`) ?? -Infinity) <
      CONFIRMATION_REUSE_MS;
    const read = async (accountId: string, forced: boolean): Promise<UsageLimitReading> => {
      const reading = await this.deps.readUsage(platform, accountId, { force: forced }).then(
        (snapshot) => boundedUsageReading(platform, snapshot, this.now()),
        (): UsageLimitReading => ({ freshness: "none", wouldPay: false }),
      );
      if (forced && reading.freshness === "fresh") {
        if (this.probed.size >= MAX_TRACKED_STOPS) this.probed.clear();
        this.probed.set(`${platform}:${accountId}`, this.now());
      }
      return reading;
    };
    return Promise.all(
      state.snapshot.accounts
        .filter((account) => account.platform === platform)
        .map(async (account) => {
          const included = includedIds.includes(account.id);
          let reading: UsageLimitReading = { freshness: "none", wouldPay: false };
          if (confirmedOut.has(account.id)) {
            reading = { freshness: "fresh", usedPercent: 100, wouldPay: false };
          } else if (account.signedIn && (included || account.id === state.activeId)) {
            reading = await read(account.id, mode === "probe" && !probedRecently(account.id));
            // A stale reading cannot establish headroom, even with a future reset.
            // Renew before a forced read; failed renewals retain the conservative
            // old limit blockers, ranked after every fresh account.
            if (
              mode === "cached" &&
              reading.freshness !== "fresh" &&
              (await this.renewLogin(platform, account.id))
            ) {
              reading = await read(account.id, true);
            }
          }
          return { account, included, reading };
        }),
    ).then((entries) => (mode === "probe" ? this.renewUnread(platform, entries, read) : entries));
  }

  /**
   * For each login no entry could read freshly, an urgent renewal and a forced
   * read, entry by entry until one succeeds. Twins share one allowance, so one
   * fresh reading is enough.
   */
  private async renewUnread(
    platform: AgentAccountPlatform,
    entries: AutoSwitchAccount[],
    read: (accountId: string, forced: boolean) => Promise<UsageLimitReading>,
  ): Promise<AutoSwitchAccount[]> {
    const loginOf = (entry: AutoSwitchAccount) =>
      entry.account.identity?.email?.trim().toLowerCase() || `id:${entry.account.id}`;
    const freshLogins = new Set(
      entries.filter(({ reading }) => reading.freshness === "fresh").map(loginOf),
    );
    const unread = new Map<string, AutoSwitchAccount[]>();
    for (const entry of entries) {
      const key = loginOf(entry);
      if (!entry.included || !entry.account.signedIn || freshLogins.has(key)) continue;
      unread.set(key, [...(unread.get(key) ?? []), entry]);
    }
    const renewed = new Map<AutoSwitchAccount, UsageLimitReading>();
    await Promise.all(
      Array.from(unread.values(), async (twins) => {
        for (const entry of twins) {
          if (!(await this.renewLogin(platform, entry.account.id, true))) continue;
          const reading = await read(entry.account.id, true);
          renewed.set(entry, reading);
          if (reading.freshness === "fresh") return;
        }
      }),
    );
    return entries.map((entry) => {
      const reading = renewed.get(entry);
      return reading ? { ...entry, reading } : entry;
    });
  }
}
