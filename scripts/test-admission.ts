import path from "node:path";
import { createHostTestScheduler } from "../packages/protocol/src/node/host-test-scheduler";
import { renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import type { CommandResult, TestGroup } from "./test-all";

/**
 * Host resource held by every group of a complete aggregate run. Groups of one
 * run share it (same admission cohort); another worktree's complete run waits
 * until none of them is running. Overlapping full suites made each slower than
 * running them back to back and pushed subprocess tests into timeouts.
 */
export const AGGREGATE_SUITE_RESOURCE = "host:aggregate-test-suite";

/**
 * Second lock for the opt-in pressure gate. A complete run that the gate admits
 * alongside the holder of {@link AGGREGATE_SUITE_RESOURCE} holds this one
 * instead, so at most two complete runs overlap: overflow runs still exclude
 * each other, exactly as primary runs do.
 */
export const AGGREGATE_SUITE_OVERFLOW_RESOURCE = "host:aggregate-test-suite-overflow";

/**
 * EXPERIMENTAL, default off, unvalidated under real concurrent runs. `1` lets a
 * complete run that is queued behind another complete run start anyway once the
 * host has been calm for a while. See the testing guide before using it.
 */
export const AGGREGATE_PRESSURE_GATE_ENV = "ORKESTRATOR_TEST_AGGREGATE_PRESSURE_GATE";
/** CPU `some avg10` (percent of time some task waited for a CPU) must stay below this. */
export const AGGREGATE_PRESSURE_MAX_ENV = "ORKESTRATOR_TEST_AGGREGATE_PRESSURE_MAX_PERCENT";
/** Calm must hold this long without a single hot or unreadable sample. */
export const AGGREGATE_PRESSURE_SETTLE_ENV = "ORKESTRATOR_TEST_AGGREGATE_PRESSURE_SETTLE_MS";
/** `MemAvailable` must be at least this percentage of `MemTotal`. */
export const AGGREGATE_PRESSURE_MIN_MEMORY_ENV =
  "ORKESTRATOR_TEST_AGGREGATE_PRESSURE_MIN_MEMORY_AVAILABLE_PERCENT";
/**
 * Default off. `1` sizes each group's reservation from what its previous
 * undisturbed runs measured (see {@link groupUsageKey}) instead of the static
 * worker plan, and lets it start on a busy host with a quarter of that.
 */
export const ADAPTIVE_RESERVATION_ENV = "ORKESTRATOR_TEST_ADAPTIVE_RESERVATION";
export const DEFAULT_AGGREGATE_PRESSURE_MAX_PERCENT = 20;
export const DEFAULT_AGGREGATE_PRESSURE_SETTLE_MS = 15_000;
export const DEFAULT_AGGREGATE_PRESSURE_MIN_MEMORY_PERCENT = 25;
/** Memory `some avg10` ceiling: stalls on memory mean the host is already short. */
export const AGGREGATE_PRESSURE_MAX_MEMORY_PERCENT = 5;

/** What the pressure gate needs to know about the host right now. */
export interface HostPressure {
  /** `/proc/pressure/cpu` `some avg10`, percent. */
  cpuSomeAvg10: number;
  /** `/proc/pressure/memory` `some avg10`, percent. */
  memorySomeAvg10: number;
  /** `MemAvailable` as a percentage of `MemTotal`. */
  memoryAvailablePercent: number;
}

/**
 * Reads Linux pressure stall information. Anything missing, unreadable or
 * malformed yields `undefined`, which the gate treats as "not calm" (fail
 * closed). `procRoot` and `platform` are injectable for tests.
 */
export function readHostPressure(
  procRoot = "/proc",
  platform: NodeJS.Platform = process.platform,
): HostPressure | undefined {
  if (platform !== "linux") return undefined;
  try {
    const some = (name: string) => {
      const match = /^some avg10=(\d+(?:\.\d+)?) /m.exec(
        readFileSync(`${procRoot}/pressure/${name}`, "utf8"),
      );
      const value = match ? Number(match[1]) : Number.NaN;
      if (!Number.isFinite(value)) throw new Error("unreadable pressure");
      return value;
    };
    const meminfo = readFileSync(`${procRoot}/meminfo`, "utf8");
    const kib = (field: string) =>
      Number(new RegExp(`^${field}:\\s+(\\d+) kB`, "m").exec(meminfo)?.[1]);
    const total = kib("MemTotal"),
      available = kib("MemAvailable");
    if (!(total > 0) || !Number.isFinite(available)) return undefined;
    return {
      cpuSomeAvg10: some("cpu"),
      memorySomeAvg10: some("memory"),
      memoryAvailablePercent: (available / total) * 100,
    };
  } catch {
    return undefined;
  }
}

/**
 * Opaque digest naming a group's identity for the host `usage` table, shared by
 * every worktree of one repository. The host's budget, tier, worker plan and
 * exact command all change how much CPU a group uses, so all of them are part
 * of it; a worktree-specific timings path is not.
 */
export function groupUsageKey(
  scope: string,
  group: Pick<TestGroup, "name" | "cwd" | "command" | "args" | "env" | "workers">,
  tier: string,
): string {
  const args = group.args.map((arg) =>
    arg.includes("orkestrator-test-timings.") ? "<timings>" : arg,
  );
  const env = Object.entries(group.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(
      JSON.stringify([
        "aggregate-group-v1",
        scope,
        tier,
        group.name,
        group.cwd ?? ".",
        group.command,
        args,
        env,
        group.workers ?? 1,
      ]),
    )
    .digest("hex");
}

/** Per-invocation projection; the host database remains admission authority. */
export function createTestAdmission(
  root: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  options: {
    clock?: () => number;
    /** Hold {@link AGGREGATE_SUITE_RESOURCE} so complete runs never overlap. */
    exclusiveSuite?: boolean;
    /** Wall clock for queue waits and group deadlines; `Date.now` by default. */
    now?: () => number;
    /** Host pressure reader for the opt-in pressure gate; the real `/proc` by default. */
    readPressure?: () => HostPressure | undefined;
    /** Identity scope for learned group CPU; the repository's Git common directory by default. */
    usageScope?: string;
  } = {},
) {
  const clock = options.clock ?? (() => performance.now());
  const now = options.now ?? (() => Date.now());
  if (env.ORKESTRATOR_TEST_PARENT_RESERVATION) {
    throw new Error(
      "Nested aggregate validation requires this exact command in .orkestrator-test-scheduler.json; no tests were started (avoided double reservation)",
    );
  }
  const inherited = env.ORKESTRATOR_VALIDATION_RESOURCES ?? "[]";
  if (inherited.length > 8192)
    throw new Error("Validation resource declarations exceed their bound");
  const resources: unknown = JSON.parse(inherited);
  if (
    !Array.isArray(resources) ||
    resources.length > 32 ||
    resources.some(
      (resource) =>
        typeof resource !== "string" ||
        !/^(\*|resource:[a-f0-9]{64}|workspace:[a-f0-9]{64}:(?:[a-f0-9]{64}|\*))$/.test(resource),
    )
  )
    throw new Error("Invalid validation resource declarations");
  // Constituents of one command may share its exclusive resources with each
  // other, but not with any other command/worktree's admission cohort.
  const cohort = randomUUID();
  const scheduler = createHostTestScheduler({
    directory: env.ORKESTRATOR_TEST_SCHEDULER_DIR,
    workers: Number(env.ORKESTRATOR_TEST_HOST_WORKERS),
    memoryMiB: Number(env.ORKESTRATOR_TEST_HOST_MEMORY_MIB),
  });
  const capacity = scheduler.capacity();
  const owner = scheduler.owner(root);
  const suiteResources = options.exclusiveSuite
    ? scheduler.resources(owner, [AGGREGATE_SUITE_RESOURCE])
    : [];
  const overflowResources = options.exclusiveSuite
    ? scheduler.resources(owner, [AGGREGATE_SUITE_OVERFLOW_RESOURCE])
    : [];
  // Experimental pressure gate: off unless explicitly enabled. Without a
  // complete-run lock there is nothing to relax.
  const gateEnabled = Boolean(options.exclusiveSuite) && env[AGGREGATE_PRESSURE_GATE_ENV] === "1";
  const nonNegative = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return env[name] !== undefined && env[name] !== "" && Number.isFinite(value) && value >= 0
      ? value
      : fallback;
  };
  const gateMaxCpu = nonNegative(
    AGGREGATE_PRESSURE_MAX_ENV,
    DEFAULT_AGGREGATE_PRESSURE_MAX_PERCENT,
  );
  const gateSettleMs = nonNegative(
    AGGREGATE_PRESSURE_SETTLE_ENV,
    DEFAULT_AGGREGATE_PRESSURE_SETTLE_MS,
  );
  const gateMinMemory = nonNegative(
    AGGREGATE_PRESSURE_MIN_MEMORY_ENV,
    DEFAULT_AGGREGATE_PRESSURE_MIN_MEMORY_PERCENT,
  );
  const readPressure = options.readPressure ?? (() => readHostPressure());
  // Run-level state shared by every group of this run: once one group's wait
  // is excused, all of them move to the overflow lock together.
  let overflow = false,
    calmSince: number | undefined,
    lastGateCheck = Number.NEGATIVE_INFINITY;
  const gateOpens = () => {
    const at = now();
    // PSI averages move over seconds; polling it per group per 100 ms is noise.
    if (at - lastGateCheck < 250) return overflow;
    lastGateCheck = at;
    let pressure: HostPressure | undefined;
    try {
      pressure = readPressure();
    } catch {
      pressure = undefined;
    }
    const calm =
      pressure !== undefined &&
      [pressure.cpuSomeAvg10, pressure.memorySomeAvg10, pressure.memoryAvailablePercent].every(
        Number.isFinite,
      ) &&
      pressure.cpuSomeAvg10 < gateMaxCpu &&
      pressure.memorySomeAvg10 < AGGREGATE_PRESSURE_MAX_MEMORY_PERCENT &&
      pressure.memoryAvailablePercent >= gateMinMemory;
    // Fail closed: one hot or unreadable sample restarts the settle window,
    // because avg10 lags the load a second concurrent run would add.
    if (!calm) calmSince = undefined;
    else calmSince ??= at;
    return calm && at - (calmSince ?? at) >= gateSettleMs;
  };
  let usageScope = options.usageScope;
  const resolveUsageScope = () => {
    if (usageScope === undefined) {
      const common = spawnSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "ignore"],
      });
      usageScope =
        common.status === 0 && common.stdout.trim()
          ? path.resolve(root, common.stdout.trim())
          : root;
      try {
        usageScope = realpathSync(usageScope);
      } catch {}
    }
    return usageScope;
  };
  const adaptiveReservation = env[ADAPTIVE_RESERVATION_ENV] === "1";
  type AdmissionJob = { state: "queued" | "running"; queueReason?: string };
  const jobs = new Map<string, AdmissionJob>();
  const channel = env.ORKESTRATOR_VALIDATION_SCHEDULER_STATE;
  const queueTimeout = Math.max(
    1000,
    Math.min(7200000, Number(env.ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS) || 1800000),
  );
  let cancelled = false,
    incomplete = false,
    sequence = 0;
  // Integrate wall time once, before every state transition. Parallel groups
  // do not multiply either deadline. Running takes precedence over queued;
  // individual tickets separately enforce their own queue wait deadline.
  let executionMs = 0,
    queuedMs = 0,
    clockAt = clock();
  const advanceClock = () => {
    const now = clock();
    const elapsed = Math.max(0, now - clockAt);
    if (Array.from(jobs.values()).some((job) => job.state === "running")) executionMs += elapsed;
    else if (jobs.size) queuedMs += elapsed;
    clockAt = now;
  };
  const settle = (id: string) => {
    advanceClock();
    jobs.delete(id);
  };
  function publish(done = false) {
    advanceClock();
    const now = Date.now();
    const running = Array.from(jobs.values()).some((job) => job.state === "running");
    const state = done ? (incomplete ? "incomplete" : "completed") : running ? "running" : "queued";
    const queueReason = done
      ? undefined
      : Array.from(jobs.values()).find((job) => job.queueReason)?.queueReason;
    if (!channel) return;
    const temp = channel + "." + process.pid + "." + ++sequence;
    writeFileSync(
      temp,
      JSON.stringify({
        version: 1,
        timing: "wall",
        pid: process.pid,
        state,
        queueReason,
        heartbeat: now,
        executionMs: Math.floor(executionMs),
        queuedMs: Math.floor(queuedMs),
      }),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temp, channel);
  }
  publish();
  const heartbeat = setInterval(() => {
    try {
      publish();
    } catch {
      cancelled = true;
    }
  }, 500);
  return {
    capacity,
    cancel() {
      cancelled = true;
    },
    async run(
      group: TestGroup,
      execute: (group: TestGroup) => Promise<CommandResult>,
    ): Promise<CommandResult> {
      let id: string | undefined;
      try {
        if (cancelled) throw new Error("Validation was cancelled before admission");
        const planned = Math.min(capacity.workers, group.workers ?? 1);
        // Opt-in: reserve what earlier undisturbed runs of this exact group
        // used, never more than the plan, with an elastic floor so a mostly
        // waiting group can start on a busy host. No history keeps the plan.
        const usageKey = groupUsageKey(
          resolveUsageScope(),
          group,
          env.ORKESTRATOR_TEST_TIER || "default",
        );
        let workers = planned,
          minWorkers: number | undefined,
          learned: number | undefined;
        if (adaptiveReservation && !group.exclusive) {
          learned = scheduler.estimateWorkers(usageKey);
          if (learned !== undefined) {
            workers = Math.max(1, Math.min(planned, learned));
            minWorkers = Math.max(1, Math.ceil(workers / 4));
          }
        }
        let ticketOverflow = overflow;
        // Memory is not elastic: the group still starts every planned Bun
        // worker however few CPU slots it learned it needs, so its memory
        // estimate stays that of the plan.
        const memoryMiB = group.exclusive
          ? capacity.memoryMiB
          : Math.min(capacity.memoryMiB, planned * 1024);
        const submit = () =>
          scheduler.enqueue({
            owner,
            cohort,
            workers,
            ...(minWorkers !== undefined ? { minWorkers } : {}),
            memoryMiB,
            resources: group.exclusive
              ? ["*"]
              : [
                  "worktree:" +
                    owner +
                    ":" +
                    group.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 70),
                  ...resources,
                  ...(ticketOverflow ? overflowResources : suiteResources),
                ],
          });
        id = submit();
        advanceClock();
        jobs.set(id, { state: "queued" });
        log(`QUEUED ${group.name}: waiting for host capacity`);
        publish();
        const queuedAt = now();
        const { deadline } = group;
        let lastReason: string | undefined;
        let granted = workers;
        while (true) {
          const status = scheduler.poll(id);
          const job = jobs.get(id)!;
          job.queueReason = status.queueReason;
          if (status.state === "running") {
            granted = status.workers;
            break;
          }
          if (status.queueReason !== lastReason) {
            lastReason = status.queueReason;
            log(`QUEUED ${group.name}: ${lastReason}`);
          }
          if (cancelled) throw new Error("Validation was cancelled while queued");
          if (deadline !== undefined && now() >= deadline)
            throw new Error(
              "Group deadline passed while waiting for host capacity; tests did not run",
            );
          if (now() - queuedAt >= queueTimeout)
            throw new Error("Host capacity wait expired; tests did not run");
          // Experimental gate: only a wait on another complete run's suite
          // lock can be excused, and only while the host has been calm. A
          // wait on any other exclusive resource (an inherited host resource,
          // a whole-host reservation) is not one the overflow lock relieves.
          if (
            gateEnabled &&
            !group.exclusive &&
            suiteResources.length > 0 &&
            !ticketOverflow &&
            (overflow ||
              (status.blockedOn.length > 0 &&
                status.blockedOn.every((resource) => suiteResources.includes(resource)) &&
                gateOpens()))
          ) {
            if (!overflow) {
              overflow = true;
              log(
                `ADMITTING ${group.name} alongside another complete run: CPU pressure stayed below ${gateMaxCpu}% (experimental ${AGGREGATE_PRESSURE_GATE_ENV})`,
              );
            }
            // Same group, same queue time, now holding the overflow lock.
            const stale = id;
            ticketOverflow = true;
            id = submit();
            scheduler.release(stale);
            settle(stale);
            advanceClock();
            jobs.set(id, { state: "queued" });
            lastReason = undefined;
            continue;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (cancelled) throw new Error("Validation was cancelled before execution");
        // The deadline covers the queue wait, so the child gets only what is
        // left of it, never a fresh full allowance.
        let timeoutMs = group.timeoutMs;
        if (deadline !== undefined) {
          const remaining = deadline - now();
          if (remaining <= 0)
            throw new Error(
              "Group deadline passed while waiting for host capacity; tests did not run",
            );
          timeoutMs = Math.min(timeoutMs ?? remaining, remaining);
        }
        if (env.ORKESTRATOR_VALIDATION_HEAD_REF) {
          const options = {
            cwd: root,
            encoding: "utf8" as const,
            timeout: 10000,
            maxBuffer: 1024 * 1024,
          };
          const head = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], options);
          if (head.status !== 0 || head.stdout.trim() !== env.ORKESTRATOR_VALIDATION_HEAD_REF)
            throw new Error(
              "Repository changed while queued; group did not run against a stale snapshot",
            );
          const status = spawnSync(
            "git",
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            options,
          );
          if (status.status !== 0)
            throw new Error(
              "Repository changed while queued; group did not run against a stale snapshot",
            );
          if (status.stdout.replaceAll("\0", "").trim())
            log("NOTE worktree is dirty while queued; continuing with recorded environment drift");
        }
        const job = jobs.get(id);
        if (job) {
          advanceClock();
          job.state = "running";
          delete job.queueReason;
        }
        publish();
        log(
          `RUNNING ${group.name} (${granted} worker slots; waited ${((now() - queuedAt) / 1000).toFixed(1)}s${learned !== undefined ? `; adaptive: learned ${learned} of ${planned} planned` : ""})`,
        );
        const ticket = id;
        const result = await execute({
          ...group,
          timeoutMs,
          measureCpu: true,
          onSpawn: (pid) => scheduler.registerChild(ticket, pid),
        });
        if (result.infrastructureError || result.timeoutReason || result.outputLimitExceeded)
          incomplete = true;
        // Learn only from an undisturbed run: a failed, cut-short or cancelled
        // group understates what a healthy one uses, and under a second the
        // sample is noise. Measurement can never change the group's verdict.
        const { cpu } = result;
        if (
          cpu &&
          cpu.spanMs >= 1000 &&
          result.status === 0 &&
          !result.infrastructureError &&
          !result.timeoutReason &&
          !result.outputLimitExceeded &&
          !cancelled
        ) {
          const observedCores = cpu.ms / cpu.spanMs;
          try {
            scheduler.recordUsage(usageKey, observedCores);
            return { ...result, observedCores, reservedSlots: granted };
          } catch {
            return result;
          }
        }
        return result;
      } catch (error) {
        incomplete = true;
        return {
          status: 75,
          infrastructureError: true,
          output: error instanceof Error ? error.message : String(error),
        };
      } finally {
        // Releasing or publishing must never replace the group's real result: a
        // failed release or artifact write is incomplete evidence, not a lost
        // run. Without this guard a throw here rejects Promise.all in runAllTests.
        try {
          if (id) {
            scheduler.release(id);
            settle(id);
          }
          publish();
        } catch {
          incomplete = true;
        }
      }
    },
    close() {
      clearInterval(heartbeat);
      try {
        try {
          publish(true);
        } catch {
          incomplete = true;
        }
      } finally {
        scheduler.close();
      }
    },
  };
}
