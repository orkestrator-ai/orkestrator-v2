import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Runs the real launcher (`bin/orkestrator-launcher.js`) against fake
 * releases whose entry behaves like the backend: it answers `toolchain
 * install`, and for `serve` writes the instance descriptor naming its process
 * and version, then waits for SIGTERM.
 */

const LAUNCHER = path.resolve(import.meta.dir, "../bin/orkestrator-launcher.js");

const FAKE_ENTRY = `
import { readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const packageRoot = path.resolve(import.meta.dir, "..");
const release = path.resolve(packageRoot, "../..");
const version = path.basename(release);
const mode = readFileSync(path.join(packageRoot, "mode"), "utf8").trim();
if (args[0] === "toolchain") process.exit(0);
if (mode === "crash") process.exit(1);
if (mode.startsWith("refuse:") && args.includes(mode.slice("refuse:".length))) process.exit(1);
if (mode === "unready") {
  const dataDir = args[args.indexOf("--data-dir") + 1];
  const { appendFileSync } = await import("node:fs");
  appendFileSync(path.join(dataDir, "failed-pids"), process.pid + "\\n");
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const dataDir = args[args.indexOf("--data-dir") + 1];
writeFileSync(path.join(dataDir, "backend-instance.json"), JSON.stringify({ pid: process.pid, appVersion: version }));
process.on("SIGTERM", () => process.exit(0));
if (mode.startsWith("update-to:")) {
  // What the self-updater does: switch current, mark the restart, exit.
  setTimeout(() => {
    const root = path.join(dataDir, "backend");
    const next = path.join(root, "releases", mode.slice("update-to:".length));
    const temporary = path.join(root, "current.tmp");
    rmSync(temporary, { force: true });
    symlinkSync(next, temporary);
    renameSync(temporary, path.join(root, "current"));
    writeFileSync(path.join(root, "restart-requested"), "now");
    process.exit(0);
  }, 300);
}
setInterval(() => {}, 1000);
`;

let dataDir: string;
let launcher: ChildProcess | null = null;

afterEach(async () => {
  if (launcher && launcher.exitCode === null) {
    const exited = new Promise((resolve) => launcher!.once("exit", resolve));
    launcher.kill("SIGTERM");
    await exited;
  }
  launcher = null;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function release(version: string, mode: string): Promise<string> {
  const dir = path.join(dataDir, "backend", "releases", version);
  const bin = path.join(dir, "node_modules", "orkestrator", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "orkestrator.js"), FAKE_ENTRY);
  await writeFile(path.join(dir, "node_modules", "orkestrator", "mode"), mode);
  return dir;
}

async function setup(options: {
  current: string;
  previous?: string;
  lastReady?: string;
  args?: string[];
  rollbackTarget?: { version: string; args: string[] };
  installGeneration?: string;
}): Promise<void> {
  const root = path.join(dataDir, "backend");
  await symlink(path.join(root, "releases", options.current), path.join(root, "current"));
  if (options.previous) {
    await symlink(path.join(root, "releases", options.previous), path.join(root, "previous"));
  }
  await writeFile(
    path.join(root, "service.json"),
    JSON.stringify({
      version: 1,
      installGeneration: options.installGeneration,
      dataDir,
      bun: process.execPath,
      bunVersion: Bun.version,
      args: options.args ?? [],
      ...(options.rollbackTarget ? { rollbackTarget: options.rollbackTarget } : {}),
    }),
  );
  if (options.lastReady) {
    await writeFile(
      path.join(root, "launcher-state.json"),
      JSON.stringify({ version: 1, lastReadyVersion: options.lastReady, bootAttempts: {} }),
    );
  }
  launcher = spawn(process.execPath, [LAUNCHER, dataDir], {
    stdio: "ignore",
    env: {
      ...process.env,
      ORKESTRATOR_LAUNCHER_RETRY_DELAY_MS: "20",
      ORKESTRATOR_LAUNCHER_CRASH_DELAY_MS: "20",
      ORKESTRATOR_LAUNCHER_READY_TIMEOUT_MS: "1000",
      ORKESTRATOR_LAUNCHER_STOP_TIMEOUT_MS: "50",
    },
  });
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

describe("orkestrator-launcher", () => {
  test("rolls back to the previous release when a new one never becomes ready", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-launcher-"));
    await release("1.0.0", "good");
    await release("2.0.0", "crash");
    await setup({
      current: "2.0.0",
      previous: "1.0.0",
      lastReady: "1.0.0",
      installGeneration: "new-install",
    });
    const state = () => readJson(path.join(dataDir, "backend", "launcher-state.json"));
    await until(
      () => readJson(path.join(dataDir, "backend-instance.json"))?.appVersion === "1.0.0",
    );
    expect(state()?.rollback).toMatchObject({
      failedVersion: "2.0.0",
      restoredVersion: "1.0.0",
      installGeneration: "new-install",
    });
    // The restored release was already the last ready one, so only clearing the
    // failure shows the launcher has seen it become ready again.
    await until(() => state()?.bootFailure === null);
    expect(state()?.lastReadyVersion).toBe("1.0.0");
  }, 30_000);

  test("a restored release runs with the arguments it had, not the new install's", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-launcher-"));
    await release("1.0.0", "refuse:--new-flag");
    await release("2.0.0", "crash");
    await setup({
      current: "2.0.0",
      previous: "1.0.0",
      lastReady: "1.0.0",
      args: ["--new-flag"],
      rollbackTarget: { version: "1.0.0", args: [] },
    });
    await until(
      () => readJson(path.join(dataDir, "backend-instance.json"))?.appVersion === "1.0.0",
    );
  }, 30_000);

  test("the same version reached by a self-update runs with the service's arguments", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-launcher-"));
    await release("1.0.0", "good");
    await release("2.0.0", "refuse:--old-flag");
    await setup({
      current: "2.0.0",
      previous: "1.0.0",
      rollbackTarget: { version: "2.0.0", args: ["--old-flag"] },
    });
    await until(
      () => readJson(path.join(dataDir, "backend-instance.json"))?.appVersion === "2.0.0",
    );
  }, 30_000);

  test("records consecutive failed boots when nothing can be rolled back to", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-launcher-"));
    await release("2.0.0", "crash");
    await setup({ current: "2.0.0", installGeneration: "new-install" });
    const failure = () =>
      readJson(path.join(dataDir, "backend", "launcher-state.json"))?.bootFailure as
        { version: string; exits: number; at: string } | undefined;
    await until(() => (failure()?.exits ?? 0) >= 2);
    expect(failure()).toMatchObject({ version: "2.0.0", installGeneration: "new-install" });
    expect(Number.isNaN(Date.parse(failure()!.at))).toBe(false);
  }, 30_000);

  test("starts the new release at once after a self-update asks for a restart", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-launcher-"));
    await release("1.0.0", "update-to:2.0.0");
    await release("2.0.0", "good");
    await setup({ current: "1.0.0" });
    await until(
      () => readJson(path.join(dataDir, "backend-instance.json"))?.appVersion === "2.0.0",
    );
    const state = readJson(path.join(dataDir, "backend", "launcher-state.json"));
    await until(
      () =>
        readJson(path.join(dataDir, "backend", "launcher-state.json"))?.lastReadyVersion ===
        "2.0.0",
    );
    expect(state?.rollback ?? null).toBeNull();
  }, 30_000);

  test("forwards SIGTERM and exits with the backend", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-launcher-"));
    await release("1.0.0", "good");
    await setup({ current: "1.0.0" });
    await until(() => readJson(path.join(dataDir, "backend-instance.json")) !== null);
    const exited = new Promise<number | null>((resolve) =>
      launcher!.once("exit", (code) => resolve(code)),
    );
    launcher!.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 30_000);
});

test("kills live unready children after a bounded grace period and restores the previous release", async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ork-launcher-unready-"));
  await release("1.0.0", "good");
  await release("2.0.0", "unready");
  await setup({ current: "2.0.0", previous: "1.0.0", lastReady: "1.0.0" });
  await until(() => readJson(path.join(dataDir, "backend-instance.json"))?.appVersion === "1.0.0");
  const pids = readFileSync(path.join(dataDir, "failed-pids"), "utf8")
    .trim()
    .split("\n")
    .map(Number);
  expect(pids).toHaveLength(2);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);

test("a corrected reinstall gets fresh boot attempts despite persisted old failures", async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ork-launcher-reinstall-"));
  await release("1.0.0", "good");
  await release("2.0.0", "good");
  await writeFile(
    path.join(dataDir, "backend/launcher-state.json"),
    JSON.stringify({
      version: 1,
      installGeneration: "old-install",
      lastReadyVersion: "1.0.0",
      bootAttempts: { "2.0.0": 2 },
      bootFailure: {
        version: "2.0.0",
        exits: 2,
        at: new Date().toISOString(),
        installGeneration: "old-install",
      },
    }),
  );
  await setup({ current: "2.0.0", previous: "1.0.0", installGeneration: "new-install" });
  await until(
    () => readJson(path.join(dataDir, "backend/launcher-state.json"))?.lastReadyVersion === "2.0.0",
  );
  const state = readJson(path.join(dataDir, "backend/launcher-state.json"));
  expect(state?.installGeneration).toBe("new-install");
  expect(state?.rollback).toBeNull();
  expect(state?.bootFailure).toBeNull();
}, 30_000);
