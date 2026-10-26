import { describe, expect, test } from "bun:test";
import { fixtureAnnotation } from "@orkestrator/protocol/testing/web-annotations-fixtures";
import {
  assertSameRowPlan,
  defaultMeta,
  emptySnapshot,
  freezeRowValue,
  planChangedRows,
  planRows,
  type RowPlan,
  type StoreSnapshot,
} from "./web-annotation-store-rows.js";
import {
  emptyManifest,
  type ManifestEntry,
  type ManifestReceipt,
  type WebAnnotationManifest,
} from "./web-annotation-storage-format.js";
import { WorkingManifest } from "./web-annotation-working-manifest.js";

const ENV = "env-working-manifest";
const NOW = "2026-10-26T00:00:00.000Z";

function entry(annotationId: string, sequence: number): ManifestEntry {
  return {
    id: `entry-${annotationId}-${sequence}`,
    annotationId,
    sequence,
    kind: "comment",
    provenance: "host-user",
    bytes: 10,
    createdAt: NOW,
  };
}

function receipt(index: number): ManifestReceipt {
  return { operationId: `op-${index}`, kind: "create", bodyHash: "h", recordedAt: NOW };
}

/** A committed snapshot of `count` annotations with two entries each. */
function committed(count: number): StoreSnapshot {
  const manifest = emptyManifest(ENV, NOW);
  for (let index = 0; index < count; index++) {
    const id = `annotation-${index}`;
    manifest.annotations[id] = fixtureAnnotation({ id, environmentId: ENV });
    manifest.changedAt[id] = 1;
    manifest.entries[id] = [entry(id, 1), entry(id, 2)];
  }
  manifest.receipts = [receipt(1), receipt(2)];
  const meta = defaultMeta(ENV, NOW);
  const plan = planRows(emptySnapshot(ENV, NOW), manifest, meta, new Map());
  return {
    storeRevision: 1,
    manifest: freezeRowValue(manifest),
    meta: freezeRowValue(meta),
    unreadable: new Map(),
    rows: plan.rows,
    values: plan.values,
    indexBytes: plan.indexBytes,
    maxPosition: plan.maxPosition,
  };
}

/** Commit a working manifest the way storage does; returns both plans. */
function commit(
  base: StoreSnapshot,
  work: (manifest: WebAnnotationManifest, working: WorkingManifest) => void,
): { incremental: RowPlan; full: RowPlan; next: WebAnnotationManifest; working: WorkingManifest } {
  const working = new WorkingManifest(base.manifest);
  work(working.manifest, working);
  const meta = freezeRowValue({ ...base.meta, revision: base.meta.revision + 1 });
  const changes = working.changes();
  changes.rows.push({ collection: "meta", key: "state", value: meta });
  const incremental = planChangedRows(base, changes);
  const next = working.commit(changes);
  const full = planRows(base, next, meta, base.unreadable);
  return { incremental, full, next, working };
}

describe("copy-on-write working manifest", () => {
  test("a committed manifest is deep-frozen, so writing into it throws", () => {
    const base = committed(2);
    expect(Object.isFrozen(base.manifest.annotations)).toBe(true);
    expect(() => {
      (base.manifest.annotations["annotation-0"] as { title: string }).title = "changed";
    }).toThrow();
    expect(() => {
      base.manifest.entries["annotation-0"]!.push(entry("annotation-0", 3));
    }).toThrow();
    const working = new WorkingManifest(base.manifest);
    expect(() => {
      working.manifest.annotations["annotation-1"]!.hidden = true;
    }).toThrow();
  });

  test("reads copy nothing; a touched collection is copied once, shallowly", () => {
    const base = committed(3);
    const working = new WorkingManifest(base.manifest);
    expect(working.copiedCollections).toBe(0);
    const annotation = working.manifest.annotations["annotation-0"];
    expect(working.manifest.annotations["annotation-1"]).toBeDefined();
    expect(working.copiedCollections).toBe(1);
    // Rows are shared with the committed manifest, not cloned.
    expect(annotation).toBe(base.manifest.annotations["annotation-0"]);
    expect(working.changes().rows.map((row) => row.key)).toEqual(["migration"]);
  });

  test("edit swaps in one private clone and leaves the committed row intact", () => {
    const base = committed(2);
    const before = base.manifest.annotations["annotation-0"]!;
    const { incremental, full, next, working } = commit(base, (_manifest, working) => {
      const edited = working.edit("annotations", "annotation-0")!;
      expect(edited).not.toBe(before);
      expect(working.edit("annotations", "annotation-0")).toBe(edited);
      edited.title = "Edited";
    });
    expect(working.edit("annotations", "missing")).toBeUndefined();
    expect(before.title).not.toBe("Edited");
    expect(next.annotations["annotation-0"]!.title).toBe("Edited");
    expect(Object.isFrozen(next.annotations["annotation-0"])).toBe(true);
    expect(next.annotations["annotation-1"]).toBe(base.manifest.annotations["annotation-1"]);
    // Untouched collections are shared.
    expect(next.captures).toBe(base.manifest.captures);
    expect(incremental.upserts.map((row) => row.key).sort()).toEqual(["annotation-0", "state"]);
    assertSameRowPlan(full, incremental);
  });

  test("only replaced rows are serialized, however large the collection", () => {
    const small = commit(committed(1), (manifest) => {
      manifest.annotations["annotation-new"] = fixtureAnnotation({
        id: "annotation-new",
        environmentId: ENV,
      });
      manifest.entries["annotation-new"] = [entry("annotation-new", 1)];
      manifest.receipts.push(receipt(3));
    });
    const large = commit(committed(400), (manifest) => {
      manifest.annotations["annotation-new"] = fixtureAnnotation({
        id: "annotation-new",
        environmentId: ENV,
      });
      manifest.entries["annotation-new"] = [entry("annotation-new", 1)];
      manifest.receipts.push(receipt(3));
    });
    // Annotation, entry, receipt and meta state; the migration row is untouched.
    expect(small.incremental.serialized).toBe(4);
    expect(large.incremental.serialized).toBe(small.incremental.serialized);
    expect(large.full.serialized).toBeGreaterThan(1_000);
    assertSameRowPlan(small.full, small.incremental);
    assertSameRowPlan(large.full, large.incremental);
  });

  test("removals, replaced lists, receipt eviction and whole-collection assignment", () => {
    const base = committed(4);
    const { incremental, full } = commit(base, (manifest) => {
      delete manifest.annotations["annotation-0"];
      delete manifest.changedAt["annotation-0"];
      delete manifest.entries["annotation-0"];
      // Not append-only: the group is renumbered, keeping the new order.
      manifest.entries["annotation-1"] = [entry("annotation-1", 2), entry("annotation-1", 1)];
      manifest.entries["annotation-2"] = [
        ...manifest.entries["annotation-2"]!,
        entry("annotation-2", 3),
      ];
      manifest.receipts.push(receipt(3));
      manifest.receipts.splice(0, 1);
      manifest.migration.completedAt = NOW;
      manifest.requests = {};
    });
    assertSameRowPlan(full, incremental);
    expect(incremental.deletes.map((row) => row.key).sort()).toEqual(
      [
        "annotation-0",
        "annotation-0",
        "entry-annotation-0-1",
        "entry-annotation-0-2",
        "op-1",
      ].sort(),
    );
    const order = (annotationId: string) =>
      Array.from(incremental.rows.values())
        .filter((row) => row.collection === "entries" && row.key.includes(`${annotationId}-`))
        .sort((a, b) => a.position - b.position)
        .map((row) => row.key);
    expect(order("annotation-1")).toEqual(["entry-annotation-1-2", "entry-annotation-1-1"]);
    expect(order("annotation-2")).toEqual([
      "entry-annotation-2-1",
      "entry-annotation-2-2",
      "entry-annotation-2-3",
    ]);
  });

  test("a row set back to its committed value is not a change", () => {
    const base = committed(2);
    const { incremental } = commit(base, (manifest) => {
      const original = manifest.annotations["annotation-0"]!;
      manifest.annotations["annotation-0"] = { ...original, title: "Temporary" };
      manifest.annotations["annotation-0"] = original;
      // A copy with equal content is serialized but not written.
      manifest.annotations["annotation-1"] = { ...manifest.annotations["annotation-1"]! };
    });
    expect(incremental.serialized).toBe(2);
    expect(incremental.upserts.map((row) => row.key)).toEqual(["state"]);
  });

  test("the debug check refuses a plan that misses a change", () => {
    const base = committed(2);
    const { incremental, full } = commit(base, (manifest) => {
      manifest.annotations["annotation-0"] = {
        ...manifest.annotations["annotation-0"]!,
        title: "Changed",
      };
    });
    const missed = planChangedRows(base, {
      rows: incremental.upserts
        .filter((row) => row.collection === "meta")
        .map((row) => ({ collection: row.collection, key: row.key, value: JSON.parse(row.json) })),
      groups: [],
    });
    expect(() => assertSameRowPlan(full, missed)).toThrow(/stale annotations\/annotation-0/);
  });

  test("quota bytes track UTF-8 additions, growth, shrinkage and deletion across commits", () => {
    let base = committed(2);
    const id = "annotation-quota";
    for (const title of ["é", "🦊".repeat(100), "a", null]) {
      const before = base.rows.get(`annotations\0${id}`)?.bytes ?? 0;
      const { incremental, full, next } = commit(base, (manifest) => {
        if (title === null) delete manifest.annotations[id];
        else manifest.annotations[id] = fixtureAnnotation({ id, environmentId: ENV, title });
      });
      const after = incremental.rows.get(`annotations\0${id}`)?.bytes ?? 0;
      const metaDelta =
        incremental.rows.get("meta\0state")!.bytes - base.rows.get("meta\0state")!.bytes;
      expect(incremental.indexBytes).toBe(base.indexBytes + after - before + metaDelta);
      expect(incremental.indexBytes).toBe(
        Array.from(incremental.rows.values()).reduce(
          (sum, row) => sum + Buffer.byteLength(row.json, "utf8"),
          0,
        ),
      );
      expect(incremental.serialized).toBe(title === null ? 1 : 2);
      assertSameRowPlan(full, incremental);
      base = { ...base, ...incremental, manifest: next };
    }
  });

  test.each([-1, 1])("the debug check refuses quota byte drift of %i", (drift) => {
    const { full, incremental } = commit(committed(2), (_manifest, working) => {
      working.edit("annotations", "annotation-0")!.title = "é🦊";
    });
    expect(incremental.serialized).toBe(2);
    expect(full.serialized).toBeGreaterThan(incremental.serialized);
    expect(() => assertSameRowPlan(full, incremental)).not.toThrow();
    expect(() =>
      assertSameRowPlan(full, { ...incremental, indexBytes: incremental.indexBytes + drift }),
    ).toThrow(/indexBytes .*expected/);
  });
});
