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
 *   restore puts back.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { environmentStateDirectory } from "../../apps/backend/src/core/environment-state-paths";

export type SteerPlatform = "codex" | "claude" | "cursor";

export const STEER_PLATFORM_LABELS: Record<SteerPlatform, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
};

/** The bundle's backup beside the entry it replaced. */
export const REAL_ENTRY_SUFFIX = ".qa-real";

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

/**
 * Put `bundle` where the bridge entry is, keeping the real entry beside it.
 * A backup left by an earlier, interrupted run is the real entry, so it is
 * kept rather than overwritten with whatever the entry now holds.
 */
export function swapBridgeEntry(entry: string, bundle: string): () => void {
  const backup = `${entry}${REAL_ENTRY_SUFFIX}`;
  if (!existsSync(backup)) {
    if (!existsSync(entry)) throw new Error(`bridge entry not found: ${entry}`);
    renameSync(entry, backup);
  }
  writeFileSync(entry, bundle, { mode: 0o644 });
  return () => {
    if (existsSync(backup)) renameSync(backup, entry);
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
