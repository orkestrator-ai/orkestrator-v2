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
