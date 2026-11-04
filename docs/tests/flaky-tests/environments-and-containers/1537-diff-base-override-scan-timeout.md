# Diff-base override integration scan timeout

- **ID:** 1537
- **Status:** resolved
- **Observed:** 2026-10-31
- **Test:** `saved/reset overrides retarget real scans and reverts; replacement drops an unpushed base`
- **File:** `apps/backend/src/core/diff-base-override.integration.test.ts`

During coordinator recovery validation,
`mise run test:logged -- --name repaired-full-suite -- mise run test:full`
timed out this unchanged integration case at 30,011.70 ms against its 30,000 ms
budget. The all-tier workspace reserved four slots with two isolated workers
per package, root reserved one slot, and bridges two. Browser and Electron
validation also ran on the shared Linux host.

The complete owning file passed alone:
`mise run test:logged -- --name isolated-diff-base-existing -- bun test --cwd apps/backend ./src/core/diff-base-override.integration.test.ts --parallel=1 --only-failures`
(exit zero, 14.5 s). The logged runner removed passing raw output. Aggregate
evidence is in
`/tmp/orkestrator-test-run.eeYqDS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed after completion). Final aggregate counts are retained with that
run's artifacts.

This is an intermittent deadline miss in a real Git and scan scenario.
Shared-host contention is a hypothesis, not an established root cause. No
assertion, timeout, skip, scan implementation or owning test changed.

## Post-repair full rerun

The exact `mise run test:full` command was rerun after repairing the new PR
storage registry entry. It completed in 913.8 s including 204.5 s queued.
This unchanged owner passed in that aggregate; the backend reported 14,591
passed, 145 skipped and 31 failures confined to browser preview/rendering
owners. The first aggregate had 14,586 passed, 145 skipped and 36 failed,
including the subsequently repaired storage writer guard. Final evidence:
`/tmp/orkestrator-test-run.UVuLi8/` and
`/tmp/orkestrator-test-run.sFiOj2/`. The overall command remains non-green.

## Clean-runner observations (2026-11-03)

The test also misses its deadline on fresh GitHub runners, in the `Tests
(backend)` shard of `ci.yml` (`mise run test:full`, four-core runner). It failed
in four of the 40 most recent runs on `main` (12:03 to 22:02 UTC): `a2bba9d80`,
`b7f41b692`, `1de19cfc9` and `387d1412f`. In
[`a2bba9d80`](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727207763/job/126235023752)
it was the only failure (17,040 passed, 1 failed), at 30,000.83 ms.

The owning file passed alone at `a2bba9d80` on the Linux worktree host:
`bun test --cwd apps/backend ./src/core/diff-base-override.integration.test.ts --parallel=1`
(2 pass, 0 fail, 0.56 s).

A shared Orkestrator host is therefore not required for the miss. Why it stalls
is still unknown. The work to find out is in
[`docs/reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md`](../../../reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md).

## Root cause and fix (2026-11-04)

The stall is a wait, not CPU contention. A step report added to the test placed
every local miss in the third `readFileList` (right after `diffStats.sync`), at
about 28 s, with every other step taking milliseconds and load 4 to 5.

That read was joined to a scan of the previous target lineage
(`attemptGen` 3 against `targetGeneration` 4, already aborted, holding a pool
lease). No child process was alive. Recording each command's events showed why:
a `git` child had exited 0 in about 2 ms, but its stdout never reported `end` or
`close`, so `executeCommandBytes` waited for a `close` that did not come until
the command's own deadline (60 s for `status`, 10 s for `rev-parse`). It hit
`git status` and `git rev-parse`. The `rev-parse` sample had 0 stdout bytes from a
command that prints a commit, so the output itself was lost.

The fix is in `apps/backend/src/core/shell.ts`: a `git` command whose output has
not closed 5 s after it exits now fails, classified as timed out, rather than
waiting out its deadline. It never resolves, because empty output would read as a
clean worktree.

Reproduced with the test looping beside a continuous
`preview-runaway.test.ts` loop, both pinned to four cores of a 16-core host:

| Run | Iterations | Failures |
| --- | --- | --- |
| Before the fix | 34 and 169 | 1 and 4 |
| Watcher `close()` disabled, before the fix | 174 | 5 |
| `stopCapture()` disabled, before the fix | 169 | 4 |
| With the fix (whole owning file) | 435 | 0 |

With the fix, 22 of the 435 iterations took over 3 s (maximum 5,969 ms): the
condition still occurs, and now costs the grace instead of the deadline.

Not established: what makes the output go missing. About 810,000 spawns in
standalone scripts, using the same spawn options under the same load, with
failing siblings, stream teardown and watcher churn, lost none. Fifteen idle
iterations passed, too few to say the load is required. Local misses match CI's in
test and deadline only; a further CI miss prints its step through the report the
test keeps. The remaining work is in
[`docs/reports/ci-shard-validation/0020-git-output-lost-after-exit.md`](../../../reports/ci-shard-validation/0020-git-output-lost-after-exit.md).
