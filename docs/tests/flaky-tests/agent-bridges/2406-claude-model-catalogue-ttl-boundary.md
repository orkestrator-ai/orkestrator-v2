# Claude model catalogue cache expires before its boundary assertion

- **ID:** 2406
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `the model catalogue without a running CLI > the answer expires, as a backstop for a change nothing reported`
- **File:** `bridges/claude-bridge/src/services/claude-model-catalog.test.ts:284`
- **Original command:** `mise run test:logged -- --name review-repair-default -- mise run test`
- **Workers:** workspace/root/bridges/protocol reservations 5/1/2/1; Claude bridge used one Bun worker, beside browser and Electron validation on a shared macOS host.
- **Failure:** expected one probe, received two (143.29 ms). The Claude group reported 1,769 pass, nine skip and one fail across 93 files.
- **Owning-file rerun:** `mise run test:logged -- --name claude-catalogue-owner -- bun test --cwd bridges/claude-bridge ./src/services/claude-model-catalog.test.ts --parallel=1 --only-failures` passed unchanged, exit 0 in 1.3 s.
- **Evidence:** `orkestrator-test-run.BSqVX9/bridges.log` below the host temporary directory, compressed at aggregate finalization.
- **Hypothesis:** the test calculates its near-expiry clock from real time after fetching the first answer. Scheduling across that one-millisecond margin may cross the actual cache boundary. The cause has not been established. No assertion, timeout, skip or catalogue implementation changed.

### Final default-suite verification — 2026-11-02

`mise run test:logged -- --name review-repair-default-controlled -- mise run test`
passed all four groups (exit 0, 741.9 seconds including a 540.5-second capacity
wait) at code commit `1144ea780`. The logging shutdown clock fix is in that
commit; the other owners listed here were unchanged. This green aggregate
does not establish a root cause for the still-open intermittent cases.

### H3 review validation — 2026-11-03

Preparation at `28a19d5db` repeated expected one probe / received two at line
284 (1.75 ms) in `mise run test`; the original artifacts remain under
`.orkestrator/review-artifacts/review-validation-f687c5af-e160-44ca-a69e-8b4c9e450ba7/validation-04.stdout.txt`.
The unrelated owner passed alone on detached `origin/main` `b58d401e1`:
`mise run test:logged -- --name h3-base-catalog -- bun test bridges/claude-bridge/src/services/claude-model-catalog.test.ts --parallel=1 --only-failures`
(exit 0, 1.3 s). A targeted repetition on that same detached checkout reproduced
the exact line-284 assertion:
`mise run test:logged -- --name h3-base-ttl-boundary -- bun test bridges/claude-bridge/src/services/claude-model-catalog.test.ts --parallel=1 --rerun-each=500 --test-name-pattern 'the answer expires' --only-failures`
(2 pass, 498 fail, 11,000 filtered; 2.9 s; artifact
`.orkestrator/review-artifacts/h3-fix-evidence/h3-base-ttl-boundary.log.gz`). Dependencies
were installed independently with `mise exec -- bun install --frozen-lockfile`.
No catalogue implementation or assertion was changed by H3.
## Recurrence, 2026-11-03

`mise run test:logged -- --name full-default-2 -- mise run test` on branch
`debug-ci-failures-a629816c8619-r1` (16-core Linux host, queued behind another
worktree's aggregate run, so the workspace group took 1,019 s against about
245 s for the previous run that day) repeated this failure (6.27 ms). The unchanged
owner then passed alone: `bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/claude-model-catalog.test.ts --parallel=1`.
