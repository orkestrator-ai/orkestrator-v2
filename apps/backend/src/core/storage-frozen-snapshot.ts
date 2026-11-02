import type { StorageContext } from "./storage-context.js";
import type { StorageDatabase } from "./storage-database.js";

/**
 * Serialized length (UTF-16 code units, as `observeFetch` counts) above which a
 * snapshot is still built and returned but not kept for the next call. One
 * snapshot is kept per instance, so this is also the bound on what it retains.
 */
export const FROZEN_SNAPSHOT_MAX_RETAINED_LENGTH = 64 * 1024 * 1024;

type DecodedRow = { value: string; decoded: unknown };

export interface FrozenStoreSnapshotOptions<T> {
  /** The record or array store the snapshot reads. */
  filePath: string;
  /**
   * Decodes one parsed row (an array item or a record value). Runs once per
   * changed serialized value; may normalize in place. The result is frozen.
   */
  decodeRow?: (parsed: unknown, key: string) => unknown;
  /** Builds the shared value from the decoded rows, in stored order. */
  build: (rows: ReadonlyArray<{ key: string; decoded: unknown }>) => T;
  /**
   * A fresh whole-store read, used when there are no committed rows to reuse:
   * inside an atomic scope that buffers this store, for a store held whole as
   * a document, and for an unreadable row (so corruption reads exactly as the
   * repository's own loader reads it).
   */
  load: () => Promise<T>;
  /** Defaults to {@link FROZEN_SNAPSHOT_MAX_RETAINED_LENGTH}. */
  maxRetainedLength?: number;
}

/**
 * One decoded, deeply frozen copy of a store per committed revision, shared by
 * read-only background callers (the activity sweep, the interaction tracker,
 * the tmux reconcile) so a sweep does not parse the environment and session
 * stores once per job. It follows the agent mail read model
 * (`AgentMailStore.snapshot`): the store's revision moves on every write by
 * this or any other process, so a read never sees an older store than a fresh
 * load would, and a rebuild re-decodes only the rows whose serialized value
 * changed. An unchanged store costs one revision query.
 *
 * Never mutate the result or anything reached from it (it is frozen, so a
 * write throws); read-modify-write paths keep loading a mutable copy.
 */
export class FrozenStoreSnapshot<T> {
  private model: {
    /** The connection the revision belongs to; a reopened one rebuilds. */
    database: StorageDatabase;
    revision: number;
    value: T;
    rows: Map<string, DecodedRow>;
  } | null = null;

  constructor(
    private readonly context: StorageContext,
    private readonly options: FrozenStoreSnapshotOptions<T>,
  ) {}

  async read(): Promise<T> {
    const serialized = this.context.loadStoreSerialized(this.options.filePath);
    if (serialized === undefined || serialized?.mode === "document") {
      // Buffered by an atomic scope, or stored whole: no rows to reuse.
      this.model = null;
      return deepFreeze(await this.options.load());
    }
    if (serialized === null) {
      this.model = null;
      return deepFreeze(this.options.build([]));
    }
    const database = this.context.database;
    if (this.model?.database === database && this.model.revision === serialized.revision) {
      return this.model.value;
    }
    // Reusing a decoded row needs only its serialized value to match, whatever
    // the revision or connection it was decoded under.
    const previous = this.model?.rows;
    const rows = new Map<string, DecodedRow>();
    const ordered: Array<{ key: string; decoded: unknown }> = [];
    let length = 0;
    try {
      // Assembled in the order `assembleStoredValue` uses.
      const stored = [...serialized.rows]
        .filter((row) => row.collection === "")
        .sort((a, b) => a.position - b.position);
      for (const row of stored) {
        length += row.value.length;
        const known = previous?.get(row.key);
        const decoded =
          known && known.value === row.value
            ? known.decoded
            : deepFreeze(this.decode(JSON.parse(row.value) as unknown, row.key));
        rows.set(row.key, { value: row.value, decoded });
        ordered.push({ key: row.key, decoded });
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.model = null;
      return deepFreeze(await this.options.load());
    }
    const value = deepFreeze(this.options.build(ordered));
    const maxRetainedLength = this.options.maxRetainedLength ?? FROZEN_SNAPSHOT_MAX_RETAINED_LENGTH;
    this.model =
      length <= maxRetainedLength ? { database, revision: serialized.revision, value, rows } : null;
    return value;
  }

  private decode(parsed: unknown, key: string): unknown {
    return this.options.decodeRow ? this.options.decodeRow(parsed, key) : parsed;
  }
}

/** Freezes `value` and everything reachable from it, skipping frozen subtrees. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
