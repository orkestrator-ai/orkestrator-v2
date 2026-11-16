/**
 * Runs one package's `bun test` for the tier in `ORKESTRATOR_TEST_TIER`.
 *
 * Usage, from a package script:
 *   bun --no-env-file ../../scripts/bun-test-tier.ts <package-dir> <path...> -- <bun test flags...>
 *
 * The package's discovery paths come before `--` so the slow tier can replace
 * them with its explicit file list. See `test-tiers.ts`.
 * Start this wrapper with --no-env-file: only the child `bun test` should load
 * dotenv files, after Bun has selected the test environment.
 */
import path from "node:path";
import process from "node:process";
import { forwardWithDotLines, withProgressDots } from "./test-progress-dots";
import { testTier, tierArguments } from "./test-tiers";

const root = path.resolve(import.meta.dir, "..");
const [packageDirectory, ...rest] = process.argv.slice(2);
const separator = rest.indexOf("--");
if (!packageDirectory || separator < 1) {
  console.error(
    "Usage: bun --no-env-file scripts/bun-test-tier.ts <package-dir> <path...> -- <bun test flags...>",
  );
  process.exit(2);
}
const paths = rest.slice(0, separator);
// A run that hides passing tests reports each finished one as a dot, so the
// aggregate's no-output watchdog follows real progress (test-progress-dots.ts).
const flags = withProgressDots(rest.slice(separator + 1));
const tier = testTier(process.env);
const selection = tierArguments(tier, root, packageDirectory, paths);
if (!selection) {
  console.log(`No ${tier}-tier tests in ${packageDirectory}.`);
  process.exit(0);
}

// Turbo and the aggregate runner signal this process; pass it on so the test
// runner can clean up its own workers instead of being orphaned. The handlers
// exist before the child does (AGENTS.md invariant 16): a signal that reached
// this script first would otherwise kill it with the default action and leave
// the child running unsignalled (flake 9945).
let child: { kill(signal: NodeJS.Signals): void } | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (child) child.kill(signal);
    else process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal]);
  });
}
// Bun's reporter writes to stderr; it is piped only to close each run of
// progress dots with a newline for Turbo's line-at-a-time output.
const spawned = Bun.spawn([process.execPath, "test", ...selection, ...flags], {
  stdio: ["inherit", "inherit", "pipe"],
  env: process.env,
});
child = spawned;
const drain = new AbortController();
const forwarded = forwardWithDotLines(
  spawned.stderr,
  (text) => process.stderr.write(text),
  drain.signal,
);
// Observe forwarding errors immediately, while the test runner is still alive.
void forwarded.catch(() => {});
const status = await spawned.exited;
child = undefined;
// A descendant may keep its inherited stderr open after bun test exits. Give
// buffered diagnostics time to drain, then release our reader regardless of EOF.
const drainTimer = setTimeout(() => drain.abort(), 250);
try {
  await forwarded;
} finally {
  clearTimeout(drainTimer);
}
process.exitCode = status;
