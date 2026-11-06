# Container status: exclude repair timed out in the aggregate suite

- **ID:** 6603
- **Status:** resolved
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

### Resolution — 2026-11-06

- **Root cause:** a budget mismatch with real subprocess work, not a logic
  race. The test runs two repository inits and seven container status scans.
  Each scan is a real `bash` status script of about fifteen `git` and
  coreutils processes. On this Linux host the scans took 160–180 ms each at
  load average 22, and the test took 1.45 s idle, already 30% of Bun's
  generic five-second deadline. Process start-up costs more on macOS, so a
  saturated macOS aggregate (load about 31) pushed the test past five
  seconds. Bun then killed the running `git`/`bash` child, which is the
  recorded "killed 1 dangling process".
- **Fix:** `apps/backend/src/core/commands-files-local-scan.test.ts` sets an
  explicit 30 s file budget with `setDefaultTimeout`, as the sibling real-Git
  owners do (`diff-stats-tracking.test.ts`,
  `commands-environment-worktree-location.test.ts`). Every case in the file
  drives real Git. No assertion changed.
- **Reproduction:** the unchanged file with `--timeout 1000` on the loaded
  host failed this case with "this test timed out after 1000ms" and "killed 1
  dangling process", the recorded signature at a shortened deadline. The
  five-second deadline was not reached on Linux.
- **Verification:** `mise run test:logged -- --name env-local-scan-stress --
  bun --cwd=apps/backend test ./src/core/commands-files-local-scan.test.ts
  --parallel=4 --rerun-each=20`: PASS in 51.9 s on the shared host at load
  average 20–30.
