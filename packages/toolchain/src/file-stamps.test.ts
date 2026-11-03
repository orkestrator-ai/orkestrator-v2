import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  STAMP_FILE,
  openFileStampStore,
  sha256File,
  type StampStoreOptions,
} from "./file-stamps.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRoot(): Promise<{ rootDir: string; versionDir: string }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-stamps-"));
  directories.push(rootDir);
  const versionDir = path.join(rootDir, "codex", "1.2.3", "darwin-arm64");
  await mkdir(versionDir, { recursive: true });
  return { rootDir, versionDir };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A store whose hashes are counted, with racy stamps off unless asked for. */
async function openCounted(rootDir: string, options: StampStoreOptions = {}) {
  const hashed: string[] = [];
  const store = await openFileStampStore(rootDir, {
    // Trust stamps of files written a moment ago (see `racyWindowMs`).
    racyWindowMs: -60_000,
    ...options,
    hashFileForTests: async (filePath) => {
      hashed.push(filePath);
      return sha256File(filePath);
    },
  });
  return { store, hashed };
}

async function readStampFile(rootDir: string) {
  return JSON.parse(await readFile(path.join(rootDir, STAMP_FILE), "utf8")) as {
    fullCheckAt: number;
    files: Record<string, { sha256: string; stampedAtNs: string }>;
    derived: Record<string, string>;
  };
}

describe("verified file stamps", () => {
  test("a matching stamp reports the recorded digest without reading the file", async () => {
    const { rootDir, versionDir } = await createRoot();
    const filePath = path.join(versionDir, "codex");
    await writeFile(filePath, "pinned bytes");

    const first = await openCounted(rootDir);
    expect(first.store.fullCheck).toBe(true);
    expect(await first.store.sha256(filePath)).toBe(sha256("pinned bytes"));
    // Within one run a stamp is reused too, which spares the final verification.
    expect(await first.store.sha256(filePath)).toBe(sha256("pinned bytes"));
    expect(first.hashed).toEqual([filePath]);
    await first.store.save([versionDir]);

    const second = await openCounted(rootDir);
    expect(second.store.fullCheck).toBe(false);
    expect(await second.store.sha256(filePath)).toBe(sha256("pinned bytes"));
    expect(second.hashed).toEqual([]);
  });

  const changes: Array<{
    name: string;
    change: (filePath: string) => Promise<void>;
    digest: string;
  }> = [
    {
      name: "same-size rewrite",
      change: (filePath) => writeFile(filePath, "PINNED BYTES"),
      digest: sha256("PINNED BYTES"),
    },
    {
      name: "permission change only",
      change: (filePath) => chmod(filePath, 0o500),
      digest: sha256("pinned bytes"),
    },
    {
      name: "replacement by rename",
      change: async (filePath) => {
        const replacement = `${filePath}.new`;
        await writeFile(replacement, "other bytes!");
        await rename(replacement, filePath);
      },
      digest: sha256("other bytes!"),
    },
  ];

  for (const { name, change, digest } of changes) {
    test(`any metadata mismatch re-hashes the file: ${name}`, async () => {
      const { rootDir, versionDir } = await createRoot();
      const filePath = path.join(versionDir, "codex");
      await writeFile(filePath, "pinned bytes");
      const first = await openCounted(rootDir);
      await first.store.sha256(filePath);
      await first.store.save([versionDir]);

      await change(filePath);
      const second = await openCounted(rootDir);
      expect(await second.store.sha256(filePath)).toBe(digest);
      expect(second.hashed).toEqual([filePath]);
    });
  }

  test("a stamp taken while the file was fresh is never trusted on metadata alone", async () => {
    const { rootDir, versionDir } = await createRoot();
    const filePath = path.join(versionDir, "codex");
    await writeFile(filePath, "pinned bytes");

    const first = await openCounted(rootDir, { racyWindowMs: 60_000 });
    await first.store.sha256(filePath);
    await first.store.sha256(filePath);
    expect(first.hashed).toEqual([filePath, filePath]);
    await first.store.save([versionDir]);

    const second = await openCounted(rootDir, { racyWindowMs: 60_000 });
    await second.store.sha256(filePath);
    expect(second.hashed).toEqual([filePath]);
  });

  test("a full check ignores persisted stamps periodically, on request, and after clock skew", async () => {
    const { rootDir, versionDir } = await createRoot();
    const filePath = path.join(versionDir, "codex");
    await writeFile(filePath, "pinned bytes");
    // Realistic: a clock before the file's own times would make every stamp racy.
    const base = Date.now();
    let now = base;
    const first = await openCounted(rootDir, { now: () => now, fullCheckIntervalMs: 1_000 });
    await first.store.sha256(filePath);
    await first.store.save([versionDir]);
    expect((await readStampFile(rootDir)).fullCheckAt).toBe(base);

    now += 500;
    const withinInterval = await openCounted(rootDir, {
      now: () => now,
      fullCheckIntervalMs: 1_000,
    });
    expect(withinInterval.store.fullCheck).toBe(false);
    await withinInterval.store.sha256(filePath);
    expect(withinInterval.hashed).toEqual([]);
    await withinInterval.store.save([versionDir]);
    // A stamped run does not move the last full check forward.
    expect((await readStampFile(rootDir)).fullCheckAt).toBe(base);

    const forced = await openCounted(rootDir, {
      now: () => now,
      fullCheckIntervalMs: 1_000,
      forceFullCheck: true,
    });
    expect(forced.store.fullCheck).toBe(true);
    await forced.store.sha256(filePath);
    expect(forced.hashed).toEqual([filePath]);

    now = base + 1_000;
    const due = await openCounted(rootDir, { now: () => now, fullCheckIntervalMs: 1_000 });
    expect(due.store.fullCheck).toBe(true);
    await due.store.sha256(filePath);
    expect(due.hashed).toEqual([filePath]);
    await due.store.save([versionDir]);
    expect((await readStampFile(rootDir)).fullCheckAt).toBe(base + 1_000);

    now = base - 1;
    const skewed = await openCounted(rootDir, { now: () => now, fullCheckIntervalMs: 1_000 });
    expect(skewed.store.fullCheck).toBe(true);
  });

  test("a missing, corrupt or oversized stamp file means a full check", async () => {
    const { rootDir } = await createRoot();
    expect((await openCounted(rootDir)).store.fullCheck).toBe(true);
    await writeFile(path.join(rootDir, STAMP_FILE), "{not json");
    expect((await openCounted(rootDir)).store.fullCheck).toBe(true);
    await writeFile(
      path.join(rootDir, STAMP_FILE),
      JSON.stringify({
        version: 1,
        fullCheckAt: Date.now(),
        files: {},
        derived: {},
        pad: "x".repeat(9 * 1024 * 1024),
      }),
    );
    expect((await openCounted(rootDir)).store.fullCheck).toBe(true);
  });

  test("a malformed stamp entry is dropped rather than trusted", async () => {
    const { rootDir, versionDir } = await createRoot();
    const filePath = path.join(versionDir, "codex");
    await writeFile(filePath, "pinned bytes");
    await writeFile(
      path.join(rootDir, STAMP_FILE),
      JSON.stringify({
        version: 1,
        fullCheckAt: Date.now(),
        files: { [filePath]: { sha256: sha256("pinned bytes") } },
        derived: {},
      }),
    );
    const store = await openCounted(rootDir);
    expect(store.store.fullCheck).toBe(false);
    await store.store.sha256(filePath);
    expect(store.hashed).toEqual([filePath]);
  });

  test("only stamps touched in this run under the active version directories are kept", async () => {
    const { rootDir, versionDir } = await createRoot();
    const kept = path.join(versionDir, "codex");
    const staging = path.join(rootDir, ".staging-codex-1", "codex");
    const untouched = path.join(versionDir, "untouched");
    await mkdir(path.dirname(staging), { recursive: true });
    for (const filePath of [kept, staging, untouched]) await writeFile(filePath, "bytes");

    const first = await openCounted(rootDir);
    await first.store.sha256(untouched);
    await first.store.save([versionDir]);
    const second = await openCounted(rootDir);
    await second.store.sha256(kept);
    await second.store.sha256(staging);
    await second.store.save([versionDir]);

    expect(Object.keys((await readStampFile(rootDir)).files)).toEqual([kept]);
  });

  test("records which pinned source a locally produced file came from", async () => {
    const { rootDir, versionDir } = await createRoot();
    const produced = path.join(versionDir, "opencode");
    await writeFile(produced, "re-signed bytes");
    const source = sha256("upstream");

    const first = await openCounted(rootDir);
    expect(first.store.derivedFrom(produced)).toBeUndefined();
    expect(await first.store.isUnchanged(produced)).toBe(false);
    await first.store.recordDerived(produced, source);
    await first.store.save([versionDir]);
    expect((await readStampFile(rootDir)).derived).toEqual({ [produced]: source });

    const second = await openCounted(rootDir);
    expect(second.store.derivedFrom(produced)).toBe(source);
    expect(await second.store.isUnchanged(produced)).toBe(true);
    expect(second.hashed).toEqual([]);
    second.store.retainDerived(produced);
    await second.store.save([versionDir]);
    expect((await readStampFile(rootDir)).derived).toEqual({ [produced]: source });

    await writeFile(produced, "tampered bytes!");
    const third = await openCounted(rootDir);
    expect(await third.store.isUnchanged(produced)).toBe(false);
    // A record nobody retained or re-recorded is dropped on save.
    await third.store.save([versionDir]);
    expect((await readStampFile(rootDir)).derived).toEqual({});

    const full = await openCounted(rootDir, { forceFullCheck: true });
    expect(full.store.derivedFrom(produced)).toBeUndefined();
  });
});
