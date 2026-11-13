/**
 * Per-platform wiring for `steer-inactive-live.spec.ts` (todo 0005 task 7):
 * the same inactive-path steer scenario on Codex with a real model, and on
 * Claude and Cursor with scripted ones.
 *
 * - Claude: the profile's own Claude settings point at the scripted loopback
 *   model `steer-inactive-fake-claude.ts` (through `startLocalFakeModel`,
 *   which restores them), and the real CLI writes the files.
 * - Cursor: for the length of the case the profile's Cursor bridge entry
 *   (`bridges/cursor-bridge/dist/index.js`, which the backend's host launch
 *   runs) is swapped for a bundle of the bridge's
 *   `src/testing/host-fake-engine-server.ts`: the real bridge over the fake
 *   SDK, which keeps every steer it accepted in its store. The real entry is
 *   kept beside it and put back by the returned `restore`; a run killed
 *   before that leaves the backup, which the next install keeps and the next
 *   restore puts back. The entry is shared by every profile started from
 *   this checkout, so the swap holds an owner lock for its whole length (a
 *   second run is refused while the first is alive), and the bundle serves
 *   the fake only to the owning profile's bridges: any other launch runs the
 *   real entry (`bridges/cursor-bridge/src/testing/host-fake-entry-lock.ts`).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { environmentStateDirectory } from "../../apps/backend/src/core/environment-state-paths";
import {
  LOCK_FILE_NAME,
  readHostFakeEntryLock,
  REAL_ENTRY_NAME,
  type HostFakeEntryLock,
} from "../../bridges/cursor-bridge/src/testing/host-fake-entry-lock";

export type SteerPlatform = "codex" | "claude" | "cursor";

export const STEER_PLATFORM_LABELS: Record<SteerPlatform, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
};

/** A real provider model, or the platform's scripted one. */
export type SteerEngine = "real" | "scripted";

/** The prompt that starts the long turn the queued prompt is steered into. */
export function readyPrompt(platform: SteerPlatform, engine: SteerEngine): string {
  const prompt =
    "This is a bounded QA task in a disposable fixture. Create .qa-queued-ready containing ready, then run sleep 45 repeatedly until steered or cancelled. Do not change other files, finish, or commit.";
  // The fake Cursor SDK keeps a run open while its prompt says HOLD.
  return platform === "cursor" && engine === "scripted" ? `HOLD. ${prompt}` : prompt;
}

/** The queued prompt that is steered in; a compliant model appends `marker` once. */
export function steerPrompt(marker: string): string {
  return `Append exactly ${marker} once to .qa-queued-received. Then run sleep 120 and wait for cancellation. Do not change other files or finish.`;
}

function claudeOrCursor(list: string, variable: string): Array<"claude" | "cursor"> {
  return list
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      if (name !== "claude" && name !== "cursor") {
        throw new Error(`${variable} names claude and cursor only, not ${name}`);
      }
      return name;
    });
}

/**
 * Which platforms a run selects, and on which engine. Codex runs on a real
 * model behind `ORKESTRATOR_AGENT_TEST_REVIEW=1`. Claude and Cursor run on
 * scripted models behind `ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS=1`
 * (`ORKESTRATOR_AGENT_TEST_STEER_PLATFORMS` narrows them), or on the
 * profile's real logins when `ORKESTRATOR_AGENT_TEST_STEER_REAL_PLATFORMS`
 * names them (billed; the manual-test checklist's run).
 */
export function selectedSteerPlatforms(env: NodeJS.ProcessEnv): Map<SteerPlatform, SteerEngine> {
  const selected = new Map<SteerPlatform, SteerEngine>();
  if (env.ORKESTRATOR_AGENT_TEST_REVIEW === "1") selected.set("codex", "real");
  if (env.ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS === "1") {
    const variable = "ORKESTRATOR_AGENT_TEST_STEER_PLATFORMS";
    for (const name of claudeOrCursor(env[variable] ?? "claude,cursor", variable)) {
      selected.set(name, "scripted");
    }
  }
  const realVariable = "ORKESTRATOR_AGENT_TEST_STEER_REAL_PLATFORMS";
  for (const name of claudeOrCursor(env[realVariable] ?? "", realVariable)) {
    if (selected.has(name))
      throw new Error(`${name} is selected for both a real and a scripted model`);
    selected.set(name, "real");
  }
  return selected;
}

/** Whether `pid` names a live process (signal 0 checks, it delivers nothing). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the entry's owner lock for `dataDir`'s profile. A lock held by a live
 * process is refused; one whose process is gone was left by a killed run and
 * is taken over.
 */
function acquireEntryLock(directory: string, dataDir: string): HostFakeEntryLock {
  const file = path.join(directory, LOCK_FILE_NAME);
  const lock: HostFakeEntryLock = { pid: process.pid, dataDir, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o644);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = readHostFakeEntryLock(directory);
      if (held && processAlive(held.pid)) {
        throw new Error(
          `the Cursor bridge entry is swapped by another run (pid ${held.pid}, data directory ${held.dataDir}); wait for it, or remove ${file} if that process is not a steer run`,
        );
      }
      rmSync(file, { force: true });
      continue;
    }
    try {
      writeSync(fd, JSON.stringify(lock));
    } finally {
      closeSync(fd);
    }
    return lock;
  }
  throw new Error(`could not take the Cursor bridge entry lock ${file}`);
}

/**
 * Put `bundle` where the bridge entry is for `dataDir`'s profile, keeping the
 * real entry beside it as {@link REAL_ENTRY_NAME}. The swap holds the entry's
 * owner lock until the returned restore runs, so a second run is refused
 * rather than restoring the first run's entry under it. A backup left by an
 * earlier, interrupted run is the real entry, so it is kept rather than
 * overwritten with whatever the entry now holds. Both writes are renames, so
 * a launch never finds the entry missing or half written.
 */
export function swapBridgeEntry(entry: string, bundle: string, dataDir: string): () => void {
  const directory = path.dirname(entry);
  const backup = path.join(directory, REAL_ENTRY_NAME);
  const lock = acquireEntryLock(directory, dataDir);
  const lockFile = path.join(directory, LOCK_FILE_NAME);
  try {
    if (!existsSync(backup)) {
      if (!existsSync(entry)) throw new Error(`bridge entry not found: ${entry}`);
      copyFileSync(entry, `${backup}.tmp`);
      renameSync(`${backup}.tmp`, backup);
    }
    writeFileSync(`${entry}.qa-tmp`, bundle, { mode: 0o644 });
    renameSync(`${entry}.qa-tmp`, entry);
  } catch (error) {
    rmSync(lockFile, { force: true });
    throw error;
  }
  return () => {
    // Only the owner restores; a later swap's lock is not this one's to drop.
    if (readHostFakeEntryLock(directory)?.token !== lock.token) return;
    if (existsSync(backup)) renameSync(backup, entry);
    rmSync(lockFile, { force: true });
  };
}

/** The Cursor bridge entry the backend's host launch runs from this checkout. */
export function cursorBridgeEntry(repositoryRoot: string): string {
  return path.join(repositoryRoot, "bridges", "cursor-bridge", "dist", "index.js");
}

/** Builds the host fake entry the way the bridge's own build does. */
export function bundleHostFakeCursorBridge(repositoryRoot: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "orkestrator-qa-fake-cursor-host-"));
  try {
    const outfile = path.join(directory, "index.js");
    const built = spawnSync(
      "bun",
      [
        "build",
        "src/testing/host-fake-engine-server.ts",
        "--target=bun",
        "--format=esm",
        "--external",
        "@cursor/sdk",
        `--outfile=${outfile}`,
      ],
      { cwd: path.join(repositoryRoot, "bridges", "cursor-bridge"), encoding: "utf8" },
    );
    if (built.status !== 0) throw new Error(built.stderr || "cursor fake bridge build failed");
    return readFileSync(outfile, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export interface FakeCursorTurn {
  runId: string;
  prompt: string;
  status: string;
  steers?: string[];
}

/** Where `host-fake-engine-server.ts` keeps an environment's fake vendor store. */
export function fakeCursorStorePath(dataDir: string, environmentId: string): string {
  return path.join(
    environmentStateDirectory(dataDir, "cursor-bridge-state", environmentId),
    "qa-fake-cursor",
    "store.json",
  );
}

/** Every turn the fake Cursor vendor ran for one environment, oldest first. */
export function fakeCursorTurns(dataDir: string, environmentId: string): FakeCursorTurn[] {
  const file = fakeCursorStorePath(dataDir, environmentId);
  if (!existsSync(file)) return [];
  const store = JSON.parse(readFileSync(file, "utf8")) as {
    agents?: Record<string, { turns?: FakeCursorTurn[] }>;
  };
  return Object.values(store.agents ?? {}).flatMap((agent) => agent.turns ?? []);
}

/** How many times `marker` reached the vendor as a steer of a running turn. */
export function steersCarrying(turns: FakeCursorTurn[], marker: string): number {
  return turns.flatMap((turn) => turn.steers ?? []).filter((steer) => steer.includes(marker))
    .length;
}
