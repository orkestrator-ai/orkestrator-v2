/**
 * Reads the fuses and asar layout of the locally built shipping package and
 * fails unless they match security report L3 (`scripts/packaged-security.ts`).
 * Prints one line per check and writes the same, content-free, to
 * `output/package-security/<platform>-<arch>.json`.
 *
 *   bun scripts/verify-packaged-security.ts [--executable <path>]
 *
 * `ORKESTRATOR_SHIPPED_APP_EXECUTABLE` overrides the executable as well, the
 * same variable the shipping security spec reads. Run by
 * `mise run test:package:security` after an unsigned `--dir` build.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { shippingPackage, verifyShippingPackage } from "./packaged-security";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const flag = process.argv.indexOf("--executable");
const override =
  (flag === -1 ? undefined : process.argv[flag + 1]) ||
  process.env.ORKESTRATOR_SHIPPED_APP_EXECUTABLE?.trim() ||
  undefined;

const pkg = shippingPackage(repositoryRoot, process.platform, process.arch, override);
const report = await verifyShippingPackage(pkg);

console.log(`Shipping package: ${path.relative(repositoryRoot, pkg.executable)}`);
for (const check of report.checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.check}: ${check.detail}`);
}
const reportFile = path.join(
  repositoryRoot,
  "output/package-security",
  `${process.platform}-${process.arch}.json`,
);
await mkdir(path.dirname(reportFile), { recursive: true });
await writeFile(
  reportFile,
  `${JSON.stringify(
    {
      executable: path.relative(repositoryRoot, pkg.executable),
      checkedAt: new Date().toISOString(),
      ...report,
    },
    null,
    2,
  )}\n`,
);
console.log(`Report: ${path.relative(repositoryRoot, reportFile)}`);
if (!report.passed) {
  console.error("The shipping package does not have the fuses security report L3 requires");
  process.exit(1);
}
