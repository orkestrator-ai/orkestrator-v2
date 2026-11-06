import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyBridgeLaunchEnvironment,
  BRIDGE_LAUNCH_ENVIRONMENT_ENV,
  BRIDGE_LAUNCH_KEYS_ENV,
  BRIDGE_LAUNCH_WORKDIR_ENV,
} from "./bridge-launch-environment";

const directories: string[] = [];

function snapshotFile(entries: string[]): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ork-launch-env-"));
  directories.push(directory);
  const file = path.join(directory, "snapshot");
  writeFileSync(file, `${entries.join("\0")}\0`);
  return file;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("bridge launch environment", () => {
  test("applies the start script's environment for the agents, never the launcher's own values", () => {
    const file = snapshotFile([
      "PATH=/home/node/.local/bin:/usr/bin",
      "ORKESTRATOR_AGENT_MCP_URL=http://host.docker.internal:1234/mcp",
      "LD_PRELOAD=/tmp/planted.so",
      "VALUE_WITH_EQUALS=a=b",
      // What the backend gave the launcher, and what only it may set.
      "PORT=1",
      "CLAUDE_BRIDGE_TOKEN_SHA256=00",
      "CLAUDE_BRIDGE_TOKEN_SHA256_AUTHORITY_KEY=forged",
      "CLAUDE_BRIDGE_TOKEN_AUTHORITY_KEY=forged",
      "CLAUDE_BRIDGE_TOKEN=forged",
      "ORKESTRATOR_BRIDGE_EXECUTION_POLICY=widened",
      "ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT=/tmp/other",
      "ORKESTRATOR_COORDINATOR_WEB_RESEARCH=on",
      // The shell's bookkeeping and this process's own module resolution.
      "PWD=/workspace",
      "NODE_PATH=/tmp/modules",
      "not a name=1",
      "noseparator",
    ]);
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      PORT: "4097",
      CLAUDE_BRIDGE_TOKEN_SHA256: "f".repeat(64),
      [BRIDGE_LAUNCH_ENVIRONMENT_ENV]: file,
      [BRIDGE_LAUNCH_KEYS_ENV]: "CLAUDE_BRIDGE_TOKEN_SHA256,PORT",
      [BRIDGE_LAUNCH_WORKDIR_ENV]: "/workspace",
    };
    const visited: string[] = [];

    const result = applyBridgeLaunchEnvironment(env, (directory) => visited.push(directory));

    expect(result).toEqual({ applied: 4, refused: 8 });
    expect(env).toEqual({
      PATH: "/home/node/.local/bin:/usr/bin",
      PORT: "4097",
      CLAUDE_BRIDGE_TOKEN_SHA256: "f".repeat(64),
      ORKESTRATOR_AGENT_MCP_URL: "http://host.docker.internal:1234/mcp",
      LD_PRELOAD: "/tmp/planted.so",
      VALUE_WITH_EQUALS: "a=b",
    });
    expect(visited).toEqual(["/workspace"]);
    // Read once: nothing later in this process or its children finds it again.
    expect(existsSync(file)).toBe(false);
  });

  test("does nothing for a bridge started without the launcher", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(applyBridgeLaunchEnvironment(env, () => undefined)).toBeNull();
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("a missing snapshot or one behind a link still starts the bridge, with nothing applied", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "ork-launch-env-"));
    directories.push(directory);
    const target = path.join(directory, "elsewhere");
    writeFileSync(target, "LD_PRELOAD=/tmp/planted.so\0");
    const link = path.join(directory, "snapshot");
    symlinkSync(target, link);

    for (const file of [path.join(directory, "absent"), link]) {
      const env: NodeJS.ProcessEnv = {
        [BRIDGE_LAUNCH_ENVIRONMENT_ENV]: file,
        [BRIDGE_LAUNCH_KEYS_ENV]: "PORT",
        [BRIDGE_LAUNCH_WORKDIR_ENV]: "/nowhere",
      };
      const result = applyBridgeLaunchEnvironment(env, () => {
        throw new Error("no such directory");
      });
      expect(result).toEqual({ applied: 0, refused: 0 });
      expect(env).toEqual({});
    }
    // The link is removed, never what it pointed at.
    expect(existsSync(target)).toBe(true);
  });
});
