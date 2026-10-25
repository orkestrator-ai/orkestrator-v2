import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startAssignedContainerRuntimeTask } from "../src/core/commands-environment";
import { resetContainerOwnershipCache } from "../src/core/container-lifecycle-service";
import { resetImageManifestCache } from "../src/core/docker-image";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  resetContainerOwnershipCache();
  resetImageManifestCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

for (const boot of ["ready", "failed", "legacy"] as const) {
  test(`project-files repair follows ${boot} boot readiness`, async () => {
    const dir = await tempDir("ork-start-readiness-");
    cleanup.push(dir);
    const owner = dockerOwnerNamespace(dir);
    const imageId = `sha256:${"b".repeat(64)}`;
    const environment = lifecycleEnvironment({
      containerId: "runtime-1",
      containerLifecycle: {
        schemaVersion: 1,
        revision: 1,
        lastRuntimeGeneration: 1,
        runtime: { containerId: "runtime-1", runtimeGeneration: 1, owner, imageId },
        storage: { format: "legacy-layer", workspaceGeneration: 1 },
        outcomes: [],
      },
    });
    const { context } = memoryLifecycleContext([environment], dir);
    const manifest = {
      schemaVersion: 1,
      appVersion: "2.26.0",
      sourceRevision: "b".repeat(40),
      architecture: "amd64",
      runtimes: { bun: "1.4.3", node: "24.21.0" },
      agents: {},
      bridges: [],
      capabilities: { "boot-status": 1 },
      stateFormats: {},
    };
    await fs.writeFile(path.join(dir, "image-manifest.json"), JSON.stringify(manifest));
    const tar = path.join(dir, "manifest.tar");
    expect(
      spawnSync("tar", ["--format=ustar", "-cf", tar, "-C", dir, "image-manifest.json"], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      }).status,
    ).toBe(0);
    const record = JSON.stringify({
      version: 1,
      bootId: "0b0b0b0b-1111-2222-3333-444444444444",
      pid1Start: "5000",
      phase: boot,
      failureCode: boot === "failed" ? "firewall-failed" : null,
      updatedAt: "2026-09-27T00:00:00Z",
    });
    await withDockerScript(
      `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect)
    case "$*" in
      *State.Running*) printf 'false\n' ;;
      *orkestrator-inputs-revision*) printf '\n' ;;
      *) printf '${owner}\texited\torkestrator-v2\truntime-1\n' ;;
    esac ;;
  create) printf 'manifest-probe\n' ;;
  cp) ${boot === "legacy" ? "printf 'no such file\\n' >&2; exit 1" : `cat '${tar}'`} ;;
  exec)
    case "$*" in
      *'chgrp -R node /project-files'*)
        ${boot === "failed" ? "printf 'container is not running\\n' >&2; exit 1" : "exit 0"} ;;
      *boot-status.json*) printf '%s\n5000\n' '${record}' ;;
      *) printf 'marker invalidation failed\n' >&2; exit 1 ;;
    esac ;;
esac
exit 0
`,
      async (log) => {
        const starting = startAssignedContainerRuntimeTask(environment.id, context);
        if (boot === "failed") {
          await expect(starting).rejects.toThrow("ContainerLifecycleError:not-ready");
        } else {
          expect(await starting).toBe("runtime-1");
        }
        const calls = await log.read();
        const repair = calls.indexOf("chgrp -R node /project-files");
        const probe = calls.indexOf("boot-status.json");
        expect(calls).toContain("start runtime-1");
        if (boot === "failed") {
          expect(probe).toBeGreaterThan(-1);
          expect(repair).toBe(-1);
        } else {
          expect(repair).toBeGreaterThan(-1);
          if (boot === "ready") {
            expect(probe).toBeGreaterThan(-1);
            expect(repair).toBeGreaterThan(probe);
          } else expect(probe).toBe(-1);
        }
      },
    );
  });
}
