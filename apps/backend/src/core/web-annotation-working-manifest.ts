/**
 * Copy-on-write working manifest of one web-annotation commit.
 *
 * A committed manifest is deep-frozen (`freezeRowValue`), so a mutation can
 * neither corrupt it nor change a row without the commit seeing it: writing
 * into a committed row throws. A transaction instead gets a working manifest
 * whose collections are shallow copies made on first access (pointer copies,
 * no row is cloned), and replaces the rows it changes, either directly
 * (`tx.manifest.requests[id] = { ...request, state }`) or through
 * `WebAnnotationTransaction.edit`, which swaps in a private clone of one row.
 *
 * At commit, a row whose value is still the committed object is unchanged, so
 * only replaced rows are serialized (`changes`), and the next committed
 * manifest reuses every untouched collection and row (`commit`). A `work`
 * callback that throws leaves the committed manifest as it was.
 */
import {
  freezeRowValue,
  type GroupChange,
  type RowChange,
  type RowChanges,
} from "./web-annotation-store-rows.js";
import type {
  ManifestEntry,
  ManifestReceipt,
  WebAnnotationManifest,
} from "./web-annotation-storage-format.js";

/** Manifest collections stored one row per key, and their row collection. */
const KEYED = {
  annotations: "annotations",
  changedAt: "changed",
  captures: "captures",
  requests: "requests",
  results: "results",
  assets: "assets",
  drafts: "drafts",
} as const;

type KeyedField = keyof typeof KEYED;
/** Group name prefix of one annotation's entries (see `manifestRows`). */
const ENTRY_GROUP = "e\u0000";
/** Collections a transaction may `edit` one row of. */
export type EditableCollection = Exclude<KeyedField, "changedAt">;
type CopiedField = KeyedField | "entries" | "receipts" | "migration";

const COPIED: readonly CopiedField[] = [
  ...(Object.keys(KEYED) as KeyedField[]),
  "entries",
  "receipts",
  "migration",
];

function copyOf(field: CopiedField, value: unknown): unknown {
  if (field === "receipts") return (value as ManifestReceipt[]).slice();
  // One row, edited in place by the migration flow.
  if (field === "migration") return structuredClone(value);
  return { ...(value as Record<string, unknown>) };
}

function dedupeReceipts(receipts: readonly ManifestReceipt[]): ManifestReceipt[] {
  // Lookups return the first receipt of an operation id (see `manifestRows`).
  const seen = new Set<string>();
  return receipts.filter((receipt) => {
    if (seen.has(receipt.operationId)) return false;
    seen.add(receipt.operationId);
    return true;
  });
}

/** Fields whose copy records the keys written into it. */
type TrackedField = KeyedField | "entries";

function isTracked(field: CopiedField): field is TrackedField {
  return field === "entries" || field in KEYED;
}

export class WorkingManifest {
  /** What the transaction reads and edits. */
  readonly manifest: WebAnnotationManifest;
  /** The copies themselves (what commits), by field. */
  private readonly copies = new Map<CopiedField, unknown>();
  /** What `manifest` hands out: a key-tracking view of a keyed copy. */
  private readonly views = new Map<CopiedField, unknown>();
  /** Keys set or deleted through a view, so `changes` visits only those. */
  private readonly written = new Map<TrackedField, Set<string>>();
  /** Fields the transaction assigned a whole new object to: diffed in full. */
  private readonly replaced = new Set<CopiedField>();
  /** Shallow copies made: the commit's only O(collection) work, pointer copies. */
  copiedCollections = 0;

  constructor(private readonly base: Readonly<WebAnnotationManifest>) {
    const manifest = { ...base } as WebAnnotationManifest;
    for (const field of COPIED) {
      Object.defineProperty(manifest, field, {
        enumerable: true,
        configurable: false,
        get: () => this.copy(field),
        set: (value: unknown) => {
          this.copies.set(field, value);
          this.views.set(field, value);
          this.replaced.add(field);
        },
      });
    }
    this.manifest = manifest;
  }

  private copy(field: CopiedField): unknown {
    if (!this.copies.has(field)) {
      const copy = copyOf(field, this.base[field]);
      this.copies.set(field, copy);
      this.views.set(field, isTracked(field) ? this.track(field, copy as object) : copy);
      this.copiedCollections += 1;
    }
    return this.views.get(field);
  }

  /**
   * Records the keys written into a keyed copy. Reads pass straight through
   * (no `get` trap), so lookups stay plain property reads.
   */
  private track(field: TrackedField, copy: object): object {
    const keys = new Set<string>();
    this.written.set(field, keys);
    const note = (key: string | symbol) => {
      if (typeof key === "string") keys.add(key);
    };
    return new Proxy(copy, {
      set: (target, key, value) => {
        note(key);
        return Reflect.set(target, key, value);
      },
      deleteProperty: (target, key) => {
        note(key);
        return Reflect.deleteProperty(target, key);
      },
      defineProperty: (target, key, descriptor) => {
        note(key);
        return Reflect.defineProperty(target, key, descriptor);
      },
    });
  }

  /** Keys of `field` that may have changed: the written ones, or all of them. */
  private candidateKeys(field: TrackedField): Iterable<string> {
    if (!this.replaced.has(field)) return this.written.get(field) ?? [];
    const before = this.base[field] as object;
    const after = this.copies.get(field) as object;
    return new Set([...Object.keys(after), ...Object.keys(before)]);
  }

  /**
   * A private, mutable clone of one committed row, put in place of it, so
   * code written against mutable objects can edit it. Returns the same
   * clone for later calls; `undefined` when there is no such row.
   */
  edit<C extends EditableCollection>(
    collection: C,
    key: string,
  ): WebAnnotationManifest[C][string] | undefined {
    const rows = this.copy(collection) as Record<string, WebAnnotationManifest[C][string]>;
    const current = rows[key];
    if (current === undefined || !Object.isFrozen(current)) return current;
    const clone = structuredClone(current);
    rows[key] = clone;
    return clone;
  }

  /** The rows this transaction replaced, removed or added. */
  changes(): RowChanges {
    const rows: RowChange[] = [];
    const groups: GroupChange[] = [];
    for (const field of Object.keys(KEYED) as KeyedField[]) {
      if (!this.copies.has(field)) continue;
      const collection = KEYED[field];
      const before = this.base[field] as Record<string, unknown>;
      const after = this.copies.get(field) as Record<string, unknown>;
      for (const key of this.candidateKeys(field)) {
        const value = Object.hasOwn(after, key) ? after[key] : undefined;
        const committed = Object.hasOwn(before, key) ? before[key] : undefined;
        if (value !== committed) rows.push({ collection, key, value });
      }
    }
    // Listed even when untouched: the committed object is skipped without
    // serializing, and a new store gets its first migration row.
    rows.push({
      collection: "meta",
      key: "migration",
      value: this.copies.get("migration") ?? this.base.migration,
    });
    if (this.copies.has("entries")) {
      const before = this.base.entries;
      const after = this.copies.get("entries") as Record<string, ManifestEntry[] | undefined>;
      const changed = Array.from(this.candidateKeys("entries")).filter(
        (key) =>
          (Object.hasOwn(after, key) ? after[key] : undefined) !==
          (Object.hasOwn(before, key) ? before[key] : undefined),
      );
      for (const annotationId of changed) {
        groups.push({
          group: `${ENTRY_GROUP}${annotationId}`,
          members: (after[annotationId] ?? []).map((entry) => ({
            collection: "entries",
            key: entry.id,
            value: entry,
          })),
          previous: (before[annotationId] ?? []).map((entry) => ({
            collection: "entries",
            key: entry.id,
          })),
        });
      }
    }
    if (this.copies.has("receipts")) {
      const before = this.base.receipts;
      const after = this.copies.get("receipts") as ManifestReceipt[];
      const same =
        after.length === before.length &&
        after.every((receipt, index) => receipt === before[index]);
      if (!same) {
        groups.push({
          group: "receipts",
          members: dedupeReceipts(after).map((receipt) => ({
            collection: "receipts",
            key: receipt.operationId,
            value: receipt,
          })),
          previous: dedupeReceipts(before).map((receipt) => ({
            collection: "receipts",
            key: receipt.operationId,
          })),
        });
      }
    }
    return { rows, groups };
  }

  /**
   * The next committed manifest: untouched collections are shared with the
   * base, copied ones are adopted. Freezes only what is new, the values in
   * `changes` and the containers holding them: every other value in a copy
   * is still a frozen committed one, so the copies freeze shallowly.
   */
  commit(changes: RowChanges): WebAnnotationManifest {
    const next = {} as Record<string, unknown>;
    for (const field of Object.keys(this.manifest)) {
      next[field] = COPIED.includes(field as CopiedField)
        ? this.copies.has(field as CopiedField)
          ? this.copies.get(field as CopiedField)
          : this.base[field as CopiedField]
        : this.manifest[field as keyof WebAnnotationManifest];
    }
    for (const change of changes.rows) freezeRowValue(change.value);
    const entries = next.entries as Record<string, ManifestEntry[] | undefined>;
    for (const group of changes.groups) {
      for (const member of group.members) freezeRowValue(member.value);
      if (group.group.startsWith(ENTRY_GROUP)) {
        const list = entries[group.group.slice(ENTRY_GROUP.length)];
        if (list) Object.freeze(list);
      }
    }
    for (const field of Object.keys(KEYED) as KeyedField[]) {
      if (this.copies.has(field)) Object.freeze(next[field]);
    }
    if (this.copies.has("entries")) Object.freeze(entries);
    // Small and bounded: frozen deeply, which also covers duplicate receipts.
    if (this.copies.has("receipts")) freezeRowValue(next.receipts);
    if (this.copies.has("migration")) freezeRowValue(next.migration);
    freezeRowValue(next.usage);
    freezeRowValue(next.consumedDrafts);
    return Object.freeze(next) as unknown as WebAnnotationManifest;
  }
}
