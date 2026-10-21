import type { SshAskpassHandler } from "./askpass.js";
import type { SshAdapterContext } from "./context.js";
import {
  probeHostKey as runHostKeyProbe,
  trustHostKey as appendTrustedHostKey,
  type HostKeyProbeResult,
} from "./host-trust.js";
import {
  routeTunnelKey,
  validateSshRoute,
  type SshRouteSpec,
  type ValidatedSshRoute,
} from "./ssh-command.js";
import type { SshConfigWarning } from "./ssh-config-inspection.js";
import {
  classifySshStderr,
  isForwardingDeniedLine,
  redactSshDiagnostic,
} from "./stderr-classification.js";
import { BoundedTail, MAX_TUNNEL_STDERR_BYTES } from "./tunnel-child.js";
import { SshTunnelError, tunnelFailure, type SshTunnelFailure } from "./tunnel-failures.js";
import {
  DEFAULT_TUNNEL_TIMINGS,
  startSshTunnel,
  type StartedTunnel,
  type TunnelTimings,
} from "./tunnel-starter.js";

export type SshTunnelAcquireOptions = {
  /**
   * `true` only for a user-initiated connect: prompts may be shown through the
   * askpass broker. Background reconnects pass `false`, which runs ssh with
   * BatchMode=yes and fails fast with `authentication-required` (SH-03).
   */
  interactive: boolean;
  signal?: AbortSignal;
};

/** A reference to a shared, Orkestrator-owned forward for one route. */
export interface SshTunnelLease {
  readonly routeId: string;
  /** `http://127.0.0.1:<port>`; ephemeral, never part of durable identity. */
  readonly localOrigin: string;
  readonly localPort: number;
  readonly usesProxyJump: boolean;
  readonly warnings: readonly SshConfigWarning[];
  /** True once the tunnel closed (unexpectedly or by dispose) or this lease was released. */
  readonly closed: boolean;
  /**
   * Called at most once if the tunnel stops while this lease is held. The
   * supervisor never restarts a tunnel itself; the route manager decides.
   */
  onClosed(listener: (reason: SshTunnelFailure) => void): () => void;
  /** Idempotent. The last release of a route closes only that route's child. */
  release(): void;
}

export type SshTunnelSnapshot = {
  routeId: string;
  state: "starting" | "ready";
  leases: number;
  localOrigin?: string;
  usesProxyJump?: boolean;
};

export type SshTunnelSupervisorOptions = {
  context: SshAdapterContext;
  /** Native prompt for passphrases/passwords; used only for interactive acquires. */
  prompt?: SshAskpassHandler;
  timings?: Partial<TunnelTimings>;
};

const MAX_ISSUED_PROBES = 16;

type TunnelEntry = {
  routeId: string;
  key: string;
  state: "starting" | "ready" | "closed";
  starting: Promise<StartedTunnel>;
  startAbort: AbortController;
  waiters: number;
  started?: StartedTunnel;
  leases: Set<LeaseHandle>;
  /** Set when the supervisor decided why the child must stop. */
  pendingFailure?: SshTunnelFailure;
  /** Set when Orkestrator itself closed the child (release/dispose). */
  intentional: boolean;
  postReadyStderr: BoundedTail;
};

class LeaseHandle implements SshTunnelLease {
  readonly routeId: string;
  readonly localOrigin: string;
  readonly localPort: number;
  readonly usesProxyJump: boolean;
  readonly warnings: readonly SshConfigWarning[];
  #listeners = new Set<(reason: SshTunnelFailure) => void>();
  #closedReason: SshTunnelFailure | null = null;
  #released = false;
  #onRelease: (lease: LeaseHandle) => void;

  constructor(entry: TunnelEntry, started: StartedTunnel, onRelease: (lease: LeaseHandle) => void) {
    this.routeId = entry.routeId;
    this.localPort = started.localPort;
    this.localOrigin = `http://127.0.0.1:${started.localPort}`;
    this.usesProxyJump = started.config.usesProxyJump;
    this.warnings = [...started.warnings];
    this.#onRelease = onRelease;
  }

  get closed(): boolean {
    return this.#released || this.#closedReason !== null;
  }

  onClosed(listener: (reason: SshTunnelFailure) => void): () => void {
    if (this.#released) return () => undefined;
    const reason = this.#closedReason;
    if (reason) {
      queueMicrotask(() => listener(reason));
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#listeners.clear();
    this.#onRelease(this);
  }

  notifyClosed(reason: SshTunnelFailure): void {
    if (this.#released || this.#closedReason) return;
    this.#closedReason = reason;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) {
      try {
        listener(reason);
      } catch {
        // A faulty listener must not prevent the others from hearing about it.
      }
    }
  }
}

/**
 * Owns every OpenSSH forwarding child Orkestrator starts. One child per route,
 * shared by reference-counted leases (SH-10). It only ever signals the pids it
 * spawned (SH-11) and always runs ssh with ControlMaster=no/ControlPath=none,
 * so an external ControlMaster is never used or stopped (SH-14).
 */
export class SshTunnelSupervisor {
  #context: SshAdapterContext;
  #prompt: SshAskpassHandler | undefined;
  #timings: TunnelTimings;
  #entries = new Map<string, TunnelEntry>();
  #closing = new Set<Promise<void>>();
  #issuedProbes = new Map<string, HostKeyProbeResult>();
  #disposed = false;

  constructor(options: SshTunnelSupervisorOptions) {
    this.#context = options.context;
    this.#prompt = options.prompt;
    this.#timings = { ...DEFAULT_TUNNEL_TIMINGS, ...options.timings };
  }

  async acquire(spec: SshRouteSpec, options: SshTunnelAcquireOptions): Promise<SshTunnelLease> {
    if (this.#disposed) throw SshTunnelError.of("cancelled");
    const route = validateSshRoute(spec, this.#context.homedir);
    if (options.signal?.aborted) throw SshTunnelError.of("cancelled");
    const key = routeTunnelKey(route);
    let entry = this.#entries.get(route.routeId);
    if (entry && entry.key !== key) {
      throw SshTunnelError.of("invalid-route", {
        message: "This route already has an open SSH tunnel with different settings.",
      });
    }
    if (!entry) {
      entry = this.#start(route, key, options.interactive);
    }
    if (entry.state === "starting") await this.#awaitStart(entry, options.signal);
    if (entry.state !== "ready" || !entry.started) throw SshTunnelError.of("tunnel-exited");
    const lease = new LeaseHandle(entry, entry.started, (handle) => this.#release(entry, handle));
    entry.leases.add(lease);
    return lease;
  }

  /** Fetch the host key for first-use approval; no credential is offered. */
  async probeHostKey(
    spec: SshRouteSpec,
    options: { signal?: AbortSignal } = {},
  ): Promise<HostKeyProbeResult> {
    const route = validateSshRoute(spec, this.#context.homedir);
    const lookup = await this.#context.locateBinaries();
    if (!lookup.ok) throw SshTunnelError.of("ssh-unavailable");
    const result = await runHostKeyProbe(this.#context, lookup.binaries, route, options.signal);
    this.#issuedProbes.set(result.probeId, result);
    while (this.#issuedProbes.size > MAX_ISSUED_PROBES) {
      const oldest = this.#issuedProbes.keys().next().value;
      if (oldest === undefined) break;
      this.#issuedProbes.delete(oldest);
    }
    return result;
  }

  /**
   * Record explicit user approval of a probe this supervisor issued. Only the
   * exact probed lines are appended to the Orkestrator-owned known_hosts.
   */
  async trustHostKey(probe: Pick<HostKeyProbeResult, "probeId">): Promise<{ added: number }> {
    const issued = this.#issuedProbes.get(probe.probeId);
    if (!issued) {
      throw SshTunnelError.of("invalid-route", {
        message: "The host key approval has expired. Check the host key again.",
      });
    }
    this.#issuedProbes.delete(probe.probeId);
    return appendTrustedHostKey(this.#context, issued);
  }

  /** Close one route's tunnel regardless of outstanding leases. */
  async closeRoute(routeId: string): Promise<void> {
    const entry = this.#entries.get(routeId);
    if (!entry) return;
    if (entry.state === "starting") {
      entry.startAbort.abort();
      await entry.starting.catch(() => undefined);
      return;
    }
    this.#close(entry, tunnelFailure("cancelled", { message: "The SSH tunnel was closed." }));
    await this.idle();
  }

  /** App exit: close every owned child (SIGTERM, bounded wait, SIGKILL). */
  async disposeAll(): Promise<void> {
    this.#disposed = true;
    const entries = [...this.#entries.values()];
    for (const entry of entries) {
      if (entry.state === "starting") entry.startAbort.abort();
      else this.#close(entry, tunnelFailure("cancelled", { message: "Orkestrator is closing." }));
    }
    await Promise.all(entries.map((entry) => entry.starting.catch(() => undefined)));
    await this.idle();
  }

  /** Resolves once every pending child termination has finished. */
  async idle(): Promise<void> {
    while (this.#closing.size > 0) await Promise.all(this.#closing);
  }

  snapshot(): SshTunnelSnapshot[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.state !== "closed")
      .map((entry) => {
        const item: SshTunnelSnapshot = {
          routeId: entry.routeId,
          state: entry.state === "ready" ? "ready" : "starting",
          leases: entry.leases.size,
        };
        if (entry.started) {
          item.localOrigin = `http://127.0.0.1:${entry.started.localPort}`;
          item.usesProxyJump = entry.started.config.usesProxyJump;
        }
        return item;
      });
  }

  #start(route: ValidatedSshRoute, key: string, interactive: boolean): TunnelEntry {
    const startAbort = new AbortController();
    // The callbacks below run asynchronously, after `entry` is initialised.
    const starting = startSshTunnel(this.#context, route, {
      interactive,
      prompt: this.#prompt,
      signal: startAbort.signal,
      timings: this.#timings,
    }).then(
      async (started) => {
        if (startAbort.signal.aborted || this.#disposed) {
          entry.intentional = true;
          await started.child.terminate(this.#timings.terminateGraceMs);
          this.#forget(entry);
          throw SshTunnelError.of("cancelled");
        }
        entry.started = started;
        entry.state = "ready";
        this.#monitor(entry, started);
        this.#context.logger.info("ssh tunnel ready", {
          routeId: entry.routeId,
          pid: started.child.pid ?? -1,
        });
        return started;
      },
      (error: unknown) => {
        this.#forget(entry);
        throw error;
      },
    );
    const entry: TunnelEntry = {
      routeId: route.routeId,
      key,
      state: "starting",
      starting,
      startAbort,
      waiters: 0,
      leases: new Set(),
      intentional: false,
      postReadyStderr: new BoundedTail(MAX_TUNNEL_STDERR_BYTES),
    };
    // Waiters observe the outcome; an unobserved failure must not crash main.
    starting.catch(() => undefined);
    this.#entries.set(route.routeId, entry);
    return entry;
  }

  async #awaitStart(entry: TunnelEntry, signal: AbortSignal | undefined): Promise<void> {
    entry.waiters += 1;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(SshTunnelError.of("cancelled"));
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      aborted.catch(() => undefined);
      await Promise.race([entry.starting, aborted]);
    } finally {
      entry.waiters -= 1;
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      // The start is shared: only abandon it when nobody is waiting any more.
      if (signal?.aborted && entry.waiters === 0 && entry.state === "starting") {
        entry.startAbort.abort();
      }
    }
  }

  #monitor(entry: TunnelEntry, started: StartedTunnel): void {
    const { child } = started;
    const unsubscribe = child.onStderrLine((line) => {
      entry.postReadyStderr.append(`${line}\n`);
      // SH-07: forwards open lazily, so the server's refusal can arrive on a
      // later connection. The tunnel is useless; stop it with a typed reason.
      if (isForwardingDeniedLine(line) && !entry.pendingFailure && !entry.intentional) {
        entry.pendingFailure = tunnelFailure("forwarding-denied", {
          detail: redactSshDiagnostic(line, [started.config.user, this.#context.homedir]),
        });
        this.#trackClosing(child.terminate(this.#timings.terminateGraceMs).then(() => undefined));
      }
    });
    void child.exited.then(() => {
      unsubscribe();
      if (entry.intentional) return;
      const failure = entry.pendingFailure ?? this.#exitFailure(entry, started);
      this.#context.logger.warn("ssh tunnel exited", {
        routeId: entry.routeId,
        code: failure.code,
        ...(failure.cause ? { cause: failure.cause } : {}),
      });
      this.#forget(entry);
      for (const lease of entry.leases) lease.notifyClosed(failure);
      entry.leases.clear();
    });
  }

  #exitFailure(entry: TunnelEntry, started: StartedTunnel): SshTunnelFailure {
    const classified = classifySshStderr(entry.postReadyStderr.text, {
      interactive: started.interactive,
    });
    if (!classified || classified.code === "port-collision") return tunnelFailure("tunnel-exited");
    return tunnelFailure("tunnel-exited", {
      cause: classified.code,
      detail: redactSshDiagnostic(classified.line, [started.config.user, this.#context.homedir]),
    });
  }

  #release(entry: TunnelEntry, lease: LeaseHandle): void {
    if (!entry.leases.delete(lease)) return;
    if (entry.leases.size === 0 && entry.state === "ready") this.#close(entry, null);
  }

  #close(entry: TunnelEntry, notify: SshTunnelFailure | null): void {
    if (entry.state !== "ready" || !entry.started || entry.intentional) return;
    entry.intentional = true;
    this.#forget(entry);
    const child = entry.started.child;
    this.#context.logger.info("ssh tunnel closing", {
      routeId: entry.routeId,
      pid: child.pid ?? -1,
    });
    if (notify) for (const lease of entry.leases) lease.notifyClosed(notify);
    entry.leases.clear();
    this.#trackClosing(child.terminate(this.#timings.terminateGraceMs).then(() => undefined));
  }

  #trackClosing(promise: Promise<void>): void {
    const tracked = promise.catch(() => undefined);
    this.#closing.add(tracked);
    void tracked.finally(() => this.#closing.delete(tracked));
  }

  #forget(entry: TunnelEntry): void {
    entry.state = "closed";
    if (this.#entries.get(entry.routeId) === entry) this.#entries.delete(entry.routeId);
  }
}
