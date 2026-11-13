import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import {
  capacityVerdict,
  runCopyStep,
  replacementCopyFailure,
  quiesceRuntime,
  parseCopyOutput,
  candidateStartError,
  COPY_DRAIN_BASE_MS,
  copyDrainWindowMs,
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
  test("the deadline fails the step even when neither child can be seen to close", async () => {
    // A killed child's descendant still holds the pipes, so `close` does not fire:
    // the same wait a lost completion event leaves. Each fake `docker` logs its
    // pid once its pipe-holding `sleep` exists.
    await withDockerScript(
      '#!/bin/sh\nsleep 8 &\necho "$$" >> "$FAKE_DOCKER_LOG"\nexec sleep 8\n',
      async (log) => {
        const started = Date.now();
        const result = await pipeContainerPath("source", "/workspace", ["run", "helper"], {
          // The deadline must fire after both shells have forked their holder;
          // nothing can be awaited for that, because the timer starts at spawn.
          // At 100 ms a loaded macOS host killed both shells first in 2 of 25
          // runs (flake 9979): with no holder both closed, and the step failed
          // through `close` instead. 1.5 s leaves a wide margin for the fork.
          timeoutMs: 1_500,
          settleGraceMs: 100,
        });
        // The scenario held: both children had a descendant holding the pipes.
        expect((await log.read()).split("\n").filter(Boolean)).toHaveLength(2);
        expect(result).toEqual({
          absent: false,
          output: "",
          producerFailed: true,
          daemonUnavailable: false,
        });
        expect(Date.now() - started).toBeLessThan(6_000);
      },
    );
  }, 15_000);
  test("a helper that never sees end of input after its producer exits is abandoned in the drain window (to-do 7705)", async () => {
    // The 2026-11-11 stall: `docker cp` had exited, but the helper's `tee` was
    // still blocked on the container's stdin 14 minutes later, so the step
    // waited for the one-hour deadline. Here the helper ignores its input
    // ending, as that one did.
    // Removal is slow here: the step must not settle before it finishes,
    // because rollback removes the candidate's volumes next.
    await withDockerScript(
      `#!/bin/sh
case "$1" in
  cp) printf 'archive bytes'; exit 0 ;;
  rm) sleep 1; echo "rm $*" >> "$FAKE_DOCKER_LOG"; exit 0 ;;
  *) exec sleep 30 ;;
esac
`,
      async (log) => {
        const started = Date.now();
        const logs = captureLogs();
        let streamed = -1;
        const result = await pipeContainerPath("source", "/workspace", ["run", "helper"], {
          drainWindowMs: (bytes, streamedMs) => {
            expect(bytes).toBe("archive bytes".length);
            // Measured from the producer's spawn to its close.
            streamed = streamedMs;
            return 300;
          },
          settleGraceMs: 2_000,
          consumerContainer: "orkestrator-copy-test",
        }).finally(() => logs.restore());
        expect(result).toEqual({
          absent: false,
          output: "",
          producerFailed: true,
          daemonUnavailable: false,
          stalled: true,
        });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(logs.records()).toMatchObject([
          {
            event: "replacement.copy-helper-stalled",
            fields: { producerCode: 0, bytes: "archive bytes".length, drainMs: 300 },
          },
        ]);
        expect(streamed).toBeGreaterThanOrEqual(0);
        expect(streamed).toBeLessThan(Date.now() - started);
        expect(logs.records()[0]?.fields?.streamedMs).toBe(streamed);
        // The helper container is removed (killing `docker run` leaves it
        // running), and the removal had finished before the step settled.
        expect(await log.read()).toContain("rm rm -f orkestrator-copy-test");
      },
    );
  }, 20_000);
  test("a stalled helper that cannot be removed is reported, and one already gone is not", async () => {
    for (const [rm, failed] of [
      ["echo 'Error response from daemon: cannot remove container: device busy' >&2; exit 1", true],
      [
        "echo 'Error response from daemon: No such container: orkestrator-copy-test' >&2; exit 1",
        false,
      ],
    ] as const) {
      await withDockerScript(
        `#!/bin/sh
case "$1" in
  cp) printf 'archive bytes'; exit 0 ;;
  rm) ${rm} ;;
  *) exec sleep 30 ;;
esac
`,
        async () => {
          const logs = captureLogs();
          const result = await pipeContainerPath("source", "/workspace", ["run", "helper"], {
            drainWindowMs: () => 300,
            settleGraceMs: 2_000,
            consumerContainer: "orkestrator-copy-test",
          }).finally(() => logs.restore());
          expect(result).toMatchObject({ absent: false, stalled: true });
          const removeFailed = logs
            .records()
            .filter((record) => record.event === "replacement.copy-helper-remove-failed");
          if (failed) {
            expect(result).toMatchObject({ helperRemovalFailed: true });
            expect(removeFailed).toMatchObject([
              { level: "warn", fields: { helper: "orkestrator-copy-test" } },
            ]);
          } else {
            expect(result).not.toHaveProperty("helperRemovalFailed");
            expect(removeFailed).toEqual([]);
          }
        },
      );
    }
  }, 20_000);
  test("a producer's own failure outranks a stall of the helper it left waiting", async () => {
    // The producer already said why it failed; the helper then sat in the
    // drain window. Its answer, not the stall, names the failure.
    for (const [stderr, expected] of [
      [
        "Error response from daemon: Could not find the file /home/node/.pi in container source",
        { absent: true },
      ],
      [
        "Error response from daemon: remount-ro /d/rootfs/overlayfs/1/git, flags: 0x1021: operation not permitted",
        { absent: false, refused: true, stalled: true },
      ],
      [
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        { absent: false, daemonUnavailable: true, stalled: true },
      ],
    ] as const) {
      await withDockerScript(
        `#!/bin/sh
case "$1" in
  cp) printf '%s\\n' '${stderr}' >&2; exit 1 ;;
  rm) echo "rm $*" >> "$FAKE_DOCKER_LOG"; exit 0 ;;
  *) exec sleep 30 ;;
esac
`,
        async (log) => {
          const result = await pipeContainerPath("source", "/workspace", ["run", "helper"], {
            drainWindowMs: () => 300,
            settleGraceMs: 2_000,
            consumerContainer: "orkestrator-copy-test",
          });
          expect(result).toEqual(
            expected.absent
              ? expected
              : {
                  output: "",
                  producerFailed: true,
                  daemonUnavailable: false,
                  ...expected,
                },
          );
          expect(await log.read()).toContain("rm rm -f orkestrator-copy-test");
        },
      );
    }
  }, 30_000);
  test("the drain window does not cut short a helper that finishes its checks", async () => {
    await withDockerScript(
      `#!/bin/sh
case "$1" in
  cp) printf 'archive bytes'; exit 0 ;;
  rm) echo "rm $*" >> "$FAKE_DOCKER_LOG"; exit 0 ;;
  *) cat >/dev/null; sleep 1; printf 'ORKESTRATOR_COPY status=ok files=1 bytes=13\\n'; exit 0 ;;
esac
`,
      async (log) => {
        const result = await pipeContainerPath("source", "/workspace", ["run", "helper"], {
          drainWindowMs: () => 5_000,
          consumerContainer: "orkestrator-copy-test",
        });
        expect(result).toMatchObject({ absent: false, producerFailed: false });
        expect(result).not.toHaveProperty("stalled");
        expect(parseCopyOutput((result as { output: string }).output)).toEqual({
          ok: true,
          files: 1,
          bytes: 13,
        });
        expect(await log.read()).toBe("");
      },
    );
  }, 20_000);
  test("the drain window is minutes, grows with the bytes sent and stays far below the hour", () => {
    expect(copyDrainWindowMs(0)).toBe(COPY_DRAIN_BASE_MS);
    expect(copyDrainWindowMs(1024 ** 3)).toBeGreaterThan(copyDrainWindowMs(0));
    expect(copyDrainWindowMs(5 * 1024 ** 3)).toBeLessThan(10 * 60_000);
  });
  test("the drain window also gets as long again as the stream took", () => {
    // A loaded host slows the helper's work after its input ends as much as
    // its work while the stream flows, so a slow stream earns a longer drain.
    expect(copyDrainWindowMs(0, 90_000)).toBe(COPY_DRAIN_BASE_MS + 90_000);
    expect(copyDrainWindowMs(1024 ** 3, 60_000)).toBe(copyDrainWindowMs(1024 ** 3) + 60_000);
    expect(copyDrainWindowMs(0, -5)).toBe(COPY_DRAIN_BASE_MS);
  });
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
      [
        "Error response from daemon: remount-ro /d/rootfs/overlayfs/1/git, flags: 0x1021: operation not permitted",
        { absent: false, producerFailed: true, daemonUnavailable: false, refused: true },
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
    // OpenCode 1.x's opencode.db is left behind.
    expect(opencode?.select).toEqual([
      "opencode/opencode2.db",
      "opencode/opencode2.db-wal",
      "opencode/opencode2.db-shm",
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
  test("a refused copy is the topology error and needs no probe", async () => {
    await withDockerScript(
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"\nexit 99\n',
      async (log) => {
        const error = await replacementCopyFailure("source-copy-refused");
        expect(String(error)).toContain("ContainerLifecycleError:unsupported-topology");
        expect(String(error)).toContain("kept unchanged");
        expect(await log.read()).toBe("");
      },
    );
  });
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

test("copy step maps a refused producer to source-copy-refused before outage probing", async () => {
  const { context, owner } = await fixture();
  const candidate = planStorageSet("env-lifecycle", owner, 1, "candidate");
  const step = replacementCopyPlan("legacy-layer")[0]!;
  await withDockerScript(
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = cp ]; then
  echo 'Error response from daemon: remount-ro /rootfs/git, flags: 0x1021: operation not permitted' >&2
  exit 1
fi
cat >/dev/null
exit 1
`,
    async (log) => {
      const result = await runCopyStep(
        context,
        "sha256:fixture",
        step,
        {
          containerId: "source-container",
          storage: { format: "legacy-layer", workspaceGeneration: 1 },
        },
        candidate,
      );
      expect(result).toEqual({ ok: false, reason: "source-copy-refused" });
      if (result.ok) throw new Error("Expected copy failure");
      expect(String(await replacementCopyFailure(result.reason))).toContain(
        "ContainerLifecycleError:unsupported-topology",
      );
      const calls = await log.read();
      expect(calls).toContain("cp source-container:");
      expect(calls).not.toContain("version --format");
    },
  );
});

// Engine 29.9.3's wording when the daemon stops (SIGTERM) or dies (SIGKILL)
// under an attached helper. The step must fail as an outage, not as files that
// failed verification, and must say so without asking the daemon again: on a
// systemd host that probe waits for the restarted daemon and answers "up".
describe("a streamed copy step whose helper stalls", () => {
  async function stalledStep(rm: string) {
    const { context, owner } = await fixture();
    const candidate = planStorageSet("env-lifecycle", owner, 1, "candidate");
    const step = replacementCopyPlan("legacy-layer")[0]!;
    let result: Awaited<ReturnType<typeof runCopyStep>> | undefined;
    let dockerLog = "";
    await withDockerScript(
      `#!/bin/sh
case "$1" in
  cp) printf 'archive'; exit 0 ;;
  rm) echo "rm $*" >> "$FAKE_DOCKER_LOG"; ${rm} ;;
  version) echo 29.0.0; exit 0 ;;
  *) exec sleep 30 ;;
esac
`,
      async (log) => {
        result = await runCopyStep(
          context,
          "sha256:fixture",
          step,
          {
            containerId: "source-container",
            storage: { format: "legacy-layer", workspaceGeneration: 1 },
          },
          candidate,
          { drainWindowMs: () => 300, settleGraceMs: 2_000 },
        );
        dockerLog = await log.read();
      },
    );
    return { result: result!, dockerLog };
  }

  test("fails as helper-input-stalled once its named helper is removed", async () => {
    const { result, dockerLog } = await stalledStep("exit 0");
    expect(result).toEqual({ ok: false, reason: "helper-input-stalled" });
    expect(dockerLog).toMatch(/^rm rm -f orkestrator-copy-[0-9a-f-]{12}$/m);
  }, 20_000);

  test("fails as helper-remove-failed when the helper cannot be removed", async () => {
    const { result } = await stalledStep(
      "echo 'Error response from daemon: cannot remove container' >&2; exit 1",
    );
    expect(result).toEqual({ ok: false, reason: "helper-remove-failed" });
    if (result.ok) throw new Error("Expected copy failure");
    await withDockerScript("#!/bin/sh\necho 29.0.0\n", async () => {
      const error = String(await replacementCopyFailure(result.reason));
      expect(error).toContain("ContainerLifecycleError:needs-attention");
      expect(error).toContain("helper container could not be removed");
    });
  }, 20_000);
});

describe("copy step names a daemon lost while its helper waited", () => {
  const LOST = [
    "Error waiting for container: Canceled: grpc: the client connection is closing: context canceled",
    "error waiting for container: unexpected EOF",
  ];

  for (const message of LOST) {
    test(`streamed step: ${message}`, async () => {
      const { context, owner } = await fixture();
      const candidate = planStorageSet("env-lifecycle", owner, 1, "candidate");
      const step = replacementCopyPlan("legacy-layer")[0]!;
      await withDockerScript(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = cp ]; then printf 'archive'; exit 0; fi
cat >/dev/null
printf '%s\\n' '${message}' >&2
exit 125
`,
        async (log) => {
          const result = await runCopyStep(
            context,
            "sha256:fixture",
            step,
            {
              containerId: "source-container",
              storage: { format: "legacy-layer", workspaceGeneration: 1 },
            },
            candidate,
          );
          expect(result).toEqual({ ok: false, reason: "daemon-unavailable" });
          if (result.ok) throw new Error("Expected copy failure");
          expect(String(await replacementCopyFailure(result.reason))).toContain(
            "ContainerLifecycleError:daemon-unavailable",
          );
          expect(await log.read()).not.toContain("version --format");
        },
      );
    });

    test(`volume step: ${message}`, async () => {
      const { context, owner } = await fixture();
      const source = planStorageSet("env-lifecycle", owner, 1, "source");
      const candidate = planStorageSet("env-lifecycle", owner, 2, "candidate");
      const step = replacementCopyPlan("volume-v1")[0]!;
      await withDockerScript(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
printf '%s\\n' '${message}' >&2
exit 125
`,
        async (log) => {
          const result = await runCopyStep(
            context,
            "sha256:fixture",
            step,
            { containerId: "source-container", storage: source },
            candidate,
          );
          expect(result).toEqual({ ok: false, reason: "daemon-unavailable" });
          if (result.ok) throw new Error("Expected copy failure");
          expect(String(await replacementCopyFailure(result.reason))).toContain(
            "ContainerLifecycleError:daemon-unavailable",
          );
          expect(await log.read()).not.toContain("version --format");
        },
      );
    });
  }

  test("a helper whose daemon answered with connection wording is not an outage", async () => {
    const { context, owner } = await fixture();
    const source = planStorageSet("env-lifecycle", owner, 1, "source");
    const candidate = planStorageSet("env-lifecycle", owner, 2, "candidate");
    const step = replacementCopyPlan("volume-v1")[0]!;
    await withDockerScript(
      `#!/bin/sh
echo 'Error waiting for container: Error response from daemon: dial tcp 10.0.0.2:5000: connect: connection refused' >&2
exit 125
`,
      async () => {
        const result = await runCopyStep(
          context,
          "sha256:fixture",
          step,
          { containerId: "source-container", storage: source },
          candidate,
        );
        expect(result.ok).toBe(false);
        expect(result).not.toEqual({ ok: false, reason: "daemon-unavailable" });
      },
    );
  });
});
