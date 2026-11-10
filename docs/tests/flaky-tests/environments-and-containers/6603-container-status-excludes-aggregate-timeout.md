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

## Transcript restoration review — 2026-11-06

The default reruns repeated the same case at 5,005.77 ms and 5,002.11 ms.
Evidence is in `orkestrator-test-run.PCIx5Q` and `orkestrator-test-run.IKjOmZ`
workspace logs under the host temporary directory (compressed on finalization).
`mise run test:logged -- --name repair-local-scan-alone -- bun test --cwd apps/backend ./src/core/commands-files-local-scan.test.ts --parallel=1 --only-failures`
passed the entire unchanged owner, exit 0, in 8.3 s. Passing output was deleted;
no counts are inferred. The cause remains unestablished. No assertion, deadline,
skip or implementation changed.

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

## Worktree-watcher review recurrence — 2026-11-10

Observed in `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-full-final -- mise run test` at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`, base `08d3da4a23cfe2ecc34fba663ca27e765f7924a9`, macOS arm64/Bun 1.4.4. The workspace reserved six slots (web two, backend four), root one, bridges two and protocol one. The aggregate exited 1 after 2468.77 s; backend has no final counts because the workspace no-progress watchdog fired. Root reported 4274 pass/25 skip/4 fail; web 14336 pass/10 skip/2 fail; Pi 706 pass/1 skip/2 fail.

- `apps/backend/src/core/commands-files-local-scan.test.ts` — `container status > repairs excludes after same-container replacement, deletion, rewrite and failed housekeeping`: Test deadline 30,000 ms exceeded. Observed 30002.16ms. Complete unchanged owner: 10 pass, 0 fail, 0 skip in 13.38 s at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.

```sh
mise run test:logged -- --name watcher-triage-local-scan -- bun test --cwd apps/backend ./src/core/commands-files-local-scan.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/local-scan.xml
```

`mise run flaky:recurrence -- 6603 --base 08d3da4a23cfe2ecc34fba663ca27e765f7924a9 --registry-ref origin/main` found the resolution commit `ee2cc84234` in the base. Reopen the case: the current deadline is already 30 s, and this recurrence does not justify another budget increase.

Evidence: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dH765N/` (compressed group logs); JUnit under `/private/tmp/ork-watcher-failure-triage.0oarZv/`. [The complete report](../../../development/worktree-watcher-validation.md) contains the exact group outcomes, commands and non-green isolated owners. Passing alone establishes intermittence, not a cause or a fix. No related assertion, timeout, skip or implementation changed.
