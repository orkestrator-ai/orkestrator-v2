/**
 * The coordinator-repair job's agent-test override (to-do 7569 (retired), task 4),
 * driven through the real activity-job scheduler: a timing file shortens the
 * delay after the next pass, removing it restores the production period, and
 * without agent-test timing the job keeps its interval.
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

  test("an override shortens the delay after the next pass, and removing it restores the period", async () => {
    const time = new ManualTime(0);
    const file = await timingFile();
    const runs: number[] = [];
    schedule(
      time,
      coordinatorRepairJob({
        intervalMs: INTERVAL_MS,
        timing: createAgentTestTiming(file),
        repair: async () => {
          runs.push(time.now());
        },
        onError: () => undefined,
      }),
    );
    // Written before the first pass: the pass already scheduled keeps its
    // 60 s delay, and every pass after it returns the shortened one.
    await fs.writeFile(file, JSON.stringify({ coordinatorRepairIntervalMs: 5_000 }));
    await time.advance(70_000);
    expect(runs).toEqual([60_000, 65_000, 70_000]);

    await fs.rm(file);
    await time.advance(5_000);
    // The 75 s pass reads no file, so the one after it is a full period away.
    expect(runs).toEqual([60_000, 65_000, 70_000, 75_000]);
    await time.advance(59_000);
    expect(runs).toHaveLength(4);
    await time.advance(1_000);
    expect(runs).toEqual([60_000, 65_000, 70_000, 75_000, 135_000]);
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
        repair: async () => {
          runs.push(time.now());
        },
        onError: () => undefined,
      }),
    );
    await time.advance(60_000);
    expect(runs).toEqual([20_000, 40_000, 60_000]);
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
