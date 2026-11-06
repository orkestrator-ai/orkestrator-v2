# Remote workspace grouping delivery posted five messages instead of none

- **ID:** 1531
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Test:** the grouping-delivery case near the then line 819 (now
  `browser grouping delivery uses the current workspace envelope and survives grant replacement`, line 894, or its neighbour at 870)
- **File:** `apps/web/src/components/federation/RemoteWorkspaceRegion.test.tsx`
- **Original command:** the environment-list main merge aggregate,
  [0790](../aggregate-validation-runs/0790-environment-list-main-merge-validation.md).
- **Failure:** grouping delivery saw five `postMessage` calls instead of zero
  at line 819 (23.04 ms).
- **Isolated rerun:** the unchanged owner passed alone
  (`merge-remote-workspace-owner`, 2.7 s).
- **Related:** [1248](../aggregate-validation-runs/1248-project-landing-tab-review-validation.md)
  saw a different failure in this owner (a missing `boardTab`, 263 ms) while
  an edit was in flight; it was not classified as a flake.
- **Hypothesis:** none. Created on 2026-10-31 from the 2026-10-25 triage in
  todo 0030, which named this owner without a case; the evidence is the 0790
  record, not a new run. Next recurrence: capture which messages were posted
  (their `type`) and whether an earlier test's grant or timer was still live.

## R6a final aggregate recurrence — 2026-11-04

At `315d6953c72e238ea85281abb5cd2f800b32f2e3`, the exact preparation command
`mise run test:logged -- --name review-default-tests -- mise run test`
failed in 325.6 s. The scheduler granted five workspace slots, one root slot
and two bridge slots. The grouping-delivery test at line 1163 received seven
`postMessage` calls instead of zero (12.99 ms). Web totals were 11,784 passed,
ten skipped, one failed; backend had 14,069 passed, 102 skipped, zero failed.
The only other failure was the root Chromium lifecycle hook (case 2711).

Evidence:
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.Cj4lpa/review-default-tests.log.gz`
(lines 2670–2683). Inner group evidence is under
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.kVPV5d/`.

The unchanged complete owner passed alone, exit 0 in 1.1 s:

```sh
mise run test:logged -- --name fix-final-remote-workspace-owner -- bun test --cwd apps/web ./src/components/federation/RemoteWorkspaceRegion.test.tsx --preload ../../tests/setup.ts --parallel=1 --only-failures
```

The owner, component and direct grouping/workspace/UI stores have no diff in
`origin/main...HEAD`. The posted message types were not captured. This confirms
another intermittent observation, not a demonstrated cause or an environmental
excuse. No assertion, timer or renderer implementation was changed; the failed
aggregate remains a limitation for the verifier.

## C5 address-findings recurrence — 2026-11-05

At `7e51eb465`, `mise run test:logged -- --name address-committed-suite -- mise run test`
failed after 434.3 s. The workspace used two web workers and four backend
workers. The grouping-delivery case (line 1163, 18.72 ms) expected zero
`postMessage` calls and received seven. Web totals: 12,485 passed, ten skipped,
one failed. Backend totals: 15,225 passed, 119 skipped, zero failed. Root,
bridges and the Codex protocol lockfile groups passed. The three failures in
C5's original preparation package were absent after repair.

Evidence: `/tmp/orkestrator-test-run.jwBKD9/address-committed-suite.log.gz`
(lines 2622–2628); inner logs: `/tmp/orkestrator-test-run.Cel21e/`.

The unchanged complete owner passed alone (2.1 s, exit 0):

```sh
mise run test:logged -- --name address-federation-owner -- env NODE_ENV=test bun test --cwd apps/web ./src/components/federation/RemoteWorkspaceRegion.test.tsx --parallel=1 --only-failures
```

The component, owner and machine grouping store have no diff in
`origin/main...HEAD`. No new root cause was established and no federation
assertion or implementation was changed. This recurrence remains an aggregate
validation limitation; the isolated pass does not make the aggregate green.

### Resolution — 2026-11-06

**Root cause (product).** In `FrameRealm` (`RemoteWorkspaceRegion.tsx`), the
window `message` listener that filters by workspace ID was registered in a
passive `useEffect`, while `useRealmRequests` swaps its sender (`latest.current.send`)
in a layout effect. After a grant replacement commits (the frame's `src` names
`workspace-2`), there is a window before passive effects flush in which the
old listener still accepts `workspace-1`. A late `ready` from the replaced
document arriving in that window set `ready.current = true` and posted the
full shell state (sidebar, files panel, grouping and so on) through the new
`workspace-2` sender to a document that had not loaded. On a loaded host the
test's stale `ready` lands in that window, so it saw five or seven posts where
it expected none.

**Reproduction.** A probe delivered the stale `workspace-1` `ready` from a
`MutationObserver` on the frame's `src`, at the commit point. On the unchanged
component it produced 3 posts, and the test's later expectation then failed.

**Fix.** `apps/web/src/components/federation/RemoteWorkspaceRegion.tsx`: the
listener is registered in `useLayoutEffect`, so it always names the workspace
the committed frame was given. The owning test now delivers the stale `ready`
at exactly that point and asserts zero posts, so the race is covered
deterministically. Without the product fix this assertion fails (expected 0,
received 3); with it, it passes.

**Verification.** `mise run test:logged -- --name web-1531-owner-stress -- bun --cwd=apps/web test src/components/federation/RemoteWorkspaceRegion.test.tsx --rerun-each=20`
passed (exit 0, 19.6 s). The combined ten-owner `--parallel=3` run also
passed. No other test file imports this component.
