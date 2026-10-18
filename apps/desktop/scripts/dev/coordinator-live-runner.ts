import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  COORDINATOR_LIVE_OPT_IN_ENV,
  COORDINATOR_LIVE_PLATFORMS_ENV,
  COORDINATOR_LIVE_SCENARIOS,
  COORDINATOR_LIVE_SCENARIOS_ENV,
  coordinatorLiveSummaryFile,
  parseCoordinatorLivePlatformSummary,
  runCoordinatorLiveSuite,
  type CoordinatorLivePlatform,
  type CoordinatorLivePlatformSummary,
  type CoordinatorLiveScenario,
  type CoordinatorLiveSuiteEntry,
} from "./coordinator-live.js";
import { coordinatorLiveRunnerTimeout } from "./coordinator-live-budgets.js";
import { runIsolatedBrowser } from "./isolated-browser.js";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");

/**
 * Points the entrypoint at another repository root, so a test can drive it
 * against a fixture without writing artifacts into this checkout.
 */
export const COORDINATOR_LIVE_ROOT_ENV = "ORKESTRATOR_AGENT_TEST_COORDINATOR_ROOT";

export interface CoordinatorLiveRunOptions {
  platforms: readonly CoordinatorLivePlatform[];
  /** Absent runs every scenario. */
  scenarios?: readonly CoordinatorLiveScenario[];
  signal: AbortSignal;
  /** The repository the profiles run in and the artifacts are written to. */
  root?: string;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  log?: (line: string) => void;
  startupTimeoutMs?: number;
  testTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

/**
 * One disposable `dev:test --fixture` profile per platform, authorized for
 * that platform's host credential alone, runs the live coordinator spec and is
 * stopped and reset afterwards. Each profile's name is also its run id
 * (`runIsolatedBrowser` sets both), which is where the spec writes the
 * platform's summary. The aggregate is written even when the run is cancelled.
 */
export async function runCoordinatorLive(options: CoordinatorLiveRunOptions): Promise<{
  exitCode: number;
  results: CoordinatorLiveSuiteEntry[];
  summaryFile: string;
}> {
  const root = options.root ?? repositoryRoot;
  const runId = options.runId ?? `qa-coordinator-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const scenarios = options.scenarios ?? COORDINATOR_LIVE_SCENARIOS;
  const testTimeoutMs =
    options.testTimeoutMs ?? coordinatorLiveRunnerTimeout(scenarios, options.env ?? process.env);
  const { exitCode, results } = await runCoordinatorLiveSuite({
    platforms: options.platforms,
    scenarios,
    signal: options.signal,
    log: options.log,
    async runPlatform(entry) {
      const profile = `qa-coordinator-${entry.platform}-${randomUUID().slice(0, 8)}`;
      let code: number | null = null;
      let error: string | undefined;
      try {
        code = await runIsolatedBrowser({
          profile,
          profileArgs: ["--credential-source", entry.platform, "--agent-platforms", entry.platform],
          suite: {
            label: `live coordinator (${entry.platform})`,
            config: "e2e/agent-testing/playwright.coordinator.config.ts",
            env: {
              [COORDINATOR_LIVE_OPT_IN_ENV]: "1",
              [COORDINATOR_LIVE_PLATFORMS_ENV]: entry.platform,
              [COORDINATOR_LIVE_SCENARIOS_ENV]: scenarios.join(","),
            },
          },
          signal: options.signal,
          root,
          ...(options.env ? { env: options.env } : {}),
          // A first run may download a toolchain the host lacks.
          startupTimeoutMs: options.startupTimeoutMs ?? 300_000,
          testTimeoutMs,
          ...(options.cleanupTimeoutMs ? { cleanupTimeoutMs: options.cleanupTimeoutMs } : {}),
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      // Read even after an error: the spec may have recorded why before the
      // profile failed underneath it.
      const summaries: Partial<
        Record<CoordinatorLiveScenario, CoordinatorLivePlatformSummary | null>
      > = {};
      for (const scenario of scenarios) {
        summaries[scenario] = parseCoordinatorLivePlatformSummary(
          await readFile(
            coordinatorLiveSummaryFile(root, profile, entry.platform, scenario),
            "utf8",
          )
            .then((text) => JSON.parse(text) as unknown)
            .catch(() => null),
        );
      }
      return { profile, exitCode: code, summaries, ...(error ? { error } : {}) };
    },
  });

  const summaryFile = path.join(root, "output", "agent-testing", runId, "summary.json");
  await mkdir(path.dirname(summaryFile), { recursive: true, mode: 0o700 });
  await writeFile(summaryFile, `${JSON.stringify({ version: 1, runId, results }, null, 2)}\n`, {
    mode: 0o600,
  });
  return { exitCode, results, summaryFile };
}
