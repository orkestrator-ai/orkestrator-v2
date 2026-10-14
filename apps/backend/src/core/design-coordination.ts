import { deletionMarker, markDeletion } from "./storage-deletion-fences.js";
import { DesignError } from "./design-errors.js";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";

/**
 * Cross-process coordination for design canvases.
 *
 * Canvas records, pending files and checkpoints stay files (a record is up to
 * 6 MiB and is replaced on every edit). Several backends may share the data
 * directory, so the database supplies what files cannot:
 *
 * - a lease per canvas (`design-canvases/<id>`) around each lane's critical
 *   section (load, verify, commit), and one for the global guard
 *   (`design-canvases`: quota reservation, environment deletion); lock order is
 *   global, then one canvas, in every process;
 * - a liveness lease per service instance (`design-owner/<instance>`), held
 *   while the service runs, so recovery never interrupts a live backend's
 *   admitted work;
 * - a change signal store whose revision moves whenever any process changes
 *   the set or content of canvas records, so every process knows when to
 *   rescan its derived library index.
 *
 * Rendering and export writes never happen under a lease.
 */

/** Data-dir store whose revision is the canvases' change signal (document layout). */
export const DESIGN_LIBRARY_SIGNAL_STORE = "design-canvases/changes";
const DIRTY_PREFIX = "design-canvases/dirty/";

/**
 * Canvas critical sections are one record read, verification, a checkpoint
 * write and one record replacement (each ≤ 6–8 MiB with fsync): well under a
 * second normally. The heartbeat runs every `staleMs / 3` while the section
 * awaits I/O, so only an event-loop stall longer than `staleMs` (machine
 * sleep) could let a waiter reclaim a live holder's lease.
 */
export const CANVAS_LEASE = { staleMs: 30_000, acquireTimeoutMs: 60_000 } as const;
/** The global guard may sweep a whole environment's canvases. */
export const GLOBAL_LEASE = { staleMs: 30_000, acquireTimeoutMs: 120_000 } as const;
/** A service instance is dead once its liveness heartbeat is this old. */
export const OWNER_STALE_MS = 60_000;

function ownerLease(owner: string) {
  return `design-owner/${owner}`;
}

export class DesignCoordination {
  private database: StorageDatabase | undefined;
  private releaseOwner: (() => Promise<void>) | undefined;
  private starting: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly dataDir: string,
    /** This service instance's identity, recorded on the work it owns. */
    readonly owner: string,
  ) {}

  private db(): StorageDatabase {
    if (!this.database) {
      if (this.closed)
        throw new DesignError("unsupported", "Design service is stopping", {
          retry: "after-delay",
        });
      this.database = openBackendDatabase(this.dataDir);
    }
    return this.database;
  }

  /** Takes this instance's liveness lease; held until {@link close}. */
  async start(): Promise<void> {
    if (this.releaseOwner) return;
    this.starting ??= this.db()
      .acquireLease(ownerLease(this.owner), "design service owner", {
        staleMs: OWNER_STALE_MS,
        acquireTimeoutMs: 5_000,
      })
      .then((release) => {
        this.releaseOwner = release;
      })
      .finally(() => {
        this.starting = undefined;
      });
    await this.starting;
  }

  /**
   * Whether the service instance that recorded `owner` is still running. An
   * absent owner (work recorded before owners existed) is never alive.
   */
  isAlive(owner: string | undefined): boolean {
    if (!owner) return false;
    if (owner === this.owner) return !this.closed;
    const row = this.db()
      .db.query("SELECT heartbeat_at FROM leases WHERE name = ?")
      .get(ownerLease(owner)) as { heartbeat_at: number } | null;
    return row !== null && row.heartbeat_at >= Date.now() - OWNER_STALE_MS;
  }

  /** Runs `work` holding the named cross-process lease. */
  async exclusive<T>(
    name: string,
    description: string,
    options: { staleMs: number; acquireTimeoutMs: number },
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.closed)
      throw new DesignError("unsupported", "Design service is stopping", { retry: "after-delay" });
    let release: () => Promise<void>;
    try {
      release = await this.db().acquireLease(name, description, options);
    } catch (error) {
      if (error instanceof DesignError) throw error;
      throw new DesignError(
        "capacity",
        "This design is busy in another Orkestrator process; retry shortly",
        { retryAfterMs: 1000 },
      );
    }
    try {
      return await work();
    } finally {
      await release().catch(() => undefined);
    }
  }

  environmentDeleted(environmentId: string): boolean {
    return !!deletionMarker(this.db(), "design", environmentId);
  }

  fenceEnvironment(environmentId: string): void {
    this.db().transaction(() => markDeletion(this.db(), "design", environmentId));
  }

  // Written before touching files. A failed signal or crash leaves a durable
  // reason to reconcile, independent of the final change signal.
  beginLibraryChange(canvasId: string): void {
    this.db().writeStore(`${DIRTY_PREFIX}${canvasId}`, { owner: this.owner });
  }
  finishLibraryChange(canvasId: string): void {
    this.db().deleteStore(`${DIRTY_PREFIX}${canvasId}`);
  }
  libraryDirty(): boolean {
    return this.db().listStores(DIRTY_PREFIX).length > 0;
  }

  async claimExport(token: string): Promise<() => Promise<void>> {
    return this.db().acquireLease(`design-export/${token}`, "design export", {
      staleMs: OWNER_STALE_MS,
      acquireTimeoutMs: 5_000,
    });
  }
  exportAlive(token: string): boolean {
    const row = this.db()
      .db.query("SELECT heartbeat_at FROM leases WHERE name = ?")
      .get(`design-export/${token}`) as { heartbeat_at: number } | null;
    return row !== null && row.heartbeat_at >= Date.now() - OWNER_STALE_MS;
  }

  /** The change signal's current revision (0 before any change). */
  libraryRevision(): number {
    return this.db().storeRevision(DESIGN_LIBRARY_SIGNAL_STORE) ?? 0;
  }

  /**
   * Moves the change signal after a record was written or removed. Returns
   * the revision before and after, so the writer can tell whether its own
   * index was current (and stays current) or another process moved it too.
   * A failed signal only delays other processes' index refresh; it never
   * fails the commit that already happened.
   */
  signalLibraryChange(): { before: number; after: number } | undefined {
    try {
      const database = this.db();
      return database.transaction(() => {
        const before = database.storeRevision(DESIGN_LIBRARY_SIGNAL_STORE) ?? 0;
        const after = database.writeStoreInTransaction(DESIGN_LIBRARY_SIGNAL_STORE, {
          sequence: before + 1,
        });
        return { before, after };
      });
    } catch (error) {
      console.warn(
        "[backend] Design change signal failed:",
        (error as { code?: string })?.code ?? "error",
      );
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => undefined);
    this.closed = true;
    const release = this.releaseOwner;
    this.releaseOwner = undefined;
    await release?.().catch(() => undefined);
    this.database?.close();
  }
}
