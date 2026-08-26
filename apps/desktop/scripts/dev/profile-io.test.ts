import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseRuntimeStatusManifest,
  resolveRuntimeProfile,
  statusManifestPath,
} from "../../electron/runtime-profile.js";
import type { ToolchainArtifact } from "../../electron/toolchain-manifest.js";
import {
  atomicWriteJson,
  initializeProfile,
  processMatches,
  processStartTime,
  readAndValidateSentinel,
  removeProfileState,
  reserveLoopbackPorts,
  seedAgentTestProviderCredentials,
  seedInstalledAgentToolchains,
  seedInstalledModelCatalogCaches,
} from "./profile-io.js";
import {
  createBoundedLogWriter,
  orphanedRuntimeProcesses,
  seedAgentTestProfileState,
  stoppedRuntimeStatusIfUnchanged,
  stopTrackedRuntimeProcesses,
} from "./lifecycle.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

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

async function modelCacheFixture() {
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
  return {
    root,
    roots,
    profile,
    sources: {
      agent: path.join(roots.productionDataDir, "agent-model-catalog.json"),
      opencode: path.join(roots.productionDataDir, "opencode-model-catalog.json"),
      codex: path.join(roots.homeDir, ".codex", "models_cache.json"),
      bridge: path.join(roots.homeDir, ".codex", "orkestrator-bridge", "models-cache.json"),
      grok: path.join(roots.homeDir, ".grok", "models_cache.json"),
    },
    destinations: {
      agent: path.join(profile.dataDir, "agent-model-catalog.json"),
      opencode: path.join(profile.dataDir, "opencode-model-catalog.json"),
      codex: path.join(profile.dataDir, "agent-credentials", "codex", "models_cache.json"),
      bridge: path.join(
        profile.dataDir,
        "agent-credentials",
        "codex",
        "orkestrator-bridge",
        "models-cache.json",
      ),
      grok: path.join(profile.dataDir, "agent-credentials", "home", ".grok", "models_cache.json"),
    },
  };
}

describe("development profile lifecycle primitives", () => {
  test("serializes bounded log writes and rotates without rereading the log", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-bounded-log-"));
    directories.push(root);
    const logPath = path.join(root, "vite.log");
    const writer = createBoundedLogWriter(logPath, 8);

    await Promise.all([writer.write("aaaaaa"), writer.write("bbbb"), writer.write("0123456789")]);

    expect(await readFile(logPath, "utf8")).toBe("23456789");
    expect(await readFile(`${logPath}.1`, "utf8")).toBe("bbbb");
    expect((await stat(logPath)).size).toBeLessThanOrEqual(8);
    expect((await stat(`${logPath}.1`)).size).toBeLessThanOrEqual(8);
  });

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
    await expect(readAndValidateSentinel(profile, roots)).resolves.toEqual({
      version: 1,
      profile: "qa",
    });
  });

  test("full profile reset unlinks legacy Keychain state without touching the host", async () => {
    const { root, profile } = await modelCacheFixture();
    const hostKeychains = path.join(root, "host-keychains");
    await mkdir(hostKeychains, { recursive: true });
    await writeFile(path.join(hostKeychains, "login.keychain-db"), "host-login");
    const target = path.join(profile.dataDir, "agent-credentials", "home", "Library", "Keychains");
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(hostKeychains, target);

    await removeProfileState(profile, false);

    expect(
      await access(profile.profileRoot).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await expect(readFile(path.join(hostKeychains, "login.keychain-db"), "utf8")).resolves.toBe(
      "host-login",
    );
  });

  test("toolchain-preserving reset uses the same symlink-safe deletion path", async () => {
    const { root, profile } = await modelCacheFixture();
    const toolchain = path.join(profile.dataDir, "toolchains", "grok");
    await mkdir(path.dirname(toolchain), { recursive: true });
    await writeFile(toolchain, "managed-toolchain");
    const hostKeychains = path.join(root, "host-keychains");
    await mkdir(hostKeychains, { recursive: true });
    await writeFile(path.join(hostKeychains, "login.keychain-db"), "host-login");
    const target = path.join(profile.dataDir, "agent-credentials", "home", "Library", "Keychains");
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(hostKeychains, target);

    await removeProfileState(profile, true);

    await expect(readFile(toolchain, "utf8")).resolves.toBe("managed-toolchain");
    expect(
      await access(target).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await expect(readFile(path.join(hostKeychains, "login.keychain-db"), "utf8")).resolves.toBe(
      "host-login",
    );
  });

  test("copies stable missing model catalogue caches with owner-only permissions", async () => {
    const { roots, profile, sources, destinations } = await modelCacheFixture();
    await writeFile(sources.agent, "agent-cache");
    await writeFile(sources.opencode, "opencode-cache");
    await writeFile(sources.codex, "codex-cache");
    await writeFile(sources.bridge, "bridge-cache");
    await writeFile(sources.grok, "grok-cache");

    await expect(seedInstalledModelCatalogCaches(profile, { roots, env: {} })).resolves.toEqual([
      "agent-model-catalog.json",
      "opencode-model-catalog.json",
      "codex/models_cache.json",
      "codex/orkestrator-bridge/models-cache.json",
      "grok/models_cache.json",
    ]);
    expect(await readFile(destinations.agent, "utf8")).toBe("agent-cache");
    expect(await readFile(destinations.opencode, "utf8")).toBe("opencode-cache");
    expect(await readFile(destinations.codex, "utf8")).toBe("codex-cache");
    expect(await readFile(destinations.bridge, "utf8")).toBe("bridge-cache");
    expect(await readFile(destinations.grok, "utf8")).toBe("grok-cache");
    for (const destination of Object.values(destinations)) {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
  });

  test("preserves profile-local catalogue updates when a profile is seeded again", async () => {
    const { roots, profile, sources, destinations } = await modelCacheFixture();
    for (const source of Object.values(sources)) await writeFile(source, "initial-host-cache");
    await seedInstalledModelCatalogCaches(profile, { roots, env: {} });
    for (const destination of Object.values(destinations))
      await writeFile(destination, "profile-live-cache");
    for (const source of Object.values(sources)) await writeFile(source, "new-host-cache");

    await expect(seedInstalledModelCatalogCaches(profile, { roots, env: {} })).resolves.toEqual([]);
    for (const destination of Object.values(destinations)) {
      expect(await readFile(destination, "utf8")).toBe("profile-live-cache");
    }
  });

  test("copies only an explicitly enabled Grok credential and refreshes it on restart", async () => {
    const { roots, profile } = await modelCacheFixture();
    const source = path.join(roots.homeDir, ".grok", "auth.json");
    const destination = path.join(
      profile.dataDir,
      "agent-credentials",
      "home",
      ".grok",
      "auth.json",
    );
    await writeFile(source, "host-auth-v1");

    await expect(seedAgentTestProviderCredentials(profile, { roots })).resolves.toEqual([]);
    await expect(readFile(destination)).rejects.toThrow();

    const enabled = { ...profile, credentialSources: ["grok" as const] };
    await expect(seedAgentTestProviderCredentials(enabled, { roots })).resolves.toEqual([
      "grok/auth.json",
    ]);
    expect(await readFile(destination, "utf8")).toBe("host-auth-v1");
    expect((await stat(destination)).mode & 0o777).toBe(0o600);

    await writeFile(source, "host-auth-v2");
    await expect(seedAgentTestProviderCredentials(enabled, { roots })).resolves.toEqual([
      "grok/auth.json",
    ]);
    expect(await readFile(destination, "utf8")).toBe("host-auth-v2");
  });

  /**
   * A stand-in for one pinned artifact. Only the fields the seeder reads to
   * derive a path matter; nothing here is verified against real bytes.
   */
  function toolchainArtifact(name: "pi" | "grok", version: string): ToolchainArtifact {
    return {
      name,
      version,
      platform: "darwin",
      architecture: "arm64",
      archive: {
        format: "raw",
        url: `https://example.invalid/${name}`,
        allowedHosts: ["example.invalid"],
        entryPath: name,
        size: 1,
        sha256: "0".repeat(64),
      },
      executable: { fileName: name, size: 1, sha256: "0".repeat(64) },
    };
  }

  async function toolchainFixture(platforms: Array<"pi" | "grok">) {
    const fixture = await modelCacheFixture();
    const artifacts = [toolchainArtifact("pi", "0.84.3"), toolchainArtifact("grok", "1.0.3")];
    const hostDirectory = (name: string, version: string) =>
      path.join(fixture.roots.productionDataDir, "toolchains", name, version, "darwin-arm64");
    const profileDirectory = (name: string, version: string) =>
      path.join(fixture.profile.dataDir, "toolchains", name, version, "darwin-arm64");
    return {
      ...fixture,
      artifacts,
      hostDirectory,
      profileDirectory,
      profile: { ...fixture.profile, agentPlatforms: platforms },
    };
  }

  test("seeds selected agent toolchains from the host installation", async () => {
    const {
      roots: profileRoots,
      profile,
      artifacts,
      hostDirectory,
      profileDirectory,
    } = await toolchainFixture(["pi", "grok"]);
    for (const [name, version] of [
      ["pi", "0.84.3"],
      ["grok", "1.0.3"],
    ] as const) {
      await mkdir(hostDirectory(name, version), { recursive: true });
      await writeFile(path.join(hostDirectory(name, version), name), `${name}-bytes`);
    }
    // Finder droppings would change Pi's aggregate bundle digest, which is
    // exactly the check that would then force the download this avoids.
    await writeFile(path.join(hostDirectory("pi", "0.84.3"), ".DS_Store"), "junk");

    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
      }),
    ).resolves.toEqual({ seeded: ["pi@0.84.3", "grok@1.0.3"], failed: [] });
    expect(await readFile(path.join(profileDirectory("pi", "0.84.3"), "pi"), "utf8")).toBe(
      "pi-bytes",
    );
    expect(await readFile(path.join(profileDirectory("grok", "1.0.3"), "grok"), "utf8")).toBe(
      "grok-bytes",
    );
    await expect(
      access(path.join(profileDirectory("pi", "0.84.3"), ".DS_Store")),
    ).rejects.toThrow();
  });

  test("seeds only the selected platforms and leaves the host untouched", async () => {
    const {
      roots: profileRoots,
      profile,
      artifacts,
      hostDirectory,
      profileDirectory,
    } = await toolchainFixture(["grok"]);
    for (const [name, version] of [
      ["pi", "0.84.3"],
      ["grok", "1.0.3"],
    ] as const) {
      await mkdir(hostDirectory(name, version), { recursive: true });
      await writeFile(path.join(hostDirectory(name, version), name), `${name}-bytes`);
    }

    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
      }),
    ).resolves.toEqual({ seeded: ["grok@1.0.3"], failed: [] });
    await expect(access(profileDirectory("pi", "0.84.3"))).rejects.toThrow();
    // One-way: the profile never writes back into the user's real installation.
    expect(await readFile(path.join(hostDirectory("grok", "1.0.3"), "grok"), "utf8")).toBe(
      "grok-bytes",
    );
  });

  test("leaves an already-provisioned profile toolchain alone", async () => {
    const {
      roots: profileRoots,
      profile,
      artifacts,
      hostDirectory,
      profileDirectory,
    } = await toolchainFixture(["grok"]);
    await mkdir(hostDirectory("grok", "1.0.3"), { recursive: true });
    await writeFile(path.join(hostDirectory("grok", "1.0.3"), "grok"), "host-bytes");
    await mkdir(profileDirectory("grok", "1.0.3"), { recursive: true });
    await writeFile(path.join(profileDirectory("grok", "1.0.3"), "grok"), "profile-bytes");

    // A running backend resolves through this directory. Re-seeding it on every
    // restart would swap the executable underneath a live session.
    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
      }),
    ).resolves.toEqual({ seeded: [], failed: [] });
    expect(await readFile(path.join(profileDirectory("grok", "1.0.3"), "grok"), "utf8")).toBe(
      "profile-bytes",
    );
  });

  test("reports nothing when the host has not installed the toolchain", async () => {
    const {
      roots: profileRoots,
      profile,
      artifacts,
      profileDirectory,
    } = await toolchainFixture(["pi", "grok"]);

    // The installer downloads it instead. Seeding is an optimization, so a bare
    // host must not fail the profile start.
    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
      }),
    ).resolves.toEqual({ seeded: [], failed: [] });
    await expect(access(profileDirectory("grok", "1.0.3"))).rejects.toThrow();
  });

  test("refuses a symlinked host toolchain directory", async () => {
    const {
      root,
      roots: profileRoots,
      profile,
      artifacts,
      hostDirectory,
      profileDirectory,
    } = await toolchainFixture(["grok"]);
    const elsewhere = path.join(root, "elsewhere", "grok");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "grok"), "elsewhere-bytes");
    await mkdir(path.dirname(hostDirectory("grok", "1.0.3")), { recursive: true });
    // Following it would copy from a tree outside the host toolchain root, which
    // is not the installation this seeding is allowed to trust.
    await symlink(elsewhere, hostDirectory("grok", "1.0.3"));

    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
        warn: () => undefined,
      }),
    ).resolves.toEqual({ seeded: [], failed: [] });
    await expect(access(profileDirectory("grok", "1.0.3"))).rejects.toThrow();
  });

  test("reports a failed copy distinctly from a host that has nothing installed", async () => {
    const {
      roots: profileRoots,
      profile,
      artifacts,
      hostDirectory,
      profileDirectory,
    } = await toolchainFixture(["grok"]);
    await mkdir(hostDirectory("grok", "1.0.3"), { recursive: true });
    await writeFile(path.join(hostDirectory("grok", "1.0.3"), "grok"), "host-bytes");
    // A file where the version directory has to go. The copy cannot succeed, and
    // this must not look like the bare-host case, which is byte-identical in its
    // outcome — both fall through to the installer's download.
    await mkdir(path.dirname(path.dirname(profileDirectory("grok", "1.0.3"))), { recursive: true });
    await writeFile(path.dirname(profileDirectory("grok", "1.0.3")), "not-a-directory");

    const warnings: string[] = [];
    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
        warn: (message) => warnings.push(message),
      }),
    ).resolves.toEqual({ seeded: [], failed: ["grok@1.0.3"] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("grok@1.0.3");
    // Diagnostics name the artifact, never the filesystem paths involved.
    expect(warnings[0]).not.toContain(profileRoots.productionDataDir);
    expect(warnings[0]).not.toContain(profile.dataDir);
  });

  test("seeds nothing for a profile that provisions no platforms", async () => {
    const { roots: profileRoots, profile, artifacts, hostDirectory } = await toolchainFixture([]);
    await mkdir(hostDirectory("grok", "1.0.3"), { recursive: true });
    await writeFile(path.join(hostDirectory("grok", "1.0.3"), "grok"), "host-bytes");

    await expect(
      seedInstalledAgentToolchains(
        { ...profile, agentPlatforms: [] },
        { roots: profileRoots, artifacts, platform: "darwin", architecture: "arm64" },
      ),
    ).resolves.toEqual({ seeded: [], failed: [] });
  });

  test("seeds an agent-test profile and reports what Electron still has to download", async () => {
    const { profile } = await toolchainFixture(["pi", "grok"]);
    const logs: string[] = [];
    const warnings: string[] = [];

    await seedAgentTestProfileState(profile, "agent-test", {
      seedModelCatalogCaches: async () => [],
      seedProviderCredentials: async () => [],
      seedAgentToolchains: async () => ({ seeded: ["pi@0.84.3"], failed: ["grok@1.0.3"] }),
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    });

    expect(logs).toEqual([
      "Seeded toolchains from the host install: pi@0.84.3",
      // Attributes a slow or hung startup before Electron is even launched.
      "Electron will download managed toolchains for: grok",
    ]);
    expect(warnings).toEqual(["Could not seed from the host install: grok@1.0.3"]);
  });

  test("seeds nothing for an ordinary development profile", async () => {
    const { profile } = await toolchainFixture(["pi", "grok"]);
    const calls: string[] = [];

    // `dev` uses the durable per-installation state; copying host toolchains
    // into it would be provisioning a profile that does not exist.
    await seedAgentTestProfileState({ ...profile, flavor: "development" }, "development", {
      seedModelCatalogCaches: async () => {
        calls.push("caches");
        return [];
      },
      seedProviderCredentials: async () => {
        calls.push("credentials");
        return [];
      },
      seedAgentToolchains: async () => {
        calls.push("toolchains");
        return { seeded: [], failed: [] };
      },
      log: (message) => calls.push(message),
      warn: (message) => calls.push(message),
    });

    expect(calls).toEqual([]);
  });

  test("skips missing, symlinked, and oversized model cache sources", async () => {
    const { root, roots, profile, sources, destinations } = await modelCacheFixture();
    const linkedCache = path.join(root, "linked-cache.json");
    await writeFile(linkedCache, "linked-cache");
    await symlink(linkedCache, sources.opencode);
    await writeFile(sources.agent, "");
    await truncate(sources.agent, 16 * 1024 * 1024 + 1);

    await expect(seedInstalledModelCatalogCaches(profile, { roots, env: {} })).resolves.toEqual([]);
    for (const destination of Object.values(destinations)) {
      await expect(readFile(destination)).rejects.toThrow();
    }
  });

  test("rejects caches that grow or are replaced after descriptor validation", async () => {
    const { roots, profile, sources, destinations } = await modelCacheFixture();
    await writeFile(sources.agent, "agent-cache");
    await writeFile(sources.opencode, "opencode-cache");

    await expect(
      seedInstalledModelCatalogCaches(profile, {
        roots,
        env: {},
        afterSourceValidation: async (label) => {
          if (label === "agent-model-catalog.json") {
            await appendFile(sources.agent, "-changed");
          } else if (label === "opencode-model-catalog.json") {
            await rename(sources.opencode, `${sources.opencode}.old`);
            await writeFile(sources.opencode, "replacement-cache");
          }
        },
      }),
    ).resolves.toEqual([]);
    await expect(readFile(destinations.agent)).rejects.toThrow();
    await expect(readFile(destinations.opencode)).rejects.toThrow();
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

    await expect(
      stopTrackedRuntimeProcesses(status, {
        matches: (pid) => Boolean(pid && active.has(pid)),
        signal: (pid, signal, processGroup) => {
          signals.push({ pid, signal, processGroup });
          active.delete(pid);
          if (pid === 33) active.delete(44);
        },
        sleep: async () => undefined,
      }),
    ).resolves.toEqual([]);

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

    await expect(
      stopTrackedRuntimeProcesses(runtimeStatus(), {
        matches: (pid) => Boolean(pid && active.has(pid)),
        signal: (pid, signal, processGroup) => {
          signals.push({ pid, signal, processGroup });
          if (pid === 11) active.clear();
        },
        sleep: async () => undefined,
      }),
    ).resolves.toEqual([]);

    expect(signals).toEqual([{ pid: 11, signal: "SIGTERM", processGroup: false }]);
  });

  test("escalates to SIGKILL and reports whatever outlives it", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let clock = 0;
    // Nothing ever exits: SIGTERM to the launcher, then SIGTERM to all four,
    // then SIGKILL to the four survivors, and the caller learns every name.
    // The clock is driven by the sleep stub so the 5s/5s/2s deadlines are
    // exercised without spending twelve real seconds on them.
    await expect(
      stopTrackedRuntimeProcesses(runtimeStatus(), {
        matches: (pid) => Boolean(pid),
        signal: (pid, signal) => void signals.push({ pid, signal }),
        sleep: async (milliseconds) => void (clock += milliseconds),
        now: () => clock,
      }),
    ).resolves.toEqual(["launcher", "vite", "electron", "backend"]);

    expect(signals.filter((entry) => entry.signal === "SIGTERM").map((entry) => entry.pid)).toEqual(
      [11, 11, 22, 33, 44],
    );
    expect(signals.filter((entry) => entry.signal === "SIGKILL").map((entry) => entry.pid)).toEqual(
      [11, 22, 33, 44],
    );
  });

  test("treats surviving processes without a launcher as orphans that block a restart", () => {
    const live = { launcher: false, vite: true, electron: false, backend: true };
    expect(orphanedRuntimeProcesses(live)).toEqual(["vite", "backend"]);
    // A live launcher owns them, so `dev` reports "already running" instead.
    expect(orphanedRuntimeProcesses({ ...live, launcher: true })).toEqual([]);
    expect(
      orphanedRuntimeProcesses({ launcher: false, vite: false, electron: false, backend: false }),
    ).toEqual([]);
    expect(orphanedRuntimeProcesses(null)).toEqual([]);
  });

  test("marks only the process snapshot it stopped as stopped", () => {
    const original = runtimeStatus();
    const stopped = stoppedRuntimeStatusIfUnchanged(original, original, "2026-08-14T12:00:00.000Z");
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.updatedAt).toBe("2026-08-14T12:00:00.000Z");

    expect(
      stoppedRuntimeStatusIfUnchanged(original, {
        ...original,
        pids: { ...original.pids, launcher: 55 },
        processStartTimes: { ...original.processStartTimes, launcher: 5 },
      }),
    ).toBeNull();
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
    expect(() => parseRuntimeStatusManifest({ ...base, token: "secret" })).toThrow(
      "unsupported field",
    );

    const root = await mkdtemp(path.join(os.tmpdir(), "ork-profile-status-"));
    directories.push(root);
    const filePath = path.join(root, "status.json");
    await atomicWriteJson(filePath, base);
    expect(JSON.parse(await readFile(filePath, "utf8"))).not.toHaveProperty("token");
    expect(
      statusManifestPath(
        resolveRuntimeProfile({
          repositoryRoot: root,
          requestedId: "qa",
          roots: {
            developmentRoot: root,
            productionDataDir: path.join(root, "prod"),
            homeDir: os.tmpdir(),
          },
        }),
      ),
    ).toEndWith(path.join("runtime", "status.json"));
  });
});
