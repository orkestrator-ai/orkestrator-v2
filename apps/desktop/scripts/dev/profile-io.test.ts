import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseRuntimeStatusManifest, resolveRuntimeProfile, statusManifestPath } from "../../electron/runtime-profile.js";
import { atomicWriteJson, initializeProfile, processMatches, processStartTime, readAndValidateSentinel, reserveLoopbackPorts } from "./profile-io.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

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

  test("validates process identity with PID and start time", () => {
    const started = processStartTime(process.pid);
    expect(started).not.toBeNull();
    expect(processMatches(process.pid, started!)).toBe(true);
    expect(processMatches(process.pid, started! - 60_000)).toBe(false);
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
