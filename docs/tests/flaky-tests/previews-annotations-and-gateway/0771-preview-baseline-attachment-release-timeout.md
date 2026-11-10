# Preview baseline attachment-release request timeout

- **ID:** 0771
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Test:** `baseline orchestration > releases private-origin attachments after handoff failure (att-missing-code)` in `tests/unit/preview-latency-baseline.test.ts`.
- **Original command:** the testing guide's GNU-tool PATH with `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, merging `0014505caeed69395b3cc996dd541fcc6df12c23` into `ce4e1b007c4797868255438bd67d5d5168098773`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; one root worker on a shared macOS host, with other worktrees validating concurrently.
- **Root counts:** 3368 passed and 15 failed across 3383 tests in 162 files (1001.90 seconds).
- **Evidence:** `orkestrator-test-run.O0jvRO/root-and-agent-support-tests.log.gz` below the host temporary directory after aggregate completion.
- **Failure:** `get_preview_services: timed out` from the local HTTP request timeout (246.05 ms test duration).
- **Unchanged owner:** `mise run test:logged -- --name merge-owner-preview-baseline -- bun test ./tests/unit/preview-latency-baseline.test.ts --parallel=1 --only-failures` passed (exit 0, 2.2 seconds logged).
- **Hypothesis:** shared-host scheduling contention may delay the local fixture response; the isolated pass confirms intermittence but does not establish the mechanism. No implementation, assertion, timeout or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** the test passes `--timeout-ms 100` to the baseline (`preview-latency-baseline.test.ts:634`), so a local request slower than 100 ms under load fails with `get_preview_services: timed out`. The case checks release after a handoff failure, not timeouts.
- **Next step:** give this fixture a larger request timeout (for example 2,000 ms).

## Resolution (2026-11-10)

- **Root cause:** the test passed `--timeout-ms 100`, and the baseline uses
  that one option as the socket idle timeout of every local `invokeCommand`
  request (`scripts/preview-latency-baseline.ts`), including
  `get_preview_capabilities` and `get_preview_services` against the test's own
  HTTP fixture. A fixture worker descheduled for more than 100 ms under load
  therefore failed the run with `get_preview_services: timed out` before the
  handoff path the test checks was ever reached. The small budget existed only
  to bound the legacy handoff, whose session exchange opened a real TLS
  connection to `s.preview.test:443`.
- **Fix:** `tests/unit/preview-latency-baseline.test.ts` now gives the run a
  5,000 ms budget that no step waits on, and points the legacy handoff at a
  fixture-owned listener that resets every connection
  (`--publication-address 127.0.0.1` plus the listener's port in the handoff
  URL), so that exchange fails at once with no DNS lookup and no timeout. The
  route-failed, release and no-secret assertions are unchanged.
- **Reproduced:** yes — a temporary `await Bun.sleep(150)` before the fixture
  answered `get_preview_services` failed all four cases with the recorded
  `get_preview_services: timed out`
  (`mise run test:logged -- --name b39-0771-repro -- bun test ./tests/unit/preview-latency-baseline.test.ts --parallel=1 -t "baseline orchestration"`);
  with the fix and the same injected delay the four cases pass
  (`b39-0771-fixed-delay`).
- **Stress:** `mise run test:logged -- --name b39-0771-stress -- bun scripts/test-under-contention.ts -- bun test ./tests/unit/preview-latency-baseline.test.ts --parallel=1 --rerun-each=20`
  passed (27 tests × 20, exit 0; macOS, so the burners ran unpinned).
