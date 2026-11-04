/**
 * Which new containers get a project's Git mirror, read from the `docker create`
 * the backend actually issues. Fake Docker answers the manifest probe, and a
 * closed lifecycle tracker keeps the background refresh off the network.
 */
import { afterEach, expect, test } from "bun:test";
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
      capabilities: options.capabilities,
      stateFormats: {},
    }),
  );
  const tarball = path.join(dir, "manifest.tar");
  // Docker emits a plain archive; macOS tar must not add AppleDouble metadata.
  spawnSync("tar", ["--format=ustar", "-cf", tarball, "-C", dir, "image-manifest.json"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const environment = lifecycleEnvironment({ networkAccessMode: "full" });
  const { context } = memoryLifecycleContext([environment], dir);
  Object.assign(context, {
    runtimeFlavor: "agent-test",
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
      global: { enabledAgentPlatforms: [] },
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

  expect(create).toContain(
    `-v ${path.join(dataDir, "git-mirrors", "project-1", "mount")}:${CONTAINER_GIT_MIRROR_MOUNT}:ro`,
  );
  expect(create).toContain("-e ORKESTRATOR_GIT_MIRROR=/orkestrator-git-mirror/mirror.git");
  // The URL goes to Docker unchanged: origin stays the project's own remote.
  expect(create).toContain("-e GIT_URL=https://example.invalid/repo.git");
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
