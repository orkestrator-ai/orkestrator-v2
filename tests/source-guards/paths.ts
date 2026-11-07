import path from "node:path";

/**
 * Which repository files are test sources. Kept apart from `scan.ts` so a
 * guard can ask without importing the scan, which imports every guard.
 */

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SUPPORT_NAME = /test-harness|test-support|fixture/i;
const SUPPORT_DIRECTORY = /(?:^|\/)(?:tests|testing|__tests__)\//;

/** Test files plus the modules that support them. */
export function isTestSource(relativePath: string): boolean {
  const name = path.posix.basename(relativePath);
  if (!SCRIPT_FILE.test(name) || name.endsWith(".d.ts")) return false;
  return TEST_FILE.test(name) || SUPPORT_NAME.test(name) || SUPPORT_DIRECTORY.test(relativePath);
}
