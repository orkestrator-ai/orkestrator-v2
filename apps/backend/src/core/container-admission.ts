import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";

/**
 * Backend-wide admission for expensive container work.
 *
 * The lifecycle queue serializes operations per environment only, so ten
 * environments starting (image boots, readiness waits) or rebuilding (full
 * workspace copies) at once would all run together and starve each other and
 * the host. Each kind has a fixed number of slots; further requests wait in
 * FIFO order, and a request beyond the wait bound is refused as
 * `resource-exhausted` instead of queueing without limit. Slots are released
 * however the work ends.
 */

export type ContainerAdmissionKind = "start" | "copy";

export const CONTAINER_ADMISSION_LIMITS: Record<
  ContainerAdmissionKind,
  { concurrent: number; waiting: number }
> = {
  /** Container starts through readiness. */
  start: { concurrent: 4, waiting: 64 },
  /** Preserving rebuilds, migrations and restores: disk- and I/O-heavy copies. */
  copy: { concurrent: 2, waiting: 32 },
};

class AdmissionPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly kind: ContainerAdmissionKind,
    private readonly limits: { concurrent: number; waiting: number },
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  snapshot(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiters.length };
  }

  private acquire(): Promise<void> {
    if (this.active < this.limits.concurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.limits.waiting) {
      return Promise.reject(
        new Error(
          formatContainerLifecycleError(
            "resource-exhausted",
            this.kind === "copy"
              ? "Too many rebuilds are waiting. Retry once some have finished."
              : "Too many containers are waiting to start. Retry once some have started.",
          ),
        ),
      );
    }
    return new Promise((resolve) => {
      // The slot is handed over directly, so `active` never dips below the
      // number of running holders.
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}

const pools: Record<ContainerAdmissionKind, AdmissionPool> = {
  start: new AdmissionPool("start", CONTAINER_ADMISSION_LIMITS.start),
  copy: new AdmissionPool("copy", CONTAINER_ADMISSION_LIMITS.copy),
};

export function withContainerAdmission<T>(
  kind: ContainerAdmissionKind,
  work: () => Promise<T>,
): Promise<T> {
  return pools[kind].run(work);
}

export function containerAdmissionSnapshot(): Record<
  ContainerAdmissionKind,
  { active: number; waiting: number }
> {
  return { start: pools.start.snapshot(), copy: pools.copy.snapshot() };
}

/** Test seam: a pool with its own limits. */
export function createAdmissionPoolForTest(
  kind: ContainerAdmissionKind,
  limits: { concurrent: number; waiting: number },
): {
  run: <T>(work: () => Promise<T>) => Promise<T>;
  snapshot: () => { active: number; waiting: number };
} {
  const pool = new AdmissionPool(kind, limits);
  return { run: (work) => pool.run(work), snapshot: () => pool.snapshot() };
}
