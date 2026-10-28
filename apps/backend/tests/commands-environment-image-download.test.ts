import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  admitEnvironmentStartTask,
  enqueueEnvironmentLifecycleOperation,
  startEnvironmentOnce,
  startAssignedContainerRuntimeTask,
} from "../src/core/commands-environment";
import { registerDockerCommands } from "../src/core/commands-registry-docker";
import type { CommandHandler } from "../src/core/commands-context";
import type { RegistryDependencies } from "../src/core/commands-registry-types";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { containerAdmissionSnapshot } from "../src/core/container-admission";
import { resetDockerTopologyCache, resetImageManifestCache } from "../src/core/docker-image";
import { ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES } from "../src/core/commands-error-text";
import { HostMaintenanceService } from "../src/core/host-maintenance";
import { startImageUpdate } from "../src/core/host-maintenance-tasks";
import { CommandFailedError } from "../src/core/shell";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetImageManifestCache();
  resetDockerTopologyCache();
});

async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("download did not reach gate");
    await Bun.sleep(10);
  }
}

async function fixture() {
  const dir = await tempDir("ork-image-lifecycle-");
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const environment = lifecycleEnvironment({
    setupScriptsComplete: true,
    networkAccessMode: "full",
  });
  const scene = memoryLifecycleContext([environment], dir);
  const service = new HostMaintenanceService({
    dataDir: dir,
    updater: "none",
    version: "2.34.0",
    emit: () => undefined,
  });
  service.init();
  cleanups.push(() => service.close());
  cleanups.push(() => scene.context.runtime.shutdown());
  Object.assign(scene.context, {
    hostMaintenance: service,
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
  });
  Object.assign(scene.context.storage, {
    getProject: async () => ({
      id: environment.projectId,
      name: "Project",
      gitUrl: "https://example.invalid/repo.git",
      localPath: null,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { enabledAgentPlatforms: [] },
      repositories: {},
    }),
    getEnvironmentsByProject: async () => [scene.environments.get(environment.id)],
  });
  const manifest = {
    schemaVersion: 1,
    appVersion: "2.34.0",
    sourceRevision: "a".repeat(40),
    architecture: "amd64",
    runtimes: {},
    agents: {},
    bridges: [],
    capabilities: { "workspace-prepare": 1 },
    stateFormats: {},
  };
  await fs.writeFile(path.join(dir, "image-manifest.json"), JSON.stringify(manifest));
  const tar = path.join(dir, "manifest.tar");
  expect(
    spawnSync("tar", ["--format=ustar", "-cf", tar, "-C", dir, "image-manifest.json"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    }).status,
  ).toBe(0);
  const commands = new Map<string, CommandHandler>();
  registerDockerCommands(
    (name, handler) => commands.set(name, handler),
    {} as RegistryDependencies,
  );
  const invoke = (kind: "start" | "provision") =>
    kind === "start"
      ? admitEnvironmentStartTask(environment.id, scene.context, () => undefined).then(
          ({ task }) => task,
        )
      : commands.get("provision_environment")!({ environmentId: environment.id }, scene.context);
  const script = (failure = "") => `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  image)
    if [ ! -e '${dir}/ready' ]; then printf 'No such image\\n' >&2; exit 1; fi
    printf 'sha256:${"a".repeat(64)}\\t[]\\tamd64\\n' ;;
  pull)
    while [ ! -e '${dir}/release' ]; do sleep 0.01; done
    ${failure ? `printf '${failure}\\n' >&2; exit 1` : `touch '${dir}/ready'`} ;;
  create) case "$*" in *manifest-probe*) echo probe ;; *) echo runtime-new ;; esac ;;
  cp) cat '${tar}' ;;
  info) printf '{"OSType":"linux","Architecture":"x86_64","ServerVersion":"29.7.2","SecurityOptions":[],"NCPU":8,"MemTotal":17179869184}\\n' ;;
  inspect) case "$*" in *State.Running*) echo true ;; *) echo '' ;; esac ;;
  exec) case "$*" in *git*) echo abcdef ;; esac ;;
esac
exit 0
`;
  return { ...scene, dir, environment, service, invoke, script };
}

for (const kind of ["start", "provision"] as const) {
  test(`${kind} waits for an automatic missing-image pull outside start admission`, async () => {
    const scene = await fixture();
    await withDockerScript(scene.script(), async (log) => {
      const pending = Promise.resolve(scene.invoke(kind));
      // Attach a handler immediately, including if a later assertion fails.
      const outcome = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await until(async () => (await log.read()).includes("pull "));
        expect((await log.read()).includes("create ")).toBe(false);
        expect(containerAdmissionSnapshot().start).toEqual({ active: 0, waiting: 0 });
      } finally {
        await fs.writeFile(path.join(scene.dir, "release"), "");
      }
      const result = await outcome;
      if ("error" in result) throw result.error;
      if (kind === "start") {
        expect(result.value).toMatchObject({
          environment: { status: "running", containerId: "runtime-new" },
          setupStarted: false,
        });
      } else expect(result.value).toBe("runtime-new");
      expect(scene.environments.get(scene.environment.id)?.containerId).toBe("runtime-new");
      expect(scene.service.snapshot().tasks["image-update"]?.state).toBe("succeeded");
      const calls = await log.read();
      expect(calls.indexOf("tag ")).toBeLessThan(calls.indexOf("create --name"));
    });
  });

  test(`${kind} surfaces automatic pull failure before creating`, async () => {
    const scene = await fixture();
    await fs.writeFile(path.join(scene.dir, "release"), "");
    await withDockerScript(scene.script("no space left on device"), async (log) => {
      await expect(scene.invoke(kind)).rejects.toThrow("no space left on device");
      expect((await log.read()).includes("create ")).toBe(false);
      expect(scene.service.snapshot().tasks["image-update"]?.state).toBe("failed");
      if (kind === "start")
        expect(scene.environments.get(scene.environment.id)?.lifecycleError).toBe(
          ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.diskFull,
        );
    });
  });

  for (const deletion of ["guard", "tombstone"] as const) {
    test(`${kind} checks a pending ${deletion} after the download and lets queued deletion finish`, async () => {
      const scene = await fixture();
      await withDockerScript(scene.script(), async (log) => {
        const pending = Promise.resolve(scene.invoke(kind)).then(
          () => null,
          (error) => error as Error,
        );
        await until(async () => (await log.read()).includes("pull "));
        if (deletion === "guard")
          scene.context.runtime.environments.beginDelete(scene.environment.id);
        else
          await scene.context.storage.updateEnvironment(scene.environment.id, {
            deletionRequestedAt: new Date().toISOString(),
          });
        const deleting = enqueueEnvironmentLifecycleOperation(
          scene.environment.id,
          scene.context,
          () => scene.context.storage.removeEnvironment(scene.environment.id),
        );
        await fs.writeFile(path.join(scene.dir, "release"), "");
        expect((await pending)?.message).toContain("Environment is being deleted");
        await deleting;
        expect(scene.environments.has(scene.environment.id)).toBe(false);
        expect((await log.read()).includes("create --name")).toBe(false);
      });
    });
  }
}

test("a structured timeout from a joined manual pull persists the timeout classification", async () => {
  const scene = await fixture();
  let reject!: (error: Error) => void;
  const gate = new Promise<never>((_, fail) => {
    reject = fail;
  });
  startImageUpdate(scene.context, {
    run: async () => gate,
    status: async () => {
      throw new Error("unexpected status");
    },
    read: async () => null,
    reset: () => undefined,
  });
  await withDockerScript(scene.script(), async (log) => {
    const pending = startEnvironmentOnce(scene.environment.id, scene.context, () => undefined);
    const outcome = pending.catch((error) => error as Error);
    await until(async () => (await log.read()).includes("image inspect"));
    // The child logs before exiting; allow its inspection response to reach the waiter.
    await Bun.sleep(100);
    reject(new CommandFailedError("Command failed: docker pull", { timedOut: true }));
    expect(await outcome).toBeInstanceOf(Error);
    expect(scene.environments.get(scene.environment.id)?.lifecycleError).toBe(
      ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.timedOut,
    );
  });
});

test("an assigned container starts without inspecting or downloading the configured image", async () => {
  const scene = await fixture();
  await scene.context.storage.updateEnvironment(scene.environment.id, {
    containerId: "runtime-old",
  });
  const owner = dockerOwnerNamespace(scene.dir);
  await withDockerScript(
    scene
      .script()
      .replace(
        "*) echo '' ;;",
        `*) printf '${owner}\\texited\\torkestrator-v2\\truntime-old\\n' ;;`,
      ),
    async (log) => {
      expect(await startAssignedContainerRuntimeTask(scene.environment.id, scene.context)).toBe(
        "runtime-old",
      );
      const calls = await log.read();
      expect(calls).toContain("start runtime-old");
      expect(calls).not.toContain("image inspect");
      expect(calls).not.toContain("pull ");
    },
  );
});

test("a missing custom image persists operator remediation without promising a download", async () => {
  const scene = await fixture();
  scene.context.dockerImage = "custom:dev";
  await withDockerScript(scene.script(), async (log) => {
    await expect(scene.invoke("start")).rejects.toThrow("No such image: custom:dev");
    const remediation = scene.environments.get(scene.environment.id)?.lifecycleError;
    expect(remediation).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageUnavailable);
    expect(remediation).toContain("Provide or build");
    expect(remediation).not.toContain("download");
    expect(await log.read()).not.toContain("pull ");
  });
});
