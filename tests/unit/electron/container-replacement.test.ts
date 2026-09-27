import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import {
  capacityVerdict,
  parseCopyOutput,
  rebuildPreview,
  replaceRuntimePreservingState,
  replacementCopyPlan,
} from "../../../apps/backend/src/core/container-replacement";
import { reconcileContainerOperation } from "../../../apps/backend/src/core/container-lifecycle-service";
import { planStorageSet } from "../../../apps/backend/src/core/container-storage";
import { PROVIDER_STATE_LAYOUT } from "../../../apps/backend/src/core/container-state-layout";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import {
  resetDockerTopologyCache,
  resetImageManifestCache,
} from "../../../apps/backend/src/core/docker-image";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  resetImageManifestCache();
  resetDockerTopologyCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const OPERATION_ID = "01890000-0000-7000-8000-000000000001";

describe("copy plan", () => {
  test("a legacy source copies the workspace and every provider path, relocating databases", () => {
    const plan = replacementCopyPlan("legacy-layer");
    expect(plan[0]).toEqual({
      source: { kind: "container-path", path: "/workspace" },
      target: { role: "workspace", subdir: "" },
    });
    expect(plan).toHaveLength(PROVIDER_STATE_LAYOUT.length + 1);
    const codex = plan.find((step) => step.target.subdir === "codex/sqlite");
    // Only the top-level databases, never the rest of the Codex home (which
    // holds configuration and credentials).
    expect(codex).toEqual({
      source: { kind: "container-path", path: "/home/node/.codex" },
      target: { role: "state", subdir: "codex/sqlite" },
      select: [".codex/*.sqlite", ".codex/*.sqlite-wal", ".codex/*.sqlite-shm"],
    });
    const opencode = plan.find((step) => step.target.subdir === "opencode/db");
    expect(opencode?.select).toEqual([
      "opencode/opencode.db",
      "opencode/opencode.db-wal",
      "opencode/opencode.db-shm",
    ]);
    for (const step of plan) {
      if (step.source.kind === "container-path") {
        expect(step.source.path).not.toMatch(/^\/home\/node\/?$/);
      }
    }
  });

  test("a volume source copies both whole volumes", () => {
    expect(replacementCopyPlan("volume-v1")).toEqual([
      { source: { kind: "volume", role: "workspace" }, target: { role: "workspace", subdir: "" } },
      { source: { kind: "volume", role: "state" }, target: { role: "state", subdir: "" } },
    ]);
  });

  test("parses the helper's result line and never trusts a missing one", () => {
    expect(
      parseCopyOutput(
        "noise\nORKESTRATOR_COPY status=ok files=12 bytes=3400 links=2 dirs=4 source_dirs=4 git=ok\n",
      ),
    ).toEqual({ ok: true, files: 12, bytes: 3400 });
    expect(parseCopyOutput("ORKESTRATOR_COPY status=mismatch kind=files differing=3")).toEqual({
      ok: false,
      reason: "mismatch:files",
    });
    expect(parseCopyOutput("ORKESTRATOR_COPY status=root-symlink")).toEqual({
      ok: false,
      reason: "root-symlink",
    });
    expect(parseCopyOutput("")).toEqual({ ok: false, reason: "helper-failed" });
  });
});

describe("capacity", () => {
  test("requires the estimate plus headroom on the daemon's filesystem", () => {
    const gib = 1024 ** 3;
    expect(capacityVerdict({ estimateBytes: gib, availableBytes: 3 * gib }, false)).toEqual({
      ok: true,
    });
    const short = capacityVerdict({ estimateBytes: 2 * gib, availableBytes: 2 * gib }, false);
    expect(short.ok).toBe(false);
    // A measured shortfall is refused even when unknown capacity is allowed.
    expect(capacityVerdict({ estimateBytes: 2 * gib, availableBytes: 2 * gib }, true).ok).toBe(
      false,
    );
  });

  test("unknown capacity is refused unless the user explicitly accepts it", () => {
    expect(capacityVerdict({ estimateBytes: null, availableBytes: 10 }, false).ok).toBe(false);
    expect(capacityVerdict({ estimateBytes: 10, availableBytes: null }, true)).toEqual({
      ok: true,
    });
  });
});

async function fixture(overrides: Parameters<typeof lifecycleEnvironment>[0] = {}) {
  const dir = await tempDir("ork-replacement-");
  cleanup.push(dir);
  const owner = dockerOwnerNamespace(dir);
  const environment = lifecycleEnvironment({
    containerId: "source-container",
    status: "running",
    containerLifecycle: {
      schemaVersion: 1,
      revision: 4,
      lastRuntimeGeneration: 1,
      runtime: { containerId: "source-container", runtimeGeneration: 1, owner },
      storage: { format: "legacy-layer", workspaceGeneration: 1 },
      outcomes: [],
    },
    ...overrides,
  });
  const built = memoryLifecycleContext([environment], dir);
  Object.assign(built.context.storage, {
    listMultiReviewWorkflows: async () => [],
    listAllBuildPipelines: async () => [],
  });
  return { ...built, owner, environment };
}

function record(environment: unknown) {
  const parsed = parseContainerLifecycle(environment);
  if (!parsed.supported) throw new Error("unsupported");
  return parsed.record;
}

describe("replacement admission", () => {
  test("refuses a runtime that changed after review without touching Docker", async () => {
    const { context, environments } = await fixture();
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
exit 1
`,
      async (log) => {
        await expect(
          replaceRuntimePreservingState(
            { environmentId: "env-lifecycle", expectedContainerId: "reviewed-elsewhere" },
            context,
          ),
        ).rejects.toThrow("ContainerLifecycleError:runtime-changed");
        expect(await log.read()).toBe("");
      },
    );
    expect(record(environments.get("env-lifecycle")?.containerLifecycle).operation).toBeUndefined();
  });

  test("paused admissions refuse rebuilds before anything runs; the preview says why", async () => {
    const { context, environments } = await fixture();
    const previous = process.env.ORKESTRATOR_CONTAINER_REPLACEMENT;
    process.env.ORKESTRATOR_CONTAINER_REPLACEMENT = "paused";
    try {
      await withDockerScript(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
exit 1
`,
        async (log) => {
          await expect(
            replaceRuntimePreservingState(
              { environmentId: "env-lifecycle", expectedContainerId: "source-container" },
              context,
            ),
          ).rejects.toThrow("ContainerLifecycleError:capability-unavailable");
          expect(await log.read()).toBe("");
          const preview = await rebuildPreview("env-lifecycle", context);
          expect(preview).toMatchObject({
            available: false,
            unavailableReason: "admission-paused",
          });
        },
      );
    } finally {
      if (previous === undefined) delete process.env.ORKESTRATOR_CONTAINER_REPLACEMENT;
      else process.env.ORKESTRATOR_CONTAINER_REPLACEMENT = previous;
    }
    expect(record(environments.get("env-lifecycle")?.containerLifecycle).operation).toBeUndefined();
  });

  test("an image without the storage contract is refused before the source stops", async () => {
    const { context, environments, owner } = await fixture();
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf '${owner}\\trunning\\torkestrator-v2\\tsource-container\\n' ;;
  image) printf 'sha256:${"b".repeat(64)}\\t[]\\tamd64\\n' ;;
  context) printf 'unix:///var/run/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Ubuntu","Architecture":"x86_64","ServerVersion":"29.7.2","SecurityOptions":[]}\\n' ;;
  create) printf 'probe\\n' ;;
  cp) printf 'Error response from daemon: Could not find the file /usr/local/share/orkestrator/image-manifest.json in container probe\\n' >&2; exit 1 ;;
esac
exit 0
`,
      async (log) => {
        await expect(
          replaceRuntimePreservingState(
            { environmentId: "env-lifecycle", expectedContainerId: "source-container" },
            context,
          ),
        ).rejects.toThrow("ContainerLifecycleError:capability-unavailable");
        const calls = await log.read();
        expect(calls).not.toMatch(/^stop /m);
        expect(calls).not.toMatch(/^volume create/m);
      },
    );
    const stored = environments.get("env-lifecycle");
    expect(stored?.containerId).toBe("source-container");
    expect(stored?.status).toBe("running");
    const lifecycle = record(stored?.containerLifecycle);
    expect(lifecycle.storage.format).toBe("legacy-layer");
    expect(lifecycle.outcomes.at(-1)).toMatchObject({ kind: "migrate", status: "failed" });
  });
});

describe("restart reconciliation", () => {
  test("an interrupted replacement removes its candidate and keeps the original", async () => {
    const dir = await tempDir("ork-replacement-");
    cleanup.push(dir);
    const owner = dockerOwnerNamespace(dir);
    const candidateStorage = planStorageSet("env-lifecycle", owner, 1, "cand1");
    const environment = lifecycleEnvironment({
      containerId: "source-container",
      status: "running",
      containerLifecycle: {
        schemaVersion: 1,
        revision: 7,
        lastRuntimeGeneration: 1,
        runtime: { containerId: "source-container", runtimeGeneration: 1, owner },
        storage: { format: "legacy-layer", workspaceGeneration: 1 },
        operation: {
          operationId: OPERATION_ID,
          kind: "migrate",
          status: "running",
          phase: "candidate-prepared",
          startedAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          candidateStorage,
        },
        outcomes: [],
      },
    });
    const { context, environments } = memoryLifecycleContext([environment], dir);
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1:$2" in
  ps:*) printf 'candidate-container\\t2\\n' ;;
  volume:inspect) printf '{"orkestrator-owner":"${owner}","environment-id":"env-lifecycle"}\\n' ;;
esac
exit 0
`,
      async (log) => {
        expect(await reconcileContainerOperation(context, environment)).toBe("settled");
        const calls = await log.read();
        expect(calls).toContain("rm -f candidate-container");
        expect(calls).not.toContain("rm -f source-container");
        for (const volume of candidateStorage.volumes ?? []) {
          expect(calls).toContain(`volume rm ${volume.name}`);
        }
      },
    );
    const stored = environments.get("env-lifecycle");
    // The pointer never moved; the original is kept, stopped.
    expect(stored?.containerId).toBe("source-container");
    expect(stored?.status).toBe("stopped");
    const lifecycle = record(stored?.containerLifecycle);
    expect(lifecycle.operation).toBeUndefined();
    expect(lifecycle.storage.format).toBe("legacy-layer");
    expect(lifecycle.outcomes.at(-1)).toMatchObject({
      operationId: OPERATION_ID,
      status: "interrupted",
    });
  });

  test("a candidate volume that will not remove stays referenced, not orphaned", async () => {
    const dir = await tempDir("ork-replacement-");
    cleanup.push(dir);
    const owner = dockerOwnerNamespace(dir);
    const candidateStorage = planStorageSet("env-lifecycle", owner, 1, "cand2");
    const environment = lifecycleEnvironment({
      containerId: "source-container",
      containerLifecycle: {
        schemaVersion: 1,
        revision: 2,
        lastRuntimeGeneration: 1,
        storage: { format: "legacy-layer", workspaceGeneration: 1 },
        operation: {
          operationId: OPERATION_ID,
          kind: "migrate",
          status: "running",
          phase: "copying",
          startedAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          candidateStorage,
        },
        outcomes: [],
      },
    });
    const { context, environments } = memoryLifecycleContext([environment], dir);
    await withDockerScript(
      `#!/bin/sh
case "$1:$2" in
  volume:inspect) printf '{"orkestrator-owner":"${owner}","environment-id":"env-lifecycle"}\\n' ;;
  volume:rm) printf 'Error response from daemon: volume is in use\\n' >&2; exit 1 ;;
esac
exit 0
`,
      async () => {
        await reconcileContainerOperation(context, environment);
      },
    );
    const lifecycle = record(environments.get("env-lifecycle")?.containerLifecycle);
    expect(lifecycle.retainedStorage).toEqual([
      expect.objectContaining({
        storageSetId: "cand2",
        reason: "failed-candidate",
        operationId: OPERATION_ID,
      }),
    ]);
  });
});
