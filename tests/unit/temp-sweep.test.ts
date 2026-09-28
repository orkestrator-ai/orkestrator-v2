import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOwnedTempDir, isProcessAlive, sweepStaleTempDirs } from "../temp-sweep";

const PREFIX = "sweep-fixture-";
const HOUR_MS = 60 * 60 * 1_000;
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const LIVE_PID = 4_001;
const DEAD_PID = 4_002;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "orkestrator-temp-sweep-test-"));
  roots.push(root);
  return root;
}

function createEntry(root: string, name: string, ageMs: number, kind: "dir" | "file" = "dir") {
  const target = path.join(root, name);
  if (kind === "dir") {
    mkdirSync(target);
    writeFileSync(path.join(target, "config"), "");
  } else {
    writeFileSync(target, "");
  }
  const modified = new Date(NOW - ageMs);
  utimesSync(target, modified, modified);
  return target;
}

function sweep(root: string, options: { legacyMaxAgeMs?: number } = {}): string[] {
  return sweepStaleTempDirs({
    prefix: PREFIX,
    maxAgeMs: HOUR_MS,
    root,
    now: NOW,
    isProcessAlive: (pid) => pid === LIVE_PID,
    ...options,
  });
}

describe("sweepStaleTempDirs", () => {
  test("keeps a directory whose owner is still running, however old", () => {
    const root = createRoot();
    const live = createEntry(root, `${PREFIX}${LIVE_PID}-abc123`, 48 * HOUR_MS);
    const own = createEntry(root, `${PREFIX}${process.pid}-abc123`, 48 * HOUR_MS);

    expect(sweep(root)).toEqual([]);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(own)).toBe(true);
  });

  test("removes an old directory whose owner has exited", () => {
    const root = createRoot();
    const stale = createEntry(root, `${PREFIX}${DEAD_PID}-abc123`, 2 * HOUR_MS);

    expect(sweep(root)).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
  });

  test("keeps a recent directory whose owner has exited", () => {
    const root = createRoot();
    const fresh = createEntry(root, `${PREFIX}${DEAD_PID}-abc123`, HOUR_MS / 2);

    expect(sweep(root)).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  test("never touches other prefixes, other name shapes, or files", () => {
    const root = createRoot();
    const untouched = [
      createEntry(root, `other-prefix-${DEAD_PID}-abc123`, 48 * HOUR_MS),
      createEntry(root, `${PREFIX}nested-${DEAD_PID}-abc123`, 48 * HOUR_MS),
      createEntry(root, `${PREFIX}${DEAD_PID}-abc123.keep`, 48 * HOUR_MS),
      createEntry(root, `${PREFIX}0-abc123`, 48 * HOUR_MS),
      createEntry(root, `${PREFIX}${DEAD_PID}-abc124`, 48 * HOUR_MS, "file"),
    ];

    expect(sweep(root, { legacyMaxAgeMs: HOUR_MS })).toEqual([]);
    for (const entry of untouched) expect(existsSync(entry)).toBe(true);
  });

  test("removes names without a PID only when the caller opts in and they are old", () => {
    const root = createRoot();
    const old = createEntry(root, `${PREFIX}Ab12Cd`, 2 * HOUR_MS);
    const fresh = createEntry(root, `${PREFIX}Ef34Gh`, HOUR_MS / 2);

    expect(sweep(root)).toEqual([]);
    expect(existsSync(old)).toBe(true);

    expect(sweep(root, { legacyMaxAgeMs: HOUR_MS })).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("accepts several prefixes in one pass", () => {
    const root = createRoot();
    const first = createEntry(root, `first-${DEAD_PID}-abc123`, 2 * HOUR_MS);
    const second = createEntry(root, `second-${DEAD_PID}-abc123`, 2 * HOUR_MS);

    const removed = sweepStaleTempDirs({
      prefix: ["first-", "second-"],
      maxAgeMs: HOUR_MS,
      root,
      now: NOW,
      isProcessAlive: () => false,
    });
    expect(removed.toSorted()).toEqual([first, second]);
  });

  test("returns nothing rather than throwing when the root is missing", () => {
    const root = path.join(createRoot(), "missing");
    expect(sweep(root)).toEqual([]);
  });
});

describe("owned temporary directories", () => {
  test("embed the creating process's PID where the sweep reads it", () => {
    const root = createRoot();
    const directory = createOwnedTempDir(PREFIX, root);

    expect(path.basename(directory)).toMatch(
      new RegExp(`^${PREFIX}${process.pid}-[A-Za-z0-9]{6}$`),
    );
    expect(sweep(root)).toEqual([]);
    expect(existsSync(directory)).toBe(true);
  });

  test("tells a running process from one that has exited", () => {
    const exited = Bun.spawnSync(["true"]);

    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(exited.pid)).toBe(false);
  });
});
