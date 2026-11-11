/**
 * The test-only fan-out stats recorder (to-do 0027 task 1): off outside an
 * isolated agent-test backend, and inside one it records the fan-out's peak
 * concurrency per run while its marker exists.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentTestFanoutStats,
  FANOUT_STATS_FILE,
  FANOUT_STATS_FIXTURE_DIR,
  FANOUT_STATS_MARKER,
  type FanoutStatsRecord,
} from "./agent-test-fanout-stats.js";
import {
  recordEfficiency,
  RecordingEfficiencyObserver,
  type MultiReviewEfficiencyObserver,
} from "./multi-review-efficiency.js";
import { runBoundedTasks } from "./review-fanout-scheduler.js";

const ISOLATED = { ORKESTRATOR_AGENT_TEST_ISOLATED: "1" } as NodeJS.ProcessEnv;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-fanout-stats-"));
  directories.push(directory);
  return directory;
}

async function arm(root: string, runId: string): Promise<void> {
  const directory = path.join(root, FANOUT_STATS_FIXTURE_DIR);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, FANOUT_STATS_MARKER), `${runId}\n`);
}

async function read(root: string): Promise<FanoutStatsRecord | undefined> {
  const file = path.join(root, FANOUT_STATS_FIXTURE_DIR, FANOUT_STATS_FILE);
  if (!existsSync(file)) return undefined;
  return JSON.parse(await fs.readFile(file, "utf8")) as FanoutStatsRecord;
}

function recorder(root: string): MultiReviewEfficiencyObserver {
  const created = agentTestFanoutStats({
    dataDir: root,
    runtimeFlavor: "agent-test",
    env: ISOLATED,
  });
  if (!created) throw new Error("the recorder should exist in an isolated agent-test backend");
  return created;
}

function pass(
  observer: MultiReviewEfficiencyObserver,
  admission: number,
  byPlatform: Record<string, number>,
) {
  recordEfficiency(observer, {
    owner: "multi-review",
    operation: "reviewer.admission_concurrency",
    count: admission,
  });
  for (const [platform, count] of Object.entries(byPlatform)) {
    recordEfficiency(observer, {
      owner: "multi-review",
      operation: "reviewer.provider_concurrency",
      platform: platform as never,
      count,
    });
  }
}

describe("agent-test fan-out stats", () => {
  test("is off outside an isolated agent-test backend", async () => {
    const root = await dataDir();
    expect(
      agentTestFanoutStats({ dataDir: root, runtimeFlavor: "development", env: ISOLATED }),
    ).toBeUndefined();
    expect(
      agentTestFanoutStats({ dataDir: root, runtimeFlavor: "agent-test", env: {} }),
    ).toBeUndefined();
    expect(
      agentTestFanoutStats({ dataDir: root, runtimeFlavor: "production", env: ISOLATED }),
    ).toBeUndefined();
  });

  test("records nothing until armed", async () => {
    const root = await dataDir();
    pass(recorder(root), 3, { claude: 2 });
    expect(await read(root)).toBeUndefined();
  });

  test("keeps each cap's maximum per run and starts again for a new run id", async () => {
    const root = await dataDir();
    const observer = recorder(root);
    await arm(root, "run-1");
    pass(observer, 2, { claude: 1, codex: 2 });
    pass(observer, 4, { claude: 3, grok: 1 });
    pass(observer, 1, { claude: 2 });
    expect(await read(root)).toMatchObject({
      runId: "run-1",
      passes: 3,
      maxAdmission: 4,
      maxByPlatform: { claude: 3, codex: 2, grok: 1 },
    });
    // Other operations are not this recorder's business.
    recordEfficiency(observer, { owner: "multi-review", operation: "reviewer.task", count: 99 });
    expect((await read(root))?.passes).toBe(3);

    await arm(root, "run-2");
    pass(observer, 1, { pi: 1 });
    const second = await read(root);
    expect(second).toMatchObject({ runId: "run-2", passes: 1, maxAdmission: 1 });
    expect(second?.maxByPlatform).toEqual({ pi: 1 });
    expect(JSON.stringify(second)).not.toContain(root);
  });

  test("records the scheduler's real per-platform peak, which the cap bounds", async () => {
    const root = await dataDir();
    const observer = recorder(root);
    const recording = new RecordingEfficiencyObserver();
    await arm(root, "scheduler");
    // Twelve slow tasks over three platforms against the default caps.
    const tasks = Array.from({ length: 12 }, (_, index) => ({
      pool: "observation" as const,
      group: ["claude", "codex", "cursor"][index % 3]!,
      run: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    }));
    const stats = await runBoundedTasks(tasks, { admission: 4, observation: 8, provider: 2 });
    for (const target of [observer, recording]) {
      pass(target, stats.maxActiveByPool.admission, stats.maxActiveByGroup);
    }
    const record = await read(root);
    expect(record?.maxByPlatform).toEqual({ claude: 2, codex: 2, cursor: 2 });
    expect(recording.count("reviewer.provider_concurrency")).toBe(3);
  });
});
