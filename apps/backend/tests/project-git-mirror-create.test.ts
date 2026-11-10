/**
 * Which new containers get a project's Git mirror, read from the `docker create`
 * the backend actually issues. Fake Docker answers the manifest probe, and a
 * closed lifecycle tracker keeps the background refresh off the network.
 */
import { afterEach, expect, test } from "bun:test";
import { configureLogger, resetLogger } from "@orkestrator/protocol/logger";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createDockerContainer,
  type CreateContainerIdentity,
} from "../src/core/commands-containers";
import { resetResourceCaches } from "../src/core/container-resources";
import { resetDockerTopologyCache, resetImageManifestCache } from "../src/core/docker-image";
import { CONTAINER_GIT_MIRROR_MOUNT } from "../src/core/project-git-mirror";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  resetResourceCaches();
  resetDockerTopologyCache();
  resetImageManifestCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createCommand(options: {
  capabilities: Record<string, number>;
  gitUrl?: string;
  identity?: Partial<CreateContainerIdentity>;
  /** Restricted, with this allowlist; full when absent. */
  allowedDomains?: string[];
  /** A production backend, which hands containers the GitHub credential Settings selects. */
  production?: boolean;
  global?: Record<string, unknown>;
}): Promise<{ create: string; dataDir: string }> {
  const dir = await tempDir("ork-git-mirror-create-");
  cleanup.push(dir);
  const manifest = path.join(dir, "image-manifest.json");
  await fs.writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      appVersion: "1.0.0",
      sourceRevision: "b27421dcfa8de61b9c20a08e79efd7dfbd0c7fc2",
      architecture: "amd64",
      runtimes: { bun: "1.4.3", node: "24.21.0" },
      agents: { claude: "2.1.280" },
      bridges: ["claude-bridge"],
      // New containers need staged inputs, whatever else the image declares.
      capabilities: { "staged-inputs": 5, ...options.capabilities },
      stateFormats: {},
    }),
  );
  const tarball = path.join(dir, "manifest.tar");
  // Docker emits a plain archive; macOS tar must not add AppleDouble metadata.
  spawnSync("tar", ["--format=ustar", "-cf", tarball, "-C", dir, "image-manifest.json"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const environment = lifecycleEnvironment(
    options.allowedDomains
      ? { networkAccessMode: "restricted", allowedDomains: options.allowedDomains }
      : { networkAccessMode: "full" },
  );
  const { context } = memoryLifecycleContext([environment], dir);
  Object.assign(context, {
    runtimeFlavor: options.production ? "production" : "agent-test",
    credentialSources: new Set(),
    environmentLifecycleTasks: { isAccepting: () => false },
  });
  Object.assign(context.storage, {
    getProject: async () => ({
      id: "project-1",
      gitUrl: options.gitUrl ?? "https://example.invalid/repo.git",
      localPath: null,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { enabledAgentPlatforms: [], ...options.global },
      repositories: {},
    }),
  });
  let commands: string[] = [];
  await withDockerScript(
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  context) printf 'unix:///var/run/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Debian","Architecture":"x86_64","ServerVersion":"29.7.2","SecurityOptions":[]}\\n' ;;
  create) printf 'created-container\\n' ;;
  network) [ "$2" = inspect ] && { echo "network not found" >&2; exit 1; }; exit 0 ;;
  cp) cat '${tarball}' ;;
esac
exit 0
`,
    async (log) => {
      await createDockerContainer(environment, context, {
        imageId: "sha256:image",
        ...options.identity,
      });
      commands = (await log.read()).split("\n").filter(Boolean);
    },
  );
  const create = commands.find((line) => line.startsWith("create --name"));
  if (!create) throw new Error("no docker create was issued");
  return { create, dataDir: dir };
}

test("an image with the capability gets the read-only mount and the variable", async () => {
  const { create, dataDir } = await createCommand({ capabilities: { "git-mirror": 1 } });

  // No GitHub credential for containers: the mirror fetched with none.
  expect(create).toContain(
    `-v ${path.join(dataDir, "git-mirrors", "project-1", "mount-anonymous")}:${CONTAINER_GIT_MIRROR_MOUNT}:ro`,
  );
  expect(create).toContain("-e ORKESTRATOR_GIT_MIRROR=/orkestrator-git-mirror/mirror.git");
  // The URL goes to Docker unchanged: origin stays the project's own remote.
  expect(create).toContain("-e GIT_URL=https://example.invalid/repo.git");
});

test("a container is bound to the mirror of the GitHub credential it is given", async () => {
  const github = {
    capabilities: { "git-mirror": 1 },
    gitUrl: "git@github.com:acme/repo.git",
    production: true,
  };
  const mount = (dataDir: string, kind: string) =>
    `-v ${path.join(dataDir, "git-mirrors", "project-1", `mount-${kind}`)}:${CONTAINER_GIT_MIRROR_MOUNT}:ro`;

  const pat = await createCommand({
    ...github,
    global: { containerGitHubCredential: "pat", githubToken: "container-pat" },
  });
  expect(pat.create).toMatch(/mount-github-pat-[a-f0-9-]{36}:/);
  // The token reaches the refresh in memory, never the create command.
  expect(pat.create).not.toContain("container-pat");

  // The backend's own PAT is not the containers' credential.
  const none = await createCommand({
    ...github,
    global: { useHostGitHubCredentials: false, githubToken: "backend-pat" },
  });
  expect(none.create).toContain(mount(none.dataDir, "anonymous"));

  // Containers are given no credential for a host other than GitHub.
  const elsewhere = await createCommand({
    ...github,
    gitUrl: "https://git.example.com/acme/repo.git",
    global: { containerGitHubCredential: "pat", githubToken: "container-pat" },
  });
  expect(elsewhere.create).toContain(mount(elsewhere.dataDir, "anonymous"));
});

test("an image without the capability gets neither, and nothing is written", async () => {
  const { create, dataDir } = await createCommand({ capabilities: { "workspace-prepare": 1 } });

  expect(create).not.toContain("orkestrator-git-mirror");
  expect(create).not.toContain("ORKESTRATOR_GIT_MIRROR");
  await expect(fs.stat(path.join(dataDir, "git-mirrors"))).rejects.toThrow();
});

test("a runtime over an existing checkout never clones, so it gets neither", async () => {
  const { create } = await createCommand({
    capabilities: { "git-mirror": 1 },
    identity: { reusesWorkspace: true },
  });

  expect(create).not.toContain("orkestrator-git-mirror");
});

test("a project whose stored URL is not a remote gets neither", async () => {
  const { create } = await createCommand({
    capabilities: { "git-mirror": 1 },
    gitUrl: "/some/local/path.git",
  });

  expect(create).not.toContain("orkestrator-git-mirror");
});

test("a restricted container gets the mirror of a GitHub remote, which its firewall always opens", async () => {
  const { create } = await createCommand({
    capabilities: { "git-mirror": 1 },
    gitUrl: "git@github.com:acme/repo.git",
    allowedDomains: ["registry.npmjs.org"],
  });

  expect(create).toContain("NETWORK_MODE=restricted");
  expect(create).toContain("-e ORKESTRATOR_GIT_MIRROR=/orkestrator-git-mirror/mirror.git");
});

test("a restricted container that cannot reach the remote does not read it through the mirror", async () => {
  const { create } = await createCommand({
    capabilities: { "git-mirror": 1 },
    gitUrl: "https://git.example.com/acme/repo.git",
    allowedDomains: ["registry.npmjs.org", "example.com"],
  });

  expect(create).toContain("NETWORK_MODE=restricted");
  expect(create).not.toContain("orkestrator-git-mirror");
  expect(create).not.toContain("ORKESTRATOR_GIT_MIRROR");
});

test("a restricted container whose allowlist names the remote's host gets the mirror", async () => {
  const { create } = await createCommand({
    capabilities: { "git-mirror": 1 },
    gitUrl: "git@git.example.com:acme/repo.git",
    allowedDomains: ["git.example.com"],
  });

  expect(create).toContain("-e ORKESTRATOR_GIT_MIRROR=/orkestrator-git-mirror/mirror.git");
});

// Before policy 3, an allowlisted address is open on every TCP port.
test.each([1, 2, 3])("mirror mount respects policy %i port semantics", async (policy) => {
  const { create } = await createCommand({
    capabilities: { "git-mirror": 1, "network-policy": policy },
    gitUrl: "https://git.example.com:8443/acme/repo.git",
    allowedDomains: ["git.example.com"],
  });
  expect(create.includes("ORKESTRATOR_GIT_MIRROR=")).toBe(policy < 3);
});

test("withheld logging only describes a runtime eligible to clone", async () => {
  const events: string[] = [];
  configureLogger({
    level: "info",
    sink: ({ record }) => {
      if (record) events.push(record.event);
    },
  });
  try {
    const options = {
      capabilities: { "git-mirror": 1 },
      gitUrl: "https://git.example.com/repo.git",
      allowedDomains: ["other.example"],
    };
    await createCommand({ ...options, identity: { reusesWorkspace: true } });
    expect(events).not.toContain("git-mirror.mount-withheld");
    await createCommand(options);
    expect(events.filter((event) => event === "git-mirror.mount-withheld")).toHaveLength(1);
  } finally {
    resetLogger();
  }
});
