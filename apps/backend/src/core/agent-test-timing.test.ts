/**
 * The test-only timing overrides (to-do 7569, tasks 2, 3 and 5): off outside an
 * isolated agent-test backend; inside one they can only shorten a period,
 * and a running backend picks up a changed or removed file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_TEST_TIMING_FILE,
  agentTestTiming,
  createAgentTestTiming,
  parseTiming,
  timingValue,
} from "./agent-test-timing.js";

const ISOLATED = { ORKESTRATOR_AGENT_TEST_ISOLATED: "1" } as NodeJS.ProcessEnv;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-agent-test-timing-"));
  directories.push(directory);
  return directory;
}

async function writeTiming(root: string, content: string, mtime?: Date): Promise<string> {
  const file = path.join(root, AGENT_TEST_TIMING_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (mtime) await fs.utimes(file, mtime, mtime);
  return file;
}

describe("agentTestTiming", () => {
  test("is off outside an isolated agent-test backend", async () => {
    const root = await dataDir();
    await writeTiming(root, JSON.stringify({ containerTreeMaxAgeMs: 1_000 }));
    for (const runtimeFlavor of ["production", "development", undefined] as const) {
      expect(agentTestTiming({ dataDir: root, runtimeFlavor, env: ISOLATED })).toBeUndefined();
    }
    expect(
      agentTestTiming({ dataDir: root, runtimeFlavor: "agent-test", env: {} }),
    ).toBeUndefined();
  });

  test("reads the file in an isolated agent-test backend", async () => {
    const root = await dataDir();
    const timing = agentTestTiming({ dataDir: root, runtimeFlavor: "agent-test", env: ISOLATED });
    expect(timing).toBeDefined();
    expect(timing!.current()).toEqual({});
    await writeTiming(root, JSON.stringify({ webAnnotationGcEveryTicks: 5 }));
    expect(timing!.current()).toEqual({ webAnnotationGcEveryTicks: 5 });
  });
});

describe("createAgentTestTiming", () => {
  test("re-reads a changed file and forgets a removed one", async () => {
    const root = await dataDir();
    const timing = createAgentTestTiming(path.join(root, AGENT_TEST_TIMING_FILE));
    const file = await writeTiming(
      root,
      JSON.stringify({ containerTreeMaxAgeMs: 2_000 }),
      new Date(1_000_000),
    );
    expect(timing.current()).toEqual({ containerTreeMaxAgeMs: 2_000 });
    await writeTiming(
      root,
      JSON.stringify({ containerTreeMaxAgeMs: 3_000, webAnnotationGcEveryTicks: 2 }),
      new Date(2_000_000),
    );
    expect(timing.current()).toEqual({
      containerTreeMaxAgeMs: 3_000,
      webAnnotationGcEveryTicks: 2,
    });
    await fs.rm(file);
    expect(timing.current()).toEqual({});
  });

  test("ignores a file too large to be one a spec wrote", async () => {
    const root = await dataDir();
    const timing = createAgentTestTiming(path.join(root, AGENT_TEST_TIMING_FILE));
    await writeTiming(
      root,
      JSON.stringify({ containerTreeMaxAgeMs: 2_000, padding: "x".repeat(8 * 1024) }),
    );
    expect(timing.current()).toEqual({});
  });
});

describe("parseTiming", () => {
  test("keeps whole numbers within bounds and drops everything else", () => {
    expect(parseTiming("not json")).toEqual({});
    expect(parseTiming("[1]")).toEqual({});
    expect(parseTiming("null")).toEqual({});
    expect(
      parseTiming(
        JSON.stringify({
          containerTreeMaxAgeMs: 499,
          webAnnotationGcEveryTicks: 101,
          unknown: 5,
        }),
      ),
    ).toEqual({});
    expect(
      parseTiming(
        JSON.stringify({ containerTreeMaxAgeMs: 1_500.5, webAnnotationGcEveryTicks: "3" }),
      ),
    ).toEqual({});
    expect(
      parseTiming(JSON.stringify({ containerTreeMaxAgeMs: 500, webAnnotationGcEveryTicks: 100 })),
    ).toEqual({ containerTreeMaxAgeMs: 500, webAnnotationGcEveryTicks: 100 });
    expect(parseTiming(JSON.stringify({ coordinatorRepairIntervalMs: 999 }))).toEqual({});
    expect(parseTiming(JSON.stringify({ coordinatorRepairIntervalMs: 60_001 }))).toEqual({});
    expect(parseTiming(JSON.stringify({ coordinatorRepairIntervalMs: 5_000 }))).toEqual({
      coordinatorRepairIntervalMs: 5_000,
    });
  });
});

describe("timingValue", () => {
  test("is the fallback without an override, and never exceeds it", () => {
    expect(timingValue(undefined, "containerTreeMaxAgeMs", 10_000)).toBe(10_000);
    const fixed = (overrides: ReturnType<typeof parseTiming>) => ({ current: () => overrides });
    expect(timingValue(fixed({}), "containerTreeMaxAgeMs", 10_000)).toBe(10_000);
    expect(
      timingValue(fixed({ containerTreeMaxAgeMs: 3_000 }), "containerTreeMaxAgeMs", 10_000),
    ).toBe(3_000);
    expect(
      timingValue(fixed({ webAnnotationGcEveryTicks: 50 }), "webAnnotationGcEveryTicks", 20),
    ).toBe(20);
  });
});
