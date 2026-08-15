import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseRuntimeStatusManifest, resolveRuntimeProfile, statusManifestPath } from "../../electron/runtime-profile.js";
import { atomicWriteJson, initializeProfile, processMatches, processStartTime, readAndValidateSentinel, reserveLoopbackPorts, seedInstalledModelCatalogCaches } from "./profile-io.js";
import { orphanedRuntimeProcesses, stoppedRuntimeStatusIfUnchanged, stopTrackedRuntimeProcesses } from "./lifecycle.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function runtimeStatus() {
  return {
    version: 1 as const,
    status: "ready" as const,
    profile: "qa",
    flavor: "agent-test" as const,
    dataDir: "/tmp/data",
    electronTitle: "Orkestrator AI — DEV [qa]",
    rendererUrl: "http://127.0.0.1:1",
    logDir: "/tmp/logs",
    statusPath: "/tmp/status.json",
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    pids: { launcher: 11, vite: 22, electron: 33, backend: 44 },
    processStartTimes: { launcher: 1, vite: 2, electron: 3, backend: 4 },
  };
}

describe("development profile lifecycle primitives", () => {
  test("creates owner-only profile metadata and a matching sentinel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-profile-io-"));
    directories.push(root);
    const roots = {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    };
    const profile = resolveRuntimeProfile({
      repositoryRoot: path.join(root, "repo"),
      requestedId: "qa",
      roots,
    });
    const profilePath = await initializeProfile(profile);
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
    await expect(readAndValidateSentinel(profile, roots)).resolves.toEqual({ version: 1, profile: "qa" });
  });

  test("copies only bounded installed model catalogue caches into the isolated profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-profile-caches-"));
    directories.push(root);
    const roots = {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: path.join(root, "home"),
    };
    const profile = resolveRuntimeProfile({
      repositoryRoot: path.join(root, "repo"),
      requestedId: "qa",
      roots,
    });
    await initializeProfile(profile);
    await mkdir(roots.productionDataDir, { recursive: true });
    await mkdir(path.join(roots.homeDir, ".codex", "orkestrator-bridge"), { recursive: true });
    await mkdir(path.join(roots.homeDir, ".grok"), { recursive: true });
    await writeFile(path.join(roots.productionDataDir, "agent-model-catalog.json"), "agent-cache");
    await writeFile(path.join(roots.productionDataDir, "opencode-model-catalog.json"), "opencode-cache");
    await writeFile(path.join(roots.homeDir, ".codex", "models_cache.json"), "codex-cache");
    await writeFile(path.join(roots.homeDir, ".codex", "orkestrator-bridge", "models-cache.json"), "bridge-cache");
    await writeFile(path.join(roots.homeDir, ".grok", "models_cache.json"), "grok-cache");

    await expect(seedInstalledModelCatalogCaches(profile, { roots, env: {} })).resolves.toEqual([
      "agent-model-catalog.json",
      "opencode-model-catalog.json",
      "codex/models_cache.json",
      "codex/orkestrator-bridge/models-cache.json",
      "grok/models_cache.json",
    ]);
    expect(await readFile(path.join(profile.dataDir, "agent-model-catalog.json"), "utf8")).toBe("agent-cache");
    expect(await readFile(path.join(profile.dataDir, "opencode-model-catalog.json"), "utf8")).toBe("opencode-cache");
    expect(await readFile(path.join(profile.dataDir, "agent-credentials", "codex", "models_cache.json"), "utf8"))
      .toBe("codex-cache");
    expect(await readFile(path.join(profile.dataDir, "agent-credentials", "codex", "orkestrator-bridge", "models-cache.json"), "utf8"))
      .toBe("bridge-cache");
    expect(await readFile(path.join(profile.dataDir, "agent-credentials", "home", ".grok", "models_cache.json"), "utf8"))
      .toBe("grok-cache");
  });

  test("validates process identity with PID and start time", () => {
    const started = processStartTime(process.pid);
    expect(started).not.toBeNull();
    expect(processMatches(process.pid, started!)).toBe(true);
    expect(processMatches(process.pid, started! - 60_000)).toBe(false);
  });

  test("stops surviving detached processes when the launcher is already dead", async () => {
    const active = new Set([22, 33, 44]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals; processGroup: boolean }> = [];
    const status = runtimeStatus();

    await expect(stopTrackedRuntimeProcesses(status, {
      matches: (pid) => Boolean(pid && active.has(pid)),
      signal: (pid, signal, processGroup) => {
        signals.push({ pid, signal, processGroup });
        active.delete(pid);
        if (pid === 33) active.delete(44);
      },
      sleep: async () => undefined,
    })).resolves.toEqual([]);

    expect(signals).toEqual([
      { pid: 22, signal: "SIGTERM", processGroup: true },
      { pid: 33, signal: "SIGTERM", processGroup: true },
    ]);
    expect(active.size).toBe(0);
  });

  test("stops at the launcher when its shutdown takes the whole tree with it", async () => {
    // The launcher's own SIGTERM handler kills the Vite and Electron groups, so
    // signalling every tracked PID as well would be redundant at best and, once
    // those PIDs are recycled, aimed at something else entirely.
    const active = new Set([11, 22, 33, 44]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals; processGroup: boolean }> = [];

    await expect(stopTrackedRuntimeProcesses(runtimeStatus(), {
      matches: (pid) => Boolean(pid && active.has(pid)),
      signal: (pid, signal, processGroup) => {
        signals.push({ pid, signal, processGroup });
        if (pid === 11) active.clear();
      },
      sleep: async () => undefined,
    })).resolves.toEqual([]);

    expect(signals).toEqual([{ pid: 11, signal: "SIGTERM", processGroup: false }]);
  });

  test("escalates to SIGKILL and reports whatever outlives it", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let clock = 0;
    // Nothing ever exits: SIGTERM to the launcher, then SIGTERM to all four,
    // then SIGKILL to the four survivors, and the caller learns every name.
    // The clock is driven by the sleep stub so the 5s/5s/2s deadlines are
    // exercised without spending twelve real seconds on them.
    await expect(stopTrackedRuntimeProcesses(runtimeStatus(), {
      matches: (pid) => Boolean(pid),
      signal: (pid, signal) => void signals.push({ pid, signal }),
      sleep: async (milliseconds) => void (clock += milliseconds),
      now: () => clock,
    })).resolves.toEqual(["launcher", "vite", "electron", "backend"]);

    expect(signals.filter((entry) => entry.signal === "SIGTERM").map((entry) => entry.pid))
      .toEqual([11, 11, 22, 33, 44]);
    expect(signals.filter((entry) => entry.signal === "SIGKILL").map((entry) => entry.pid))
      .toEqual([11, 22, 33, 44]);
  });

  test("treats surviving processes without a launcher as orphans that block a restart", () => {
    const live = { launcher: false, vite: true, electron: false, backend: true };
    expect(orphanedRuntimeProcesses(live)).toEqual(["vite", "backend"]);
    // A live launcher owns them, so `dev` reports "already running" instead.
    expect(orphanedRuntimeProcesses({ ...live, launcher: true })).toEqual([]);
    expect(orphanedRuntimeProcesses({ launcher: false, vite: false, electron: false, backend: false })).toEqual([]);
    expect(orphanedRuntimeProcesses(null)).toEqual([]);
  });

  test("marks only the process snapshot it stopped as stopped", () => {
    const original = runtimeStatus();
    const stopped = stoppedRuntimeStatusIfUnchanged(original, original, "2026-08-14T12:00:00.000Z");
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.updatedAt).toBe("2026-08-14T12:00:00.000Z");

    expect(stoppedRuntimeStatusIfUnchanged(original, {
      ...original,
      pids: { ...original.pids, launcher: 55 },
      processStartTimes: { ...original.processStartTimes, launcher: 5 },
    })).toBeNull();
  });

  test("reserves distinct usable loopback ports", async () => {
    const [first, second] = await reserveLoopbackPorts(2);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(first).not.toBe(second);
  });

  test("status validation rejects secret-bearing or unknown fields", async () => {
    const base = {
      version: 1,
      status: "ready",
      profile: "qa",
      flavor: "agent-test",
      dataDir: "/tmp/data",
      electronTitle: "Orkestrator AI — DEV [qa]",
      rendererUrl: "http://127.0.0.1:1",
      logDir: "/tmp/logs",
      statusPath: "/tmp/status.json",
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      pids: {},
      processStartTimes: {},
    };
    expect(parseRuntimeStatusManifest(base).profile).toBe("qa");
    expect(() => parseRuntimeStatusManifest({ ...base, token: "secret" })).toThrow("unsupported field");

    const root = await mkdtemp(path.join(os.tmpdir(), "ork-profile-status-"));
    directories.push(root);
    const filePath = path.join(root, "status.json");
    await atomicWriteJson(filePath, base);
    expect(JSON.parse(await readFile(filePath, "utf8"))).not.toHaveProperty("token");
    expect(statusManifestPath(resolveRuntimeProfile({
      repositoryRoot: root,
      requestedId: "qa",
      roots: { developmentRoot: root, productionDataDir: path.join(root, "prod"), homeDir: os.tmpdir() },
    }))).toEndWith(path.join("runtime", "status.json"));
  });
});
