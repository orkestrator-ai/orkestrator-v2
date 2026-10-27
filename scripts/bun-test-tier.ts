/**
 * Runs one package's `bun test` for the tier in `ORKESTRATOR_TEST_TIER`.
 *
 * Usage, from a package script:
 *   bun ../../scripts/bun-test-tier.ts <package-dir> <path...> -- <bun test flags...>
 *
 * The package's discovery paths come before `--` so the slow tier can replace
 * them with its explicit file list. See `test-tiers.ts`.
 */
import path from "node:path";
import process from "node:process";
import { testTier, tierArguments } from "./test-tiers";

const root = path.resolve(import.meta.dir, "..");
const [packageDirectory, ...rest] = process.argv.slice(2);
const separator = rest.indexOf("--");
if (!packageDirectory || separator < 1) {
  console.error(
    "Usage: bun scripts/bun-test-tier.ts <package-dir> <path...> -- <bun test flags...>",
  );
  process.exit(2);
}
const paths = rest.slice(0, separator);
const flags = rest.slice(separator + 1);
const tier = testTier(process.env);
const selection = tierArguments(tier, root, packageDirectory, paths);
if (!selection) {
  console.log(`No ${tier}-tier tests in ${packageDirectory}.`);
  process.exit(0);
}

const child = Bun.spawn([process.execPath, "test", ...selection, ...flags], {
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});
// Turbo and the aggregate runner signal this process; pass it on so the test
// runner can clean up its own workers instead of being orphaned.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => child.kill(signal));
}
process.exitCode = await child.exited;
