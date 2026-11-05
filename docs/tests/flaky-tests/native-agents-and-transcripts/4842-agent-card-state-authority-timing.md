# Agent card state authority timing

- **ID:** 4842
- **Status:** resolved
- **Observed:** 2026-11-05
- **Test:** `AgentNativeTab progressive controller > keeps Claude agent-card position through unavailable-state until authority returns`
- **File:** `apps/web/src/components/native-agent/AgentNativeTab.progressive.test.tsx`

Preparation's `mise run test` at cd5b0142 reported this assertion after 1058.59 ms: the Stop Investigate rendering button was still present when absence was expected (line 676). The recorded aggregate had ten named failures and errors outside tests; the package does not provide a reliable combined test total. Worker allocation was controlled by the aggregate runner, not supplied explicitly on its command line.

The owning file passed alone on the repair branch with:

```sh
mise run test:logged -- --name recorded-agent-card -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=1 --only-failures
```

The complete file passed in 8.5 seconds (114 output bytes; passing log removed by the logged runner). No assertion was weakened or skipped. The original failure remains in `.orkestrator/review-artifacts/review-validation-6e251f8d-c76b-469b-b389-d7b80e76ea49/validation-04.stdout.txt` around lines 1509–1522. The test waits for transcript text before checking state authority, while those reads run independently; ordering under aggregate load needs further investigation. This is a hypothesis, not an established cause.

## Additional pre-repair observations (2026-11-05)

On 2026-11-05, preparation at `366fa15c7` again reported the same Stop-button
assertion (1099.35 ms, line 676). The aggregate reported three failures (31,842
passed, 150 not run); worker allocation was controlled by the aggregate runner.
Evidence: `.orkestrator/review-artifacts/review-validation-4565b97a-56f2-49c1-85c0-4e153180ac69/validation-04.stderr.txt`, lines 568–580.
The complete owner passed alone in 15.6 s with
`NODE_ENV=test mise run test:logged -- --name recorded-agent-card -- bash -c 'cd apps/web && bun test ./src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=1 --only-failures'`.
An initial invocation without `NODE_ENV=test` loaded production React and failed
with `React.act is not a function` (artifact `/tmp/orkestrator-test-run.FAgmsw`);
that invocation did not exercise the assertion. No test or renderer behavior
was changed. The existing independent-read ordering hypothesis remains unproven.

The failure does not depend on the E5 storage branch (`database-upkeep-ac99b5b934a3-r1`).
Its first recorded occurrence, at `cd5b0142`, is on the E8 branch, which is
neither an ancestor of nor a descendant of the E5 work. `git diff --stat
origin/main...HEAD -- apps/web` on the E5 branch is empty, so the branch
changes no renderer code, test or mock that this file loads. One possible
cause, not yet proven: after the `unavailable` read, the test's state mock answers
`unchanged` (`state-unscripted`) until `stateUpdates` is reassigned. A poll in
that window could restore Stop before the held state is installed.

## Resolution (2026-11-05)

**Root cause.** The test's backend mock answered every state read that no
scripted update covered with `unchanged`. After the scripted `unavailable` (or
rejected) read, the hook drops its state token and Stop disappears, but the
next background poll that landed before the test scripted the held recovery
read got that `unchanged` reply. The hook treats `unchanged` as current
authority (`useNativeAgentSession.ts`, progressive state read), so Stop came
back before line 676 asserted its absence. A real bridge cannot answer
`unchanged` to a read that carries no known token, so the reply was a
fixture artefact, and how often a poll fell in that window depended on load.
The `failed-read` case had the same window.

**Fix.** The branch test file gained a `stateFallback` hook for unscripted state reads.
The two outage transitions set it to keep reporting the outage (the rejection
or the `unavailable` reply) until the held recovery read is scripted, and clear
it at that point; every other test keeps the `unchanged` default. No assertion
was weakened or skipped, and no product code changed.

**Verification.** A temporary three-second `act` wait inserted before the
recovery is scripted (standing in for aggregate-load lag) made the old test
fail in both `failed-read` and `unavailable-state`, and the fixed test pass all
three cases. Without the wait, the whole file passed through
`mise run test:logged -- --name agent-native-progressive -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=1 --only-failures`
(with `NODE_ENV=test`, 11.6 s), and the three parameterised cases passed five
repeated runs.

## Resolution (2026-11-05, C5 review repair)

The captured run at `dacb38039` repeated the Stop-button assertion failure
(1027.79 ms; 31,770 passed, 3 failed, 137 not run overall). The isolated
owner also failed (41 passed, 1 failed, 7.6 s) using:

```sh
mise run test:logged -- --name address-progressive-owner -- env NODE_ENV=test bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.fSBhmH/address-progressive-owner.log.gz`.
The fixture consumed its one unavailable response, then answered subsequent
polls with `unchanged`, which restores state authority. The assertion could
therefore race a fixture-generated recovery before the held recovery read was
installed. The fixture now repeats the outage until the explicit held recovery,
and keeps that recovery held across additional reads. Assertions are unchanged.
The complete isolated owner passed after repair (8.0 s). Aggregate verification
is recorded in the Address Findings result.

## Merge reconciliation (2026-11-05)

Both branches independently repaired the same fixture race. The merged test uses
`fallbackStateRead` from the C5 repair, including its held-recovery fallback and
cleanup after release. The reproduction and verification records above describe
the respective branch fixes before reconciliation.
