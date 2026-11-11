import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isolatedAgentTestBackend } from "./agent-test-dispatch-hold.js";
import type {
  EfficiencyEvent,
  EfficiencyPlatform,
  MultiReviewEfficiencyObserver,
} from "./multi-review-efficiency.js";

/**
 * A test-only recorder of the reviewer fan-out's peak concurrency (to-do 0027
 * task 1), so the live Multi Review scale case can show that the per-provider
 * and admission caps held, which sampling the workflow cannot: the scheduler
 * bounds concurrent operations within a pass, not reviewers whose turn is
 * running.
 *
 * A spec arms it by writing a run id into
 * `<data dir>/agent-test-fixtures/fanout-stats/record`. While that marker
 * exists, every fan-out pass's `reviewer.admission_concurrency` and
 * `reviewer.provider_concurrency` events (`review-fanout.ts`) raise the
 * maxima in `fanout-stats.json` beside it, which is rewritten atomically
 * whenever a maximum or the pass count changes. A new run id starts from
 * zero. The file holds the run id, counts and platform names only.
 *
 * It exists only where the dispatch hold does
 * (`isolatedAgentTestBackend`): an isolated agent-test backend from source.
 * Anywhere else `agentTestFanoutStats` answers `undefined` and Multi Review
 * keeps the no-op observer.
 */

export const FANOUT_STATS_FIXTURE_DIR = path.join("agent-test-fixtures", "fanout-stats");
export const FANOUT_STATS_MARKER = "record";
export const FANOUT_STATS_FILE = "fanout-stats.json";

const MAX_RUN_ID_LENGTH = 128;

export interface FanoutStatsRecord {
  runId: string;
  /** Fan-out passes seen while armed (one admission event each). */
  passes: number;
  /** Peak concurrent tasks in the admission pool within one pass. */
  maxAdmission: number;
  /** Peak concurrent tasks against each provider platform within one pass. */
  maxByPlatform: Partial<Record<EfficiencyPlatform, number>>;
  updatedAt: string;
}

export interface AgentTestFanoutStatsOptions {
  dataDir: string;
  runtimeFlavor: "production" | "development" | "agent-test" | undefined;
  env?: NodeJS.ProcessEnv;
}

/** The recorder for this backend, or `undefined` outside an isolated agent-test profile. */
export function agentTestFanoutStats(
  options: AgentTestFanoutStatsOptions,
): MultiReviewEfficiencyObserver | undefined {
  if (!isolatedAgentTestBackend(options)) return undefined;
  return createFanoutStatsRecorder(path.join(options.dataDir, FANOUT_STATS_FIXTURE_DIR));
}

/**
 * Multi Review's `efficiency` option for this backend, as `index.ts` spreads
 * it into `MultiReviewService`: the recorder in an isolated agent-test
 * profile, nothing (the no-op observer) anywhere else.
 */
export function multiReviewEfficiencyOption(options: AgentTestFanoutStatsOptions): {
  efficiency?: MultiReviewEfficiencyObserver;
} {
  const recorder = agentTestFanoutStats(options);
  return recorder ? { efficiency: recorder } : {};
}

/** The recorder itself, writing under `directory`. Exported for tests. */
export function createFanoutStatsRecorder(directory: string): MultiReviewEfficiencyObserver {
  const marker = path.join(directory, FANOUT_STATS_MARKER);
  const target = path.join(directory, FANOUT_STATS_FILE);
  let current: FanoutStatsRecord | undefined;
  let sequence = 0;

  const armedRunId = (): string | undefined => {
    if (!existsSync(marker)) return undefined;
    try {
      const runId = readFileSync(marker, "utf8").trim().slice(0, MAX_RUN_ID_LENGTH);
      return runId || "unnamed";
    } catch {
      return undefined;
    }
  };

  const write = (record: FanoutStatsRecord) => {
    // Diagnostics only: a failed write must not change the review.
    try {
      mkdirSync(directory, { recursive: true });
      const temporary = `${target}.${process.pid}.${++sequence}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, target);
    } catch {
      // The spec then fails on the missing record instead.
    }
  };

  return {
    record(event: EfficiencyEvent) {
      if (
        event.operation !== "reviewer.admission_concurrency" &&
        event.operation !== "reviewer.provider_concurrency"
      ) {
        return;
      }
      const runId = armedRunId();
      if (runId === undefined) return;
      if (current?.runId !== runId) {
        current = { runId, passes: 0, maxAdmission: 0, maxByPlatform: {}, updatedAt: "" };
      }
      const count = event.count ?? 0;
      let changed = false;
      if (event.operation === "reviewer.admission_concurrency") {
        current.passes += 1;
        changed = true;
        if (count > current.maxAdmission) current.maxAdmission = count;
      } else if (event.platform) {
        const previous = current.maxByPlatform[event.platform] ?? 0;
        if (count > previous) {
          current.maxByPlatform[event.platform] = count;
          changed = true;
        }
      }
      if (!changed) return;
      current.updatedAt = new Date().toISOString();
      write(current);
    },
  };
}
