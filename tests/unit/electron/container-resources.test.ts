import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { parseResourceLimits } from "@orkestrator/protocol/container-resources";
import {
  parseAppliedLimits,
  parseDockerInfo,
  parseMemorySize,
  parseStatsLine,
  parseSystemDf,
  resetResourceCaches,
  resolveResourceLimits,
  resourceArguments,
  sampleContainerUsage,
} from "../../../apps/backend/src/core/container-resources";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  resetResourceCaches();
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
