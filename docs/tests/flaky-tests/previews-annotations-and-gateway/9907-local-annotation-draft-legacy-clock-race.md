# Local annotation drafts: legacy payload built twice across a millisecond

- **ID:** 9907
- **Status:** resolved
- **Date observed:** 2026-11-09
- **Test:** `local annotation drafts are kept per node > the un-namespaced copy moves to the command node once`
- **File:** `apps/web/src/lib/persistence-keys.test.ts:41`

## Observation (2026-11-09)

- **Run:** CI `main` run 42594132603 (`6c0ee503a`, #1998), job
  "Tests (workspace)" 129082577001, `@orkestrator/web#test:workspace` in the
  workspace shard of the complete non-iOS suite. It was the only failing test
  in the workspace group. Observed from branch `fix-ci-main-5daa3930bd92`,
  base `448e9fffb`.
- **Failure:** `expect(received).toBe(expected)` at line 41 after 0.75 ms. The
  two legacy-draft JSON strings differed only in `updatedAt`
  (`1794216849935` expected, `1794216849934` received).
- **Isolated rerun:** the owning file passed alone, and passed
  `--rerun-each=200` before the fix.

## Resolution (2026-11-09)

- **Root cause:** a test defect. `legacyDraft()` stamps `Date.now()`, and the
  case built the stale payload twice: once to write it and once to compare.
  When a millisecond boundary fell between the two calls the strings
  differed. The product behaviour under test, that the v1 key is left as
  written, was correct.
- **Fix:** the case builds the stale payload once and compares the stored
  value with that same string. The assertion is unchanged.
- **Reproduced:** yes. A temporary preload that made `Date.now()` advance 1 ms
  per call (`bun test --preload <tmp>/tick.ts src/lib/persistence-keys.test.ts`
  from `apps/web`) failed the previous version of the file with the CI
  signature (`updatedAt` off by the ticks between the calls) and passed the
  fixed one (6 pass).
- **Stress:** `mise run test:logged -- --name persistence-keys-rerun -- bun --cwd=apps/web test src/lib/persistence-keys.test.ts --rerun-each=200`
  passed.
