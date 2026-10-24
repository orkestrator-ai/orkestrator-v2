import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PINNED_TOOL_VERSIONS } from "@orkestrator/toolchain/manifest";
import { isHostIdle } from "@orkestrator/protocol/host-maintenance";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { setManagedGitHubCli } from "./github-cli-binary.js";
import { readRestartImpact, readToolStatus } from "./host-maintenance-readers.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-host-readers-"));
});

afterEach(async () => {
  setManagedGitHubCli(undefined);
  await rm(root, { recursive: true, force: true });
});

test("restart impact counts working and waiting agents and unfinished pipelines", async () => {
  const context = {
    runtime: new BackendRuntime({ emit: () => undefined }),
    agentRegistry: {
      snapshot: async () => ({
        entries: [
          { state: "working" },
          { state: "working" },
          { state: "waiting" },
          { state: "idle" },
        ],
      }),
    },
    storage: {
      listAllBuildPipelines: async () => [
        { snapshot: { phase: "building" } },
        { snapshot: { phase: "complete" } },
        { snapshot: { phase: "failed" } },
        { snapshot: { phase: "paused" } },
      ],
    },
  } as unknown as CommandContext;
  expect(await readRestartImpact(context)).toMatchObject({
    workingAgents: 2,
    waitingAgents: 1,
    activePipelines: 1,
  });
});

test("tools report the managed version from their versioned directory", async () => {
  const pinned = PINNED_TOOL_VERSIONS.claude;
  const versionDir = path.join(root, "toolchains", "claude", pinned, "darwin-arm64");
  await mkdir(versionDir, { recursive: true });
  const executable = path.join(versionDir, "claude");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  const binDir = path.join(root, "toolchains", "bin", "set");
  await mkdir(binDir, { recursive: true });
  await symlink(executable, path.join(binDir, "claude"));
  const context = {
    toolchainBinDir: binDir,
    resourceRoot: path.join(root, "resources"),
    appRoot: path.join(root, "app"),
  } as unknown as CommandContext;
  const tools = await readToolStatus(context, "latest");
  expect(tools.find((tool) => tool.name === "claude")).toEqual({
    name: "claude",
    pinnedVersion: pinned,
    source: "managed",
    installedVersion: pinned,
  });
  const gh = tools.find((tool) => tool.name === "gh");
  expect(gh?.channel).toBe("latest");
  expect(gh?.source).not.toBe("managed");
});

test("a grok on PATH is missing: the backend never runs it from PATH", async () => {
  const bin = path.join(root, "path-bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["grok", "codex"]) {
    await writeFile(path.join(bin, name), "#!/bin/sh\n");
    await chmod(path.join(bin, name), 0o755);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const context = {
      resourceRoot: path.join(root, "resources"),
      appRoot: path.join(root, "app"),
    } as unknown as CommandContext;
    const tools = await readToolStatus(context, "pinned");
    expect(tools.find((tool) => tool.name === "grok")?.source).toBe("missing");
    expect(tools.find((tool) => tool.name === "codex")?.source).toBe("path");
  } finally {
    process.env.PATH = originalPath;
  }
});

for (const reader of ["agents", "pipelines"] as const) {
  test(`restart impact is unavailable when ${reader} cannot be read`, async () => {
    const context = {
      agentRegistry: {
        snapshot: async () => {
          if (reader === "agents") throw new Error("unavailable");
          return { entries: [{ state: "working" }] };
        },
      },
      storage: {
        listAllBuildPipelines: async () => {
          if (reader === "pipelines") throw new Error("unavailable");
          return [{ snapshot: { phase: "building" } }];
        },
      },
    } as unknown as CommandContext;
    await expect(readRestartImpact(context)).rejects.toThrow("unavailable");
  });
}

test("unknown terminal activity in an inactive environment stays busy; paused pipelines are idle", async () => {
  let entries = [{ kind: "terminal", state: "unknown", environmentId: "inactive" }];
  const context = {
    runtime: new BackendRuntime({ emit: () => undefined }),
    agentRegistry: { snapshot: async () => ({ entries }) },
    storage: { listAllBuildPipelines: async () => [{ snapshot: { phase: "paused" } }] },
  } as unknown as CommandContext;
  const impact = await readRestartImpact(context);
  expect(impact).toMatchObject({ unknownAgents: 1, activePipelines: 0 });
  expect(isHostIdle(impact)).toBe(false);
  entries = [{ kind: "terminal", state: "stopped", environmentId: "inactive" }];
  expect(isHostIdle(await readRestartImpact(context))).toBe(true);
});

test("gh-latest reports its actual installed version, and unknown layouts never report the pin", async () => {
  const executable = path.join(root, "toolchains", "gh-latest", "2.200.0", "gh");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\n");
  setManagedGitHubCli(executable);
  const context = { resourceRoot: root, appRoot: root } as unknown as CommandContext;
  expect(
    (await readToolStatus(context, "latest")).find((tool) => tool.name === "gh")?.installedVersion,
  ).toBe("2.200.0");
  const unknown = path.join(root, "gh");
  await writeFile(unknown, "#!/bin/sh\n");
  setManagedGitHubCli(unknown);
  expect(
    (await readToolStatus(context, "latest")).find((tool) => tool.name === "gh")?.installedVersion,
  ).toBeNull();
});
