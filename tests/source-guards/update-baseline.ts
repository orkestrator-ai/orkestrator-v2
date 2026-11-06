/**
 * Regenerates tests/source-guards/baseline.json from the current tree:
 *
 *   bun tests/source-guards/update-baseline.ts
 *
 * The output is deterministic (guards in declaration order, files sorted), so
 * running it twice on the same tree writes the same bytes. A baseline entry
 * should only ever go down; review any increase as a new offender.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { BASELINE_PATH, baselineFromFindings, serializeBaseline } from "./baseline";
import { GUARD_IDS } from "./guard";
import { scanRepository } from "./scan";

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "../..");
  const started = performance.now();
  const baseline = baselineFromFindings(scanRepository(root));
  const elapsed = performance.now() - started;
  writeFileSync(BASELINE_PATH, serializeBaseline(baseline));
  for (const guard of GUARD_IDS) {
    const counts = Object.values(baseline[guard]);
    const total = counts.reduce((sum, count) => sum + count, 0);
    console.log(`${guard}: ${counts.length} file(s), ${total} finding(s)`);
  }
  console.log(`Wrote ${path.relative(root, BASELINE_PATH)} (scan ${Math.round(elapsed)} ms).`);
}
