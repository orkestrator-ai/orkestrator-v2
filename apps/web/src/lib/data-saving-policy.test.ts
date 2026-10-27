import { describe, expect, test } from "bun:test";
import {
  FILES_PANEL_DATA_SAVING_BACKOFF_MS,
  FILES_PANEL_DATA_SAVING_UNWATCHED_BACKOFF_MS,
  REVIEWER_DATA_SAVING_BACKOFF_MS,
} from "./data-saving-policy";
import { nativeSessionReadDemand } from "./native-session-read-policy";
import type { ReadDemand } from "./read-coordinator";
import { createFakeReadEnvironment } from "./testing/read-coordinator";

const TEN_MINUTES_MS = 600_000;

/** Reads one quiet, visible, unchanging view schedules in ten minutes. */
async function readsInTenMinutes(demand: ReadDemand, dataSaving: boolean): Promise<number> {
  const { clock, coordinator } = createFakeReadEnvironment();
  coordinator.setDataSaving(dataSaving);
  let reads = 0;
  coordinator.subscribe({
    key: { resource: "budget", target: "view" },
    read: async () => {
      reads += 1;
    },
    readOnSubscribe: false,
    demand,
  });
  await clock.advance(TEN_MINUTES_MS);
  coordinator.dispose();
  return reads;
}

// The demands the hooks build (useNativeAgentSession, useFilesPanel,
// MultiReviewReviewerTab); their own tests prove the wiring.
const SCENARIOS: Array<{ name: string; demand: ReadDemand; off: number; on: number }> = [
  {
    name: "running native view",
    demand: nativeSessionReadDemand("claude", "running", {
      active: true,
      observationEvents: true,
    }),
    off: 1_200,
    on: 600,
  },
  {
    name: "idle qualified native view",
    demand: nativeSessionReadDemand("cursor", "idle", { active: true, observationEvents: true }),
    // 1.5, 3, 5 and 10 s, then 15 s: data saving leaves it alone.
    off: 42,
    on: 42,
  },
  {
    name: "Files panel, watched worktree",
    demand: {
      intervalMs: 5_000,
      dataSaving: { quietBackoffMs: FILES_PANEL_DATA_SAVING_BACKOFF_MS },
    },
    off: 120,
    on: 22,
  },
  {
    name: "Files panel, unwatched target",
    demand: {
      intervalMs: 5_000,
      dataSaving: { quietBackoffMs: FILES_PANEL_DATA_SAVING_UNWATCHED_BACKOFF_MS },
    },
    off: 120,
    on: 60,
  },
  {
    name: "running reviewer tab",
    demand: {
      intervalMs: 4_000,
      priority: "standard",
      dataSaving: { quietBackoffMs: REVIEWER_DATA_SAVING_BACKOFF_MS },
    },
    off: 150,
    on: 22,
  },
];

describe("data-saving read budget (scheduled reads per quiet ten minutes)", () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      expect(await readsInTenMinutes(scenario.demand, false)).toBe(scenario.off);
      expect(await readsInTenMinutes(scenario.demand, true)).toBe(scenario.on);
    });
  }
});
