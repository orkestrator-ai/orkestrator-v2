import { createHostTestScheduler } from "../packages/protocol/src/host-test-scheduler";
import { renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CommandResult, TestGroup } from "./test-all";

/** Per-invocation projection; the host database remains admission authority. */
export function createTestAdmission(
  root: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  clock: () => number = () => performance.now(),
) {
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
        const workers = Math.min(capacity.workers, group.workers ?? 1);
        id = scheduler.enqueue({
          owner,
          cohort,
          workers,
          memoryMiB: group.exclusive
            ? capacity.memoryMiB
            : Math.min(capacity.memoryMiB, workers * 1024),
          resources: group.exclusive
            ? ["*"]
            : [
                "worktree:" + owner + ":" + group.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 70),
                ...resources,
              ],
        });
        advanceClock();
        jobs.set(id, { state: "queued" });
        log(`QUEUED ${group.name}: waiting for host capacity`);
        publish();
        const queuedAt = Date.now();
        let lastReason: string | undefined;
        while (true) {
          const status = scheduler.poll(id);
          const job = jobs.get(id)!;
          job.queueReason = status.queueReason;
          if (status.state === "running") break;
          if (status.queueReason !== lastReason) {
            lastReason = status.queueReason;
            log(`QUEUED ${group.name}: ${lastReason}`);
          }
          if (cancelled) throw new Error("Validation was cancelled while queued");
          if (Date.now() - queuedAt >= queueTimeout)
            throw new Error("Host capacity wait expired; tests did not run");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (cancelled) throw new Error("Validation was cancelled before execution");
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
          `RUNNING ${group.name} (${workers} worker slots; waited ${((Date.now() - queuedAt) / 1000).toFixed(1)}s)`,
        );
        const ticket = id;
        const result = await execute({
          ...group,
          onSpawn: (pid) => scheduler.registerChild(ticket, pid),
        });
        if (result.infrastructureError || result.timeoutReason || result.outputLimitExceeded)
          incomplete = true;
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
