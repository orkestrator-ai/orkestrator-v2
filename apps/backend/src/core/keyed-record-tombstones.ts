import { AsyncMutex } from "./keyed-record-concurrency.js";
import { statFingerprint } from "./keyed-record-format.js";
import {
  boundTombstones,
  emptyTombstones,
  isTombstoneState,
  ownerTombstoneKey,
  readMetaJson,
  writeMetaJson,
  type TombstoneState,
} from "./keyed-record-meta.js";
import type { KeyedRecordLock } from "./keyed-record-store.js";

const MAX_TOMBSTONE_FILE_BYTES = 512 * 1024;

/**
 * Durable deletion markers for one keyed-record namespace.
 *
 * Their only job is to stop a legacy import (or a retried migration) from
 * recreating a record the user already deleted. They are bounded by count
 * and lifetime; a count overflow is recorded so the consumer can retire the
 * legacy source rather than trust an incomplete set. Retire them once the
 * legacy source and its backups are gone.
 */
export class KeyedRecordTombstones {
  private readonly mutex = new AsyncMutex();
  private cached: { fingerprint: string | null; state: TombstoneState } | null = null;

  constructor(
    private readonly options: {
      file: string;
      namespace: string;
      lock?: KeyedRecordLock;
      now: () => number;
      maxEntries: number;
      ttlMs: number;
      ensureDirectory: () => Promise<void>;
    },
  ) {}

  /** Current markers, re-read only when the file's fingerprint changed. */
  async read(): Promise<TombstoneState> {
    const fingerprint = await statFingerprint(this.options.file);
    if (this.cached && this.cached.fingerprint === fingerprint) return this.cached.state;
    if (fingerprint === null) {
      this.cached = { fingerprint: null, state: emptyTombstones() };
      return this.cached.state;
    }
    const read = await readMetaJson(this.options.file, MAX_TOMBSTONE_FILE_BYTES, isTombstoneState);
    // A corrupt marker file cannot prove which deletions it held; report it
    // as overflowed so consumers stop relying on the legacy source.
    const state = read.status === "ok" ? read.value : { ...emptyTombstones(), overflowed: true };
    this.cached = { fingerprint: read.status === "ok" ? read.fingerprint : fingerprint, state };
    return state;
  }

  async isTombstoned(stem: string, owner: Record<string, string> = {}): Promise<boolean> {
    const state = await this.read();
    if (state.keys[stem] !== undefined) return true;
    return Object.entries(owner).some(
      ([attribute, value]) => state.owners[ownerTombstoneKey(attribute, value)] !== undefined,
    );
  }

  addKey(stem: string): Promise<void> {
    return this.mutate((state) => {
      state.keys[stem] = this.options.now();
    });
  }

  addOwner(attribute: string, value: string): Promise<void> {
    return this.mutate((state) => {
      state.owners[ownerTombstoneKey(attribute, value)] = this.options.now();
    });
  }

  /** Removes every marker; call only after the legacy source is retired. */
  retireAll(): Promise<void> {
    return this.mutate((state) => {
      state.keys = {};
      state.owners = {};
      state.overflowed = false;
    });
  }

  private mutate(change: (state: TombstoneState) => void): Promise<void> {
    return this.mutex.run(async () => {
      await this.options.ensureDirectory();
      const release = this.options.lock ? await this.options.lock(this.options.file) : null;
      try {
        this.cached = null;
        const current = structuredClone(await this.read());
        change(current);
        const bounded = boundTombstones(current, {
          now: this.options.now(),
          ttlMs: this.options.ttlMs,
          maxEntries: this.options.maxEntries,
        });
        const fingerprint = await writeMetaJson(this.options.file, bounded, {
          durable: true,
          maxBytes: MAX_TOMBSTONE_FILE_BYTES,
        });
        this.cached = { fingerprint, state: bounded };
      } finally {
        await release?.();
      }
    });
  }
}
