# Slow-tier file scan races a concurrent `dist` rebuild

- **ID:** 9902
- **Status:** open
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
- **Hypothesis (unconfirmed):** `slowTestFiles` globs `**/*.live.test.ts`-style patterns over the whole package directory, `dist/` included. Another group of the same aggregate rebuilds `dist/artifact-runtime` at the same time, so a directory entry the scan listed is gone when it is read. The same scan also runs in the real runner (`tierArguments`), so a build racing the tier selection could fail a real run, not only this test. A fix would skip build output (`dist/`) in the scan or retry the scan on `ENOENT`; it has not been reproduced yet, so none is applied (Reproduce before fixing).
- **Branch:** `upgrade-opencode-602d9d93f8a6-r1` (OpenCode 2 work); nothing on it touches `scripts/test-tiers.ts` or `dist/artifact-runtime`.
