import type { StorageContext } from "./storage-context.js";

/** The single row's key: one history per backend data directory. */
const MACHINE_LOAD_HISTORY_ROW = "local";

/**
 * The `machine-load-history` store: one row holding this machine's load
 * history (`machine-load-history-document.ts`), so its 24-hour figure survives
 * a backend restart (#2287). Numbers only. Written by the sampler about
 * once every 15 minutes and at shutdown, each write one `updateStoreRow`; the
 * row is never deleted. Validation lives with the sampler: this returns the
 * stored value as is.
 */
export class MachineLoadHistoryRepository {
  constructor(private readonly context: StorageContext) {}

  private machineLoadHistoryFile(): string {
    return this.context.file("machine-load-history.json");
  }

  /** The stored document, or `undefined` when none was written. Throws on an unreadable row. */
  loadMachineLoadHistory(): unknown {
    return this.context.loadStoreRow(this.machineLoadHistoryFile(), MACHINE_LOAD_HISTORY_ROW, {
      unreadable: "throw",
    });
  }

  /** Replaces the document; an unreadable row is overwritten. */
  saveMachineLoadHistory(document: unknown): void {
    this.context.updateStoreRow<void>(
      this.machineLoadHistoryFile(),
      MACHINE_LOAD_HISTORY_ROW,
      () => ({ result: undefined, value: document }),
      { unreadableRow: "replace" },
    );
  }
}

/**
 * The machine-load history store: what callers reach as
 * `storage.machineLoadHistory`. Every name here is an entry point
 * `storage-writer-guards.test.ts` follows store writes back to.
 */
export type MachineLoadHistoryStorage = Pick<
  MachineLoadHistoryRepository,
  "loadMachineLoadHistory" | "saveMachineLoadHistory"
>;
