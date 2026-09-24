/**
 * The process lifecycle of a long-lived bridge: start once, arm its background
 * timers, and tear every one of them down on shutdown.
 *
 * Cursor and Pi each armed an idle sweep and a parent watch inside `start`
 * with the handles held in local variables, so an explicit `shutdown` stopped
 * the server while both intervals kept firing. Process exit normally hid that;
 * a library consumer or a test that shuts down without exiting did not. This
 * owner keeps the handles, clears them *before* awaiting disposal (a sweep that
 * fires mid-shutdown would detach sessions the shutdown is already
 * releasing), and makes a second `start` an explicit error rather than a
 * second set of timers.
 *
 * Restart after shutdown is deliberately unsupported: the bridges' session
 * registries are module-global and shutdown releases them, so "start again"
 * would promise something no caller can rely on.
 */
import {
  type IntervalTimers,
  runtimeIntervalTimers,
  startParentWatchdog,
} from "./parent-watchdog.js";

export type BridgeLifecyclePhase = "idle" | "starting" | "started" | "stopping" | "stopped";

/** The slice of `process` used for termination signals. */
export interface LifecycleSignalTarget {
  once(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export interface BridgeLifecycleOptions {
  /** Prefix identifying the process in the few content-free lines this logs. */
  label: string;
  /** Load state and bind the server. Runs at most once. */
  open: () => Promise<void>;
  /**
   * Release everything the bridge owns. Runs at most once, after every timer
   * this owner armed has already been cleared.
   */
  close: () => Promise<void>;
  /** A periodic, synchronous sweep; thrown errors are reported, not rethrown. */
  idleSweep?: { intervalMs: number; run: () => void };
  /** The advertised parent, or `null` for a bridge started by hand. */
  parentPid: number | null;
  /** How often to probe the parent. Each bridge passes its own requirement. */
  parentWatchMs: number;
  /** Terminates the process after a signal- or parent-driven shutdown. */
  exit: (code: number) => void;
  /** Injected in tests. */
  timers?: IntervalTimers;
  /** Injected in tests. */
  isParentAlive?: (pid: number) => boolean;
  /** `null` installs no signal handlers (tests); defaults to `process`. */
  signals?: LifecycleSignalTarget | null;
  /** Injected in tests. Receives content-free messages only. */
  report?: (message: string) => void;
}

const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** An error's class name only: messages can carry paths, prompts or tokens. */
function errorKind(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

export class BridgeLifecycle {
  #phase: BridgeLifecyclePhase = "idle";
  #disarmers: Array<() => void> = [];
  #signalDisarmers: Array<() => void> = [];
  #shutdown: Promise<void> | null = null;
  #exit: Promise<void> | null = null;
  readonly #options: BridgeLifecycleOptions;
  readonly #timers: IntervalTimers;
  readonly #report: (message: string) => void;

  constructor(options: BridgeLifecycleOptions) {
    this.#options = options;
    this.#timers = options.timers ?? runtimeIntervalTimers;
    this.#report = options.report ?? ((message) => console.error(message));
  }

  get phase(): BridgeLifecyclePhase {
    return this.#phase;
  }

  /** True once shutdown has begun; new requests should be refused. */
  get closing(): boolean {
    return this.#phase === "stopping" || this.#phase === "stopped";
  }

  /**
   * Open the bridge and arm its timers.
   *
   * A second call rejects before touching anything, including after shutdown.
   * A shutdown that lands while `open` is still awaiting wins: no timer is
   * armed for a bridge that is already closing.
   */
  async start(): Promise<void> {
    if (this.#phase !== "idle") {
      throw new Error(`${this.#options.label} lifecycle was already started`);
    }
    this.#phase = "starting";
    // A failed open leaves the phase at "starting": the bridge cannot be
    // started again, and `shutdown` still releases whatever `open` did.
    await this.#options.open();
    if (this.#phase !== "starting") return;
    this.#arm();
    this.#phase = "started";
  }

  /**
   * Disarm every timer, then release the bridge. Idempotent: every caller gets
   * the same promise, and `close` runs once.
   */
  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#phase = "stopping";
    // Timers first, synchronously: nothing armed here may observe a bridge
    // that is half torn down. Signal handlers stay until `close` settles so a
    // repeated signal joins this shutdown instead of racing it.
    this.#disarmTimers();
    this.#shutdown = (async () => {
      try {
        await this.#options.close();
      } finally {
        this.#phase = "stopped";
        this.#disarmSignals();
      }
    })();
    return this.#shutdown;
  }

  /**
   * Shut down and exit, exactly once, however many signals or watchdog ticks
   * ask for it. Never rejects: a failed shutdown is reported and still exits,
   * because a bridge whose parent is gone must not linger as an orphan.
   */
  requestExit(): Promise<void> {
    this.#exit ??= this.shutdown().then(
      () => this.#options.exit(0),
      (error: unknown) => {
        this.#report(`${this.#options.label} shutdown failed (${errorKind(error)})`);
        this.#options.exit(1);
      },
    );
    return this.#exit;
  }

  #arm(): void {
    const { idleSweep, parentPid } = this.#options;
    if (idleSweep) {
      const handle = this.#timers.setInterval(() => {
        // A callback already queued when shutdown cleared the interval must do
        // nothing; `phase` is the authority, not the handle.
        if (this.#phase !== "started") return;
        try {
          idleSweep.run();
        } catch (error) {
          this.#report(`${this.#options.label} idle sweep failed (${errorKind(error)})`);
        }
      }, idleSweep.intervalMs);
      this.#disarmers.push(() => this.#timers.clearInterval(handle));
    }

    // Bridges are spawned detached so they outlive a backend that dies without
    // running its shutdown path. Watching the advertised PID is what stops this
    // process — and every agent it owns — from being orphaned.
    if (parentPid !== null) {
      this.#disarmers.push(
        startParentWatchdog({
          parentPid,
          pollIntervalMs: this.#options.parentWatchMs,
          timers: this.#timers,
          ...(this.#options.isParentAlive ? { isAlive: this.#options.isParentAlive } : {}),
          onParentExit: () => void this.requestExit(),
        }),
      );
    }

    const signals =
      this.#options.signals === undefined
        ? (process as unknown as LifecycleSignalTarget)
        : this.#options.signals;
    if (signals) {
      for (const signal of TERMINATION_SIGNALS) {
        const listener = () => void this.requestExit();
        signals.once(signal, listener);
        this.#signalDisarmers.push(() => signals.off(signal, listener));
      }
    }
  }

  #disarmTimers(): void {
    const disarmers = this.#disarmers;
    this.#disarmers = [];
    for (const disarm of disarmers) disarm();
  }

  #disarmSignals(): void {
    const disarmers = this.#signalDisarmers;
    this.#signalDisarmers = [];
    for (const disarm of disarmers) disarm();
  }
}
