import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hostFakeEntryServes,
  LOCK_FILE_NAME,
  readHostFakeEntryLock,
  REAL_ENTRY_NAME,
} from "../../bridges/cursor-bridge/src/testing/host-fake-entry-lock";
import {
  bundleHostFakeCursorBridge,
  fakeCursorStorePath,
  fakeCursorTurns,
  readyPrompt,
  selectedSteerPlatforms,
  steerPrompt,
  steersCarrying,
  swapBridgeEntry,
} from "./steer-inactive-live-support";
import { steerStep } from "./steer-inactive-fake-claude";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "steer-inactive-support-"));
  directories.push(directory);
  return directory;
}

/** A dist directory with a real entry, and the profile data directory a swap serves. */
function distWithEntry(): { entry: string; dist: string; backup: string; lock: string } {
  const dist = scratch();
  const entry = path.join(dist, "index.js");
  writeFileSync(entry, "real bridge");
  return {
    entry,
    dist,
    backup: path.join(dist, REAL_ENTRY_NAME),
    lock: path.join(dist, LOCK_FILE_NAME),
  };
}

test("the swap puts the bundle in place and restore brings the real entry back", () => {
  const { entry, dist, backup, lock } = distWithEntry();
  const restore = swapBridgeEntry(entry, "fake bridge", "/profiles/a");
  expect(readFileSync(entry, "utf8")).toBe("fake bridge");
  expect(readFileSync(backup, "utf8")).toBe("real bridge");
  expect(readHostFakeEntryLock(dist)).toMatchObject({ pid: process.pid, dataDir: "/profiles/a" });
  restore();
  expect(readFileSync(entry, "utf8")).toBe("real bridge");
  expect(existsSync(backup)).toBe(false);
  expect(existsSync(lock)).toBe(false);
  // A second restore has nothing left to do.
  restore();
  expect(readFileSync(entry, "utf8")).toBe("real bridge");
});

test("a backup left by an interrupted run is kept as the real entry", () => {
  const { entry, backup, lock } = distWithEntry();
  writeFileSync(backup, "real bridge");
  writeFileSync(entry, "stale fake bridge");
  // The killed run's lock names a process that is gone.
  writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, dataDir: "/profiles/old", token: "x" }));
  const restore = swapBridgeEntry(entry, "fake bridge", "/profiles/a");
  expect(readFileSync(backup, "utf8")).toBe("real bridge");
  restore();
  expect(readFileSync(entry, "utf8")).toBe("real bridge");
  expect(existsSync(lock)).toBe(false);
});

test("a second run is refused while the first owns the swap, and cannot restore under it", () => {
  const { entry, dist } = distWithEntry();
  const first = swapBridgeEntry(entry, "fake bridge A", "/profiles/a");
  expect(() => swapBridgeEntry(entry, "fake bridge B", "/profiles/b")).toThrow(
    "swapped by another run",
  );
  // The refused run changed nothing: the owner's fake and lock are in place.
  expect(readFileSync(entry, "utf8")).toBe("fake bridge A");
  expect(readHostFakeEntryLock(dist)?.dataDir).toBe("/profiles/a");
  first();
  expect(readFileSync(entry, "utf8")).toBe("real bridge");
  // Once released, the next run may take it.
  const second = swapBridgeEntry(entry, "fake bridge B", "/profiles/b");
  expect(readFileSync(entry, "utf8")).toBe("fake bridge B");
  // The first run's restore is not the second's: it leaves the second's swap alone.
  first();
  expect(readFileSync(entry, "utf8")).toBe("fake bridge B");
  second();
  expect(readFileSync(entry, "utf8")).toBe("real bridge");
});

test("a missing entry is refused before anything is written", () => {
  const dist = scratch();
  const entry = path.join(dist, "index.js");
  expect(() => swapBridgeEntry(entry, "fake bridge", "/profiles/a")).toThrow(
    "bridge entry not found",
  );
  expect(existsSync(entry)).toBe(false);
  expect(existsSync(path.join(dist, LOCK_FILE_NAME))).toBe(false);
});

test("the fake serves only bridges inside the owning profile's data directory", () => {
  const lock = { pid: 1, dataDir: "/profiles/a", token: "t" };
  expect(hostFakeEntryServes(lock, "/profiles/a/cursor-bridge-state/env-1")).toBe(true);
  expect(hostFakeEntryServes(lock, "/profiles/b/cursor-bridge-state/env-1")).toBe(false);
  expect(hostFakeEntryServes(lock, "/profiles/ab/cursor-bridge-state/env-1")).toBe(false);
  expect(hostFakeEntryServes(lock, "/profiles/a")).toBe(false);
  expect(hostFakeEntryServes(lock, undefined)).toBe(false);
  expect(hostFakeEntryServes(null, "/profiles/a/cursor-bridge-state/env-1")).toBe(false);
});

test("the bundle runs the real entry for any other profile, and when no swap owns it", () => {
  const dist = scratch();
  const entry = path.join(dist, "index.js");
  writeFileSync(entry, bundleHostFakeCursorBridge(repositoryRoot));
  const ranReal = path.join(dist, "ran-real");
  writeFileSync(
    path.join(dist, REAL_ENTRY_NAME),
    `require("node:fs").writeFileSync(${JSON.stringify(ranReal)}, process.env.CURSOR_BRIDGE_STATE_DIR ?? "");`,
  );
  const run = (stateDir: string) => {
    rmSync(ranReal, { force: true });
    const result = spawnSync("bun", [entry], {
      env: { ...process.env, CURSOR_BRIDGE_STATE_DIR: stateDir },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return existsSync(ranReal) ? readFileSync(ranReal, "utf8") : null;
  };
  // No lock: the swap has been released (or never taken).
  expect(run(path.join(dist, "profiles", "a", "state"))).toBe(
    path.join(dist, "profiles", "a", "state"),
  );
  // Another profile's bridge while profile a owns the swap.
  writeFileSync(
    path.join(dist, LOCK_FILE_NAME),
    JSON.stringify({ pid: process.pid, dataDir: path.join(dist, "profiles", "a"), token: "t" }),
  );
  expect(run(path.join(dist, "profiles", "b", "state"))).toBe(
    path.join(dist, "profiles", "b", "state"),
  );
}, 60_000);

test("Codex keeps its own opt-in; Claude and Cursor run scripted or, when named, real", () => {
  expect([...selectedSteerPlatforms({})]).toEqual([]);
  expect([...selectedSteerPlatforms({ ORKESTRATOR_AGENT_TEST_REVIEW: "1" })]).toEqual([
    ["codex", "real"],
  ]);
  expect([...selectedSteerPlatforms({ ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS: "1" })]).toEqual([
    ["claude", "scripted"],
    ["cursor", "scripted"],
  ]);
  expect([
    ...selectedSteerPlatforms({
      ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS: "1",
      ORKESTRATOR_AGENT_TEST_STEER_PLATFORMS: "cursor",
      ORKESTRATOR_AGENT_TEST_STEER_REAL_PLATFORMS: "claude",
    }),
  ]).toEqual([
    ["cursor", "scripted"],
    ["claude", "real"],
  ]);
  expect(() =>
    selectedSteerPlatforms({
      ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS: "1",
      ORKESTRATOR_AGENT_TEST_STEER_PLATFORMS: "codex",
    }),
  ).toThrow("not codex");
  expect(() =>
    selectedSteerPlatforms({
      ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS: "1",
      ORKESTRATOR_AGENT_TEST_STEER_REAL_PLATFORMS: "cursor",
    }),
  ).toThrow("both a real and a scripted model");
});

test("the fake vendor store is read per environment, and steers are counted by marker", () => {
  const dataDir = scratch();
  expect(fakeCursorTurns(dataDir, "env-1")).toEqual([]);
  const file = fakeCursorStorePath(dataDir, "env-1");
  expect(file.startsWith(path.join(dataDir, "cursor-bridge-state"))).toBe(true);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      agents: {
        a: {
          turns: [{ runId: "r1", prompt: "HOLD", status: "running", steers: [steerPrompt("m-1")] }],
        },
      },
    }),
  );
  const turns = fakeCursorTurns(dataDir, "env-1");
  expect(turns).toHaveLength(1);
  expect(steersCarrying(turns, "m-1")).toBe(1);
  expect(steersCarrying(turns, "m-2")).toBe(0);
  expect(fakeCursorTurns(dataDir, "env-2")).toEqual([]);
});

test("the spec's prompts are the ones the scripted models act on", () => {
  expect(readyPrompt("cursor", "scripted")).toContain("HOLD");
  // A real model is asked only for what it can do.
  expect(readyPrompt("cursor", "real")).not.toContain("HOLD");
  expect(readyPrompt("claude", "scripted")).not.toContain("HOLD");
  const tools = [{ name: "Bash" }];
  expect(
    steerStep({ tools, messages: [{ role: "user", content: readyPrompt("claude", "scripted") }] }),
  ).toMatchObject({
    kind: "shell",
    command: expect.stringContaining(".qa-queued-ready"),
  });
  expect(
    steerStep({
      tools,
      messages: [
        { role: "user", content: readyPrompt("claude", "scripted") },
        { role: "user", content: steerPrompt("queued-steer-42") },
      ],
    }),
  ).toMatchObject({ kind: "shell", command: expect.stringContaining("'queued-steer-42' >>") });
});
