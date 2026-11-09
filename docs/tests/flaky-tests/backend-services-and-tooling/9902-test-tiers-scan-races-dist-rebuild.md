# Slow-tier file scan races a concurrent `dist` rebuild

- **ID:** 9902
- **Status:** resolved
- **Date observed:** 2026-11-09
- **Base commit:** `30bce689555ce4f62e473d19e196d912535d3d04`
- **Observed head:** `5d0953cdbc2a72f561ee7693c5616c0acf7e2cec`
- **Test:** `test tier selection > real-time proxy deadline files run only in the slow tier`
- **File:** `tests/unit/test-tiers.test.ts` (helper `slowTestFiles` in `scripts/test-tiers.ts`)
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`
- **Worker configuration:** default concurrent aggregate (workspace, root, bridge and protocol groups at once; root group with its planned worker pool).
- **Failure:** `ENOENT: no such file or directory, open 'dist/artifact-runtime/worker-context/licenses/dompurify@3.4.17'` thrown from `slowTestFiles` (`scripts/test-tiers.ts:184`, the `Bun.Glob(pattern).scanSync` loop) via `tierArguments`, at 2.6 ms. Root group failed; every other group passed.
- **Suite counts:** root and agent-support group: one failure; workspace, bridges and codex protocol lockfile groups passed.
- **Isolated rerun:** `bun test ./tests/unit/test-tiers.test.ts` passed 15/15, three times in a row.
- **Hypothesis (confirmed):** `slowTestFiles` globbed `**/*.live.test.ts`-style patterns over the whole package directory, `dist/` included, while another group of the same aggregate rebuilt `dist/artifact-runtime`. The same scan runs in the real runner (`tierArguments`), so a build racing the tier selection could fail a real run, not only this test.
- **Reproduction (2026-11-09, before any fix):** a scratch script ran `slowTestFiles(root, "apps/backend")` in a loop over a temporary package while a child process repeatedly created 40 `dist/artifact-runtime/worker-context/licenses/<name>@<version>/LICENSE` directories and deleted `dist/`. 2,809 of 3,365 scans in 4 s threw `ENOENT: no such file or directory, open 'dist/artifact-runtime/worker-context/licenses/pkg15@1.0'`, the same shape as the aggregate failure. `Bun.Glob.scanSync` opens each directory it listed to descend into it, and throws when that directory has gone. An unreadable `dist/` directory made the old scan throw `EACCES` the same way, deterministically.
- **Root cause:** the slow-tier scan descended into build output. `Bun.Glob.scanSync` has no way to exclude a directory (the old `node_modules` filter ran on results, after the walk), and it does not tolerate an entry vanishing between being listed and being opened.
- **Fix:** `slowTestFiles` (`scripts/test-tiers.ts`) now walks only each pattern's static prefix itself, never enters `node_modules/`, `dist/` or hidden directories, drops an entry that disappears mid-walk (`ENOENT`/`ENOTDIR`), matches candidates with `Bun.Glob.match`, and checks literal entries with one `stat`. The selection over this repository is byte-identical before and after (every package in `SLOW_TESTS`, compared as JSON). `tests/unit/test-tiers.test.ts` pins the exclusions with an unreadable `dist/`; the new slow-tier file `tests/unit/test-tiers-scan-race.test.ts` is the reproduction: it races the scan against a real process rebuilding `dist/` for 300 cycles.
- **Verification:** the race test fails against the pre-fix `scripts/test-tiers.ts` (ENOENT on `dist/artifact-runtime/worker-context/licenses/dependency19@1.0`) and passes with the fix. `mise run test:logged -- --name tier-race-stress -- bun test ./tests/unit/test-tiers-scan-race.test.ts --rerun-each=20` passed (20 races, 50.7 s); `mise run test:logged -- --name test-tiers-stress -- bun test ./tests/unit/test-tiers.test.ts --rerun-each=20` passed. The scratch race script ran five more 4 s races with the fix: 0 failures in about 43,000 scans.
- **Branch:** `upgrade-opencode-602d9d93f8a6-r1` (OpenCode 2 work); nothing on it touches `scripts/test-tiers.ts` or `dist/artifact-runtime`.
