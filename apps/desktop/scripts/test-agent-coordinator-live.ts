import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import {
  COORDINATOR_LIVE_OPT_IN_ENV,
  COORDINATOR_LIVE_PLATFORMS_ENV,
  coordinatorLiveSummaryFile,
  parseCoordinatorLiveArguments,
  parseCoordinatorLivePlatformSummary,
  runCoordinatorLiveSuite,
} from "./dev/coordinator-live.js";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";

/**
 * `mise run test:agent:coordinator [--credential-source <platform>]…`
 *
 * One disposable `dev:test --fixture` profile per platform, authorized for
 * that platform's host credential alone, runs the live coordinator spec and is
 * stopped and reset afterwards. A platform without a usable credential is
 * reported as skipped by the spec, never as passed. Real turns cost tokens, so
 * nothing else runs this: not `mise run test`, not CI, not review.
 */

installFatalRejectionGuard({ label: "[coordinator-live]" });

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const { platforms } = parseCoordinatorLiveArguments(process.argv.slice(2));
const controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);

const runId = `qa-coordinator-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const { exitCode, results } = await runCoordinatorLiveSuite({
  platforms,
  signal: controller.signal,
  log: (line) => console.log(line),
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
          },
        },
        signal: controller.signal,
        // A first run may download a toolchain the host lacks.
        startupTimeoutMs: 300_000,
        testTimeoutMs: 1_200_000,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const summary = parseCoordinatorLivePlatformSummary(
      await readFile(coordinatorLiveSummaryFile(repositoryRoot, profile, entry.platform), "utf8")
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => null),
    );
    return { profile, exitCode: code, summary, ...(error ? { error } : {}) };
  },
});

const summaryFile = path.join(repositoryRoot, "output", "agent-testing", runId, "summary.json");
await mkdir(path.dirname(summaryFile), { recursive: true, mode: 0o700 });
await writeFile(summaryFile, `${JSON.stringify({ version: 1, runId, results }, null, 2)}\n`, {
  mode: 0o600,
});
console.log(`Summary: ${path.relative(repositoryRoot, summaryFile)}`);
process.exitCode = exitCode;
