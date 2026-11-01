/**
 * Automatic account switching: keeps a machine on the included account whose
 * general weekly limit resets soonest, and decides what a turn the limit stopped
 * does next. It runs in the backend, so it needs no client and no coordinator.
 * See docs/architecture/agent-accounts.md ("Automatic switching").
 *
 * The rule itself is in `@orkestrator/protocol/agent-account-auto-switch`. This
 * class owns the reads, the switch and the waits. Nothing here sees a credential:
 * every switch only records which existing login is active.
 */
import {
  MAX_USAGE_LIMIT_RESENDS,
  decideAutoSwitch,
  rankAutoSwitchAccounts,
  weeklyLimitConfirmedUsedUp,
  weeklyLimitReading,
  type AgentAccountAutoSwitchSettings,
  type AutoSwitchAccount,
  type AutoSwitchReason,
  type UsageLimitStopVerdict,
  type WeeklyLimitReading,
} from "@orkestrator/protocol/agent-account-auto-switch";
import {
  AGENT_ACCOUNT_PLATFORMS,
  type AgentAccountPlatform,
  type AgentAccountsSnapshot,
  type AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";
import { classifyUsageLimitError } from "@orkestrator/protocol/agent-usage-limits";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

/** The backstop for work no turn-end edge reports, such as an unattended stage. */
export const AUTO_SWITCH_EVALUATE_INTERVAL_MS = 10 * 60_000;
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

export interface AutoSwitchNotice {
  platform: AgentAccountPlatform;
  from: string;
  to: string;
  reason: AutoSwitchReason;
  at: string;
}

export interface AgentAccountAutoSwitcherDeps {
  settings(): Promise<AgentAccountAutoSwitchSettings>;
  snapshot(): Promise<AgentAccountsSnapshot>;
  readUsage(
    platform: AgentAccountPlatform,
    accountId: string,
    options: { force: boolean },
  ): Promise<PlanUsageSnapshot>;
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
  now?(): number;
}

export interface UsageLimitStopInput {
  platform: AgentAccountPlatform;
  environmentId: string;
  /** The stopped turn. Its waits are bounded under this key. */
  requestId: string;
  /** The turn's error text. It says a limit was hit, never which. */
  error: string | undefined;
  /** How many times this work has already been resent. */
  resends: number;
  /** When the turn is known to have been running by. Absent says nothing about its account. */
  turnStartedAt?: string;
  /** Whether a sibling turn this machine's bridge view cannot see is still running on the bridge. */
  siblingTurnRunning?: () => boolean;
}

function label(snapshot: AgentAccountsSnapshot, platform: string, id: string): string {
  const account = snapshot.accounts.find((entry) => entry.platform === platform && entry.id === id);
  return account?.label ?? id;
}

export class AgentAccountAutoSwitcher {
  /** One decision at a time per provider: a switch moves what the next one reads. */
  private readonly queues = new Map<AgentAccountPlatform, Promise<unknown>>();
  private readonly lastEvaluated = new Map<AgentAccountPlatform, number>();
  /** Accounts a fresh reading proved used up, keyed `<platform>:<id>`. */
  private readonly confirmed = new Map<
    string,
    { until: number; reset: number; identity: string }
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
  private timer: ReturnType<typeof setInterval> | undefined;
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
  }

  /** Whether automatic switching is on here, for callers that would otherwise read a provider. */
  async automatic(platform: AgentAccountPlatform): Promise<boolean> {
    return (await this.deps.settings())[platform]?.enabled === true;
  }

  /** The ticks changed, or the machine's accounts did: look now. */
  nudge(platform: AgentAccountPlatform): void {
    void this.evaluate(platform).catch(() => {
      console.warn(`[agent-accounts] Automatic ${platform} account check failed`);
    });
  }

  /** A turn ended on this machine, which is when the weekly limit has moved. */
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
      const accounts = await this.readings(platform, state, new Set(), false);
      const decision = decideAutoSwitch(accounts, state.activeId);
      if (decision.action !== "switch") return;
      await this.moveTo(platform, state.snapshot, state.activeId, {
        accountId: decision.accountId,
        reason: decision.reason,
      });
    });
  }

  /**
   * What a turn a limit error ended does next.
   *
   * The error text cannot say which limit it was, so nothing moves on the text
   * alone. A fresh reading of the account the turn ran on has to show the general
   * weekly limit used up. A Fable, other model-specific or 5-hour limit reads
   * below that and the turn stays stopped, as does one with nowhere to go.
   */
  async handleLimitStop(input: UsageLimitStopInput): Promise<UsageLimitStopVerdict> {
    if (!classifyUsageLimitError(input.error) || input.resends >= MAX_USAGE_LIMIT_RESENDS) {
      return "stop";
    }
    const verdict = await this.serialized(input.platform, () => this.decideStop(input));
    if (verdict !== "wait") this.waitingSince.delete(input.requestId);
    return verdict;
  }

  private async decideStop(input: UsageLimitStopInput): Promise<UsageLimitStopVerdict> {
    const { platform, environmentId, requestId } = input;
    const waiting = this.waitingSince.get(requestId);
    if (waiting && this.now() - waiting.checkedAt < USAGE_LIMIT_RECHECK_MS) return "wait";
    const state = await this.automaticState(platform);
    if (!state) return "stop";
    if (waiting?.confirmedUntil !== undefined && this.now() < waiting.confirmedUntil) {
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

    const accounts = await this.readings(platform, state, new Set([ranOn]), false);
    const best = rankAutoSwitchAccounts(accounts, state.activeId)[0];
    if (!best) return "stop";
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
    // Attribution and weekly proof belong to the stopped request, not the
    // replacement bridge. Never reuse that proof beyond the weekly reset.
    waiting.confirmedUntil ??= proofKey ? this.confirmed.get(proofKey)?.reset : undefined;
    return this.now() - waiting.bridgeSince < USAGE_LIMIT_BRIDGE_WAIT_MS ? "wait" : "stop";
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
    const reading = weeklyLimitReading(platform, snapshot, this.now());
    if (reading.freshness !== "fresh") return "unreadable";
    if (!weeklyLimitConfirmedUsedUp(reading)) {
      this.confirmed.delete(key);
      return "room";
    }
    if (this.confirmed.size >= MAX_TRACKED_STOPS) this.confirmed.clear();
    this.confirmed.set(key, {
      until: Math.min(this.now() + CONFIRMATION_REUSE_MS, reading.resetsAt ?? Infinity),
      reset: reading.resetsAt ?? this.now() + USAGE_LIMIT_BRIDGE_WAIT_MS,
      identity,
    });
    return "used-up";
  }

  private async moveTo(
    platform: AgentAccountPlatform,
    snapshot: AgentAccountsSnapshot,
    activeId: string,
    target: { accountId: string; reason: AutoSwitchReason },
  ): Promise<boolean> {
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
      });
    } catch {
      // The switch stands. `lastSwitch` still records it for anyone who looks.
      console.warn(`[agent-accounts] Automatic ${platform} switch notice failed`);
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

  private async readings(
    platform: AgentAccountPlatform,
    state: NonNullable<Awaited<ReturnType<AgentAccountAutoSwitcher["automaticState"]>>>,
    confirmedOut: ReadonlySet<string>,
    force: boolean,
  ): Promise<AutoSwitchAccount[]> {
    const includedIds = state.snapshot.autoSwitch?.[platform]?.includedAccountIds ?? [];
    const now = this.now();
    return Promise.all(
      state.snapshot.accounts
        .filter((account) => account.platform === platform)
        .map(async (account) => {
          const included = includedIds.includes(account.id);
          let reading: WeeklyLimitReading = { freshness: "none", wouldPay: false };
          if (confirmedOut.has(account.id)) {
            reading = { freshness: "fresh", usedPercent: 100, wouldPay: false };
          } else if (account.signedIn && (included || account.id === state.activeId)) {
            reading = await this.deps.readUsage(platform, account.id, { force }).then(
              (snapshot) => weeklyLimitReading(platform, snapshot, now),
              () => reading,
            );
          }
          return { account, included, reading };
        }),
    );
  }
}
