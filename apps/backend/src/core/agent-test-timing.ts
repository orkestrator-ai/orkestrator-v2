import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isolatedAgentTestBackend } from "./agent-test-dispatch-hold.js";

/**
 * Test-only shortening of three backend periods (to-do 7569, tasks 2 to 4),
 * so a Docker fixture spec does not wait out a production period whose
 * length it is not testing:
 *
 * - `containerTreeMaxAgeMs`: how long a container's file tree is served from
 *   cache while a recent complete file list covers it
 *   (`CONTAINER_TREE_MAX_AGE_MS`, 10 s).
 * - `webAnnotationGcEveryTicks`: how many web annotation reconcile ticks (3 s
 *   each) pass between garbage-collection passes, which remove settled
 *   evidence (`WEB_ANNOTATION_GC_EVERY_TICKS`, 100).
 * - `coordinatorRepairIntervalMs`: the delay before the next coordinator
 *   repair pass, which closes delegations whose worker environment stopped
 *   (`MAINTENANCE_JOB_MS`, 60 s). It applies from the pass after the file is
 *   read, so the pass already scheduled keeps its delay.
 *
 * A spec arms them by writing `{"containerTreeMaxAgeMs": 2000}` (either key,
 * or both) to `<data dir>/agent-test-fixtures/timing.json`, and removes the
 * file to restore the production values. The file is re-read when its size
 * or modification time changes, so a running profile picks a change up on
 * the next read. A value can only shorten a period, never lengthen it, and
 * anything malformed or out of range is ignored.
 *
 * It exists only where the dispatch hold does (`isolatedAgentTestBackend`):
 * an isolated agent-test backend run from source. Anywhere else
 * {@link agentTestTiming} answers `undefined`, nothing reads the file, and
 * the production constants apply.
 */

export const AGENT_TEST_TIMING_FILE = path.join("agent-test-fixtures", "timing.json");

/** A larger file is not one a spec wrote; ignore it rather than parse it. */
const MAX_TIMING_FILE_BYTES = 4 * 1024;

/** The bounds of each override: [shortest allowed, production value]. */
export const AGENT_TEST_TIMING_BOUNDS = {
  containerTreeMaxAgeMs: [500, 10_000],
  webAnnotationGcEveryTicks: [1, 100],
  coordinatorRepairIntervalMs: [1_000, 60_000],
} as const satisfies Record<string, readonly [number, number]>;

export type AgentTestTimingKey = keyof typeof AGENT_TEST_TIMING_BOUNDS;

export type AgentTestTimingOverrides = Partial<Record<AgentTestTimingKey, number>>;

export interface AgentTestTiming {
  /** The overrides currently in the file; `{}` when there is none. */
  current(): AgentTestTimingOverrides;
}

export interface AgentTestTimingOptions {
  dataDir: string;
  runtimeFlavor: "production" | "development" | "agent-test" | undefined;
  env?: NodeJS.ProcessEnv;
}

/** The overrides for this backend, or `undefined` outside an isolated agent-test profile. */
export function agentTestTiming(options: AgentTestTimingOptions): AgentTestTiming | undefined {
  if (!isolatedAgentTestBackend(options)) return undefined;
  return createAgentTestTiming(path.join(options.dataDir, AGENT_TEST_TIMING_FILE));
}

/** Reads `file` on demand, re-parsing only when it changed. Exported for tests. */
export function createAgentTestTiming(file: string): AgentTestTiming {
  let stamp: string | null = null;
  let overrides: AgentTestTimingOverrides = {};
  return {
    current() {
      let next: string | null;
      try {
        const stats = statSync(file);
        next = stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : null;
        if (next !== null && stats.size > MAX_TIMING_FILE_BYTES) next = "too-large";
      } catch {
        next = null;
      }
      if (next === stamp) return overrides;
      stamp = next;
      overrides = next === null || next === "too-large" ? {} : parseTiming(readOrEmpty(file));
      return overrides;
    },
  };
}

function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function parseTiming(text: string): AgentTestTimingOverrides {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const overrides: AgentTestTimingOverrides = {};
  for (const key of Object.keys(AGENT_TEST_TIMING_BOUNDS) as AgentTestTimingKey[]) {
    const raw = record[key];
    const [min, max] = AGENT_TEST_TIMING_BOUNDS[key];
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max) {
      overrides[key] = raw;
    }
  }
  return overrides;
}

/**
 * `fallback`, or the override for `key` when an agent-test timing file names
 * one. Never larger than `fallback`.
 */
export function timingValue(
  timing: AgentTestTiming | undefined,
  key: AgentTestTimingKey,
  fallback: number,
): number {
  const override = timing?.current()[key];
  return override === undefined ? fallback : Math.min(override, fallback);
}
