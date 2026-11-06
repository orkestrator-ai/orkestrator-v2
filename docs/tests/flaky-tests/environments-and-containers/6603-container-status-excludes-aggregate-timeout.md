# Container status: exclude repair timed out in the aggregate suite

- **ID:** 6603
- **Status:** open
- **Previously:** 9834, renumbered on 2026-11-06 because three cases shared it ([todo 7142](../../../todo/cross-cutting/7142-red-lint-job-merged-unguarded.md))
- **Date observed:** 2026-11-05
- **Test:** `container status > repairs excludes after same-container replacement, deletion, rewrite and failed housekeeping`
- **File:** `apps/backend/src/core/commands-files-local-scan.test.ts:368`

## Failure

On arktech-mini (macOS) at `585cf97d8` plus the uncommitted worktree-probe change
(`review-worktree-fingerprint.ts`, `keyed-trailing-flight.ts`,
`commands-registry-terminal.ts`, `review-validation-worker.ts`), `mise run test`
ran the backend workspace group at four workers (`4x PARALLEL`). This test
failed with `this test timed out after 5000ms` at 5002.11 ms, and the runner
reported `killed 1 dangling process` for the file. The group finished 16,366
pass and 2 fail across 1,090 files in 385.21 s. The other failure was the known
load-dependent case
[6600](../aggregate-validation-runs/6600-live-head-preparation-owners-vary-with-load.md)
(`portable-inputs-shared-skills.test.ts`). The load average just after the run
was about 31.

## Isolated rerun

The unchanged owning file passed alone, 14 of 14, in 4.4 s:

```sh
mise run test:logged -- --name container-status -- mise exec -- bun --cwd=apps/backend test ./src/core/commands-files-local-scan.test.ts --parallel=1
```

## Notes

The test runs several real `git` commands against a temporary repository under
the default 5 s test deadline, so a loaded host can plausibly push it past the
deadline. That is not established. The change under test alters only the review
worktree probe's script and the command that runs it, and this test reaches
neither. No assertion, deadline or fixture was changed.

## Environment-deletion main merge — 2026-11-06

`mise run test:logged -- --name merge-default -- mise run test` repeated
the same case at 5000.27 ms with four isolated backend workers. The component
browser suite was also running. Evidence is
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.HtWRHT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
`mise run test:logged -- --name merge-local-scan-alone -- bun test --cwd apps/backend ./src/core/commands-files-local-scan.test.ts --parallel=1 --only-failures`
passed the complete unchanged owner with exit 0 in 9.0 s. Passing output was
removed by the logged runner; no isolated counts are inferred. No assertion,
deadline, skip or implementation changed. Cause unestablished.


## Storage/mail review recurrence — 2026-11-06

The exact recorded command, `mise run test:logged -- --name review-default-tests -- mise run test`,
recurred on the storage/mail branch (`023c7a2ce`, followed by the unchanged-test
classification rename `ee92c4741`). The workspace reserved six slots; backend
used four isolated workers alongside two web workers and the root group.
The completed backend totals were 16,613 pass, 138 skip, 4 fail and 2 errors
across 16,755 tests in 1,109 files (670.51 s execution). The full command
finished with exit 1 in 1,499.6 s; workspace and root failed, while bridges
and the protocol lockfile passed.

Evidence: `workspace-web-backend-desktop-web-public-cli-protocol-toolchain` in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.KcOGqn`;
outer wrapper `orkestrator-test-run.uRCFAT` under the same temporary root.

The exact `container status > repairs excludes after same-container replacement,
deletion, rewrite and failed housekeeping` case hit 5,002.34 ms against its
5,000 ms deadline, with one dangling fixture process cleaned up. The unchanged
complete owner passed alone, exit 0 in 5.5 s:

```sh
mise run test:logged -- --name findings-container-excludes -- bun test --cwd apps/backend ./src/core/commands-files-local-scan.test.ts --parallel=1 --only-failures
```

Passing logs were removed; isolated case counts are not inferred. No Git scan
implementation, assertion, deadline or skip changed. This establishes another
intermittent observation, not its cause or a fix.
