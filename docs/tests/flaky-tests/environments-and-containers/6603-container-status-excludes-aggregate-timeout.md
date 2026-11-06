# Container status: exclude repair timed out in the aggregate suite

- **ID:** 6603
- **Status:** open
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
