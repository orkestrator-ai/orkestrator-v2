import {
  MAX_JSON_BACKUPS,
  exists,
  fs,
  isMissingFileError,
  isRecord,
  path,
  randomBytes,
  randomUUID,
} from "./storage-shared.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { BACKUP_CHECK_INTERVAL_MS, takeHourlySnapshotIfDue } from "./storage-backups.js";
import { StorageChanges } from "./storage-changes.js";
import { StoreCorruptError, type RowUpdate, type StorageDatabase } from "./storage-database.js";
import {
  commitWithLegacyJsonCleanup,
  type LegacyJsonCleanup,
  databaseStoreForPath,
  hasLegacyJsonStore,
  openBackendDatabase,
  pruneRemovedContent,
  replayLegacyJsonCleanup,
  scrubLegacyJsonStore,
  storeLayout,
} from "./storage-stores.js";

/**
 * The state every store of the backend shares: the database handle, the
 * {@link atomically} scope, the per-target mutation queues, the store
 * primitives and the resource change journal ({@link changes}).
 *
 * `StorageService` owns exactly one and hands it to every repository it
 * builds (`StorageRepositories`), so they share one {@link atomically} scope
 * and one set of mutation queues. `storage-writer-guards.test.ts` follows
 * every class that holds it from the facade, and fails one it cannot reach.
 */
export class StorageContext {
  readonly dataDir: string;
  /** Process identity: client revision knowledge never crosses this boundary. */
  readonly resourceGeneration = randomBytes(16).toString("hex");
  /** Resource announcements and the revision manifests clients sync against. */
  readonly changes: StorageChanges;
  /** Serializes this process's writes of the JSON files that remain files. */
  private writeQueue = Promise.resolve();
  /**
   * In-process FIFO per mutation target. One map replaces the per-store
   * promise-chain fields: a target's tail is dropped once it settles.
   */
  private readonly mutationTails = new Map<string, Promise<unknown>>();
  private storageDatabase: StorageDatabase | null = null;
  /** Writes and announcements buffered by an open {@link atomically} scope. */
  private readonly atomicScope = new AsyncLocalStorage<AtomicStorageScope>();
  /**
   * Parsed-JSON read cache for the stores that remain JSON files, keyed by file
   * path and validated against an (inode, size, mtime) fingerprint on every
   * read, so writes by the desktop process are always observed.
   */
  private readonly jsonReadCache = new Map<string, { fingerprint: string; value: unknown }>();
  /** Periodic database snapshots; off by default under the test runner. */
  private readonly snapshots: boolean;
  private snapshotTimers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(dataDir: string, options: { snapshots?: boolean } = {}) {
    this.dataDir = dataDir;
    this.snapshots = options.snapshots ?? process.env.NODE_ENV !== "test";
    this.changes = new StorageChanges(this);
  }

  /**
   * Creates the data directory and opens (on first run, imports into) the
   * database, so a migration failure surfaces at start-up rather than
   * mid-command. Leases whose holders died long ago are purged.
   */
  async open(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.database.purgeAbandonedLeases();
  }

  /** Starts the hourly snapshot check, when snapshots are on. Idempotent. */
  startSnapshots(): void {
    if (!this.snapshots || this.snapshotTimers.length > 0) return;
    // Off the start-up path; then a cheap "is one due?" check every few minutes.
    const check = () => void takeHourlySnapshotIfDue(this.database, this.dataDir);
    const first = setTimeout(check, 60_000);
    const periodic = setInterval(check, BACKUP_CHECK_INTERVAL_MS);
    first.unref?.();
    periodic.unref?.();
    this.snapshotTimers = [first, periodic];
  }

  /**
   * The backend database, opened on first use. Opening is synchronous and runs
   * any pending migration, including the one-time import of the JSON stores.
   */
  get database(): StorageDatabase {
    if (!this.storageDatabase || this.storageDatabase.isClosed()) {
      // Reads and fetched bytes are charged by the default observers.
      this.storageDatabase = openBackendDatabase(this.dataDir);
    }
    return this.storageDatabase;
  }

  /** Closes the database connection and stops snapshots. Later calls reopen it. */
  close(): void {
    for (const timer of this.snapshotTimers) clearInterval(timer);
    this.snapshotTimers = [];
    this.storageDatabase?.close();
    this.storageDatabase = null;
  }

  /** The path of `name` in the data directory. */
  file(name: string): string {
    return path.join(this.dataDir, name);
  }

  /** The database store replacing `filePath`, or `null` for a file that stays a file. */
  storeForFile(filePath: string): string | null {
    const relative = path.relative(this.dataDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return databaseStoreForPath(relative);
  }

  /** Whether a store has ever been written (its file existed, for file stores). */
  async storeExists(filePath: string): Promise<boolean> {
    const store = this.storeForFile(filePath);
    if (store === null) return exists(filePath);
    const scope = this.atomicScope.getStore();
    if (scope?.writes.has(store)) return scope.writes.get(store) !== DELETED_STORE;
    return this.database.hasStore(store);
  }

  /**
   * Runs `operation` with every database-store write buffered, then commits
   * them in one SQLite transaction and only afterwards publishes the resource
   * announcements made inside. Reads inside see the buffered writes. Either
   * every store changes or none does, which replaces ordering-plus-marker
   * protocols between stores.
   *
   * Use only for pure storage work: anything that must be durable *before* an
   * external side effect (a provider send, a Docker call) belongs outside.
   * Locks are the caller's responsibility, exactly as without the scope.
   */
  async atomically<T>(operation: () => Promise<T>): Promise<T> {
    if (this.atomicScope.getStore()) return operation();
    const scope: AtomicStorageScope = {
      writes: new Map(),
      announcements: [],
      archiveCleanups: [],
      archiveTransforms: [],
      scrub: false,
      closed: false,
    };
    let result: T;
    try {
      result = await this.atomicScope.run(scope, operation);
    } finally {
      scope.closed = true;
    }
    const writes = [...scope.writes];
    if (writes.length > 0) {
      commitWithLegacyJsonCleanup(
        this.database,
        this.dataDir,
        () => {
          for (const [store, value] of writes) {
            if (value === DELETED_STORE) this.database.deleteStoreInTransaction(store);
            else this.database.writeStoreInTransaction(store, value);
          }
        },
        scope.archiveCleanups,
      );
      if (scope.scrub || writes.some(([, value]) => value === DELETED_STORE)) {
        this.database.scrubDeletedContent();
      }
    }
    for (const transform of scope.archiveTransforms) transform();
    for (const announcement of scope.announcements) announcement();
    return result;
  }

  /** The open atomic scope, if any; a closed one no longer buffers. */
  private openAtomicScope(): AtomicStorageScope | undefined {
    const scope = this.atomicScope.getStore();
    return scope && !scope.closed ? scope : undefined;
  }

  /**
   * Queues `callback` to run after the open {@link atomically} scope commits.
   * `false` when no scope is open: the caller runs it now.
   */
  deferUntilCommit(callback: () => void): boolean {
    const scope = this.openAtomicScope();
    if (!scope) return false;
    scope.announcements.push(callback);
    return true;
  }

  /**
   * Synchronous read-modify-write of one database store in a single SQLite
   * transaction. Because nothing awaits inside, SQLite's write lock alone
   * serializes it against this and every other backend process; no lease or
   * queue is needed. `mutate` changes the loaded value in place.
   */
  updateStore<V, T>(filePath: string, fallback: () => V, mutate: (value: V) => T): T {
    const store = this.storeForFile(filePath);
    if (store === null) throw new Error("updateStore requires a database store");
    const scope = this.openAtomicScope();
    if (scope) {
      const current = this.loadStore(store, fallback);
      const result = mutate(current);
      scope.writes.set(store, current);
      return result;
    }
    recurringWorkMetrics.work("storage-write");
    return this.database.updateStore(store, fallback, mutate);
  }

  /**
   * Synchronous read-modify-write of one row of a database store (a record
   * store's key, or a key in an envelope collection); see
   * {@link StorageDatabase.updateStoreRow}. Inside an atomic scope it applies
   * to the buffered whole value instead.
   */
  updateStoreRow<T>(
    filePath: string,
    key: string,
    mutate: (current: unknown) => RowUpdate<T>,
    options: { collection?: string } = {},
  ): T {
    const store = this.storeForFile(filePath);
    if (store === null) throw new Error("updateStoreRow requires a database store");
    const scope = this.openAtomicScope();
    if (scope) {
      const whole = this.loadStore<unknown>(store, () => ({}));
      const value: Record<string, unknown> = isRecord(whole) ? whole : {};
      const records: Record<string, unknown> = options.collection
        ? isRecord(value[options.collection])
          ? (value[options.collection] as Record<string, unknown>)
          : {}
        : value;
      const update = mutate(records[key]);
      if (update.delete) delete records[key];
      else if ("value" in update) records[key] = update.value;
      else return update.result;
      if (options.collection) value[options.collection] = records;
      scope.writes.set(store, value);
      return update.result;
    }
    recurringWorkMetrics.work("storage-write");
    return this.database.updateStoreRow(store, key, mutate, options);
  }

  private readStoreOr<V>(store: string, fallback: () => V): V {
    try {
      const snapshot = this.database.readStore(store);
      return snapshot ? (snapshot.value as V) : fallback();
    } catch (error) {
      // Imported from a legacy file that no backup could repair: like the old
      // JSON reader, treat it as absent; the next write replaces it.
      if (error instanceof StoreCorruptError) return fallback();
      throw error;
    }
  }

  private async writeAtomic(
    filePath: string,
    contents: string,
    makeBackup = true,
    mode?: number,
    refreshRecoveryBackup = false,
  ): Promise<void> {
    recurringWorkMetrics.work("storage-write");
    recurringWorkMetrics.bytes(contents.length);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomUUID()}.tmp`,
    );
    const recoveryTempPath = refreshRecoveryBackup
      ? path.join(
          path.dirname(filePath),
          `.${path.basename(filePath)}.recovery.${randomUUID()}.tmp`,
        )
      : null;

    // Structural writes (makeBackup) fsync so a crash cannot promote an empty
    // remnant. Volatile writes treat a lost refresh as recoverable.
    const writeDurableTemp = async (targetPath: string) => {
      const handle = await fs.open(targetPath, "w", mode ?? 0o666);
      try {
        await handle.writeFile(contents, "utf8");
        if (makeBackup) await handle.sync();
      } finally {
        await handle.close();
      }
    };

    await this.enqueueWrite(async () => {
      await writeDurableTemp(tempPath);
      if (recoveryTempPath) {
        // Volatile updates do not rotate five historical backups, but they
        // still need one current, valid recovery point.
        await writeDurableTemp(recoveryTempPath);
      }
      if (mode !== undefined) {
        await fs.chmod(tempPath, mode);
      }
      if (mode !== undefined && (await exists(filePath))) {
        // Backups of sensitive files must inherit the restricted mode too.
        await fs.chmod(filePath, mode);
      }
      if (makeBackup && (await exists(filePath))) {
        await this.rotateBackups(filePath, mode);
      }
      if (recoveryTempPath) {
        await fs.rename(recoveryTempPath, this.backupPath(filePath, 1));
      }
      await fs.rename(tempPath, filePath);
      // The next read must re-validate against the file we just renamed in.
      this.jsonReadCache.delete(filePath);
      if (mode !== undefined) {
        await fs.chmod(filePath, mode);
      }
    }).catch(async (error) => {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      if (recoveryTempPath) {
        await fs.rm(recoveryTempPath, { force: true }).catch(() => undefined);
      }
      throw error;
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Serializes one store's (or one key's) asynchronous read-modify-write in
   * this process and, through a database lease named after `target`, across
   * every backend process sharing the data directory.
   *
   * Prefer {@link updateStore} when the mutation is synchronous. This is for
   * critical sections that await other stores or external work.
   *
   * Lease order. A holder may take a lease that comes later in this order,
   * never an earlier one, so no two holders can wait on each other:
   *
   * 1. project creation (`project-creation-locks/<hash>`, held across Git and
   *    `gh` work);
   * 2. projects (`projects.json`);
   * 3. environments (`environments.json`);
   * 4. every other store-wide lease (one store each: Kanban, agent mail,
   *    reviews, build pipelines, configuration, ...).
   *
   * Native agent sessions add a keyed order of their own: the native service's
   * per-key work fence, then the session's `native-agent-session-leases/<hash>`
   * lease, then leaf leases (prompt queue, display tails). Never take a native
   * session lease while holding another one, a prompt-queue lease or the
   * environment lease.
   *
   * A lease only excludes other holders of the same lease. Every whole-value
   * writer of a store (`saveJson`, `saveSensitiveJson`, `deleteStore`) must
   * hold that store's lease; `storage-writer-guards.test.ts` enforces it.
   */
  serialize<T>(
    target: string,
    description: string,
    operation: () => Promise<T>,
    options: { staleMs?: number; acquireTimeoutMs?: number } = {},
  ): Promise<T> {
    const key = this.leaseName(target);
    const previous = this.mutationTails.get(key) ?? Promise.resolve();
    const run = async () => {
      const release = await this.acquireLease(target, description, options);
      try {
        // A retried deletion may now be a no-op. Finish its durable cleanup
        // before invoking code that can return without another write.
        replayLegacyJsonCleanup(this.database, this.dataDir);
        return await operation();
      } finally {
        await release();
      }
    };
    const next = previous.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.mutationTails.set(key, settled);
    void settled.finally(() => {
      if (this.mutationTails.get(key) === settled) this.mutationTails.delete(key);
    });
    return next;
  }

  /** Data-dir relative lease name for a mutation target path. */
  private leaseName(targetPath: string): string {
    const relative = path.relative(this.dataDir, targetPath);
    return relative.startsWith("..") || path.isAbsolute(relative)
      ? path.resolve(targetPath)
      : relative.split(path.sep).join("/");
  }

  /**
   * Cross-process exclusive lease for `targetPath`, held in the database.
   *
   * `staleMs` and `acquireTimeoutMs` must both exceed the critical section they
   * guard. The defaults suit a store read-modify-write; a caller that holds the
   * lease across child processes has to raise them, or a waiter will steal the
   * lease from a live holder whose event loop merely stalled (machine sleep is
   * the realistic case) and both will enter at once.
   */
  async acquireLease(
    targetPath: string,
    description: string,
    options: { staleMs?: number; acquireTimeoutMs?: number } = {},
  ): Promise<() => Promise<void>> {
    return this.database.acquireLease(this.leaseName(targetPath), description, options);
  }

  private backupPath(filePath: string, index: number): string {
    return path.join(path.dirname(filePath), `${path.basename(filePath)}.bak.${index}`);
  }

  private async rotateBackups(filePath: string, mode?: number): Promise<void> {
    // Never promote an empty/corrupt crash remnant over a valid recovery
    // ladder. The replacement write below can publish recovered state while
    // keeping the newest known-good backup at .bak.1.
    const cached = this.jsonReadCache.get(filePath);
    let primaryKnownGood = false;
    if (cached) {
      try {
        const stat = await fs.stat(filePath);
        const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        primaryKnownGood = cached.fingerprint === fingerprint;
      } catch {
        return;
      }
    }
    if (!primaryKnownGood) {
      try {
        const primary = await fs.readFile(filePath, "utf8");
        if (!primary.trim()) return;
        JSON.parse(primary);
      } catch {
        return;
      }
    }
    for (let index = MAX_JSON_BACKUPS - 1; index >= 1; index -= 1) {
      const current = this.backupPath(filePath, index);
      const next = this.backupPath(filePath, index + 1);
      if (await exists(next)) await fs.rm(next, { force: true });
      if (await exists(current)) {
        if (mode !== undefined) await fs.chmod(current, mode);
        await fs.rename(current, next);
      }
    }

    const first = this.backupPath(filePath, 1);
    if (await exists(first)) await fs.rm(first, { force: true });
    await fs.copyFile(filePath, first);
    if (mode !== undefined) await fs.chmod(first, mode);
  }

  /**
   * Newest-first walk of a JSON file's retained backups. Returns a box rather
   * than the value itself so callers can tell "recovered `null`/`[]` from a
   * backup" apart from "no backup was readable". Database stores have no
   * backups: SQLite's journal makes every commit atomic.
   */
  private async recoverJsonFromBackups<T>(filePath: string): Promise<{ value: T } | null> {
    if (this.storeForFile(filePath) !== null) return null;
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(filePath, index);
      if (!(await exists(backup))) continue;
      try {
        return { value: JSON.parse(await fs.readFile(backup, "utf8")) as T };
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Reads a store. Database stores come from SQLite (an unreadable imported
   * document reads as absent, as a corrupt file without backups did); the
   * stores that remain files keep the backup-ladder reader.
   */
  async loadJson<T>(filePath: string, fallback: () => T): Promise<T> {
    const store = this.storeForFile(filePath);
    if (store !== null) return this.loadStore(store, fallback);
    if (!(await exists(filePath))) return fallback();

    try {
      const raw = await fs.readFile(filePath, "utf8");
      recurringWorkMetrics.work("storage-read");
      recurringWorkMetrics.bytes(raw.length);
      if (!raw.trim()) throw new SyntaxError("Empty JSON store");
      return JSON.parse(raw) as T;
    } catch {
      const recovered = await this.recoverJsonFromBackups<T>(filePath);
      return recovered ? recovered.value : fallback();
    }
  }

  private loadStore<T>(store: string, fallback: () => T): T {
    const scope = this.openAtomicScope();
    if (scope?.writes.has(store)) {
      const buffered = scope.writes.get(store);
      return buffered === DELETED_STORE ? fallback() : (structuredClone(buffered) as T);
    }
    return this.readStoreOr(store, fallback);
  }

  /**
   * The items of an array/record store whose indexed owner column equals
   * `owner` (e.g. one project's Kanban tickets), without assembling the whole
   * store. Inside an atomic scope it filters the buffered value instead.
   */
  loadStoreRowsByOwner<T>(filePath: string, owner: string): T[] {
    const store = this.storeForFile(filePath);
    if (store === null) throw new Error("loadStoreRowsByOwner requires a database store");
    const scope = this.openAtomicScope();
    if (scope?.writes.has(store)) {
      const layout = storeLayout(store);
      const ownerOf =
        layout.kind === "array" || layout.kind === "record" ? layout.owner : undefined;
      const buffered = this.loadStore<unknown>(store, () => []);
      const items = Array.isArray(buffered)
        ? buffered
        : isRecord(buffered)
          ? Object.values(buffered)
          : [];
      return items.filter((item) => ownerOf?.(item) === owner) as T[];
    }
    try {
      return (this.database.readStoreRowsByOwner(store, owner) ?? []) as T[];
    } catch (error) {
      if (error instanceof StoreCorruptError) return [];
      throw error;
    }
  }

  /**
   * One row of a database store by key (an array item, a record key, or a key
   * of one envelope collection) without assembling the whole store, so a
   * lookup costs the row, not every other record. `undefined` when absent or
   * unreadable, as {@link loadJson} treats an unreadable store. Inside an
   * atomic scope it reads the buffered value instead.
   */
  loadStoreRow(filePath: string, key: string, options: { collection?: string } = {}): unknown {
    const store = this.storeForFile(filePath);
    if (store === null) throw new Error("loadStoreRow requires a database store");
    const scope = this.openAtomicScope();
    if (scope?.writes.has(store)) {
      const buffered = this.loadStore<unknown>(store, () => ({}));
      if (Array.isArray(buffered)) {
        const layout = storeLayout(store);
        const field = layout.kind === "array" ? (layout.key ?? "id") : "id";
        return buffered.find((item) => isRecord(item) && item[field] === key);
      }
      const records = options.collection
        ? isRecord(buffered)
          ? buffered[options.collection]
          : undefined
        : buffered;
      return isRecord(records) ? records[key] : undefined;
    }
    try {
      return this.database.readStoreRow(store, key, options.collection);
    } catch (error) {
      if (error instanceof StoreCorruptError) return undefined;
      throw error;
    }
  }

  /**
   * Strict read of a database store: an unreadable value throws rather than
   * reading as absent. For stores whose corruption must refuse work instead of
   * looking empty (the public operation ledger).
   */
  loadStoreStrict<T>(filePath: string): { value: T } | null {
    const store = this.storeForFile(filePath);
    if (store === null) throw new Error("loadStoreStrict requires a database store");
    const scope = this.openAtomicScope();
    if (scope?.writes.has(store)) {
      const buffered = scope.writes.get(store);
      return buffered === DELETED_STORE ? null : { value: structuredClone(buffered) as T };
    }
    const snapshot = this.database.readStore(store);
    return snapshot ? { value: snapshot.value as T } : null;
  }

  /**
   * Cached variant of {@link loadJson}. Database stores are always cached
   * (validated against their committed revision); files are validated with a
   * stat fingerprint, which also observes the desktop process's writes.
   * Returns a fresh value callers may mutate.
   */
  async loadJsonCached<T>(filePath: string, fallback: () => T): Promise<T> {
    const store = this.storeForFile(filePath);
    if (store !== null) return this.loadStore(store, fallback);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      this.jsonReadCache.delete(filePath);
      if (!isMissingFileError(error)) {
        // A stat that fails for a reason other than "not there" is no evidence
        // that the store is empty; take the backup ladder or surface it.
        const recovered = await this.recoverJsonFromBackups<T>(filePath);
        if (recovered) return recovered.value;
        throw error;
      }
      return fallback();
    }
    const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = this.jsonReadCache.get(filePath);
    if (cached && cached.fingerprint === fingerprint) {
      recurringWorkMetrics.work("storage-stat");
      return structuredClone(cached.value) as T;
    }
    const value = await this.loadJson(filePath, fallback);
    this.jsonReadCache.set(filePath, { fingerprint, value: structuredClone(value) });
    return value;
  }

  /**
   * Persists a store's complete new value. For database stores only the
   * changed rows are written, in one transaction (or buffered by an open
   * {@link atomically} scope); `backup` is meaningless there.
   *
   * For files, `backup: false` skips the five-file backup rotation. Reserved
   * for high-churn writes that only refresh volatile fields.
   */
  async saveJson(
    filePath: string,
    value: unknown,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    if (this.saveStore(filePath, value)) return;
    await this.writeAtomic(
      filePath,
      `${JSON.stringify(value, null, 2)}\n`,
      options.backup ?? true,
      undefined,
      options.backup === false,
    );
  }

  async saveSensitiveJson(
    filePath: string,
    value: unknown,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    const store = this.storeForFile(filePath);
    if (store !== null) {
      // The retired JSON archive stays the pre-migration copy a downgrade
      // restores from. A save that removes content prunes only that content
      // from every archived copy; one that removes nothing leaves the archive
      // untouched. Environment copies have an attributable scrub at the
      // deleting boundary.
      const archived = store !== "environments" && hasLegacyJsonStore(this.dataDir, store);
      let previous: unknown = MISSING_PREVIOUS;
      if (archived) {
        try {
          const snapshot = this.loadStoreStrict<unknown>(filePath);
          previous = snapshot ? snapshot.value : MISSING_PREVIOUS;
        } catch (error) {
          if (!(error instanceof StoreCorruptError)) throw error;
          previous = UNKNOWN_PREVIOUS;
        }
      }
      const cleanups: LegacyJsonCleanup[] =
        archived &&
        previous !== MISSING_PREVIOUS &&
        (previous === UNKNOWN_PREVIOUS || pruneRemovedContent(previous, value) !== previous)
          ? [{ store, kind: "prune", next: structuredClone(value) }]
          : [];
      // The intent and write share a commit, including inside atomically().
      this.saveStore(filePath, value, cleanups);
      return;
    }
    await this.writeAtomic(
      filePath,
      `${JSON.stringify(value, null, 2)}\n`,
      options.backup ?? true,
      0o600,
      options.backup === false,
    );
  }

  /** Writes a database store; `false` when `filePath` remains a file. */
  private saveStore(filePath: string, value: unknown, cleanups: LegacyJsonCleanup[] = []): boolean {
    const store = this.storeForFile(filePath);
    if (store === null) return false;
    const scope = this.openAtomicScope();
    if (scope) {
      scope.writes.set(store, structuredClone(value));
      scope.archiveCleanups.push(...cleanups);
      return true;
    }
    recurringWorkMetrics.work("storage-write");
    commitWithLegacyJsonCleanup(
      this.database,
      this.dataDir,
      () => {
        this.database.writeStoreInTransaction(store, value);
      },
      cleanups,
    );
    return true;
  }

  /**
   * Removes a database store entirely, with every retired JSON copy of it, or
   * the file that holds a file store.
   */
  async deleteStore(filePath: string): Promise<void> {
    const store = this.storeForFile(filePath);
    if (store === null) {
      await fs.rm(filePath, { force: true });
      this.jsonReadCache.delete(filePath);
      return;
    }
    const scope = this.openAtomicScope();
    if (scope) {
      scope.writes.set(store, DELETED_STORE);
      scope.archiveCleanups.push({ store, kind: "delete" });
    } else {
      commitWithLegacyJsonCleanup(
        this.database,
        this.dataDir,
        () => {
          this.database.deleteStoreInTransaction(store);
        },
        [{ store, kind: "delete" }],
      );
      this.database.scrubDeletedContent();
    }
  }

  /**
   * Makes records removed from a sensitive store unrecoverable.
   *
   * For a database store the deleting commit is already the only copy:
   * `secure_delete` zeroes freed pages and a truncating checkpoint discards
   * the WAL frames that still hold the old rows. The JSON files that remain
   * files keep rewriting their retained backups.
   *
   * `keep` receives each stored entry; anything it rejects is dropped, so a
   * caller passes the same predicate it used on the primary store.
   */
  async scrubSensitiveJsonBackups(
    filePath: string,
    keep: (storedId: string, record: unknown) => boolean,
  ): Promise<void> {
    await this.transformSensitiveJsonBackups(filePath, (parsed) =>
      Object.fromEntries(
        Object.entries(parsed).filter(([storedId, record]) => keep(storedId, record)),
      ),
    );
  }

  /** Archive transforms share the deleting mutation's atomic commit boundary. */
  scrubLegacyArchive(store: string, transform: (value: unknown) => unknown): void {
    const scrub = () => scrubLegacyJsonStore(this.dataDir, store, transform);
    const scope = this.openAtomicScope();
    if (scope) scope.archiveTransforms.push(scrub);
    else scrub();
  }

  /** Rewrites every retained sensitive backup while preserving its record shape. */
  async transformSensitiveJsonBackups(
    filePath: string,
    transform: (records: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    if (this.storeForFile(filePath) !== null) {
      this.scrubLegacyArchive(this.storeForFile(filePath)!, (value) => {
        if (!isRecord(value)) throw new Error("Unattributable legacy backup");
        return transform(value);
      });
      this.scrubDeletedDatabaseContent();
      return;
    }
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(filePath, index);
      if (!(await exists(backup))) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(backup, "utf8")) as Record<string, unknown>;
        if (!isRecord(parsed)) throw new Error("Backup is not a record");
        const sanitized = transform(parsed);
        await this.writeAtomic(backup, `${JSON.stringify(sanitized, null, 2)}\n`, false, 0o600);
      } catch {
        // A corrupt backup cannot be proven free of the deleted records.
        await fs.rm(backup, { force: true });
      }
    }
  }

  /** Discards WAL frames holding content that a committed delete removed. */
  scrubDeletedDatabaseContent(): void {
    // Inside an atomic scope the delete has not committed yet: scrub once the
    // scope's transaction has.
    const scope = this.openAtomicScope();
    if (scope) {
      scope.scrub = true;
      return;
    }
    this.database.scrubDeletedContent();
  }
}

const DELETED_STORE: unique symbol = Symbol("deleted store");

const MISSING_PREVIOUS: unique symbol = Symbol("missing previous value");

/** A present but unreadable store: nothing shows what the save kept. */
const UNKNOWN_PREVIOUS: unique symbol = Symbol("unknown previous value");

type AtomicStorageScope = {
  /** Buffered new value per store, or {@link DELETED_STORE}. */
  writes: Map<string, unknown>;
  announcements: Array<() => void>;
  archiveCleanups: LegacyJsonCleanup[];
  archiveTransforms: Array<() => void>;
  /** A delete inside asked for the post-commit WAL scrub. */
  scrub: boolean;
  closed: boolean;
};
