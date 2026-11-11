import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildDropHostClaudeLoginCommand,
  buildRestrictContainerClaudeCredentialCommand,
  syncContainerAgentAccountsOnStart,
  type ContainerRunners,
} from "./agent-accounts-containers.js";
import { AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV } from "./agent-credential-files.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";
import { createEnvironment, StorageService } from "./storage.js";

/**
 * After the host signs out of Claude, the next container start removes the
 * login the backend handed the container, instead of only stripping its
 * refresh tokens and leaving the access token usable until it expires
 * (to-do 4580 task 1). A host login that has merely expired keeps the old
 * behaviour.
 */
const ENV_KEYS = [
  "HOME",
  "ORKESTRATOR_AGENT_TEST_HOST_HOME",
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
  "CLAUDE_CONFIG_DIR",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let root: string;
let environment: Environment;
let context: CommandContext;
let runtime: BackendRuntime;

function fakeRunners() {
  const calls: Array<{ kind: "exec" | "pipe"; command: string }> = [];
  const runners: ContainerRunners = {
    exec: async (_id, command) => {
      calls.push({ kind: "exec", command });
      return "";
    },
    pipe: async (_id, command) => {
      calls.push({ kind: "pipe", command });
    },
    label: async () => "revision-1",
  };
  return { runners, calls };
}

const hostCredentials = () => path.join(root, "host-claude", ".credentials.json");

async function start(fake: ReturnType<typeof fakeRunners>): Promise<void> {
  await syncContainerAgentAccountsOnStart(
    context,
    environment,
    "container-1",
    { enabledAgentPlatforms: ["claude"] } as never,
    fake.runners,
  );
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-claude-sign-out-")));
  process.env.HOME = path.join(root, "profile-home");
  process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = path.join(root, "host-home");
  process.env[AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV] = path.join(root, "host-claude");
  delete process.env.CLAUDE_CONFIG_DIR;
  await fs.mkdir(path.join(root, "host-claude"), { recursive: true });
  await fs.mkdir(path.join(root, "host-home", ".claude"), { recursive: true });
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  environment = { ...createEnvironment("project-1"), containerId: "container-1" };
  runtime = new BackendRuntime({ emit: () => undefined });
  context = {
    storage: Object.assign(Object.create(storage), {
      loadConfig: async () => ({ global: { enabledAgentPlatforms: ["claude"] } }),
      loadEnvironments: async () => [structuredClone(environment)],
      getEnvironment: async () => structuredClone(environment),
    }),
    runtimeFlavor: "agent-test",
    credentialSources: new Set(["claude"]),
    runtime,
  } as unknown as CommandContext;
});

afterEach(async () => {
  runtime.shutdown();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(root, { recursive: true, force: true });
});

// On macOS the reading also asks the Keychain, which a test must not touch;
// `claude-host-credentials.test.ts` covers that half with a fake lookup.
describe.skipIf(process.platform === "darwin")(
  "a container start after a host Claude sign-out",
  () => {
    test("removes the host's login rather than stripping it", async () => {
      const fake = fakeRunners();
      await start(fake);
      const commands = fake.calls.map((call) => call.command);
      expect(commands).toContain(buildDropHostClaudeLoginCommand());
      expect(commands).not.toContain(buildRestrictContainerClaudeCredentialCommand());
      expect(fake.calls.some((call) => call.kind === "pipe")).toBe(false);
    });

    test("a credential file left with no login counts as signed out too", async () => {
      await fs.writeFile(hostCredentials(), "{}");
      const fake = fakeRunners();
      await start(fake);
      expect(fake.calls.map((call) => call.command)).toContain(buildDropHostClaudeLoginCommand());
    });

    test("an expired or unreadable host login only strips refresh tokens, as before", async () => {
      for (const text of [
        JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "R", expiresAt: 1 } }),
        "not json",
      ]) {
        await fs.writeFile(hostCredentials(), text);
        const fake = fakeRunners();
        await start(fake);
        const commands = fake.calls.map((call) => call.command);
        expect(commands).toContain(buildRestrictContainerClaudeCredentialCommand());
        expect(commands).not.toContain(buildDropHostClaudeLoginCommand());
      }
    });

    test("forgets the pushed login, so a later sign-in is pushed again", async () => {
      runtime.accounts.rememberPushedClaudeLogin("container-1", "digest");
      await start(fakeRunners());
      expect(runtime.accounts.pushedClaudeLogin("container-1")).toBeUndefined();
    });
  },
);

describe.skipIf(process.platform === "win32")("the drop command inside a container", () => {
  let file: string;
  async function run(): Promise<number | null> {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    if (!Bun.which("node")) {
      await fs.writeFile(path.join(bin, "node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, {
        mode: 0o755,
      });
    }
    return spawnSync("bash", ["-c", buildDropHostClaudeLoginCommand(file)], {
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      encoding: "utf8",
    }).status;
  }
  beforeEach(async () => {
    file = path.join(root, "container", ".claude", ".credentials.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
  });

  test("removes the subscription login and host MCP copies, keeping the container's own", async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        claudeAiOauth: { accessToken: "host-access" },
        mcpOAuth: {
          linear: { accessToken: "host-copy" },
          notion: { accessToken: "own", refreshToken: "CONTAINER-MCP" },
        },
      }),
    );
    expect(await run()).toBe(0);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      mcpOAuth: { notion: { accessToken: "own" } },
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  test("removes a file left with no login, or one it cannot read", async () => {
    await fs.writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: "host-access" } }));
    expect(await run()).toBe(0);
    await expect(fs.stat(file)).rejects.toThrow();
    await fs.writeFile(file, "not json");
    expect(await run()).toBe(0);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  test("a missing file is fine and a symlink is never followed", async () => {
    expect(await run()).toBe(0);
    const target = path.join(root, "outside.json");
    await fs.writeFile(target, JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
    await fs.symlink(target, file);
    expect(await run()).toBe(0);
    expect(await fs.readFile(target, "utf8")).toContain("claudeAiOauth");
  });
});
