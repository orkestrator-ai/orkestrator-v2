/**
 * ST-5: diff pages find rows by binary search with the old linear find's
 * results, and the whitespace-ignore view renders each file once.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unknownCount } from "@orkestrator/protocol/change-measurements";
import type { ChangeDiffFileBody, DiffIdentity } from "@orkestrator/protocol/change-resources";
import { diffRawLines } from "@orkestrator/protocol/node/change-tracking/raw-line-diff";
import {
  captureWorktree,
  decodePath,
  encodePath,
  findManifestEntry,
  HostCaptureExecutor,
  type Manifest,
  type ManifestEntry,
} from "./capture.js";
import type { ChangeLedger } from "./change-ledger.js";
import { DiffBodyService } from "./diff-bodies.js";
import { ObjectStore } from "./object-store.js";
import { renderSnapshotBodies, type SnapshotFileChange } from "./snapshot-diff.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const openStore = () => new ObjectStore({ root: temp("ork-lookup-store-"), durable: false });
const encode = (text: string) => new TextEncoder().encode(text);
const byPathBytes = (left: ManifestEntry, right: ManifestEntry) =>
  Buffer.compare(decodePath(left.p), decodePath(right.p));

/** The linear find that diff pages used before, verbatim. */
function linearFind(
  manifest: Pick<Manifest, "entries">,
  pathId: string | null,
  blob: string | null,
): ManifestEntry | null {
  return pathId
    ? (manifest.entries.find(
        (candidate) => candidate.p === pathId && (!blob || candidate.o === blob),
      ) ?? null)
    : null;
}

/** Paths whose byte order differs from their UTF-16 order, prefixes included. */
const AWKWARD_NAMES = [
  "a",
  "a.b",
  "a/b",
  "a0",
  "z",
  "é",
  "\u{e000}private-use",
  "\u{fffd}replacement",
  "\u{1f600}astral",
  "\u{10000}astral-first",
  "日本語/ファイル",
];

function largeEntries(count: number): ManifestEntry[] {
  const paths = [
    ...AWKWARD_NAMES.map((name) => encodePath(encode(name))),
    encodePath(new Uint8Array([0xff, 0xfe, 0x61])),
    encodePath(new Uint8Array([0x61, 0xff])),
    ...Array.from({ length: count }, (_, index) => {
      const directory = index % 3 === 0 ? `dir-é/${index % 97}` : `dir-${index % 211}`;
      return encodePath(encode(`${directory}/file-${index}.ts`));
    }),
  ];
  return paths
    .map((p, index) => ({
      p,
      m: "100644" as const,
      o: index.toString(16).padStart(40, "0"),
      s: index,
      t: 1 as const,
    }))
    .sort(byPathBytes);
}

describe("findManifestEntry", () => {
  test("matches the linear find for every entry, wrong blob and absent path of 20,000", () => {
    const entries = largeEntries(20_000);
    const manifest = { entries };
    for (const entry of entries) {
      expect(findManifestEntry(entries, entry.p)).toBe(entry);
      expect(findManifestEntry(entries, entry.p, entry.o)).toBe(entry);
      expect(findManifestEntry(entries, entry.p, "f".repeat(40))).toBeNull();
    }
    const absent = [
      "u:",
      "u:0",
      "u:a/",
      "u:a.c",
      "u:zz",
      "u:\u{10ffff}",
      "b://///w==",
      "u:dir-1/file-999999.ts",
    ];
    for (const pathId of absent) {
      expect(findManifestEntry(entries, pathId)).toBe(linearFind(manifest, pathId, null));
      expect(findManifestEntry(entries, pathId)).toBeNull();
    }
    expect(findManifestEntry([], "u:a")).toBeNull();
  });

  test("still matches where a path repeats, as a hand-made manifest could", () => {
    const blobs = ["1", "2", "3"].map((digit) => digit.repeat(40));
    const entries: ManifestEntry[] = [
      { p: "u:a", m: "100644", o: "0".repeat(40), s: 0, t: 1 },
      ...blobs.map((o) => ({ p: "u:same", m: "100644" as const, o, s: 0, t: 1 as const })),
      { p: "u:z", m: "100644", o: "9".repeat(40), s: 0, t: 1 },
    ];
    for (const blob of [null, ...blobs, "8".repeat(40)]) {
      expect(findManifestEntry(entries, "u:same", blob)).toBe(
        linearFind({ entries }, "u:same", blob),
      );
    }
  });

  test("finds every path of a real capture, which sorts by bytes", async () => {
    const repo = temp("ork-lookup-repo-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    for (const name of AWKWARD_NAMES.filter((name) => !name.includes("/")))
      writeFileSync(join(repo, name), `${name}\n`);
    mkdirSync(join(repo, "日本語"));
    writeFileSync(join(repo, "日本語", "ファイル"), "text\n");
    const result = await captureWorktree({
      executor: new HostCaptureExecutor(repo),
      store: openStore(),
    });
    if (result.kind !== "captured") throw new Error(result.reason);
    // Every name but `a/b`, which `a` the file rules out.
    expect(result.manifest.entries.length).toBe(AWKWARD_NAMES.length - 1);
    for (const entry of result.manifest.entries)
      expect(findManifestEntry(result.manifest.entries, entry.p, entry.o)).toBe(entry);
  });
});

type FileRow = {
  path_id: string;
  old_path: string | null;
  new_path: string | null;
  old_blob: string | null;
  new_blob: string | null;
  status: string;
  file_kind: string;
  reason: string | null;
};

const IDENTITY = {
  id: "diff_page",
  kind: "comparison",
  measurementId: "measurement",
  beforeSnapshotId: "before",
  afterSnapshotId: "after",
} as unknown as DiffIdentity;

function service(store: ObjectStore, trees: Record<string, string>, rows: FileRow[]) {
  const ledger = {
    diffIdentity: () => IDENTITY,
    pinMeasurement: () => () => undefined,
    measurement: () => null,
    snapshot: (id: string) => ({ tree_oid: trees[id] }),
    measurementFiles: (_: string, offset: number, limit: number) =>
      rows.slice(offset, offset + limit),
    measurementFileCount: () => rows.length,
  } as unknown as ChangeLedger;
  return new DiffBodyService({
    ledger,
    store,
    bodies: {} as never,
    measurements: {} as never,
    projections: {} as never,
    registry: {} as never,
    environmentTarget: async () => null,
    batchBytes: 1024 * 1024,
  });
}

function fileChange(
  row: FileRow,
  before: Pick<Manifest, "entries">,
  after: Pick<Manifest, "entries">,
): SnapshotFileChange {
  return {
    pathId: row.path_id,
    oldPathId: row.old_path,
    newPathId: row.new_path,
    status: row.status as SnapshotFileChange["status"],
    fileKind: row.file_kind as SnapshotFileChange["fileKind"],
    oldEntry: linearFind(before, row.old_path, row.old_blob),
    newEntry: linearFind(after, row.new_path, row.new_blob),
    additions: unknownCount(),
    deletions: unknownCount(),
    reason: row.reason,
  };
}

/** Two 20,000-entry manifests; the listed files hold real blobs on both sides. */
async function largeComparison(store: ObjectStore, sides: Array<[string, string, string]>) {
  const oids = new Map<string, { before: string; after: string }>();
  for (const [path, before, after] of sides) {
    oids.set(encodePath(encode(path)), {
      before: (await store.put("blob", encode(before))).id,
      after: (await store.put("blob", encode(after))).id,
    });
  }
  const filler = largeEntries(20_000);
  const side = (pick: "before" | "after"): ManifestEntry[] =>
    [
      ...filler,
      ...Array.from(oids, ([p, blobs]) => ({
        p,
        m: "100644" as const,
        o: blobs[pick],
        s: 1,
        t: 1 as const,
      })),
    ].sort(byPathBytes);
  const before = { v: 1 as const, root: "r", entries: side("before"), omitted: [], unstable: [] };
  const after = { v: 1 as const, root: "r", entries: side("after"), omitted: [], unstable: [] };
  const trees = {
    before: (await store.put("manifest", encode(JSON.stringify(before)))).id,
    after: (await store.put("manifest", encode(JSON.stringify(after)))).id,
  };
  const rows: FileRow[] = Array.from(oids, ([pathId, blobs]) => ({
    path_id: pathId,
    old_path: pathId,
    new_path: pathId,
    old_blob: blobs.before,
    new_blob: blobs.after,
    status: "modified",
    file_kind: "text",
    reason: null,
  }));
  return { before, after, trees, rows };
}

describe("a diff page over a large manifest", () => {
  test("returns what the linear find returned, with no linear find per row", async () => {
    const store = openStore();
    const sides = Array.from({ length: 45 }, (_, index): [string, string, string] => [
      `changed-é/${index}.ts`,
      `old ${index}\nkept\n`,
      `new ${index}\nkept\n`,
    ]);
    const { before, after, trees, rows } = await largeComparison(store, sides);
    // A row naming an object the manifest does not hold has no entry on that side.
    rows[3] = { ...rows[3]!, old_blob: "e".repeat(40) };

    const bodies = service(store, trees, rows);
    const originalFind = Array.prototype.find;
    let linearScans = 0;
    const find = spyOn(Array.prototype, "find").mockImplementation(function (
      this: unknown[],
      ...args: Parameters<typeof originalFind>
    ) {
      if (this.length > 1_000) linearScans++;
      return originalFind.apply(this, args);
    } as typeof originalFind);
    const pages: ChangeDiffFileBody[][] = [];
    try {
      let cursor: string | undefined;
      do {
        const page = await bodies.getDiff({ diffIdentityId: IDENTITY.id, cursor });
        if (page.kind !== "body") throw new Error(page.kind);
        pages.push(page.files);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    } finally {
      find.mockRestore();
    }
    expect(linearScans).toBe(0);
    expect(pages.map((page) => page.length)).toEqual([20, 20, 5]);

    const expected: ChangeDiffFileBody[] = [];
    for (let offset = 0; offset < rows.length; offset += 20) {
      expected.push(
        ...(await renderSnapshotBodies(
          store,
          rows.slice(offset, offset + 20).map((row) => fileChange(row, before, after)),
          { maxBatchBytes: 1024 * 1024 },
        )),
      );
    }
    expect(pages.flat()).toEqual(expected);
    expect(pages.flat()[0]!.hunks.length).toBeGreaterThan(0);
  });
});

/** The whitespace view as it was: a full render, then a second diff over it. */
async function oldWhitespaceView(
  store: ObjectStore,
  files: SnapshotFileChange[],
  budget: { maxBatchBytes: number; contextLines?: number },
): Promise<ChangeDiffFileBody[]> {
  const bodies: ChangeDiffFileBody[] = [];
  for (const file of files) {
    const [rendered] = await renderSnapshotBodies(store, [file], budget);
    if (!rendered || rendered.fileKind !== "text" || !file.oldEntry || !file.newEntry) {
      if (rendered) bodies.push(rendered);
      continue;
    }
    const oldBytes = await store.get(file.oldEntry.o);
    const newBytes = await store.get(file.newEntry.o);
    if (!oldBytes || !newBytes) {
      bodies.push(rendered);
      continue;
    }
    const diff = diffRawLines(oldBytes, newBytes, budget, undefined, { ignoreWhitespace: true });
    bodies.push({
      ...rendered,
      hunks: diff.kind === "diff" ? diff.hunks : [],
      truncated: diff.kind !== "diff" || diff.truncated,
    });
  }
  return bodies;
}

describe("the whitespace-ignore view", () => {
  test("reads each file's blobs once and matches the old double render", async () => {
    const store = openStore();
    const sides: Array<[string, string, string]> = [
      ["whitespace-only.ts", "a\nb\n", "a  \n\tb\n"],
      ["mixed.ts", "a\nb\nc\n", "a  \nchanged\nc\n"],
      ["unchanged-bytes.ts", "same\n", "same\n"],
    ];
    const { before, after, trees, rows } = await largeComparison(store, sides);
    const added = (await store.put("blob", encode("  new\n"))).id;
    const addedPath = encodePath(encode("added.ts"));
    const deletedPath = encodePath(encode("deleted.ts"));
    const deleted = (await store.put("blob", encode("  gone\n"))).id;
    const entry = (p: string, o: string): ManifestEntry => ({ p, m: "100644", o, s: 1, t: 1 });
    const beforeWith = {
      ...before,
      entries: [...before.entries, entry(deletedPath, deleted)].sort(byPathBytes),
    };
    const afterWith = {
      ...after,
      entries: [...after.entries, entry(addedPath, added)].sort(byPathBytes),
    };
    const expandedTrees = {
      before: (await store.put("manifest", encode(JSON.stringify(beforeWith)))).id,
      after: (await store.put("manifest", encode(JSON.stringify(afterWith)))).id,
    };
    expect(expandedTrees.before).not.toBe(trees.before);
    const allRows: FileRow[] = [
      ...rows,
      {
        path_id: addedPath,
        old_path: null,
        new_path: addedPath,
        old_blob: null,
        new_blob: added,
        status: "added",
        file_kind: "text",
        reason: null,
      },
      {
        path_id: deletedPath,
        old_path: deletedPath,
        new_path: null,
        old_blob: deleted,
        new_blob: null,
        status: "deleted",
        file_kind: "text",
        reason: null,
      },
      {
        path_id: "u:binary.bin",
        old_path: "u:binary.bin",
        new_path: "u:binary.bin",
        old_blob: null,
        new_blob: null,
        status: "modified",
        file_kind: "binary",
        reason: null,
      },
    ];
    const budget = { maxBatchBytes: 1024 * 1024 };
    const expected = await oldWhitespaceView(
      store,
      allRows.map((row) => fileChange(row, beforeWith, afterWith)),
      budget,
    );

    const read = spyOn(store, "get");
    let page;
    try {
      page = await service(store, expandedTrees, allRows).getDiff({
        diffIdentityId: IDENTITY.id,
        display: { whitespace: "ignore-for-view" },
      });
      const blobReads = read.mock.calls.filter(
        ([id]) => id !== expandedTrees.before && id !== expandedTrees.after,
      );
      // Three modified files read two sides each, added and deleted one each;
      // the old view read every side of a modified file twice.
      expect(blobReads).toHaveLength(8);
      expect(new Set(blobReads.map(([id]) => id)).size).toBe(blobReads.length - 1);
    } finally {
      read.mockRestore();
    }
    if (page.kind !== "body") throw new Error(page.kind);
    expect(page.viewIdentityId).toBe(`${IDENTITY.id}:ws-ignore`);
    expect(page.files).toEqual(expected);
    const whitespaceOnly = page.files.find((file) => file.pathId.endsWith("whitespace-only.ts"));
    expect(whitespaceOnly?.hunks).toEqual([]);
  });

  test("a limit reached by the whitespace diff is named on the file", async () => {
    const store = openStore();
    const oldBlob = await store.put("blob", encode("old line\n"));
    const newBlob = await store.put("blob", encode("new line\n"));
    const file: SnapshotFileChange = {
      pathId: "u:a",
      oldPathId: "u:a",
      newPathId: "u:a",
      status: "modified",
      fileKind: "text",
      oldEntry: { p: "u:a", m: "100644", o: oldBlob.id, s: 1, t: 1 },
      newEntry: { p: "u:a", m: "100644", o: newBlob.id, s: 1, t: 1 },
      additions: unknownCount(),
      deletions: unknownCount(),
      reason: null,
    };
    const [body] = await renderSnapshotBodies(store, [file], {
      ignoreWhitespace: true,
      maxInputBytes: 1,
    });
    expect(body).toMatchObject({
      reasonKey: "changes.body.input-bytes",
      hunks: [],
      truncated: true,
    });
  });

  test("the whitespace flag leaves added files and symlinks as they render normally", async () => {
    const store = openStore();
    const added = await store.put("blob", encode("  new\n"));
    const file: SnapshotFileChange = {
      pathId: "u:a",
      oldPathId: null,
      newPathId: "u:a",
      status: "added",
      fileKind: "text",
      oldEntry: null,
      newEntry: { p: "u:a", m: "100644", o: added.id, s: 1, t: 1 },
      additions: unknownCount(),
      deletions: unknownCount(),
      reason: null,
    };
    expect(await renderSnapshotBodies(store, [file], { ignoreWhitespace: true })).toEqual(
      await renderSnapshotBodies(store, [file]),
    );
  });
});
