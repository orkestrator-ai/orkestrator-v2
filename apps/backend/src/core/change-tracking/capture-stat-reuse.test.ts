/**
 * ST-1: a capture does not read or hash a file whose settled stat stamp still
 * matches, and the manifest it publishes is the one a full read produces.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorktree,
  displayPath,
  HostCaptureExecutor,
  STAT_SETTLE_WINDOW_MS,
  type CaptureResult,
} from "./capture.js";
import { ObjectStore } from "./object-store.js";
import { createHarness } from "./service-test-support.js";
import { WorktreeRegistry } from "./worktree-owner.js";

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).toString();
}

/** Three regular files (one executable, one nested) and a symlink. */
function repo(): string {
  const root = temp("ork-stat-reuse-repo-");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  mkdirSync(join(root, "dir"));
  writeFileSync(join(root, "dir", "b.txt"), "nested\n");
  writeFileSync(join(root, "run.sh"), "echo hi\n");
  chmodSync(join(root, "run.sh"), 0o755);
  symlinkSync("a.txt", join(root, "link"));
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

function captured(result: CaptureResult) {
  if (result.kind !== "captured") throw new Error(`capture failed: ${result.reason}`);
  return result;
}

async function captureFresh(root: string) {
  const store = new ObjectStore({ root: temp("ork-stat-reuse-store-"), durable: false });
  return captured(await captureWorktree({ executor: new HostCaptureExecutor(root), store }));
}

describe("stat-stamp reuse (ST-1)", () => {
  test("a settled unchanged file is not read, and the manifest is unchanged", async () => {
    const root = repo();
    const store = new ObjectStore({ root: temp("ork-stat-reuse-store-"), durable: false });
    // A zero window settles every file at once, so the second pass can reuse.
    const executor = new HostCaptureExecutor(root, 0);
    const first = captured(await captureWorktree({ executor, store }));
    expect(executor.reads).toEqual({ contentRead: 4, stampReused: 0 });
    // Regular files settle; a symlink has no stamp to trust and is never skipped.
    expect([...first.statCache.values()].filter((entry) => entry.settled)).toHaveLength(3);

    const second = captured(
      await captureWorktree({
        executor,
        store,
        previous: first.manifest,
        statCache: first.statCache,
      }),
    );
    // The three regular files are reused; a symlink is always read (one readlinkat).
    expect(executor.reads).toEqual({ contentRead: 5, stampReused: 3 });
    expect(second.manifestId).toBe(first.manifestId);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.coverage.metadataReused).toBe(4);
    expect(second.consistency).toBe("stable-observation");
    expect(second.statCache).toEqual(first.statCache);

    // A capture that reads everything publishes the same manifest.
    const full = await captureFresh(root);
    expect(full.manifestId).toBe(second.manifestId);
    const modes = new Map(second.manifest.entries.map((entry) => [displayPath(entry.p), entry.m]));
    expect(modes.get("run.sh")).toBe("100755");
    expect(modes.get("a.txt")).toBe("100644");
  });

  test("a changed file is read and hashed again", async () => {
    const root = repo();
    const store = new ObjectStore({ root: temp("ork-stat-reuse-store-"), durable: false });
    const executor = new HostCaptureExecutor(root, 0);
    const first = captured(await captureWorktree({ executor, store }));
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    const second = captured(
      await captureWorktree({
        executor,
        store,
        previous: first.manifest,
        statCache: first.statCache,
      }),
    );
    expect(executor.reads.stampReused).toBe(2);
    const entry = second.manifest.entries.find((candidate) => displayPath(candidate.p) === "a.txt");
    expect(entry!.o).toBe(git(root, "hash-object", "a.txt").trim());
    expect(second.manifestId).toBe((await captureFresh(root)).manifestId);
  });

  test("a file younger than the settle window is read on every capture", async () => {
    expect(STAT_SETTLE_WINDOW_MS).toBeGreaterThanOrEqual(1_000);
    const root = repo();
    const store = new ObjectStore({ root: temp("ork-stat-reuse-store-"), durable: false });
    const executor = new HostCaptureExecutor(root);
    const first = captured(await captureWorktree({ executor, store }));
    // Just written: a same-size rewrite in the same timestamp tick would keep
    // the stamp, so nothing is trusted yet.
    expect([...first.statCache.values()].some((entry) => entry.settled)).toBe(false);
    const second = captured(
      await captureWorktree({
        executor,
        store,
        previous: first.manifest,
        statCache: first.statCache,
      }),
    );
    expect(executor.reads).toEqual({ contentRead: 8, stampReused: 0 });
    expect(second.manifestId).toBe(first.manifestId);
    expect(second.coverage.metadataReused).toBe(4);
  });

  test("a reused file still counts against the per-file size limit", async () => {
    const root = repo();
    const store = new ObjectStore({ root: temp("ork-stat-reuse-store-"), durable: false });
    const executor = new HostCaptureExecutor(root, 0);
    const first = captured(await captureWorktree({ executor, store }));
    const second = captured(
      await captureWorktree({
        executor,
        store,
        previous: first.manifest,
        statCache: first.statCache,
        limits: { maxFileBytes: 7 },
      }),
    );
    // "one\ntwo\n" and "echo hi\n" are eight bytes; "nested\n" is seven.
    expect(second.manifest.omitted.map((omission) => displayPath(omission.p))).toEqual([
      "a.txt",
      "run.sh",
    ]);
    expect(second.manifest.entries.map((entry) => displayPath(entry.p))).toEqual([
      "dir/b.txt",
      "link",
    ]);
  });

  test("a missing cached blob is read again after a settled skip", async () => {
    const root = repo();
    const store = new ObjectStore({ root: temp("ork-stat-reuse-store-"), durable: false });
    const executor = new HostCaptureExecutor(root, 0);
    const first = captured(await captureWorktree({ executor, store }));
    const entry = first.manifest.entries.find((candidate) => displayPath(candidate.p) === "a.txt")!;
    rmSync(join(store.root, "objects", entry.o.slice(0, 2), entry.o.slice(2)));
    expect(await store.has(entry.o)).toBe(false);
    const reuse = spyOn(store, "reuse");
    const fetch = spyOn(executor, "fetch");
    try {
      const second = captured(
        await captureWorktree({
          executor,
          store,
          previous: first.manifest,
          statCache: first.statCache,
        }),
      );
      expect(reuse.mock.calls.some(([oid]) => oid === entry.o)).toBe(true);
      expect(fetch.mock.calls.some(([paths]) => paths.includes(entry.p))).toBe(true);
      expect(executor.reads).toEqual({ contentRead: 6, stampReused: 3 });
      expect(await store.has(entry.o)).toBe(true);
      expect(second.manifest).toEqual(first.manifest);
      expect(second.manifestId).toBe((await captureFresh(root)).manifestId);
    } finally {
      reuse.mockRestore();
      fetch.mockRestore();
    }
  });

  test("a chmod-only change on a settled file updates its mode", async () => {
    const root = repo();
    const store = new ObjectStore({ root: temp("ork-stat-reuse-store-"), durable: false });
    const executor = new HostCaptureExecutor(root, 0);
    const first = captured(await captureWorktree({ executor, store }));
    const before = first.manifest.entries.find((entry) => displayPath(entry.p) === "a.txt")!;
    chmodSync(join(root, "a.txt"), 0o755);
    const second = captured(
      await captureWorktree({
        executor,
        store,
        previous: first.manifest,
        statCache: first.statCache,
      }),
    );
    const after = second.manifest.entries.find((entry) => entry.p === before.p)!;
    expect(after.m).toBe("100755");
    expect(after.o).toBe(before.o);
    expect(executor.reads).toEqual({ contentRead: 6, stampReused: 2 });
    expect(second.manifestId).not.toBe(first.manifestId);
    expect(second.manifestId).toBe((await captureFresh(root)).manifestId);
  });

  for (const all of [false, true]) {
    test(`an in-flight ${all ? "full" : "path"} invalidation survives cache publication`, async () => {
      const h = createHarness();
      let release!: () => void;
      let describe: ReturnType<typeof spyOn> | undefined;
      let pending: Promise<unknown> | undefined;
      try {
        const registry = new WorktreeRegistry({
          ledger: h.service.ledger,
          store: new ObjectStore({ root: temp("ork-stat-reuse-store-"), durable: false }),
          statSettleWindowMs: 0,
        });
        const identity = await registry.resolve({ kind: "local", worktreePath: h.repo });
        const owner = registry.owner(identity!);
        const executor = owner.executor as HostCaptureExecutor;
        const capture = () => owner.capture({ purpose: "refresh", deadlineMs: 10_000 });
        expect((await capture()).kind).toBe("published");
        let described!: () => void;
        const reached = new Promise<void>((resolve) => {
          described = resolve;
        });
        const resume = new Promise<void>((resolve) => {
          release = resolve;
        });
        const original = executor.describe.bind(executor);
        describe = spyOn(executor, "describe").mockImplementation(async (...args) => {
          const records = await original(...args);
          described();
          await resume;
          return records;
        });
        pending = capture();
        await reached;
        expect(executor.reads).toEqual({ contentRead: 1, stampReused: 1 });
        owner.invalidate(all ? undefined : ["u:a.txt"]);
        release();
        expect(((await pending) as { kind: string }).kind).toBe("published");
        describe.mockRestore();
        expect((await capture()).kind).toBe("published");
        expect(executor.reads).toEqual({ contentRead: 2, stampReused: 1 });
        // Once the invalidation has been honoured, settled reuse resumes.
        expect((await capture()).kind).toBe("published");
        expect(executor.reads).toEqual({ contentRead: 2, stampReused: 2 });
      } finally {
        release?.();
        await pending;
        describe?.mockRestore();
        h.cleanup();
      }
    });
  }

  test("a path hint forces the next capture to read that file", async () => {
    const h = createHarness();
    try {
      const registry = new WorktreeRegistry({
        ledger: h.service.ledger,
        store: new ObjectStore({ root: temp("ork-stat-reuse-store-"), durable: false }),
        statSettleWindowMs: 0,
      });
      const identity = await registry.resolve({ kind: "local", worktreePath: h.repo });
      const owner = registry.owner(identity!);
      const executor = owner.executor as HostCaptureExecutor;
      const capture = async () =>
        expect((await owner.capture({ purpose: "refresh", deadlineMs: 10_000 })).kind).toBe(
          "published",
        );
      await capture();
      await capture();
      expect(executor.reads).toEqual({ contentRead: 1, stampReused: 1 });
      owner.invalidate(["u:a.txt"]);
      await capture();
      expect(executor.reads).toEqual({ contentRead: 2, stampReused: 1 });
      await capture();
      owner.invalidate();
      await capture();
      expect(executor.reads).toEqual({ contentRead: 3, stampReused: 2 });
    } finally {
      h.cleanup();
    }
  });
});
