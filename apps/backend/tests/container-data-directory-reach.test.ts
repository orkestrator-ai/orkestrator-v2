import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV } from "../src/core/agent-credential-files";
import { createDockerContainer } from "../src/core/commands-containers";
import { resetNetworkOwnerCache } from "../src/core/container-network-owner";
import { resetDockerTopologyCache, resetImageManifestCache } from "../src/core/docker-image";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

// The accepted risk in docs/architecture/storage.md ("Provider secrets at rest")
// relies on a container having no way to reach the files that hold the secrets.

const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const FAKE_ANTHROPIC_KEY = "fake-anthropic-key-for-reach-test";
const FAKE_CURSOR_KEY = "fake-cursor-key-for-reach-test";
const FAKE_STORED_SECRET = "fake-stored-secret-for-reach-test";
const PROTECTED_FILES = ["config.json", "config.json.bak.1", "orkestrator.sqlite", "backups/x"];

const cleanup: string[] = [];
const savedEnvironment = new Map<string, string | undefined>();

function setEnvironment(name: string, value: string): void {
  if (!savedEnvironment.has(name)) savedEnvironment.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(async () => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnvironment.clear();
  resetNetworkOwnerCache();
  resetImageManifestCache();
  resetDockerTopologyCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const dir = await tempDir(prefix);
  cleanup.push(dir);
  return dir;
}

async function manifestTar(capabilities: Record<string, number>): Promise<string> {
  const dir = await directory("ork-reach-tar-");
  await fs.writeFile(
    path.join(dir, "image-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: "2.17.0",
      sourceRevision: "b27421dcfa8de61b9c20a08e79efd7dfbd0c7fc2",
      architecture: "amd64",
      runtimes: { bun: "1.4.3", node: "24.21.0" },
      agents: { claude: "2.1.280" },
      bridges: ["claude-bridge"],
      capabilities,
      stateFormats: {},
    }),
  );
  const tarPath = path.join(dir, "out.tar");
  const result = spawnSync(
    "tar",
    ["--format=ustar", "-cf", tarPath, "-C", dir, "image-manifest.json"],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  expect(result.status).toBe(0);
  return tarPath;
}

/** A data directory holding the real names, an agent-test context, and no real host path. */
async function fixture(
  capabilities: Record<string, number>,
  options: { claude?: boolean; legacyCredentials?: boolean } = {},
): Promise<{
  dataDir: string;
  agentHome: string;
  tar: string;
  create: () => Promise<unknown>;
}> {
  const dataDir = await directory("ork-reach-data-");
  await fs.mkdir(path.join(dataDir, "backups"));
  for (const file of PROTECTED_FILES) {
    await fs.writeFile(path.join(dataDir, file), FAKE_STORED_SECRET, { mode: 0o600 });
  }
  const providers: string[] = options.legacyCredentials
    ? ["claude", "codex", "grok", "pi", "opencode", "cursor"]
    : options.claude
      ? ["claude"]
      : [];
  const environment = lifecycleEnvironment();
  const { context } = memoryLifecycleContext([environment], dataDir);
  Object.assign(context, {
    runtimeFlavor: "agent-test",
    credentialSources: new Set(providers),
  });
  Object.assign(context.storage, {
    getProject: async () => ({
      id: "project-1",
      gitUrl: "https://example.invalid/project.git",
      localPath: null,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: {
        enabledAgentPlatforms: providers,
        allowedDomains: ["one.example", "example.invalid"],
        ...(providers.includes("claude") ? { anthropicApiKey: FAKE_ANTHROPIC_KEY } : {}),
        ...(providers.includes("cursor") ? { cursorApiKey: FAKE_CURSOR_KEY } : {}),
      },
      repositories: {},
    }),
  });
  await fs.writeFile(
    path.join(dataDir, "github-ranges.txt"),
    "# github-ranges fixture\n203.0.113.0/24\n",
  );
  const empty = await directory("ork-reach-home-");
  setEnvironment("ORKESTRATOR_AGENT_TEST_HOST_HOME", empty);
  setEnvironment(AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV, path.join(empty, ".claude"));
  // Every legacy credential source is temporary, including providers whose
  // defaults would otherwise resolve to this process's real agent homes.
  setEnvironment("CODEX_HOME", path.join(empty, ".codex"));
  setEnvironment("GROK_HOME", path.join(empty, ".grok"));
  setEnvironment("XDG_CONFIG_HOME", path.join(empty, ".config"));
  setEnvironment("XDG_DATA_HOME", path.join(empty, ".local", "share"));
  setEnvironment("XDG_STATE_HOME", path.join(empty, ".local", "state"));
  if (options.legacyCredentials) {
    for (const dir of [
      ".claude",
      ".codex",
      ".grok",
      ".config/grok",
      ".pi",
      ".config/opencode",
      ".local/share/opencode",
      ".local/state/opencode",
    ]) {
      await fs.mkdir(path.join(empty, dir), { recursive: true });
    }
    await fs.writeFile(path.join(empty, ".claude.json"), "{}");
    await fs.writeFile(path.join(empty, ".local/state/opencode/model.json"), "{}");
  }
  return {
    dataDir,
    agentHome: empty,
    tar: await manifestTar(capabilities),
    create: () => createDockerContainer(environment, context, { imageId: IMAGE_ID }),
  };
}

function fakeDocker(tar: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  context) printf 'unix:///var/run/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Debian","Architecture":"x86_64","SecurityOptions":[]}\\n' ;;
  create) printf 'created-reach\\n' ;;
  cp) cat '${tar}' ;;
  network) [ "$2" = inspect ] && { echo "network not found" >&2; exit 1; }; exit 0 ;;
esac
`;
}

/** Every host path the `docker create` binds (`-v src:dst` and `--mount ...src=`). */
function bindSources(create: string): string[] {
  const sources = [...create.matchAll(/ -v ([^\s:]+):/g)].map((match) => match[1]!);
  for (const match of create.matchAll(/type=bind,src=([^,\s]+)/g)) sources.push(match[1]!);
  return sources;
}

function expectNoBindReaches(sources: string[], dataDir: string): void {
  for (const source of sources) {
    for (const file of PROTECTED_FILES) {
      const relative = path.relative(source, path.join(dataDir, file));
      expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(true);
    }
  }
}

describe("a container's reach into the data directory", () => {
  test("a staged-inputs image binds nothing holding the stored secrets", async () => {
    const capabilities = {
      "git-mirror": 1,
      "network-policy": 3,
      "network-refresh": 1,
      "staged-inputs": 2,
    };
    const { dataDir, tar, create } = await fixture(capabilities);
    await withDockerScript(fakeDocker(tar), async (log) => {
      await create();
      const docker = await log.read();
      const line = docker.split("\n").find((entry) => entry.startsWith("create --name"));
      expect(line).toBeDefined();
      const sources = bindSources(line!);

      // Not vacuous: the project's Git mirror is a bind from the data directory.
      expect(sources.some((source) => source.startsWith(dataDir))).toBe(true);
      expectNoBindReaches(sources, dataDir);
      expect(docker).not.toContain(FAKE_STORED_SECRET);
    });
  });

  test.each([false, true])(
    "an older image is refused before binding secrets (credentials: %s)",
    async (legacyCredentials) => {
      const { dataDir, agentHome, tar, create } = await fixture(
        { "git-mirror": 1, "network-policy": 2 },
        { legacyCredentials },
      );
      await withDockerScript(fakeDocker(tar), async (log) => {
        await expect(create()).rejects.toMatchObject({
          code: "container-lifecycle",
          reason: "capability-unavailable",
        });
        const docker = await log.read();
        // Manifest inspection can create a probe; no environment may be created.
        expect(docker.split("\n").some((line) => line.startsWith("create --name"))).toBe(false);
        expect(docker).not.toContain(`-v ${agentHome}`);
        expect(docker).not.toContain(`-v ${dataDir}`);
        expect(docker).not.toContain("-e ANTHROPIC_API_KEY");
        expect(docker).not.toContain("-e CURSOR_API_KEY");
        expect(docker).not.toContain(FAKE_ANTHROPIC_KEY);
        expect(docker).not.toContain(FAKE_CURSOR_KEY);
        expect(docker).not.toContain(FAKE_STORED_SECRET);
      });
    },
  );

  test("the staged Anthropic key is an owner-only copy, kept out of docker's arguments", async () => {
    const { dataDir, tar, create } = await fixture(
      { "network-policy": 3, "network-refresh": 1, "staged-inputs": 2 },
      { claude: true },
    );
    await withDockerScript(fakeDocker(tar), async (log) => {
      await create();
      const docker = await log.read();
      const line = docker.split("\n").find((entry) => entry.startsWith("create --name"));
      expect(line).toBeDefined();

      const entries = await fs.readdir(path.join(dataDir), { recursive: true });
      const key = entries.find((entry) => entry.endsWith(".orkestrator-anthropic-key"));
      expect(key).toBeDefined();
      const keyFile = path.join(dataDir, key!);
      expect(await fs.readFile(keyFile, "utf8")).toBe(FAKE_ANTHROPIC_KEY);
      expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(keyFile))).mode & 0o777).toBe(0o700);

      expect(docker).not.toContain(FAKE_ANTHROPIC_KEY);
      expectNoBindReaches(bindSources(line!), dataDir);
    });
  });
});
