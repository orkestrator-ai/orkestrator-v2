import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_HOLD_CEILING_MS,
  type AgentInteractionHold,
  type AgentInteractionHoldReason,
} from "./agent-interactions.js";

/** The clock and timer a deadline runs on; injectable so tests control time. */
export interface InteractionDeadlineClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: InteractionDeadlineClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface InteractionDeadlineOptions {
  /** Declines, denies or cancels the request; called at most once. */
  onExpire: () => void;
  /** When the request was raised. Defaults to now. */
  requestedAt?: number;
  /** The countdown a request starts with, and the one a resume restarts. */
  windowMs?: number;
  /** First deadline, when a provider publishes one shorter than the window. */
  expiresAt?: number;
  /**
   * The latest moment the provider itself will still wait, when it publishes
   * one. Read at every pause and resume, so a limit that moves (a turn
   * deadline) is honoured as it stands then. A pause never holds past it.
   */
  providerLimitAt?: () => number | undefined;
  /** Someone behind the provider keeps a deadline nobody publishes. */
  upstreamMayExpire?: boolean;
  /** Unref the timer, so a parked request cannot by itself keep a process alive. */
  unref?: boolean;
  clock?: InteractionDeadlineClock;
}

/**
 * `applied` changed the state; `unchanged` already was in it; `unavailable`
 * is a pause the provider's own limit leaves no room for; `settled` means the
 * request is no longer waiting.
 */
export type InteractionDeadlineHoldResult = "applied" | "unchanged" | "unavailable" | "settled";

/**
 * The server-side deadline of one blocking request, which a user may pause.
 *
 * Every bridge used to arm a bare `setTimeout`; this is the same timer with a
 * pause in it. Pausing stops the countdown and re-arms the timer at the hold
 * ceiling — never at "no deadline", so an approval that nobody comes back to
 * is still denied in the end and older backends, which require a deadline,
 * keep the card. Resuming restarts a fresh window rather than the remainder:
 * a pause at 0:03 would otherwise resume into three seconds.
 */
export class InteractionDeadline {
  readonly requestedAt: number;
  private readonly clock: InteractionDeadlineClock;
  private readonly windowMs: number;
  private readonly onExpire: () => void;
  private readonly providerLimitAt: () => number | undefined;
  private readonly upstreamMayExpire: boolean;
  private readonly unref: boolean;
  private deadline: number;
  private pausedAt: number | undefined;
  private pausedReason: AgentInteractionHoldReason | undefined;
  private timer: unknown;
  private done = false;

  constructor(options: InteractionDeadlineOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.requestedAt = options.requestedAt ?? this.clock.now();
    this.windowMs = options.windowMs ?? AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
    this.onExpire = options.onExpire;
    this.providerLimitAt = options.providerLimitAt ?? (() => undefined);
    this.upstreamMayExpire = options.upstreamMayExpire === true;
    this.unref = options.unref === true;
    this.deadline = options.expiresAt ?? this.requestedAt + this.windowMs;
    this.arm();
  }

  /** When the request is declined unless answered; the hold ceiling while paused. */
  get expiresAt(): number {
    return this.deadline;
  }

  get heldAt(): number | undefined {
    return this.pausedAt;
  }

  get settled(): boolean {
    return this.done;
  }

  /** What the authority publishes beside `expiresAt`. */
  hold(): AgentInteractionHold {
    if (this.pausedAt !== undefined) {
      return {
        available: true,
        heldAt: this.pausedAt,
        ...(this.pausedReason ? { reason: this.pausedReason } : {}),
      };
    }
    const limit = this.limit();
    if (limit !== undefined && limit <= this.deadline) {
      return { available: false, reason: "no-extension" };
    }
    const reason = this.limitReason(this.clock.now(), limit);
    return { available: true, ...(reason ? { reason } : {}) };
  }

  /** Pause (`true`) or resume (`false`) the countdown. */
  setHeld(held: boolean): InteractionDeadlineHoldResult {
    if (this.done) return "settled";
    if (held === (this.pausedAt !== undefined)) return "unchanged";
    const now = this.clock.now();
    const limit = this.limit();
    if (held) {
      const ceiling = Math.min(now + AGENT_INTERACTION_HOLD_CEILING_MS, limit ?? Infinity);
      if (ceiling <= this.deadline) return "unavailable";
      this.pausedAt = now;
      this.pausedReason = this.limitReason(now, limit);
      this.deadline = ceiling;
    } else {
      this.pausedAt = undefined;
      this.pausedReason = undefined;
      this.deadline = Math.min(now + this.windowMs, limit ?? Infinity);
    }
    this.arm();
    return "applied";
  }

  /** The request was answered or withdrawn; the timer must never fire. */
  settle(): void {
    this.done = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private limit(): number | undefined {
    const limit = this.providerLimitAt();
    return limit !== undefined && Number.isFinite(limit) ? limit : undefined;
  }

  private limitReason(
    now: number,
    limit: number | undefined,
  ): AgentInteractionHoldReason | undefined {
    if (limit !== undefined && limit < now + AGENT_INTERACTION_HOLD_CEILING_MS) {
      return "provider-limit";
    }
    return this.upstreamMayExpire ? "upstream-may-expire" : undefined;
  }

  private arm(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    // The ceiling is a day, well inside a timer's 2^31-1 ms range.
    const timer = this.clock.setTimeout(
      () => {
        if (this.done) return;
        this.done = true;
        this.timer = undefined;
        this.onExpire();
      },
      Math.max(0, this.deadline - this.clock.now()),
    );
    if (this.unref) (timer as { unref?: () => void } | undefined)?.unref?.();
    this.timer = timer;
  }
}
