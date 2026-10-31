import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import {
  capacityVerdict,
  replacementCopyFailure,
  quiesceRuntime,
  parseCopyOutput,
  candidateStartError,
  parseMeasureOutput,
  pipeContainerPath,
  rebuildPreview,
  replaceRuntimePreservingState,
  replacementCopyPlan,
  rollbackCandidate,
} from "../src/core/container-replacement";
import { reconcileContainerOperation } from "../src/core/container-lifecycle-service";
import { planStorageSet } from "../src/core/container-storage";
import { PROVIDER_STATE_LAYOUT } from "../src/core/container-state-layout";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { resetResourceCaches } from "../src/core/container-resources";
import { resetDockerTopologyCache, resetImageManifestCache } from "../src/core/docker-image";
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
  test("stops a producer when the copy consumer exits early", async () => {
    await withDockerScript(
      "#!/bin/sh\nif [ \"$1\" = cp ]; then while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n'; done; else exit 1; fi\n",
      async () => {
        const started = Date.now();
        const result = await pipeContainerPath("source", "/workspace", ["run", "helper"]);
        expect(result).toMatchObject({
          absent: false,
          producerFailed: true,
          daemonUnavailable: false,
        });
        expect(Date.now() - started).toBeLessThan(5_000);
      },
    );
  });
  test("settles when the daemon is lost by producer and helper at once", async () => {
    // Live C15: a cut daemon connection ends `docker cp` mid-stream while the
    // helper reading it dies too. The producer exits on its own with output
    // still unread; it must still be seen to close.
    await withDockerScript(
      `#!/bin/sh
if [ "$1" = cp ]; then
  head -c 8000000 /dev/zero &
  sleep 1
  kill $! 2>/dev/null
  echo "error during connect: unexpected EOF" >&2
  exit 1
fi
head -c 100000 >/dev/null
sleep 1
exit 125
`,
      async () => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const settled = await Promise.race([
            pipeContainerPath("source", "/workspace", ["run", "helper"]),
            new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 15_000)),
          ]);
          // Whether the producer's message lands first is a race (the
          // helper's exit kills it), so only settling is asserted here; a
          // failed step asks the daemon itself (`dockerDaemonUnreachableNow`).
          expect(settled).toMatchObject({ absent: false, producerFailed: true });
        }
      },
    );
  }, 90_000);
  test("only the daemon's answer that a path is missing counts as nothing to copy", async () => {
    // Reaching no daemon (its socket gone) also says "no such file"; that
    // step was not copied and must fail, never be skipped as absent.
    for (const [stderr, expected] of [
      [
        "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory",
        { absent: false, producerFailed: true, daemonUnavailable: true },
      ],
      [
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        { absent: false, producerFailed: true, daemonUnavailable: true },
      ],
      [
        "Error response from daemon: container source is being removed",
        { absent: false, producerFailed: true, daemonUnavailable: false },
      ],
      [
        "Error response from daemon: Could not find the file /home/node/.pi in container source",
        { absent: true },
      ],
    ] as const) {
      await withDockerScript(
        `#!/bin/sh\nif [ "$1" = cp ]; then printf '%s\\n' '${stderr}' >&2; exit 1; fi\ncat >/dev/null\nexit 1\n`,
        async () => {
          expect(await pipeContainerPath("source", "/workspace", ["run", "helper"])).toMatchObject(
            expected,
          );
        },
      );
    }
  });
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
  test("rebuild preview exposes provider preservation limits before admission", async () => {
    const { context } = await fixture();
    const previous = process.env.ORKESTRATOR_CONTAINER_REPLACEMENT;
    process.env.ORKESTRATOR_CONTAINER_REPLACEMENT = "paused";
    try {
      const preview = await rebuildPreview("env-lifecycle", context);
      const providers = new Map(preview.providers.map((entry) => [entry.provider, entry]));
      expect(providers.get("grok")).toMatchObject({ level: "partial", resumeQualified: false });
      expect(providers.get("grok")?.limitations).toContain("worktrees.db");
      expect(providers.get("grok")?.limitations).toContain("memory-v2");
      // C13 (scripts/qualify-session-resume.sh): Claude, then Codex, OpenCode,
      // Cursor and Pi on 2026-10-23. Grok stays unverified until it passes.
      expect(providers.get("claude")).toMatchObject({ level: "full", resumeQualified: true });
      expect(providers.get("codex")).toMatchObject({ level: "partial", resumeQualified: true });
      expect(providers.get("opencode")).toMatchObject({ level: "partial", resumeQualified: true });
      expect(providers.get("cursor")).toMatchObject({ level: "full", resumeQualified: true });
      expect(providers.get("pi")).toMatchObject({ level: "full", resumeQualified: true });
      expect(providers.get("grok")?.limitations).toContain("pending qualification");
      // Codex's relocated runtime databases were verified in that run.
      expect(providers.get("codex")?.limitations).not.toContain("pending qualification");
      expect(providers.get("codex")?.limitations).toContain("thread-name index");
      expect(providers.get("opencode")?.limitations).toContain("earlier turns cannot be reverted");
      expect(preview.preservedPaths).toContainEqual(
        expect.stringContaining("/home/node/.grok/sessions"),
      );
      expect(preview.preservedPaths).toContainEqual(
        expect.stringContaining("/home/node/.codex/orkestrator-bridge"),
      );
    } finally {
      if (previous === undefined) delete process.env.ORKESTRATOR_CONTAINER_REPLACEMENT;
      else process.env.ORKESTRATOR_CONTAINER_REPLACEMENT = previous;
    }
  });

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

  for (const kind of ["migrate", "rebuild"] as const) {
    for (const failedCapacity of [false, true]) {
      test(`${kind} rootless budget refusal precedes source stop (failedCapacity=${failedCapacity})`, async () => {
        const { context, environments, owner } = await fixture({
          containerResourceLimits: { cpus: null, memoryMiB: 2048, pids: 512 },
        });
        if (kind === "rebuild") {
          const source = environments.get("env-lifecycle")!;
          source.containerLifecycle = {
            ...record(source.containerLifecycle),
            storage: {
              format: "volume-v1",
              workspaceGeneration: 1,
              storageSetId: "source-set",
              volumes: [
                { role: "workspace", name: "source-workspace" },
                { role: "provider-state", name: "source-state" },
              ],
            },
          };
        }
        const sourceStorage = record(environments.get("env-lifecycle")?.containerLifecycle).storage;
        Object.assign(context.storage, {
          loadConfig: async () => ({ version: "1.0.0", global: {}, repositories: {} }),
        });
        const manifestDir = await tempDir("ork-rootless-manifest-");
        cleanup.push(manifestDir);
        await fs.writeFile(
          path.join(manifestDir, "image-manifest.json"),
          JSON.stringify({
            schemaVersion: 1,
            appVersion: "2.26.0",
            sourceRevision: "b27421dcfa8de61b9c20a08e79efd7dfbd0c7fc2",
            architecture: "amd64",
            runtimes: { bun: "1.4.3", node: "24.21.0" },
            agents: {},
            bridges: [],
            capabilities: { "persistent-workspace": 1 },
            stateFormats: {},
          }),
        );
        const tar = path.join(manifestDir, "manifest.tar");
        const archived = spawnSync(
          "tar",
          ["--format=ustar", "-cf", tar, "-C", manifestDir, "image-manifest.json"],
          { env: { ...process.env, COPYFILE_DISABLE: "1" } },
        );
        expect(archived.status).toBe(0);
        // A rootless daemon without delegated cgroups (driver `none`).
        const info = JSON.stringify({
          OSType: "linux",
          OperatingSystem: "Ubuntu 24.04",
          Architecture: "x86_64",
          ServerVersion: "29.9.2",
          SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"],
          CgroupVersion: "2",
          CgroupDriver: "none",
          CpuCfsQuota: false,
          MemoryLimit: false,
          PidsLimit: false,
        });
        resetResourceCaches();
        try {
          await withDockerScript(
            `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf '${owner}\\trunning\\torkestrator-v2\\tsource-container\\n' ;;
  image) printf 'sha256:${"b".repeat(64)}\\t[]\\tamd64\\n' ;;
  context) printf 'unix:///run/user/1000/docker.sock\\n' ;;
  info)
    ${failedCapacity ? '[ "$3" = "{{json .}}" ] && exit 1' : ""}
    printf '%s\\n' '${info}' ;;
  create) printf 'probe\\n' ;;
  cp) cat '${tar}' ;;
esac
exit 0
`,
            async (log) => {
              await expect(
                replaceRuntimePreservingState(
                  { environmentId: "env-lifecycle", expectedContainerId: "source-container" },
                  context,
                ),
              ).rejects.toThrow(
                failedCapacity
                  ? "ContainerLifecycleError:daemon-unavailable: Docker runs rootless and did not report whether it can enforce the environment's budget. The original container was not changed."
                  : "ContainerLifecycleError:unsupported-topology: This Docker engine (rootless) cannot enforce the memory, process (PID) limits in the environment's budget. The original container was not changed.",
              );
              const calls = await log.read();
              expect(calls).not.toMatch(/^stop /m);
              expect(calls).not.toMatch(/^volume create/m);
            },
          );
        } finally {
          resetResourceCaches();
        }
        const stored = environments.get("env-lifecycle");
        expect(stored?.containerId).toBe("source-container");
        expect(stored?.status).toBe("running");
        expect(record(stored?.containerLifecycle).storage).toEqual(sourceStorage);
        expect(record(stored?.containerLifecycle).outcomes.at(-1)).toMatchObject({
          kind,
          status: "failed",
        });
      });
    }
  }
});

describe("restart reconciliation", () => {
  test("rollback refuses a candidate already committed as the current runtime", async () => {
    const dir = await tempDir("ork-committed-rollback-");
    cleanup.push(dir);
    const owner = dockerOwnerNamespace(dir);
    const storage = planStorageSet("env-lifecycle", owner, 2, "committed");
    const environment = lifecycleEnvironment({
      containerId: "candidate-container",
      containerLifecycle: {
        schemaVersion: 1,
        revision: 5,
        lastRuntimeGeneration: 2,
        runtime: {
          containerId: "candidate-container",
          runtimeGeneration: 2,
          owner,
          createdByOperationId: OPERATION_ID,
        },
        storage,
        outcomes: [],
      },
    });
    const { context, environments } = memoryLifecycleContext([environment], dir);
    await withDockerScript(
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"\n',
      async (log) => {
        expect(
          await rollbackCandidate(context, environment.id, OPERATION_ID, storage),
        ).toBeUndefined();
        expect(
          await rollbackCandidate(context, environment.id, OPERATION_ID, undefined),
        ).toBeUndefined();
        expect(await log.read()).toBe("");
      },
    );
    expect(environments.get(environment.id)?.containerId).toBe("candidate-container");
  });
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

  test("a kill at any phase before the commit write leaves the original authoritative", async () => {
    for (const phase of [
      "preflight",
      "quiescing",
      "source-stopped",
      "copying",
      "verified",
      "candidate-prepared",
      "candidate-healthy",
    ]) {
      const dir = await tempDir("ork-replacement-phase-");
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
            phase,
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
          expect(calls).not.toContain("rm -f source-container");
        },
      );
      const stored = environments.get("env-lifecycle");
      expect(stored?.containerId).toBe("source-container");
      expect(record(stored?.containerLifecycle).storage.format).toBe("legacy-layer");
      expect(record(stored?.containerLifecycle).operation).toBeUndefined();
    }
  });

  test("a kill right after the commit write finds nothing to undo", async () => {
    const dir = await tempDir("ork-replacement-committed-");
    cleanup.push(dir);
    const owner = dockerOwnerNamespace(dir);
    const committed = planStorageSet("env-lifecycle", owner, 1, "cand1");
    // The one commit write moved both pointers and cleared the operation.
    const environment = lifecycleEnvironment({
      containerId: "candidate-container",
      status: "stopped",
      containerLifecycle: {
        schemaVersion: 1,
        revision: 8,
        lastRuntimeGeneration: 2,
        runtime: { containerId: "candidate-container", runtimeGeneration: 2, owner },
        storage: committed,
        outcomes: [
          {
            operationId: OPERATION_ID,
            kind: "migrate",
            status: "succeeded",
            completedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
    const { context, environments } = memoryLifecycleContext([environment], dir);
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
exit 0
`,
      async (log) => {
        expect(await reconcileContainerOperation(context, environment)).toBe("none");
        expect(await log.read()).toBe("");
      },
    );
    expect(environments.get("env-lifecycle")?.containerId).toBe("candidate-container");
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

describe("candidate start failures", () => {
  test("a published port held elsewhere is a typed, actionable failure", () => {
    const conflict = candidateStartError(
      new Error(
        "Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:3000 failed: port is already allocated",
      ),
    );
    expect(String(conflict)).toContain("ContainerLifecycleError:port-conflict");
    const other = new Error("something else");
    expect(candidateStartError(other)).toBe(other);
  });
});

describe("inode capacity", () => {
  test("a known file count needs the inodes to hold it; an unknown one does not block", () => {
    expect(
      parseMeasureOutput(
        "ORKESTRATOR_MEASURE bytes=100 available=900000000 inodes=5000 inodes_available=200",
      ),
    ).toEqual({ bytes: 100, available: 900000000, inodes: 5000, inodesAvailable: 200 });
    expect(parseMeasureOutput("ORKESTRATOR_MEASURE bytes= available=")).toEqual({
      bytes: null,
      available: null,
      inodes: null,
      inodesAvailable: null,
    });
    // A filesystem with dynamic inodes (btrfs) reports none: unknown, not full.
    expect(
      parseMeasureOutput("ORKESTRATOR_MEASURE bytes=1 available=2 inodes=3 inodes_available=")
        .inodesAvailable,
    ).toBeNull();
    const roomy = { estimateBytes: 1_000, availableBytes: 10 * 1024 ** 3 };
    expect(
      capacityVerdict({ ...roomy, estimateInodes: 5_000, availableInodes: 200 }, false),
    ).toMatchObject({
      ok: false,
    });
    expect(
      capacityVerdict({ ...roomy, estimateInodes: 5_000, availableInodes: 1_000_000 }, false),
    ).toEqual({ ok: true });
    expect(
      capacityVerdict({ ...roomy, estimateInodes: null, availableInodes: 200 }, false),
    ).toEqual({
      ok: true,
    });
  });
});

describe("replacement copy failure classification", () => {
  for (const [probe, code] of [
    ["printf '29.7.2\\n'", "needs-attention"],
    ["echo 'Cannot connect to the Docker daemon' >&2; exit 1", "daemon-unavailable"],
    ["echo 'unrelated client failure' >&2; exit 1", "needs-attention"],
    ["exec sleep 30", "daemon-unavailable"],
  ] as const) {
    test(`a copy stream failure probes Docker: ${probe}`, async () => {
      await withDockerScript(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
${probe}
`,
        async (log) => {
          expect(String(await replacementCopyFailure("helper-failed"))).toContain(
            `ContainerLifecycleError:${code}`,
          );
          expect(await log.read()).toBe("version --format {{.Server.Version}}\n");
        },
      );
    }, 15_000);
  }
  test("an explicit daemon failure needs no second probe", async () => {
    await withDockerScript("#!/bin/sh\nexit 99\n", async (log) => {
      expect(String(await replacementCopyFailure("daemon-unavailable"))).toContain(
        "ContainerLifecycleError:daemon-unavailable",
      );
      expect(await log.read()).toBe("");
    });
  });
});

test("quiescing for rebuild or recovery-copy restore settles agents only after runtime stop", async () => {
  const { context } = await fixture();
  let calls = "";
  const stopped = mock(async (environmentId: string) => {
    expect(environmentId).toBe("env-lifecycle");
    expect(calls).toContain("stop source-container");
  });
  let enterStop!: () => void;
  let releaseStop!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterStop = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const requested = mock(async (environmentId: string, agent?: string) => {
    expect(environmentId).toBe("env-lifecycle");
    expect(agent).toBeUndefined();
    enterStop();
    await gate;
  });
  context.nativeAgents = {
    runtimeStopRequested: requested,
    environmentRuntimeStopped: stopped,
  } as unknown as NonNullable<typeof context.nativeAgents>;
  await withDockerScript(
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
exit 0
`,
    async (log) => {
      // Capture the command evidence inside the callback, at the settlement edge.
      stopped.mockImplementation(async (environmentId) => {
        calls = await log.read();
        expect(environmentId).toBe("env-lifecycle");
        expect(calls).toContain("stop source-container");
      });
      const stopping = quiesceRuntime("env-lifecycle", "source-container", undefined, context);
      await entered;
      try {
        expect(await log.read()).not.toContain("stop source-container");
      } finally {
        releaseStop();
      }
      expect(await stopping).toEqual({ forced: false });
      expect(requested).toHaveBeenCalledTimes(1);
      expect(stopped).toHaveBeenCalledTimes(1);
    },
  );
});
