/**
 * The coordinator-repair job's agent-test override (to-do 7569 (retired),
 * tasks 4 and 5), driven through the real activity-job scheduler: a timing
 * file written mid-period shortens the period within a second, removing it
 * restores the production period, and without an override the job keeps its
 * interval.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_TEST_TIMING_FILE, createAgentTestTiming } from "./agent-test-timing.js";
import { BackendActivityJobs } from "./backend-activity-jobs.js";
import { coordinatorRepairJob } from "./coordinator-repair-job.js";
import { ManualTime } from "./recurring-test-support.js";

const INTERVAL_MS = 60_000;
const directories: string[] = [];
const started: BackendActivityJobs[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) jobs.stop();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function timingFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-coordinator-repair-job-"));
  directories.push(directory);
  const file = path.join(directory, AGENT_TEST_TIMING_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  return file;
}

function schedule(time: ManualTime, job: ReturnType<typeof coordinatorRepairJob>) {
  const jobs = new BackendActivityJobs([job], {
    now: time.now,
    timers: time.timerFactory,
    diagnostics: null,
  });
  started.push(jobs);
  jobs.start();
}

describe("coordinatorRepairJob", () => {
  test("without agent-test timing it runs on the production period", async () => {
    const time = new ManualTime(0);
    const runs: number[] = [];
    schedule(
      time,
      coordinatorRepairJob({
        intervalMs: INTERVAL_MS,
        timing: undefined,
        repair: async () => {
          runs.push(time.now());
        },
        onError: () => undefined,
      }),
    );
    await time.advance(180_000);
    expect(runs).toEqual([60_000, 120_000, 180_000]);
  });

  test("with agent-test timing and no override it keeps the production period", async () => {
    const time = new ManualTime(0);
    const file = await timingFile();
    const runs: number[] = [];
    schedule(
      time,
      coordinatorRepairJob({
        intervalMs: INTERVAL_MS,
        timing: createAgentTestTiming(file),
        now: time.now,
        repair: async () => {
          runs.push(time.now());
        },
        onError: () => undefined,
      }),
    );
    await time.advance(180_000);
    expect(runs).toEqual([60_000, 120_000, 180_000]);
  });

  test("an override written mid-period applies within a second, and removing it restores the period", async () => {
    const time = new ManualTime(0);
    const file = await timingFile();
    const runs: number[] = [];
    schedule(
      time,
      coordinatorRepairJob({
        intervalMs: INTERVAL_MS,
        timing: createAgentTestTiming(file),
        now: time.now,
        repair: async () => {
          runs.push(time.now());
        },
        onError: () => undefined,
      }),
    );
    // Twenty seconds into the first 60 s period, as the coordinator view
    // test arms it after login (to-do 7569 task 5): the pass already
    // scheduled does not hold the override back to 60 s.
    await time.advance(20_000);
    expect(runs).toEqual([]);
    await fs.writeFile(file, JSON.stringify({ coordinatorRepairIntervalMs: 5_000 }));
    await time.advance(1_000);
    expect(runs).toEqual([21_000]);
    await time.advance(10_000);
    expect(runs).toEqual([21_000, 26_000, 31_000]);

    await fs.rm(file);
    // A full production period after the last repair, never sooner.
    await time.advance(59_000);
    expect(runs).toHaveLength(3);
    await time.advance(1_000);
    expect(runs).toEqual([21_000, 26_000, 31_000, 91_000]);
  });

  test("an override never lengthens the period", async () => {
    const time = new ManualTime(0);
    const file = await timingFile();
    await fs.writeFile(file, JSON.stringify({ coordinatorRepairIntervalMs: 30_000 }));
    const runs: number[] = [];
    schedule(
      time,
      coordinatorRepairJob({
        intervalMs: 20_000,
        timing: createAgentTestTiming(file),
        now: time.now,
        repair: async () => {
          runs.push(time.now());
        },
        onError: () => undefined,
      }),
    );
    await time.advance(60_000);
    expect(runs).toEqual([20_000, 40_000, 60_000]);
  });

  test("with agent-test timing a wake that skips reports neither success nor failure", async () => {
    const time = new ManualTime(0);
    const file = await timingFile();
    const events: string[] = [];
    let fail = true;
    schedule(
      time,
      coordinatorRepairJob({
        intervalMs: INTERVAL_MS,
        timing: createAgentTestTiming(file),
        now: time.now,
        repair: async () => {
          if (fail) throw new Error("repair failed");
        },
        onError: () => events.push(`error@${time.now()}`),
        onSuccess: () => events.push(`success@${time.now()}`),
      }),
    );
    await time.advance(90_000);
    // The skipping wakes between 60 s and 90 s do not clear the fault.
    expect(events).toEqual(["error@60000"]);
    fail = false;
    await time.advance(30_000);
    expect(events).toEqual(["error@60000", "success@120000"]);
  });

  test("a failed pass is reported and the job keeps its cadence", async () => {
    const time = new ManualTime(0);
    const errors: unknown[] = [];
    let successes = 0;
    schedule(
      time,
      coordinatorRepairJob({
        intervalMs: INTERVAL_MS,
        timing: undefined,
        repair: async () => {
          throw new Error("repair failed");
        },
        onError: (error) => errors.push(error),
        onSuccess: () => {
          successes += 1;
        },
      }),
    );
    await time.advance(120_000);
    expect(errors).toHaveLength(2);
    expect(successes).toBe(0);
  });
});
