# E8 recorded backend failures

- **ID:** 4843
- **Status:** open
- **Observed:** 2026-11-05

Preparation's `mise run test` at cd5b0142 reported:

- `runCommand > preserves timeout and termination signal as structured failure metadata` (`apps/backend/tests/shell.test.ts`): expected SIGTERM, got null, 142.60 ms.
- `Electron backend command registry > gives an image without the helper the token-bearing rewrite, idempotently` (`apps/backend/tests/commands-container-exec.test.ts`): exceeded 5000 ms, 5005.07 ms.
- `LoopbackListenerOwnership on this host > attributes a real 127.0.0.1 listener and refuses another environment` (`apps/backend/src/core/preview-listener-ownership.test.ts`): expected true, got false, 5496.98 ms.

The complete owners passed with one worker (each file isolated by Bun):

```sh
mise run test:logged -- --name recorded-backend-failures -- bun --cwd=apps/backend test tests/shell.test.ts tests/claude-state-signal-integration.test.ts tests/commands-container-exec.test.ts src/core/preview-listener-ownership.test.ts --parallel=1 --only-failures
```

Result: pass, 6.1 seconds. The fourth file's recurrence is recorded in case 1102. Passing output was removed by the logged runner; it reported 1379 output bytes without test totals. The original aggregate has ten named failures plus between-test errors, with no reliable combined total. Original diagnostics are preserved at `.orkestrator/review-artifacts/review-validation-6e251f8d-c76b-469b-b389-d7b80e76ea49/validation-04.stdout.txt`. Worker counts were selected by the aggregate scheduler. No assertions, deadlines or skips changed. Load sensitivity is plausible, but no root cause is established.

## 2026-11-06 recurrence: credential helper after setup

Preparation at c8d754a1941b0e9162020adbadd370f03165462a ran
`mise run test:logged -- --name review-default-tests -- mise run test` with
scheduler-selected workers. `Electron backend command registry > GitHub
credential helper > keeps working after setup clears credential.helper, on
either order` exceeded 5000 ms (5021.72 ms); its synchronous Bash child returned
null status. Diagnostics are preserved in
`.orkestrator/review-artifacts/review-validation-c3a6efad-888c-4081-b04f-447d7bee2f9c/validation-04.stderr.txt`,
lines 136–158. The aggregate has no reliable complete summary and reports
between-test errors.

The complete owner passed in isolation:
`mise run test:logged -- --name recorded-container-exec -- bun test --cwd apps/backend ./tests/commands-container-exec.test.ts --parallel=1 --only-failures`
(exit 0, 3.0 s, 807 output bytes; passing output removed by the logged runner).
The credential helper and owning test have no branch diff against origin/main;
the triage's related classification comes through the command registry's import
of environment-cleanup-reconciler.ts, not the helper exercised by this test.
No assertion or deadline changed. The cause remains unestablished; this is
recorded as a recurrence, not an implementation fix or a green aggregate.

## 2026-11-06 main and branch comparison: credential helper

Verify for the environment-deletion branch blocked on the recurrence above, so
the case was run alone on a detached worktree of `origin/main` at `9f94b1142`
and on the branch at `aeb6617ed`, three times each, one worker. Host: 18
logical CPUs; 1-, 5- and 15-minute load averages taken just before each run.

```sh
mise run test:logged -- --name cred-<side>-<n> -- bun test --cwd apps/backend ./tests/commands-container-exec.test.ts --parallel=1 -t "credential helper"
```

The filter selects the eight GitHub credential helper tests, including
`keeps working after setup clears credential.helper, on either order`
(8 pass, 0 fail when run without the logged runner).

| Side | Run | Load (1/5/15 min) | Result |
| --- | --- | --- | --- |
| main | 1 | 18.95 / 12.50 / 10.68 | pass, 2.3 s |
| main | 2 | 18.95 / 12.50 / 10.68 | pass, 2.1 s |
| main | 3 | 17.68 / 12.34 / 10.63 | pass, 2.2 s |
| branch | 1 | 17.68 / 12.34 / 10.63 | pass, 2.5 s |
| branch | 2 | 17.38 / 12.36 / 10.65 | pass, 2.1 s |
| branch | 3 | 17.38 / 12.36 / 10.65 | pass, 2.1 s |

The complete owner also passed once on each side: main 15 pass in 3.98 s (load
13.78), branch 14 pass in 3.39 s (load 13.24). Main's extra test arrived with
`8ddd9ef56` after the branch's merge base. The branch has no diff against
`origin/main` in the owning test, `github-git-credentials.ts` or the Docker
credential scripts. The test spawns `bash` synchronously with a fake
`secret-token`, so the 5000 ms timeout comes from the synchronous child under
aggregate load, not from the branch's `environment-cleanup-reconciler.ts`
import. Verdict: not caused by the branch; still open with no root cause.

## Environment-deletion main merge — 2026-11-06

`mise run test:logged -- --name merge-default -- mise run test` repeated
`Electron backend command registry > GitHub credential helper > keeps working after setup clears credential.helper, on either order`
at 5003.52 ms (Bash status null and a between-test error). The backend group
used four isolated workers. Evidence is
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.HtWRHT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The complete unchanged owner passed in 22.2 s, exit 0:
`mise run test:logged -- --name merge-backend-credential-alone -- bun test --cwd apps/backend ./tests/commands-container-exec.test.ts --parallel=1 --only-failures`.
No assertion, timeout, skip or implementation changed.

## Environment-deletion follow-ups — 2026-11-06

At `b32cfe416` the complete owner failed alone:
`mise run test:logged -- --name recorded-listeners-alone -- bun test --cwd
apps/backend ./src/core/preview-listener-ownership.test.ts --parallel=1
--only-failures` (21 pass, two fail, 15.5 s). `attributes a real 127.0.0.1
listener and refuses another environment` expected `none` for a free port and
`same-port listeners on loopback and a different interface keep distinct
owners` expected `this-environment`; both received `unchecked`. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.MsRuJO/recorded-listeners-alone.log.gz`.
`unchecked` is what the checker returns when its `lsof` (2 s `timeoutMs`)
fails or times out.

At `3bc01ae0b`, on 18 CPUs at load 36.9–41.4, the same owner passed alone
three times in a row (9.2 s, 5.8 s, 6.7 s) with
`mise run test:logged -- --name listeners-alone-N -- bun test --cwd apps/backend
./src/core/preview-listener-ownership.test.ts --parallel=1`, and again in a
nine-owner run with the deletion and readiness owners (36.7 s).

The branch does not change `preview-listener-ownership.ts` or its test. It does
change `command-capture.ts`, which runs `lsof`, but only for callers that pass
`waitForTermination`; the checker does not, and its timeout and lost-exit
handling are the same as before (the lost-exit watcher now also records an exit
after a timeout, which `settleOnExit` ignores because `timedOut` is set). No
assertion, timeout, skip or implementation changed.

## Watcher review round 1 — 2026-11-11

Base `498b68766`; branch `macos-watch-churn-47b622d64a81-r1` at `ea553276d`,
which changes the worktree watcher and neither `preview-listener-ownership.ts`
nor its test. In `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name
default-tests-skip-guards -- mise run test` on macOS, with other worktrees'
aggregate runs holding the host, `LoopbackListenerOwnership on this host >
attributes a real :: listener and refuses another environment` expected
`this-environment` and received `unattributed` (142.67 ms). The complete owner
passed alone with `--parallel=1` in a five-owner rerun
(`orkestrator-test-run.WIUK3M`, whose only failure was flake 9936). Evidence:
`orkestrator-test-run.tOQhj5` under the host temporary directory. No
assertion, timeout, skip or implementation changed.
