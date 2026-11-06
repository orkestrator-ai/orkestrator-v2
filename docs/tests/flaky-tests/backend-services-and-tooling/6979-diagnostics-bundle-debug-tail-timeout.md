# Diagnostics bundle debug-log tail timeout

- **ID:** 6979
- **Status:** open
- **Date observed:** 2026-11-06
- **Test:** `the manifest is what is written > only the newest debug log bytes are kept, from a line start`
- **File:** `apps/backend/src/core/diagnostics-bundle.test.ts`
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test` (previous merge round).
- **Failure:** exceeded the default 5000 ms deadline, at 5298.99 ms. Previous-round local metadata records that it also timed out alone; the original isolated command and counts were not retained there.
- **Evidence:** `/tmp/orkestrator-test-run.nqin2k/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; previous-round metadata is under Git worktree metadata, `merge-conflict-records/f366b85e80b8705e9bca63dbaebf5feb6eec8b83--295abd298b23a7ff90a2153545c76cd337d9cf33/validation.json`.

## Main comparison — 2026-11-06

The complete owner passed on clean detached `origin/main` at `c5a478f6731ee5160c2e67366d7e00fb1e6bc687`:

```sh
mise run test:logged -- --name main-diagnostics-bundle -- bun test --cwd apps/backend ./src/core/diagnostics-bundle.test.ts --parallel=1 --only-failures
```

Exit 0, 1.6 s logged. The checkout shared installed dependency directories through symlinks; tracked files were unchanged.

The merged Work panel branch (parents `fe4548807cd50b0b3cda1f2a5a7408f2c41533a3` and `c5a478f6731ee5160c2e67366d7e00fb1e6bc687`) passed the same owner with `--name branch-diagnostics-bundle`: exit 0, 1.6 s logged. Passing output was deleted by the runner; counts were not captured. The bundle implementation and owner are identical to main. This establishes intermittence on the branch; it does not reproduce the timeout on main or establish its cause. No assertion, deadline or skip changed.

## Separate PR check failures

CI run `42144144681` tested earlier branch commit `f366b85e8`:

- **Tests (root-bridges):** the DOM absence scanner failed, and `Playwright private TMPDIR wiring > e2e/playwright.config.ts: runner and worker share a directory that is removed on exit` timed out at its inner 30-second limit. The TMPDIR owner/configuration are unchanged from current main; its cause was not reproduced in this comparison.
- **bun fmt and oxlint:** format and lint passed; the separate DOM absence scanner failed. Four DOM `toBeNull` assertions introduced in `CoordinatorPanel.test.tsx` contribute a branch-specific offender. The other offenders are inherited.

The complete `tests/unit/test-diagnostic-bounds.test.ts` owner was also compared with `--parallel=1 --only-failures`: main had 15 pass / 1 fail in 4.4 s; the branch had 15 pass / 1 fail in 5.0 s. Main reports seven offending files; the branch reports those same seven plus `CoordinatorPanel.test.tsx`. These are assertion failures, not diagnostics-bundle timeouts. Artifacts: `/tmp/orkestrator-test-run.M82z9r/main-diagnostic-owner.log.gz` and `/tmp/orkestrator-test-run.3UdefE/branch-diagnostic-owner.log.gz`. The scanner findings need a separate code repair; this merge round resolves prose conflicts only.
