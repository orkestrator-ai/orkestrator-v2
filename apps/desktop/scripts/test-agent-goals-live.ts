import { randomUUID } from "node:crypto";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";
import { SUPERVISED_FLAG, ownerAbortSignal, runUnderSupervisor } from "./dev/owner-supervisor.js";

/**
 * `mise run test:agent:goals [--credential-source <platform>]… [--environment local|container]`
 *
 * One disposable `dev:test --fixture` profile per platform, authorized for that
 * platform's host credential alone, runs `goals-live.spec.ts`, then is stopped
 * and reset. Real turns cost tokens, so nothing else runs this: not
 * `mise run test`, not CI, not review. A platform that fails or has no usable
 * credential is reported as such, never as passed.
 */

installFatalRejectionGuard({ label: "[goals-live]" });

const PLATFORMS = ["claude", "codex", "opencode", "cursor", "grok", "pi"] as const;
type Platform = (typeof PLATFORMS)[number];

function parseArguments(args: readonly string[]) {
  const platforms: Platform[] = [];
  let environment = "local";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--credential-source" && value) {
      if (!(PLATFORMS as readonly string[]).includes(value)) {
        throw new Error(`Unknown platform: ${value}`);
      }
      platforms.push(value as Platform);
      index += 1;
    } else if (arg === "--environment" && (value === "local" || value === "container")) {
      environment = value;
      index += 1;
    } else {
      throw new Error(
        `Unknown argument: ${arg}. Use --credential-source <platform> and --environment local|container.`,
      );
    }
  }
  return { platforms: platforms.length > 0 ? platforms : [...PLATFORMS], environment };
}

const args = process.argv.slice(2);
const supervised = args[0] === SUPERVISED_FLAG;
if (supervised) args.shift();
// Validated before anything starts, so a typo fails without a profile.
const { platforms, environment } = parseArguments(args);

if (supervised) {
  const owner = ownerAbortSignal();
  try {
    let failed = false;
    for (const platform of platforms) {
      if (owner.signal.aborted) break;
      const profile = `qa-goals-${platform}-${randomUUID().slice(0, 8)}`;
      console.log(`[goals-live] ${platform}: profile ${profile}`);
      let code: number | null = null;
      try {
        code = await runIsolatedBrowser({
          profile,
          profileArgs: [
            "--credential-source",
            platform,
            "--agent-platforms",
            platform,
            ...(environment === "container" ? ["--fixture-environments", "local,container"] : []),
          ],
          suite: {
            label: `live goals (${platform})`,
            config: "e2e/agent-testing/playwright.goals.config.ts",
            env: {
              ORKESTRATOR_AGENT_TEST_LIVE_GOALS: "1",
              ORKESTRATOR_AGENT_TEST_GOAL_PLATFORM: platform,
              ORKESTRATOR_AGENT_TEST_GOAL_ENVIRONMENT: environment,
            },
          },
          signal: owner.signal,
          // A first run may download a toolchain the host lacks.
          startupTimeoutMs: 300_000,
          testTimeoutMs: 2_700_000,
        });
      } catch (error) {
        console.error(`[goals-live] ${platform}:`, error instanceof Error ? error.message : error);
      }
      console.log(`[goals-live] ${platform}: exit ${code ?? "none"}`);
      if (code !== 0) failed = true;
    }
    process.exitCode = failed ? 1 : 0;
  } finally {
    owner.release();
  }
} else {
  process.exitCode = await runUnderSupervisor(import.meta.filename, args);
}
