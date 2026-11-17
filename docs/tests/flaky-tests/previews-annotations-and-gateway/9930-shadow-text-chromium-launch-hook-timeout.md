# Shadow-root text selections: Chromium launch hook timeout

- **ID:** 9930
- **Status:** open
- **Date observed:** 2026-11-10

Test: `text selections in an isolated world, in Chromium > (unnamed)` (the
suite's `beforeAll`) in
`apps/desktop/tests/browser-preview-shadow-text.integration.test.ts`.

No existing index entry matched this test; this records a new case, not a
counted recurrence.

## Observation

- **CI run:** 42811683701, job `Tests (workspace)` (129814554128), branch
  `archive-resume-picker-0a25d81b2fed-r1`, head `cbacc3f2`, merge base with
  `main` `57b944e3`.
- **Original command:** `mise run test:full` (the CI shard step, slow tier
  included; this file is slow by its `*.integration.test.ts` name).
- **Failure:** `Test "(unnamed)" timed out after 60000ms`, 60,000.61 ms. The
  hook launches Chromium, opens a page and a CDP session, under a 60 s budget.
  No test in the file ran. The only failing group in that run was the
  workspace group (891.6 s); the desktop package's per-test totals were not
  in the retained log and are not inferred.

## Isolated rerun

The unchanged owner passed alone on Linux at `2aad83a37`, exit 0, 6.3 s
(passing output removed; counts not retained):

```sh
mise run test:logged -- --name shadow-text -- bun --cwd=apps/desktop test ./tests/browser-preview-shadow-text.integration.test.ts --preload ../../tests/setup-node.ts --parallel=1
```

## Assessment

A one-off: the hook normally completes in a few seconds, so a 60 s stall
points at the launch or first navigation under aggregate load rather than at
the test's assertions. Cause unconfirmed. No budget, assertion or retry was
changed for this record.

## Next evidence

If it recurs, add content-free phase markers (launch, new page, route,
CDP session) to the hook to identify which step stalls before changing the
budget.

## Triage note (2026-11-15)

Diagnostics only; stays `open`. In `apps/desktop/tests/browser-preview-shadow-text.integration.test.ts` each `beforeAll` step (launch, new page, route, CDP session) now runs under a 45 s watchdog that names the step that stalled, and the explicit 60 s hook and 30 s test arguments are removed (the 60 s default applies). The hook budget is unchanged at 60 s, so the recorded 60 s stall is not fixed; the next recurrence will say which step stalled. Passed alone on Linux with `/usr/bin/chromium`.

## Recurrence (2026-11-16)

- **CI run:** 43968208216, job `Tests (workspace)` (133653296043), `main`
  at `0d12d63ee` (the case's triage diagnostics are on that base).
- **Original command:** `mise run test:full` (CI workspace shard).
- **Failure:** `Chromium setup stalled at: launch` after 45,002.94 ms: the
  `chromium.launch` step, not the new page, route or CDP session.
- **Rerun alone (same job):** passed, 19 pass, 0 fail, 41.58 s for the file.
  The same file passes alone locally in about 6 to 10 s, so the launch on a
  GitHub runner is slow even without load, and the 45 s watchdog sat within
  a few seconds of a normal run there.

## Budget change (2026-11-16)

As the "Next evidence" section planned, now that the stalled step is known:
the `launch` phase has its own 120 s hang watchdog and the hook an explicit
180 s budget; the other phases keep 45 s and still name the step that
stalled. This is a raised budget for genuinely heavy work, which is weaker
evidence than a fix, so the case stays `open`. Why Chromium starts so slowly
on the runner (first-run work, the binary chosen from the candidate list) is
not known; the next recurrence or a timed launch on a runner should show it.

## Review execution evidence (2026-11-17)

The changed integration file was explicitly executed on macOS, outside the
default tier (which excludes it):

```sh
mise run test:logged -- --name fix-shadow-text -- bun --cwd=apps/desktop test ./tests/browser-preview-shadow-text.integration.test.ts --parallel=1 --only-failures
```

It passed in 3.8 s. A second run exercised the same real spec and Chromium
with `chromium.launch` wrapped by a test preload: the wrapper awaits 46,000 ms,
then invokes the original launch with its original arguments. This keeps
the suite's own phase timer and `beforeAll` budget active throughout the delay;
no watchdogs or assertions are replaced. The measured launch phase was
46,331 ms, exceeding the former 45 s watchdog. All 19 tests and 76 assertions
passed, with zero skips, in 49.8 s.

```sh
mise run test:logged -- --name fix-shadow-text-delayed -- bun --cwd=apps/desktop test --preload ../../output/agent-testing/address-review/delayed-chromium.ts ./tests/browser-preview-shadow-text.integration.test.ts --parallel=1 --reporter=junit --reporter-outfile=../../output/agent-testing/address-review/shadow-delayed.xml
```

The preload, `delayed-launch.json` and `shadow-delayed.xml` are retained in
the ignored `output/agent-testing/address-review/` directory. This proves
that the real suite executes without skipping and that setup can exceed
45 s within the new 120 s / 180 s budgets. The delay is injected, not an
observed slow OS launch, and this is not a Linux slow-launch reproduction.
The original runner-specific cause remains unknown and the case stays open.
