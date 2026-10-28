import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { createDockerContainer } from "../src/core/commands-containers";
import { replaceRuntimePreservingState } from "../src/core/container-replacement";
import { resetResourceCaches } from "../src/core/container-resources";
import { resetDockerTopologyCache, resetImageManifestCache } from "../src/core/docker-image";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
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

// C14's mount and restaging contract, without requiring a Docker daemon or an
// image. Staging, container creation and replacement remain real; only Docker's
// responses (including copy verification and boot readiness) are simulated.
test("migration binds fresh read-only Codex inputs and retains the source revision", async () => {
  const dir = await tempDir("ork-replacement-inputs-");
  cleanup.push(dir);
  const codexHome = path.join(dir, "host-codex");
  await fs.mkdir(codexHome);
  await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "staged-host"\n');
  // These belong to the runtime, never its staged host inputs.
  await fs.writeFile(path.join(codexHome, "state.sqlite"), "host database");
  await fs.mkdir(path.join(codexHome, "sessions"));
  await fs.writeFile(path.join(codexHome, "sessions", "host.jsonl"), "host session");
  const imageId = `sha256:${"c".repeat(64)}`;
  await fs.writeFile(
    path.join(dir, "image-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: "2.34.2-beta",
      sourceRevision: "b27421dcfa8de61b9c20a08e79efd7dfbd0c7fc2",
      architecture: "amd64",
      runtimes: { bun: "1.4.4", node: "24.21.0" },
      agents: {},
      bridges: [],
      capabilities: { "persistent-workspace": 1, "staged-inputs": 3 },
      stateFormats: {
        workspace: { read: [1], write: [1] },
        "provider-state": { read: [1], write: [1] },
      },
    }),
  );
  const archive = path.join(dir, "manifest.tar");
  expect(
    spawnSync("tar", ["--format=ustar", "-cf", archive, "-C", dir, "image-manifest.json"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    }).status,
  ).toBe(0);

  const owner = dockerOwnerNamespace(dir);
  const environment = lifecycleEnvironment({ networkAccessMode: "full" });
  const { context } = memoryLifecycleContext([environment], dir);
  Object.assign(context, {
    runtimeFlavor: "agent-test",
    credentialSources: new Set(["codex"]),
  });
  Object.assign(context.storage, {
    getProject: async () => ({ id: "project-1", gitUrl: "https://example.invalid/repo.git" }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { enabledAgentPlatforms: ["codex"] },
      repositories: {},
    }),
    listMultiReviewWorkflows: async () => [],
    listAllBuildPipelines: async () => [],
  });

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  context) printf 'unix:///var/run/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Debian","Architecture":"x86_64","ServerVersion":"29.7.2","SecurityOptions":[]}\\n' ;;
  image) printf '${imageId}\\t[]\\tamd64\\n' ;;
  create)
    case "$*" in
      *orkestrator-resource-role=manifest-probe*) printf 'manifest-probe\\n' ;;
      *orkestrator-runtime-generation=2*) printf 'candidate-container\\n' ;;
      *) printf 'source-container\\n' ;;
    esac ;;
  inspect)
    case "$*" in
      *State.Status*) printf '${owner}\\trunning\\torkestrator-v2\\tsource-container\\n' ;;
    esac ;;
  ps) case "$*" in *--size*) printf '1kB (virtual 1MB)\\n' ;; esac ;;
  volume) [ "$2" = inspect ] && { printf 'No such volume\\n' >&2; exit 1; } ;;
  cp)
    case "$2" in
      manifest-probe:*) cat '${archive}' ;;
      source-container:*) printf 'simulated copy stream' ;;
      *) exit 1 ;;
    esac ;;
  run)
    case "$*" in
      *copy-stream*) cat >/dev/null; printf 'ORKESTRATOR_COPY status=ok files=0 bytes=0\\n' ;;
      *measure*) printf 'ORKESTRATOR_MEASURE bytes=0 available=9999999999\\n' ;;
      *) printf 'ORKESTRATOR_STORAGE status=ok\\n' ;;
    esac ;;
  exec)
    case "$*" in
      *boot-status.json*) printf '{"version":1,"pid1Start":"123","bootId":"abcdef12","phase":"ready"}\\n123\\n' ;;
    esac ;;
esac
exit 0
`,
      async (log) => {
        expect(await createDockerContainer(environment, context, { imageId })).toBe(
          "source-container",
        );
        await context.storage.updateEnvironment(environment.id, {
          containerId: "source-container",
          status: "running",
          containerLifecycle: {
            schemaVersion: 1,
            revision: 1,
            lastRuntimeGeneration: 1,
            runtime: { containerId: "source-container", runtimeGeneration: 1, owner, imageId },
            storage: { format: "legacy-layer", workspaceGeneration: 1 },
            outcomes: [],
          },
        });

        const codexBind = (command: string) => {
          const mounts = [...command.matchAll(/--mount (\S+)/g)].map((match) => match[1]!);
          const binds = mounts.filter((mount) => mount.includes("dst=/codex-home,"));
          expect(binds).toHaveLength(1);
          expect(binds[0]).toMatch(/^type=bind,src=.+,dst=\/codex-home,readonly$/);
          const source = binds[0]!.split(",")[1]!.slice("src=".length);
          expect(source.startsWith(path.join(dir, "portable-inputs") + path.sep)).toBe(true);
          expect(source).not.toBe(codexHome);
          return source;
        };
        const runtimeCreates = async () =>
          (await log.read()).split("\n").filter((line) => line.startsWith("create --name"));
        const sourceBind = codexBind((await runtimeCreates())[0]!);
        expect(await fs.readdir(sourceBind)).toEqual(["config.toml"]);
        expect(await fs.readFile(path.join(sourceBind, "config.toml"), "utf8")).toBe(
          'model = "staged-host"\n',
        );

        // Removing a file as well as adding one catches reuse or merging of an
        // older revision, even when a later boot would overwrite config.toml.
        await fs.rm(path.join(codexHome, "config.toml"));
        await fs.writeFile(path.join(codexHome, "AGENTS.md"), "restaged-host\n");
        const outcome = await replaceRuntimePreservingState(
          { environmentId: environment.id, expectedContainerId: "source-container" },
          context,
        );
        expect(outcome).toMatchObject({ kind: "migrate", containerId: "candidate-container" });
        const creates = await runtimeCreates();
        expect(creates).toHaveLength(2);
        const candidateBind = codexBind(creates[1]!);
        expect(candidateBind).not.toBe(sourceBind);
        expect(await fs.readdir(candidateBind)).toEqual(["AGENTS.md"]);
        expect(await fs.readFile(path.join(candidateBind, "AGENTS.md"), "utf8")).toBe(
          "restaged-host\n",
        );
        expect(await fs.readdir(sourceBind)).toEqual(["config.toml"]);
        const parsed = parseContainerLifecycle(
          (await context.storage.getEnvironment(environment.id))?.containerLifecycle,
        );
        expect(parsed.supported).toBe(true);
        if (!parsed.supported) throw new Error("Unsupported lifecycle record");
        expect(parsed.record.storage.format).toBe("volume-v1");
        expect(parsed.record.retainedRuntimes?.map((runtime) => runtime.containerId)).toEqual([
          "source-container",
        ]);
      },
    );
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});
