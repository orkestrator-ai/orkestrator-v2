import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CURRENT_TOOLCHAIN_LINK,
  createProgressLogger,
  currentToolchainBinDir,
  installPinnedToolchains,
  planToolchainInstall,
  resolveToolchainSelection,
} from "./install.js";
import type { EnsurePinnedToolchainsOptions, PinnedToolchainResult } from "./manager.js";
import { PINNED_TOOLCHAIN_VERSIONS, type ToolchainName } from "./manifest.js";

const ALL_TOOLS = Object.keys(PINNED_TOOLCHAIN_VERSIONS).sort();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dataDir(config?: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "toolchain-install-"));
  directories.push(directory);
  if (config !== undefined)
    await writeFile(path.join(directory, "config.json"), JSON.stringify(config));
  return directory;
}

/** A manager that installs nothing but reports the activation layout the real one does. */
function fakeEnsure(setId = "set-a") {
  const calls: EnsurePinnedToolchainsOptions[] = [];
  const ensure = async (options: EnsurePinnedToolchainsOptions): Promise<PinnedToolchainResult> => {
    calls.push(options);
    const rootDir = path.join(options.dataDir, "toolchains");
    const binDir = path.join(rootDir, "bin", setId);
    await mkdir(binDir, { recursive: true });
    const executables = {} as Record<ToolchainName, string>;
    for (const artifact of options.artifacts ?? []) {
      executables[artifact.name] = path.join(binDir, artifact.name);
    }
    return { rootDir, binDir, executables };
  };
  return { ensure, calls };
}

describe("resolveToolchainSelection", () => {
  test("an unconfigured data directory gets every pinned tool", async () => {
    const selection = await resolveToolchainSelection({ dataDir: await dataDir() });
    expect(selection.source).toBe("all");
    expect([...selection.tools].sort() as string[]).toEqual(ALL_TOOLS);
  });

  test("follows the enabled platforms in the backend's own config", async () => {
    const selection = await resolveToolchainSelection({
      dataDir: await dataDir({ global: { enabledAgentPlatforms: ["claude", "pi"] } }),
    });
    expect(selection).toEqual({ tools: ["claude", "pi"], source: "config" });
  });

  test("drops platforms that ship no binary", async () => {
    const selection = await resolveToolchainSelection({
      dataDir: await dataDir({ global: { enabledAgentPlatforms: ["codex", "cursor"] } }),
    });
    expect(selection.tools).toEqual(["codex"]);
  });

  test("an installation that predates platform selection keeps its three", async () => {
    const selection = await resolveToolchainSelection({ dataDir: await dataDir({ global: {} }) });
    expect(selection).toEqual({ tools: ["claude", "codex", "opencode"], source: "config" });
  });

  test("an explicit list wins over config and is validated", async () => {
    const directory = await dataDir({ global: { enabledAgentPlatforms: ["claude"] } });
    expect(await resolveToolchainSelection({ dataDir: directory, tools: ["grok"] })).toEqual({
      tools: ["grok"],
      source: "explicit",
    });
    await expect(
      resolveToolchainSelection({ dataDir: directory, tools: ["grok", "nope"] }),
    ).rejects.toThrow("Unknown tool: nope");
  });
});

describe("planToolchainInstall", () => {
  test("names exactly the artifacts for the host and selection", async () => {
    const plan = await planToolchainInstall({
      dataDir: await dataDir(),
      tools: ["claude", "codex"],
      platform: "linux",
      architecture: "x64",
    });
    expect(plan.artifacts.map((artifact) => artifact.name).sort()).toEqual(["claude", "codex"]);
    for (const artifact of plan.artifacts) {
      expect(artifact.version).toBe(PINNED_TOOLCHAIN_VERSIONS[artifact.name]);
      expect([artifact.platform, artifact.architecture]).toEqual(["linux", "x64"]);
    }
  });
});

describe("installPinnedToolchains", () => {
  test("hands the manager only the selected artifacts and points current at the set", async () => {
    const directory = await dataDir({ global: { enabledAgentPlatforms: ["claude", "opencode"] } });
    const { ensure, calls } = fakeEnsure();

    const result = await installPinnedToolchains({
      dataDir: directory,
      platform: "linux",
      architecture: "x64",
      ensure,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.artifacts?.map((artifact) => artifact.name).sort()).toEqual([
      "claude",
      "opencode",
    ]);
    expect(result.source).toBe("config");
    expect(result.versions).toEqual({
      claude: PINNED_TOOLCHAIN_VERSIONS.claude,
      opencode: PINNED_TOOLCHAIN_VERSIONS.opencode,
    });
    expect(result.currentBinDir).toBe(currentToolchainBinDir(directory));
    // Relative, so a moved data directory does not leave a dangling link.
    expect(await readlink(result.currentBinDir)).toBe("set-a");
  });

  test("reports the tools a narrower selection removes from current", async () => {
    const directory = await dataDir();
    const link = async (setId: string, names: string[]) => {
      const binDir = path.join(directory, "toolchains", "bin", setId);
      await mkdir(binDir, { recursive: true });
      for (const name of names) await writeFile(path.join(binDir, name), "");
      return binDir;
    };
    const ensureSet = (setId: string) => async (options: EnsurePinnedToolchainsOptions) => {
      const names = (options.artifacts ?? []).map((artifact) => artifact.name);
      const binDir = await link(setId, names);
      return {
        rootDir: path.join(directory, "toolchains"),
        binDir,
        executables: {} as Record<ToolchainName, string>,
      };
    };
    const first = await installPinnedToolchains({
      dataDir: directory,
      tools: ["claude", "codex", "pi"],
      ensure: ensureSet("set-full"),
    });
    expect(first.dropped).toEqual([]);
    const narrower = await installPinnedToolchains({
      dataDir: directory,
      tools: ["claude"],
      ensure: ensureSet("set-claude"),
    });
    expect(narrower.dropped).toEqual(["codex", "pi"]);
  });

  test("repoints current when a later install activates a different set", async () => {
    const directory = await dataDir();
    await installPinnedToolchains({
      dataDir: directory,
      tools: ["claude"],
      ensure: fakeEnsure("set-a").ensure,
    });
    const second = await installPinnedToolchains({
      dataDir: directory,
      tools: ["claude"],
      ensure: fakeEnsure("set-b").ensure,
    });
    expect(await readlink(second.currentBinDir)).toBe("set-b");
  });

  test("never replaces something at that name that is not a symlink", async () => {
    const directory = await dataDir();
    await mkdir(path.join(directory, "toolchains", "bin", CURRENT_TOOLCHAIN_LINK), {
      recursive: true,
    });
    await expect(
      installPinnedToolchains({
        dataDir: directory,
        tools: ["claude"],
        ensure: fakeEnsure().ensure,
      }),
    ).rejects.toThrow("not a symbolic link");
  });

  test("refuses an activation directory outside the toolchain tree", async () => {
    const directory = await dataDir();
    const elsewhere = await dataDir();
    await expect(
      installPinnedToolchains({
        dataDir: directory,
        tools: ["claude"],
        ensure: async () => ({
          rootDir: path.join(directory, "toolchains"),
          binDir: path.join(elsewhere, "bin", "set-x"),
          executables: {} as Record<ToolchainName, string>,
        }),
      }),
    ).rejects.toThrow("not directly inside");
  });

  test("fails clearly when the selection has nothing to install", async () => {
    const directory = await dataDir({ global: { enabledAgentPlatforms: ["cursor"] } });
    const { ensure, calls } = fakeEnsure();
    await expect(installPinnedToolchains({ dataDir: directory, ensure })).rejects.toThrow(
      "None of the selected agent platforms",
    );
    expect(calls).toHaveLength(0);
  });

  test("propagates an install failure without touching current", async () => {
    const directory = await dataDir();
    await installPinnedToolchains({
      dataDir: directory,
      tools: ["claude"],
      ensure: fakeEnsure("set-a").ensure,
    });
    await expect(
      installPinnedToolchains({
        dataDir: directory,
        tools: ["claude"],
        ensure: async () => {
          throw new Error("digest mismatch");
        },
      }),
    ).rejects.toThrow("digest mismatch");
    expect(await readlink(currentToolchainBinDir(directory))).toBe("set-a");
  });

  test("an existing current link to a dangling target is replaced", async () => {
    const directory = await dataDir();
    const binRoot = path.join(directory, "toolchains", "bin");
    await mkdir(binRoot, { recursive: true });
    await symlink("gone", path.join(binRoot, CURRENT_TOOLCHAIN_LINK), "dir");
    const result = await installPinnedToolchains({
      dataDir: directory,
      tools: ["claude"],
      ensure: fakeEnsure("set-c").ensure,
    });
    expect(await readlink(result.currentBinDir)).toBe("set-c");
  });
});

describe("createProgressLogger", () => {
  test("logs each phase of each tool once, even when tools interleave", () => {
    const lines: string[] = [];
    const report = createProgressLogger((line) => lines.push(line));
    const base = { completedTools: 0, totalTools: 1 } as const;
    report({ ...base, phase: "downloading", tool: "claude", message: "Downloading claude" });
    report({ ...base, phase: "downloading", tool: "claude", message: "Downloading claude 50%" });
    report({ ...base, phase: "downloading", tool: "codex", message: "Downloading codex" });
    // Another tool spoke in between; the first is still not repeated.
    report({ ...base, phase: "downloading", tool: "claude", message: "Downloading claude 90%" });
    report({ ...base, phase: "verifying", tool: "claude", message: "Verifying claude" });
    expect(lines).toEqual(["Downloading claude", "Downloading codex", "Verifying claude"]);
  });
});
