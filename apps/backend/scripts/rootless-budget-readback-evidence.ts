import { randomBytes } from "node:crypto";
import { cleanupEvidenceContainers } from "./rootless-budget-evidence-cleanup.js";
import type { ContainerResourceLimits } from "@orkestrator/protocol/container-resources";
import { CONTAINER_HOST_PROBE_IMAGE } from "../src/core/container-host-reachability.js";
import {
  dockerAdmissionCapacity,
  environmentResourcePolicy,
  inspectAppliedLimits,
  refuseUnenforceableLimits,
  resolveResourceLimits,
  resourceArguments,
} from "../src/core/container-resources.js";
import type { CommandContext } from "../src/core/commands-context.js";
import type { Environment } from "../src/core/models.js";
import { runCommand } from "../src/core/shell.js";

/**
 * Live evidence for to-do 0019 task 2: does the budget read-back stay
 * truthful on a rootless daemon whose user is delegated only some cgroup
 * controllers (for example `memory pids` without `cpu`)?
 *
 *   DOCKER_HOST=unix:///.../docker.sock bun apps/backend/scripts/rootless-budget-readback-evidence.ts
 *
 * It reads the daemon's capacity through the production
 * `dockerAdmissionCapacity`, resolves the built-in default with
 * `resolveResourceLimits`, asks `refuseUnenforceableLimits` about explicit
 * budgets, and then compares what Docker reports with what the kernel does:
 * a busybox container created with the production `resourceArguments`, its
 * `docker inspect` read-back (`inspectAppliedLimits`, then
 * `environmentResourcePolicy` over a stub storage holding one environment),
 * the cgroup files it sees, and three enforcement probes (a memory
 * allocation past the limit, the CPU time a busy loop gets, and forks past
 * the PID limit). Finally it asks Docker directly for a CPU limit, bypassing
 * the admission check, to record what Docker does with it.
 *
 * Every container carries a unique per-run `orkestrator-s0019-budget-evidence`
 * label and cleanup discovers and removes its containers, including failed starts.
 * Nothing is pulled: pull the pinned busybox
 * (`CONTAINER_HOST_PROBE_IMAGE`) into the daemon first. It never reads the
 * real data directory, binds no port and needs no login.
 */

const EVIDENCE_LABEL = `orkestrator-s0019-budget-evidence=${randomBytes(16).toString("hex")}`;

interface DockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function docker(args: string[], timeoutMs = 60_000): Promise<DockerResult> {
  try {
    const { stdout, stderr } = await runCommand("docker", args, { timeoutMs });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const details = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      ok: false,
      stdout: typeof details.stdout === "string" ? details.stdout.trim() : "",
      stderr:
        typeof details.stderr === "string" && details.stderr.trim()
          ? details.stderr.trim()
          : String(details.message ?? error),
    };
  }
}

function refusal(
  limits: ContainerResourceLimits,
  capacity: Parameters<typeof refuseUnenforceableLimits>[1],
) {
  try {
    refuseUnenforceableLimits(limits, capacity, "(evidence)");
    return { limits, refused: false as const };
  } catch (error) {
    return { limits, refused: true as const, message: (error as Error).message };
  }
}

const result: Record<string, unknown> = {};

/** A container with the production budget arguments, or Docker's refusal of them. */
async function createLimited(limits: ContainerResourceLimits, init = true) {
  const run = await docker([
    "run",
    "--detach",
    "--pull",
    "never",
    "--label",
    EVIDENCE_LABEL,
    ...resourceArguments(limits),
    // An init reaps the PID probe's orphaned sleepers; busybox sleep would not.
    ...(init ? ["--init"] : []),
    "--entrypoint",
    "sleep",
    CONTAINER_HOST_PROBE_IMAGE,
    "600",
  ]);
  if (!run.ok) return { limits, id: null, dockerError: run.stderr };
  const id = run.stdout.split("\n").at(-1)!;
  const cgroup = await docker([
    "exec",
    id,
    "sh",
    "-c",
    "cat /sys/fs/cgroup/cgroup.controllers; for f in cpu.max memory.max memory.swap.max pids.max; do " +
      'if [ -e /sys/fs/cgroup/$f ]; then echo "$f=$(cat /sys/fs/cgroup/$f)"; else echo "$f=(absent)"; fi; done',
  ]);
  const [controllers = "", ...files] = cgroup.stdout.split("\n");
  return {
    limits,
    id,
    dockerWarnings: run.stderr || null,
    readBack: await inspectAppliedLimits(id),
    cgroupControllers: controllers,
    cgroupFiles: Object.fromEntries(files.map((line) => line.split("=") as [string, string])),
  };
}

/** The read-back an environment holding this runtime would show in Settings. */
async function policyFor(containerId: string, requested: ContainerResourceLimits) {
  const environment = {
    id: `s0019-evidence-${randomBytes(3).toString("hex")}`,
    environmentType: "containerized",
    containerId,
    containerResourceLimits: requested,
  } as unknown as Environment;
  const context = {
    storage: {
      getEnvironment: async () => environment,
      loadConfig: async () => ({ global: {} }),
    },
  } as unknown as Pick<CommandContext, "storage">;
  return environmentResourcePolicy(environment.id, context);
}

/**
 * Memory, CPU and PID behaviour under `limits`: CPU and PIDs in container
 * `id`, memory in a second container with the same limits and no init (with
 * an init, the out-of-memory kill stopped the whole container).
 */
async function enforcement(id: string, limits: ContainerResourceLimits) {
  const memoryProbe = await createLimited(limits, false);
  if (!memoryProbe.id) throw new Error(`memory probe container: ${memoryProbe.dockerError}`);
  // Memory: hold about 100 MiB in a shell variable under a 64 MiB limit.
  const memory = await docker(
    [
      "exec",
      memoryProbe.id,
      "sh",
      "-c",
      "x=$(head -c 104857600 /dev/zero | tr '\\0' a); echo held ${#x}",
    ],
    60_000,
  );
  const memoryEvents = await docker([
    "exec",
    memoryProbe.id,
    "cat",
    "/sys/fs/cgroup/memory.events",
  ]);
  // CPU: the CPU time a busy loop gets in 3 s of wall time.
  const busy = await docker(
    [
      "exec",
      id,
      "sh",
      "-c",
      "grep usage_usec /sys/fs/cgroup/cpu.stat; timeout 3 sh -c 'while :; do :; done'; grep usage_usec /sys/fs/cgroup/cpu.stat",
    ],
    30_000,
  );
  // PIDs: 40 short sleepers under a limit of 32. busybox sh stops at the
  // first fork the kernel refuses, and an exec needs a free PID too, so the
  // counters are read once the sleepers have exited and the init reaped them.
  const pids = await docker(
    ["exec", id, "sh", "-c", "for i in $(seq 1 40); do sleep 5 & done; echo started all 40"],
    60_000,
  );
  await Bun.sleep(7_000);
  const pidCounters = await docker([
    "exec",
    id,
    "sh",
    "-c",
    "echo current=$(cat /sys/fs/cgroup/pids.current) peak=$(cat /sys/fs/cgroup/pids.peak 2>/dev/null) $(cat /sys/fs/cgroup/pids.events)",
  ]);
  return {
    memory: {
      ok: memory.ok,
      stdout: memory.stdout,
      stderr: memory.stderr.split("\n").at(-1)?.slice(0, 300) ?? "",
      events: memoryEvents.stdout.split("\n").join(", ") || memoryEvents.stderr,
    },
    cpuBusyLoop: { ok: busy.ok, usage: busy.stdout.split("\n"), stderr: busy.stderr.slice(0, 300) },
    pids: {
      ok: pids.ok,
      stdout: pids.stdout,
      stderr: pids.stderr.split("\n").at(-1)?.slice(0, 300) ?? "",
      counters: pidCounters.stdout || pidCounters.stderr,
    },
  };
}

try {
  result.dockerServer = (
    await docker(["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"])
  ).stdout;
  const warnings = await docker(["info", "--format", "{{json .Warnings}}"]);
  result.dockerWarnings = warnings.ok ? JSON.parse(warnings.stdout) : warnings.stderr;

  const capacity = await dockerAdmissionCapacity();
  result.capacity = {
    rootless: capacity.rootless,
    cgroupVersion: capacity.cgroupVersion,
    support: capacity.support,
    builtInDefault: capacity.builtInDefault,
  };
  result.resolvedDefault = resolveResourceLimits(
    { containerResourceLimits: undefined },
    { containerResourceLimits: undefined },
    capacity,
  );
  const memoryAndPids: ContainerResourceLimits = { cpus: null, memoryMiB: 64, pids: 32 };
  const withCpu: ContainerResourceLimits = { cpus: 0.5, memoryMiB: 64, pids: 32 };
  result.admission = {
    memoryAndPids: refusal(memoryAndPids, capacity),
    withCpu: refusal(withCpu, capacity),
  };

  // The budget the backend would create with, its read-back and what the kernel does.
  const allowed = await createLimited(memoryAndPids);
  result.memoryAndPidsContainer = { ...allowed, id: allowed.id?.slice(0, 12) ?? null };
  if (allowed.id) {
    result.memoryAndPidsPolicy = await policyFor(allowed.id, memoryAndPids);
    result.enforcement = await enforcement(allowed.id, memoryAndPids);
  }

  // What Docker does with a CPU limit, bypassing the admission check.
  const cpu = await createLimited(withCpu);
  result.withCpuContainer = { ...cpu, id: cpu.id?.slice(0, 12) ?? null };
  if (cpu.id) {
    result.withCpuPolicy = await policyFor(cpu.id, withCpu);
    result.withCpuEnforcement = await enforcement(cpu.id, withCpu);
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  const cleanup = await cleanupEvidenceContainers(docker, EVIDENCE_LABEL);
  Object.assign(result, cleanup);
  if (cleanup.unresolvedCleanup.length || cleanup.leftovers || "cleanupError" in cleanup) {
    process.exitCode = 1;
  }
}
console.log(JSON.stringify(result, null, 2));
