import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { setClaudeHomeForTesting } from "./claude-home.js";
import { resolveClaudeDiscoveryConfig } from "./claude-query-config.js";

/**
 * Where command discovery resolves. A container bridge is started with
 * `cd /workspace` and no `CWD` (`startContainerClaudeServer` in
 * apps/backend/src/core/commands-containers.ts), so its project commands,
 * skills and plugins must come from the process's own working directory and
 * its own home, never from a path the backend computed on the host. A local
 * bridge runs from its own directory and is pointed at the worktree by `CWD`.
 */
const containerPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-container",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "restricted",
};
const inputs = { readOnly: false, includeLocalSettings: false };

let root: string;
let workspace: string;
let previousCwd: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-discovery-"));
  workspace = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(join(workspace, ".claude"), { recursive: true });
  mkdirSync(join(workspace, "plugins", "project-plugin"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, ".claude", "plugins.json"),
    JSON.stringify({ plugins: [{ type: "local", path: "plugins/project-plugin" }] }),
  );
  setClaudeHomeForTesting(home);
  previousCwd = process.env.CWD;
  delete process.env.CWD;
});

afterEach(() => {
  setClaudeHomeForTesting(null);
  if (previousCwd === undefined) delete process.env.CWD;
  else process.env.CWD = previousCwd;
  rmSync(root, { recursive: true, force: true });
});

describe("resolveClaudeDiscoveryConfig", () => {
  test("a container bridge discovers from its own working directory with project sources", async () => {
    const cwd = spyOn(process, "cwd").mockReturnValue(workspace);
    try {
      const config = await resolveClaudeDiscoveryConfig(containerPolicy, inputs);
      expect(config.cwd).toBe(workspace);
      expect(config.settingSources).toEqual(["user", "project"]);
      expect(config.plugins).toEqual([
        { type: "local", path: join(workspace, "plugins", "project-plugin") },
      ]);
    } finally {
      cwd.mockRestore();
    }
  });

  test("CWD names the workspace when it is set (a local bridge)", async () => {
    const cwd = spyOn(process, "cwd").mockReturnValue(join(root, "bridge-install"));
    process.env.CWD = workspace;
    try {
      const config = await resolveClaudeDiscoveryConfig(containerPolicy, inputs);
      expect(config.cwd).toBe(workspace);
      expect(config.plugins.map((plugin) => plugin.path)).toEqual([
        join(workspace, "plugins", "project-plugin"),
      ]);
    } finally {
      cwd.mockRestore();
    }
  });

  test("without project resources the workspace's commands and plugins are not loaded", async () => {
    const cwd = spyOn(process, "cwd").mockReturnValue(workspace);
    try {
      const config = await resolveClaudeDiscoveryConfig(
        { ...containerPolicy, id: "interactive-host", projectResources: false },
        inputs,
      );
      expect(config.cwd).toBe(workspace);
      expect(config.settingSources).toEqual(["user"]);
      expect(config.plugins).toEqual([]);
    } finally {
      cwd.mockRestore();
    }
  });
});
