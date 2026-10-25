import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorktree,
  decodePath,
  displayPath,
  encodePath,
  HostCaptureExecutor,
  type Manifest,
} from "./capture.js";
import { ObjectStore } from "./object-store.js";
import { compareManifests, renderSnapshotBodies } from "./snapshot-diff.js";

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

function repo(): string {
  const root = temp("ork-capture-repo-");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

async function capture(root: string, store: ObjectStore, previous?: Manifest | null) {
  const result = await captureWorktree({
    executor: new HostCaptureExecutor(root),
    store,
    previous,
  });
  if (result.kind !== "captured") throw new Error(`capture failed: ${result.reason}`);
  return result;
}

describe("raw-byte capture", () => {
  test("captures tracked, staged and untracked files; zero change compares exactly", async () => {
    const root = repo();
    writeFileSync(join(root, "untracked.txt"), "u\n");
    writeFileSync(join(root, "a.txt"), "one\nTWO\n");
    const store = new ObjectStore({ root: temp("ork-store-"), durable: false });
    const first = await capture(root, store);
    const second = await capture(root, store, first.manifest);
    expect(first.manifest.entries.map((e) => displayPath(e.p))).toEqual(["a.txt", "untracked.txt"]);
    // H03: preexisting dirt with no writes is a zero delta.
    const comparison = await compareManifests(store, first.manifest, second.manifest);
    expect(comparison.changedFiles).toBe(0);
    expect(comparison.additions).toEqual({ value: 0, quality: "complete", bound: "exact" });
  });

  test("H02: git rm --cached with identical bytes is a zero physical delta", async () => {
    const root = repo();
    const store = new ObjectStore({ root: temp("ork-store-"), durable: false });
    const before = await capture(root, store);
    git(root, "rm", "--cached", "-q", "a.txt");
    const after = await capture(root, store, before.manifest);
    const comparison = await compareManifests(store, before.manifest, after.manifest);
    expect(comparison.changedFiles).toBe(0);
    expect(after.manifest.entries[0]!.t).toBe(0);
    expect(before.manifest.entries[0]!.t).toBe(1);
  });

  test("H16: raw capture never runs a configured clean filter", async () => {
    const root = repo();
    const marker = join(temp("ork-marker-"), "ran");
    git(root, "config", "filter.evil.clean", `sh -c 'touch ${marker}; cat'`);
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(join(root, "a.txt"), "changed\n");
    const store = new ObjectStore({ root: temp("ork-store-"), durable: false });
    await capture(root, store);
    expect(() => execFileSync("test", ["-e", marker])).toThrow();
  });

  test("C10: binary, mode-only, pure rename and empty file keep file identity", async () => {
    const root = repo();
    writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, "run.sh"), "echo hi\n");
    writeFileSync(join(root, "move-me.txt"), "same content\n");
    const store = new ObjectStore({ root: temp("ork-store-"), durable: false });
    const before = await capture(root, store);
    writeFileSync(join(root, "bin.dat"), Buffer.from([0, 9, 9]));
    chmodSync(join(root, "run.sh"), 0o755);
    rmSync(join(root, "move-me.txt"));
    writeFileSync(join(root, "moved.txt"), "same content\n");
    writeFileSync(join(root, "empty.txt"), "");
    const after = await capture(root, store, before.manifest);
    const comparison = await compareManifests(store, before.manifest, after.manifest);
    const byPath = new Map(comparison.files.map((f) => [displayPath(f.pathId), f]));
    expect(byPath.get("bin.dat")).toMatchObject({ status: "modified", fileKind: "binary" });
    expect(byPath.get("bin.dat")!.additions.quality).toBe("not-applicable");
    expect(byPath.get("run.sh")).toMatchObject({ status: "mode-changed" });
    expect(byPath.get("moved.txt")).toMatchObject({ status: "renamed" });
    expect(displayPath(byPath.get("moved.txt")!.oldPathId!)).toBe("move-me.txt");
    expect(byPath.get("empty.txt")).toMatchObject({ status: "added" });
    expect(byPath.get("empty.txt")!.additions.value).toBe(0);
    expect(comparison.changedFiles).toBe(4);
  });

  test("symlinks are captured as links, never followed", async () => {
    const root = repo();
    const outside = temp("ork-outside-");
    writeFileSync(join(outside, "secret"), "do not read\n");
    symlinkSync(join(outside, "secret"), join(root, "link"));
    const store = new ObjectStore({ root: temp("ork-store-"), durable: false });
    const result = await capture(root, store);
    const link = result.manifest.entries.find((e) => displayPath(e.p) === "link")!;
    expect(link.m).toBe("120000");
    expect(new TextDecoder().decode((await store.get(link.o))!)).toBe(join(outside, "secret"));
  });

  test("oversized files are explicit omissions, not zero changes", async () => {
    const root = repo();
    const store = new ObjectStore({ root: temp("ork-store-"), durable: false });
    const before = await capture(root, store);
    writeFileSync(join(root, "big.bin"), Buffer.alloc(64, 1));
    const result = await captureWorktree({
      executor: new HostCaptureExecutor(root),
      store,
      previous: before.manifest,
      limits: { maxFileBytes: 32 },
    });
    if (result.kind !== "captured") throw new Error("capture failed");
    expect(result.coverage.files).toBe("partial");
    const comparison = await compareManifests(store, before.manifest, result.manifest);
    expect(comparison.completeness).toBe("partial");
    expect(comparison.files[0]!.additions.value).toBeNull();
  });

  test("H10: history stays readable after the source repository is deleted", async () => {
    const root = repo();
    const store = new ObjectStore({ root: temp("ork-store-"), durable: false });
    const before = await capture(root, store);
    writeFileSync(join(root, "a.txt"), "one\nthree\n");
    const after = await capture(root, store, before.manifest);
    rmSync(root, { recursive: true, force: true });
    const comparison = await compareManifests(store, before.manifest, after.manifest);
    expect(comparison.additions.value).toBe(1);
    const bodies = await renderSnapshotBodies(store, comparison.files);
    expect(bodies[0]!.hunks[0]!.lines.some((l) => l.type === "add" && l.text === "three")).toBe(
      true,
    );
  });

  test("a capture is readable by plain git fsck", async () => {
    const root = repo();
    const storeRoot = temp("ork-store-");
    const store = new ObjectStore({ root: storeRoot, durable: false });
    await capture(root, store);
    expect(() => git(storeRoot, "--git-dir", storeRoot, "fsck", "--no-dangling")).not.toThrow();
  });

  test("non-UTF-8 path bytes round-trip through path ids", () => {
    const bytes = new Uint8Array([0x61, 0xff, 0x62]);
    const id = encodePath(bytes);
    expect(id.startsWith("b:")).toBe(true);
    expect([...decodePath(id)]).toEqual([...bytes]);
    expect(encodePath(new TextEncoder().encode("dir/café"))).toBe("u:dir/café");
  });

  test("a non-Git directory reports an explicit unavailable capture", async () => {
    const root = temp("ork-plain-");
    mkdirSync(join(root, "x"));
    const store = new ObjectStore({ root: temp("ork-store-"), durable: false });
    const result = await captureWorktree({ executor: new HostCaptureExecutor(root), store });
    expect(result).toMatchObject({ kind: "unavailable" });
  });
});
