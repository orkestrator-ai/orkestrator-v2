import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";

/**
 * Exclusive right of one backend process to mutate a registry's containers.
 *
 * The per-environment lifecycle queue is an in-memory promise chain, so it
 * serializes operations inside one process only. Two backends pointed at the
 * same data directory would each believe they own the queue. The lease is a
 * file in the data directory whose modification time is a heartbeat: a live
 * holder refreshes it, a holder that died stops, and after `staleMs` another
 * process may reclaim it.
 *
 * Reads never need the lease; only lifecycle writes assert it.
 */

export const REGISTRY_WRITER_LEASE_FILE = "container-lifecycle.writer.lease";

export interface RegistryWriterLeaseOptions {
  staleMs?: number;
  heartbeatMs?: number;
  /** Test seam. */
  now?: () => number;
}

interface LeaseDocument {
  token: string;
  pid: number;
  acquiredAt: string;
}

export class RegistryWriterLeaseBusyError extends Error {
  constructor() {
    super(
      formatContainerLifecycleError(
        "operation-in-progress",
        "Another Orkestrator backend is managing this data directory's containers.",
      ),
    );
    this.name = "RegistryWriterLeaseBusyError";
  }
}

export class RegistryWriterLease {
  private released = false;
  private lost = false;

  private constructor(
    private readonly leasePath: string,
    private readonly token: string,
    private readonly handle: fs.FileHandle,
    private readonly heartbeat: ReturnType<typeof setInterval>,
  ) {}

  static async acquire(
    dataDir: string,
    options: RegistryWriterLeaseOptions = {},
  ): Promise<RegistryWriterLease> {
    const staleMs = options.staleMs ?? 30_000;
    const heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(staleMs / 3));
    const now = options.now ?? Date.now;
    const leasePath = path.join(dataDir, REGISTRY_WRITER_LEASE_FILE);
    const takeoverPath = `${leasePath}.takeover`;
    await fs.mkdir(dataDir, { recursive: true });
    const token = randomUUID();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (
        await fs.stat(takeoverPath).then(
          () => true,
          () => false,
        )
      ) {
        throw new RegistryWriterLeaseBusyError();
      }
      try {
        const handle = await fs.open(leasePath, "wx", 0o600);
        const document: LeaseDocument = {
          token,
          pid: process.pid,
          acquiredAt: new Date(now()).toISOString(),
        };
        await handle.writeFile(JSON.stringify(document), "utf8");
        let lease: RegistryWriterLease | undefined;
        const heartbeat = setInterval(() => {
          void lease?.refresh();
        }, heartbeatMs);
        heartbeat.unref?.();
        lease = new RegistryWriterLease(leasePath, token, handle, heartbeat);
        return lease;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "EEXIST") throw error;
        const stat = await fs.stat(leasePath).catch(() => null);
        if (stat && now() - stat.mtimeMs > staleMs) {
          // Only one contender may remove a stale document. Leave an orphaned
          // takeover lock fail-closed rather than risk two live writers.
          try {
            await fs.mkdir(takeoverPath, { mode: 0o700 });
          } catch {
            throw new RegistryWriterLeaseBusyError();
          }
          try {
            const staleToken = await readToken(leasePath);
            const current = await fs.stat(leasePath).catch(() => null);
            if (
              current &&
              now() - current.mtimeMs > staleMs &&
              staleToken === (await readToken(leasePath))
            ) {
              await fs.rm(leasePath, { force: true });
              continue;
            }
          } finally {
            await fs.rmdir(takeoverPath);
          }
        }
        throw new RegistryWriterLeaseBusyError();
      }
    }
    throw new RegistryWriterLeaseBusyError();
  }

  private async refresh(): Promise<void> {
    if (this.released) return;
    const token = await readToken(this.leasePath);
    if (token !== this.token) {
      // Reclaimed by another process while this one was stalled (for example
      // across machine sleep). Stop writing rather than fight over it.
      this.lost = true;
      clearInterval(this.heartbeat);
      return;
    }
    const time = new Date();
    await this.handle.utimes(time, time).catch(() => undefined);
  }

  isHeld(): boolean {
    if (this.released || this.lost) return false;
    try {
      const parsed = JSON.parse(readFileSync(this.leasePath, "utf8")) as Partial<LeaseDocument>;
      if (parsed.token === this.token) return true;
    } catch {
      // A missing or malformed lease is never proof of ownership.
    }
    this.lost = true;
    clearInterval(this.heartbeat);
    return false;
  }

  /** Throws unless this process still holds the lease. */
  assertHeld(): void {
    if (!this.isHeld()) throw new RegistryWriterLeaseBusyError();
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    clearInterval(this.heartbeat);
    await this.handle.close().catch(() => undefined);
    if ((await readToken(this.leasePath)) === this.token) {
      await fs.rm(this.leasePath, { force: true });
    }
  }
}

async function readToken(leasePath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(leasePath, "utf8")) as Partial<LeaseDocument>;
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimum-writer schema marker
// ---------------------------------------------------------------------------

/**
 * A data directory records the oldest lifecycle writer allowed to mutate it.
 * A backend whose writer version is below the marker keeps reading (status,
 * history, snapshots) but refuses every container mutation, so it cannot
 * delete or reinterpret state a newer version wrote.
 *
 * This only protects versions that implement the check. Historical binaries
 * that predate it ignore the file; the rollback floor is therefore the first
 * release that ships this marker, and a manual downgrade below it bypasses
 * the protection.
 */
export const REGISTRY_SCHEMA_MARKER_FILE = "container-lifecycle.schema.json";

/** Lifecycle writer implemented by this backend. */
export const REGISTRY_WRITER_VERSION = 1;

export interface RegistrySchemaMarker {
  /** Highest lifecycle schema any writer has used in this directory. */
  schemaVersion: number;
  /** Writers below this version must not mutate containers. */
  minimumWriterVersion: number;
  updatedAt: string;
}

export type RegistrySchemaCheck =
  | { compatible: true; marker: RegistrySchemaMarker }
  | { compatible: false; marker: RegistrySchemaMarker };

export async function checkRegistrySchemaMarker(
  dataDir: string,
  writerVersion = REGISTRY_WRITER_VERSION,
): Promise<RegistrySchemaCheck> {
  const markerPath = path.join(dataDir, REGISTRY_SCHEMA_MARKER_FILE);
  let marker: RegistrySchemaMarker | null = null;
  try {
    const parsed = JSON.parse(
      await fs.readFile(markerPath, "utf8"),
    ) as Partial<RegistrySchemaMarker>;
    if (
      typeof parsed.schemaVersion === "number" &&
      typeof parsed.minimumWriterVersion === "number"
    ) {
      marker = {
        schemaVersion: parsed.schemaVersion,
        minimumWriterVersion: parsed.minimumWriterVersion,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
    } else {
      // Unreadable fields are treated as the most restrictive answer: a marker
      // exists, so some writer cared, and this one cannot prove it qualifies.
      return {
        compatible: false,
        marker: { schemaVersion: Infinity, minimumWriterVersion: Infinity, updatedAt: "" },
      };
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") {
      return {
        compatible: false,
        marker: { schemaVersion: Infinity, minimumWriterVersion: Infinity, updatedAt: "" },
      };
    }
  }
  if (marker && marker.minimumWriterVersion > writerVersion) {
    return { compatible: false, marker };
  }
  const next: RegistrySchemaMarker = {
    schemaVersion: Math.max(marker?.schemaVersion ?? 0, writerVersion),
    minimumWriterVersion: Math.max(marker?.minimumWriterVersion ?? 0, writerVersion),
    updatedAt: new Date().toISOString(),
  };
  if (
    !marker ||
    marker.schemaVersion !== next.schemaVersion ||
    marker.minimumWriterVersion !== next.minimumWriterVersion
  ) {
    const temporary = `${markerPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, markerPath);
  }
  return { compatible: true, marker: next };
}

export class RegistrySchemaBlockedError extends Error {
  constructor() {
    super(
      formatContainerLifecycleError(
        "unsupported-format",
        "This data directory was written by a newer Orkestrator. Update Orkestrator to change containers.",
      ),
    );
    this.name = "RegistrySchemaBlockedError";
  }
}

/** Writer handle that is never held: containers are read-only in this process. */
export class BlockedRegistryWriter {
  constructor(private readonly error: Error) {}
  isHeld(): boolean {
    return false;
  }
  assertHeld(): void {
    throw this.error;
  }
  async release(): Promise<void> {}
}

export type RegistryWriter = Pick<RegistryWriterLease, "assertHeld" | "isHeld" | "release">;

/**
 * Checks the schema marker, then acquires the writer lease. Never throws for
 * an incompatible or busy registry: the returned writer refuses mutations and
 * the backend keeps serving reads.
 */
export async function openRegistryWriter(
  dataDir: string,
  options: RegistryWriterLeaseOptions = {},
): Promise<RegistryWriter> {
  const schema = await checkRegistrySchemaMarker(dataDir);
  if (!schema.compatible) return new BlockedRegistryWriter(new RegistrySchemaBlockedError());
  try {
    return await RegistryWriterLease.acquire(dataDir, options);
  } catch (error) {
    if (error instanceof RegistryWriterLeaseBusyError) return new BlockedRegistryWriter(error);
    throw error;
  }
}
