import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { parseResourceLimits } from "@orkestrator/protocol/container-resources";
import {
  environmentResourcePolicy,
  parseAppliedLimits,
  parseDockerInfo,
  parseMemorySize,
  parseStatsLine,
  parseSystemDf,
  refuseUnenforceableLimits,
  resetResourceCaches,
  resolveResourceLimits,
  resourceArguments,
  sampleContainerUsage,
  sharedMemoryMiB,
  updateEnvironmentResources,
} from "../src/core/container-resources";
import { resetDockerTopologyCache } from "../src/core/docker-image";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import type { Environment } from "../src/core/models";
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
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("resource limits", () => {
  test("validates bounds and units; null is explicitly unrestricted", () => {
    expect(parseResourceLimits({ cpus: 2.333, memoryMiB: 4096, pids: 1024 })).toEqual({
      ok: true,
      limits: { cpus: 2.33, memoryMiB: 4096, pids: 1024 },
    });
    expect(parseResourceLimits({ cpus: null })).toEqual({
      ok: true,
      limits: { cpus: null, memoryMiB: null, pids: null },
    });
    expect(parseResourceLimits({ cpus: 0 })).toMatchObject({ ok: false, field: "cpus" });
    expect(parseResourceLimits({ memoryMiB: 100 })).toMatchObject({
      ok: false,
      field: "memoryMiB",
    });
    expect(parseResourceLimits({ memoryMiB: 1024.5 })).toMatchObject({ ok: false });
    expect(parseResourceLimits({ pids: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false });
    expect(parseResourceLimits({ pids: "1024" })).toMatchObject({ ok: false, field: "pids" });
  });

  test("an environment override wins; nothing configured is unrestricted", () => {
    const global = { containerResourceLimits: { cpus: 2, memoryMiB: 4096, pids: null } };
    expect(resolveResourceLimits({}, {})).toEqual({
      limits: { cpus: null, memoryMiB: null, pids: null },
      source: "none",
    });
    expect(resolveResourceLimits({}, global).source).toBe("global");
    expect(
      resolveResourceLimits(
        { containerResourceLimits: { cpus: 1, memoryMiB: null, pids: 512 } },
        global,
      ),
    ).toEqual({ limits: { cpus: 1, memoryMiB: null, pids: 512 }, source: "environment" });
  });

  test("docker arguments disable swap by pinning it to the memory limit", () => {
    expect(resourceArguments({ cpus: 1.5, memoryMiB: 2048, pids: 512 })).toEqual([
      "--cpus",
      "1.5",
      "--memory",
      "2048m",
      "--memory-swap",
      "2048m",
      "--pids-limit",
      "512",
    ]);
    expect(resourceArguments({ cpus: null, memoryMiB: null, pids: null })).toEqual([]);
  });

  test("reads applied limits back from inspect, treating 0 and <nil> as none", () => {
    expect(parseAppliedLimits("1500000000\t2147483648\t512")).toEqual({
      cpus: 1.5,
      memoryMiB: 2048,
      pids: 512,
    });
    expect(parseAppliedLimits("0\t0\t<nil>")).toEqual({ cpus: null, memoryMiB: null, pids: null });
    expect(parseAppliedLimits("garbage")).toBeNull();
  });
});

describe("shared memory under a budget", () => {
  test("is 1 GiB without a memory limit and at most half of one", () => {
    expect(sharedMemoryMiB({ cpus: null, memoryMiB: null, pids: null })).toBe(1024);
    expect(sharedMemoryMiB({ cpus: null, memoryMiB: 8192, pids: null })).toBe(1024);
    expect(sharedMemoryMiB({ cpus: null, memoryMiB: 512, pids: null })).toBe(256);
  });
});

describe("telemetry parsing", () => {
  test("memory sizes in binary and decimal units", () => {
    expect(parseMemorySize("1.5GiB")).toBe(1.5 * 1024 ** 3);
    expect(parseMemorySize("512MiB")).toBe(512 * 1024 ** 2);
    expect(parseMemorySize("12kB")).toBe(12_000);
    expect(parseMemorySize("0B")).toBe(0);
    expect(parseMemorySize("--")).toBeNull();
  });

  test("stats keep multi-core CPU unclamped and unknown values null", () => {
    expect(
      parseStatsLine('{"ID":"abc","CPUPerc":"250.50%","MemUsage":"1.5GiB / 4GiB","PIDs":"42"}'),
    ).toEqual({
      id: "abc",
      cpuCores: 2.51,
      memoryBytes: 1.5 * 1024 ** 3,
      memoryLimitBytes: 4 * 1024 ** 3,
      pids: 42,
    });
    expect(parseStatsLine('{"ID":"abc","CPUPerc":"--","MemUsage":"-- / --","PIDs":"--"}')).toEqual({
      id: "abc",
      cpuCores: null,
      memoryBytes: null,
      memoryLimitBytes: null,
      pids: null,
    });
    expect(parseStatsLine("not json")).toBeNull();
  });

  test("capacity comes from the daemon, with support flags and rootless", () => {
    const info = parseDockerInfo(
      JSON.stringify({
        NCPU: 8,
        MemTotal: 16 * 1024 ** 3,
        OperatingSystem: "Docker Desktop",
        CgroupVersion: "2",
        CpuCfsQuota: true,
        MemoryLimit: true,
        PidsLimit: false,
        SecurityOptions: ["name=seccomp", "name=rootless"],
      }),
    );
    expect(info).toMatchObject({
      scope: "docker-daemon",
      cpus: 8,
      memoryBytes: 16 * 1024 ** 3,
      rootless: true,
      support: { cpuQuota: true, memoryLimit: true, pidsLimit: false },
    });
    expect(parseDockerInfo("")).toMatchObject({ cpus: null, memoryBytes: null });
  });

  test("disk use by kind; a missing kind stays unknown", () => {
    const disk = parseSystemDf(
      [
        '{"Type":"Images","Size":"12.5GB"}',
        '{"Type":"Containers","Size":"300MB"}',
        '{"Type":"Local Volumes","Size":"2GB"}',
      ].join("\n"),
    );
    expect(disk.imagesBytes).toBe(12_500_000_000);
    expect(disk.containersBytes).toBe(300_000_000);
    expect(disk.volumesBytes).toBe(2_000_000_000);
    expect(disk.buildCacheBytes).toBeNull();
  });
});

describe("usage sampler", () => {
  test("shares one sample between concurrent callers and scopes to this owner", async () => {
    const dir = await tempDir("ork-usage-");
    cleanup.push(dir);
    const owner = dockerOwnerNamespace(dir);
    const { context } = memoryLifecycleContext([lifecycleEnvironment()], dir);
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  ps) printf 'c1\\trunning\\tenv-a\\nc2\\texited\\tenv-b\\n' ;;
  stats) sleep 0.2; printf '{"ID":"c1","CPUPerc":"150%%","MemUsage":"1GiB / 2GiB","PIDs":"7"}\\n' ;;
  inspect) printf 'c1\\tfalse\\t0\\nc2\\ttrue\\t137\\n' ;;
esac
`,
      async (log) => {
        const [a, b] = await Promise.all([
          sampleContainerUsage(context),
          sampleContainerUsage(context),
        ]);
        expect(a).toBe(b);
        const calls = (await log.read()).split("\n").filter(Boolean);
        expect(calls.filter((call) => call.startsWith("stats")).length).toBe(1);
        expect(calls.find((call) => call.startsWith("ps"))).toContain(
          `label=orkestrator-owner=${owner}`,
        );
        // Only running containers are asked for stats.
        expect(calls.find((call) => call.startsWith("stats"))).toMatch(/ c1$/);
        expect(a.containers).toEqual([
          {
            containerId: "c1",
            environmentId: "env-a",
            state: "running",
            cpuCores: 1.5,
            memoryBytes: 1024 ** 3,
            memoryLimitBytes: 2 * 1024 ** 3,
            pids: 7,
            oomKilled: false,
            oomEvents: null,
            exitCode: null,
          },
          {
            containerId: "c2",
            environmentId: "env-b",
            state: "exited",
            cpuCores: null,
            memoryBytes: null,
            memoryLimitBytes: null,
            pids: null,
            oomKilled: true,
            oomEvents: null,
            exitCode: 137,
          },
        ]);
        expect(a.scope).toBe("installation");
        expect(a.stale).toBe(false);
      },
    );
  });

  test("an unreachable daemon reports unknown, never zero usage", async () => {
    const dir = await tempDir("ork-usage-");
    cleanup.push(dir);
    const { context } = memoryLifecycleContext([lifecycleEnvironment()], dir);
    await withDockerScript("#!/bin/sh\nexit 1\n", async () => {
      const snapshot = await sampleContainerUsage(context);
      expect(snapshot).toMatchObject({
        sampledAt: null,
        stale: true,
        containers: [],
        error: "docker-unavailable",
      });
    });
  });
});

/**
 * `docker info` of a real rootless Engine 29.9.2 (docker:dind-rootless, no
 * systemd, so cgroup driver `none`). That daemon accepted `--cpus`,
 * `--memory` and `--pids-limit`, recorded them in HostConfig and enforced
 * none of them (memory.max and pids.max stayed `max`).
 */
const ROOTLESS_NO_CGROUPS_INFO = {
  ServerVersion: "29.9.2",
  OperatingSystem: "Alpine Linux v3.24",
  NCPU: 18,
  MemTotal: 8_317_267_968,
  SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"],
  CgroupVersion: "2",
  CgroupDriver: "none",
  CpuCfsQuota: false,
  MemoryLimit: false,
  PidsLimit: false,
};

function rootlessDocker(applied = "0\t0\t<nil>"): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  info) printf '%s\\n' '${JSON.stringify(ROOTLESS_NO_CGROUPS_INFO)}' ;;
  inspect) printf '${applied}\\n' ;;
  update) exit 0 ;;
esac
exit 0
`;
}

async function rootlessFixture(overrides: Partial<Environment> = {}) {
  const dir = await tempDir("ork-rootless-");
  cleanup.push(dir);
  const built = memoryLifecycleContext([lifecycleEnvironment(overrides)], dir);
  Object.assign(built.context.storage, {
    loadConfig: async () => ({ version: "1.0.0", global: {}, repositories: {} }),
  });
  return built;
}

describe("rootless daemon without cgroup enforcement", () => {
  test("a real rootless daemon's info reports rootless and no enforceable axis", () => {
    expect(parseDockerInfo(JSON.stringify(ROOTLESS_NO_CGROUPS_INFO))).toMatchObject({
      rootless: true,
      cgroupVersion: "2",
      support: { cpuQuota: false, memoryLimit: false, pidsLimit: false },
    });
  });

  test("a budget the daemon cannot enforce is refused precisely, naming each axis", () => {
    const capacity = parseDockerInfo(JSON.stringify(ROOTLESS_NO_CGROUPS_INFO));
    expect(() =>
      refuseUnenforceableLimits(
        { cpus: 1, memoryMiB: 1024, pids: 512 },
        capacity,
        "Nothing was created.",
      ),
    ).toThrow(
      "ContainerLifecycleError:unsupported-topology: This Docker engine (rootless) cannot enforce the CPU, memory, process (PID) limits in the environment's budget. Nothing was created.",
    );
    // No budget is not refused; neither is unknown support on a rootful
    // daemon, whose read-back shows a dropped limit.
    expect(() =>
      refuseUnenforceableLimits({ cpus: null, memoryMiB: null, pids: null }, capacity, "x"),
    ).not.toThrow();
    const unknown = { cpuQuota: null, memoryLimit: null, pidsLimit: null };
    expect(() =>
      refuseUnenforceableLimits(
        { cpus: 1, memoryMiB: 1024, pids: 512 },
        { rootless: false, support: unknown },
        "x",
      ),
    ).not.toThrow();
    // A rootless daemon that did not say is refused: its read-back would lie.
    expect(() =>
      refuseUnenforceableLimits(
        { cpus: null, memoryMiB: 1024, pids: null },
        { rootless: true, support: unknown },
        "Nothing was created.",
      ),
    ).toThrow(
      "ContainerLifecycleError:daemon-unavailable: Docker runs rootless and did not report whether it can enforce the environment's budget. Nothing was created.",
    );
    // Partial delegation: only the missing controller is refused.
    expect(() =>
      refuseUnenforceableLimits(
        { cpus: 1, memoryMiB: 1024, pids: 512 },
        { rootless: true, support: { cpuQuota: false, memoryLimit: true, pidsLimit: true } },
        "x",
      ),
    ).toThrow(/cannot enforce the CPU limit in/);
  });

  for (const applyNow of [true, false]) {
    test(`an unenforceable update is refused before Docker or storage (applyNow=${applyNow})`, async () => {
      const { context, writes } = await rootlessFixture({ containerId: "c1" });
      await withDockerScript(rootlessDocker(), async (log) => {
        await expect(
          updateEnvironmentResources(
            {
              environmentId: "env-lifecycle",
              limits: { cpus: 1, memoryMiB: null, pids: 512 },
              applyNow,
            },
            context,
          ),
        ).rejects.toThrow(
          "ContainerLifecycleError:unsupported-topology: This Docker engine (rootless) cannot enforce the CPU, process (PID) limits",
        );
        expect(await log.read()).not.toMatch(/^update /m);
      });
      expect(writes).toEqual([]);
    });
  }

  for (const applyNow of [true, false]) {
    test(`failed capacity probing preserves rootless update admission (applyNow=${applyNow})`, async () => {
      const { context, writes } = await rootlessFixture({ containerId: "c1" });
      await withDockerScript(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  info)
    [ "$3" = "{{json .}}" ] && exit 1
    printf '%s\\n' '{"SecurityOptions":["name=rootless"]}' ;;
esac
exit 0
`,
        async (log) => {
          await expect(
            updateEnvironmentResources(
              {
                environmentId: "env-lifecycle",
                limits: { cpus: 1, memoryMiB: null, pids: null },
                applyNow,
              },
              context,
            ),
          ).rejects.toThrow("ContainerLifecycleError:daemon-unavailable: Docker runs rootless");
          expect(await log.read()).not.toMatch(/^update /m);
          expect(writes).toEqual([]);
        },
      );
    });
  }

  test("a runtime carrying limits the daemon records but does not enforce is flagged", async () => {
    const { context } = await rootlessFixture({ containerId: "c1" });
    await withDockerScript(rootlessDocker("1000000000\t536870912\t256"), async () => {
      const policy = await environmentResourcePolicy("env-lifecycle", context);
      expect(policy.requested).toEqual({ cpus: null, memoryMiB: null, pids: null });
      expect(policy.applied).toEqual({ cpus: 1, memoryMiB: 512, pids: 256 });
      expect(policy.unsupported).toEqual(["cpus", "memoryMiB", "pids"]);
      expect(policy.daemonRootless).toBe(true);
    });
  });
});
