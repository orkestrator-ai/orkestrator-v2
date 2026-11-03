import type { StateSignalCredential } from "./agent-tools.js";
import type { CommandContext } from "./commands-context.js";
import {
  emptySignalHealthStates,
  type SignalDemotionReason,
  type SignalHealthState,
  type SignalHealthStatus,
} from "./recurring-diagnostics.js";
import type { ClaudeStateSignalSupport } from "./tmux-poll.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("tmux");

/**
 * The claude-tmux hook doorbell (`tmux-hook-signal=1`).
 *
 * A container's tmux hook script writes a pending or timed-out hook file and
 * then runs `orkestrator-state-signal hook`, which POSTs to this backend with a
 * per-container credential. A ring carries nothing: it wakes every tmux poll
 * loop of that container, which then reads its own hook directories. While the
 * doorbell is confirmed (its install's probe ring arrived), an idle tab sleeps
 * between slow safety reads instead of listing its hook directories every tick.
 *
 * A ring can only end a sleep early. Each loop keeps its own minimum gap
 * between reads, so code in a container can never make the host run more
 * `docker exec`s than the per-tick poll the doorbell replaces.
 */
export const TMUX_HOOK_SIGNAL_CONFIG_PATH = "/tmp/.orkestrator-tmux-hook-signal";
/** Least gap between attempts to arm one container, as for the Claude state signal. */
export const TMUX_HOOK_SIGNAL_RETRY_MS = 300_000;

/** Puts the doorbell config into a container (`claude-state-signal.ts`). */
export interface TmuxHookSignalInstaller {
  support(containerId: string, context: CommandContext): Promise<ClaudeStateSignalSupport>;
  /** Resolves once the config is written and its probe ring has been sent. */
  install(
    containerId: string,
    credential: StateSignalCredential,
    context: CommandContext,
    isCurrent: () => boolean,
  ): Promise<void>;
}

export type TmuxHookSignalManagerOptions = {
  /** Without one every tab keeps the per-tick poll. */
  installer?: TmuxHookSignalInstaller | null;
  nowMs?: () => number;
};

/** One poll loop's view of its container's doorbell. */
export interface TmuxHookDoorbell {
  /** Rings accepted for this container since its doorbell was armed. */
  rings(): number;
  /** Whether rings can be trusted, so an idle loop may sleep between safety reads. */
  confirmed(): boolean;
  /**
   * A read found a hook file no ring announced: stop trusting the doorbell
   * until the next arming attempt.
   */
  missed(): void;
  /** The loop ended. The last release revokes the credential. */
  release(): void;
}

type ContainerDoorbell = {
  context: CommandContext;
  listeners: Set<() => void>;
  credential?: StateSignalCredential;
  arming?: Promise<void>;
  confirmed: boolean;
  unsupported: boolean;
  demoted: boolean;
  lastAttemptAt?: number;
  rings: number;
};

const NEVER_CONFIRMED: TmuxHookDoorbell = {
  rings: () => 0,
  confirmed: () => false,
  missed: () => undefined,
  release: () => undefined,
};

export class TmuxHookSignalManager {
  private readonly doorbells = new Map<string, ContainerDoorbell>();
  private readonly installations = new Map<string, Promise<void>>();
  private readonly installer: TmuxHookSignalInstaller | null;
  private readonly nowMs: () => number;
  private readonly demotions: Partial<Record<SignalDemotionReason, number>> = {};
  private acceptedRings = 0;
  private stopped = false;

  constructor(options: TmuxHookSignalManagerOptions = {}) {
    this.installer = options.installer ?? null;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * Joins `containerId`'s doorbell, arming it if this is the first loop or the
   * retry window has passed. `onRing` runs synchronously on every ring.
   */
  attach(containerId: string, context: CommandContext, onRing: () => void): TmuxHookDoorbell {
    if (this.stopped || !this.installer) return NEVER_CONFIRMED;
    const join = (): ContainerDoorbell => {
      let doorbell = this.doorbells.get(containerId);
      if (!doorbell) {
        doorbell = {
          context,
          listeners: new Set(),
          confirmed: false,
          unsupported: false,
          demoted: false,
          rings: 0,
        };
        this.doorbells.set(containerId, doorbell);
      }
      doorbell.context = context;
      doorbell.listeners.add(listener);
      return doorbell;
    };
    const listener = () => onRing();
    let entry = join();
    let released = false;
    let ringOffset = 0;
    this.arm(containerId, entry);
    const current = () => this.doorbells.get(containerId) === entry;
    return {
      rings: () => ringOffset + entry.rings,
      confirmed: () => {
        if (released || this.stopped) return false;
        if (!current()) {
          ringOffset += entry.rings;
          entry.listeners.delete(listener);
          entry = join();
        }
        if (!entry.confirmed) this.arm(containerId, entry);
        return entry.confirmed;
      },
      missed: () => {
        if (current() && entry.confirmed) this.demote(containerId, entry, "missed-change");
      },
      release: () => {
        released = true;
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && current()) this.forgetContainer(containerId);
      },
    };
  }

  /**
   * The container stopped or was replaced: revoke its credential so a late
   * ring costs nothing, and drop its state. Live loops read unconfirmed.
   */
  forgetContainer(containerId: string): void {
    const doorbell = this.doorbells.get(containerId);
    if (!doorbell) return;
    this.doorbells.delete(containerId);
    doorbell.confirmed = false;
    this.revoke(doorbell);
  }

  /** {@link forgetContainer} by a full or short container id. */
  forgetMatching(containerId: string): void {
    if (!containerId) return;
    for (const id of Array.from(this.doorbells.keys())) {
      if (id.startsWith(containerId) || containerId.startsWith(id)) this.forgetContainer(id);
    }
  }

  shutdownAll(): void {
    this.stopped = true;
    for (const containerId of Array.from(this.doorbells.keys())) this.forgetContainer(containerId);
  }

  /** Content-free health for recurring diagnostics (`tmux-hook-signal`). */
  status(): SignalHealthStatus {
    const states = emptySignalHealthStates();
    let fallback = 0;
    for (const doorbell of this.doorbells.values()) {
      states[this.healthOf(doorbell)] += 1;
      if (!doorbell.confirmed) fallback += 1;
    }
    return {
      containers: this.doorbells.size,
      states,
      fallback,
      demotions: { ...this.demotions },
      rings: this.acceptedRings,
    };
  }

  private healthOf(doorbell: ContainerDoorbell): SignalHealthState {
    if (doorbell.unsupported) return "unsupported";
    if (doorbell.confirmed) return "confirmed";
    if (doorbell.credential) return "armed";
    if (doorbell.arming) return "arming";
    if (doorbell.demoted) return "demoted";
    return "unarmed";
  }

  private arm(containerId: string, doorbell: ContainerDoorbell): void {
    const installer = this.installer;
    if (!installer || !doorbell.context.agentTools?.issueTmuxHookSignal) return;
    if (doorbell.unsupported || doorbell.confirmed || doorbell.arming) return;
    const now = this.nowMs();
    if (
      doorbell.lastAttemptAt !== undefined &&
      now - doorbell.lastAttemptAt < TMUX_HOOK_SIGNAL_RETRY_MS
    ) {
      return;
    }
    doorbell.lastAttemptAt = now;
    const current = () => !this.stopped && this.doorbells.get(containerId) === doorbell;
    const previous = this.installations.get(containerId);
    const arming = (async () => {
      await previous;
      if (!current()) return;
      const support = await installer.support(containerId, doorbell.context);
      if (!current()) return;
      if (support !== "supported") {
        doorbell.unsupported = support === "unsupported";
        return;
      }
      this.revoke(doorbell);
      let credential: StateSignalCredential | null = null;
      credential =
        doorbell.context.agentTools?.issueTmuxHookSignal?.(() => {
          if (credential && doorbell.credential === credential) this.ring(containerId, doorbell);
        }) ?? null;
      if (!credential) return;
      doorbell.credential = credential;
      await installer.install(containerId, credential, doorbell.context, current);
    })()
      .catch((error: unknown) => {
        if (current()) {
          doorbell.confirmed = false;
          doorbell.demoted = true;
          this.countDemotion("arm-failed");
        }
        this.revoke(doorbell);
        log.warn("hook-signal.arm-failed", { containerId, error: formatLogError(error) });
      })
      .finally(() => {
        if (this.installations.get(containerId) === arming) this.installations.delete(containerId);
        if (doorbell.arming === arming) doorbell.arming = undefined;
      });
    doorbell.arming = arming;
    this.installations.set(containerId, arming);
  }

  private ring(containerId: string, doorbell: ContainerDoorbell): void {
    if (this.doorbells.get(containerId) !== doorbell) return;
    doorbell.rings += 1;
    this.acceptedRings += 1;
    doorbell.confirmed = true;
    doorbell.demoted = false;
    for (const listener of Array.from(doorbell.listeners)) listener();
  }

  private demote(
    containerId: string,
    doorbell: ContainerDoorbell,
    reason: Extract<SignalDemotionReason, "missed-change">,
  ): void {
    doorbell.confirmed = false;
    doorbell.demoted = true;
    doorbell.lastAttemptAt = this.nowMs();
    this.countDemotion(reason);
    this.revoke(doorbell);
    log.warn("hook-signal.degraded", { containerId, reason });
  }

  private countDemotion(reason: SignalDemotionReason): void {
    this.demotions[reason] = (this.demotions[reason] ?? 0) + 1;
  }

  private revoke(doorbell: ContainerDoorbell): void {
    doorbell.credential?.revoke();
    doorbell.credential = undefined;
  }
}
