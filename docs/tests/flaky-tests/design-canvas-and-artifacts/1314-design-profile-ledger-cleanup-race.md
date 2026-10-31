# Design startup profile removal precedes ledger cleanup

- **ID:** 1314
- **Status:** open
- **Test:** `design service startup > removes the recorded profile of a backend that was killed`
- **File:** `apps/backend/src/core/design/browser-profiles.test.ts:348`

During external-preview review validation on 2026-10-29, preparation and the
required `mise run test` rerun both observed the orphan profile disappearing
while its JSON ledger entry was still present. The latter failed after
168.22 ms. All preview tests passed; this owner was unchanged.

The complete owner passed alone (exit 0, 0.7 s):

```sh
mise run test:logged -- --name design-profiles-owner -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

The test waits for profile deletion, then immediately reads the ledger. A
possible explanation is that asynchronous ledger removal has not finished;
this remains an inference, not a confirmed cause. No implementation, assertion,
timeout or skip changed.

Aggregate evidence: `orkestrator-test-run.cmmuTa/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
in the host temporary directory. Preparation evidence is
`validation-04.stdout.txt` under `.orkestrator/review-artifacts/review-validation-a810480a-55a2-484a-b530-7dd5cb9588b2/`.

## Development source-hint coverage retry — 2026-10-30

The second exact `mise run test` run repeated this ledger-entry assertion
(191.91 ms). The root, bridges and protocol groups passed. Web and desktop
passed on this retry, including the owners that had failed in the previous
run. Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.DbNX2x/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The complete unchanged owner passed alone (exit 0, 1.3 s logged):

```sh
mise run test:logged -- --name design-profile-owner -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

No design implementation, assertion, deadline or skip changed. The full-suite
retry remains non-green solely because of this known cleanup race.

## Pipeline validation-history review, 2026-10-30

Preparation's `mise run test` repeated the remaining-ledger assertion at
265.62 ms; backend totals were 11,266 passed, 87 skipped and two failed.
Evidence: `.orkestrator/review-artifacts/review-validation-273917ca-9984-4108-8435-62e870238e79/validation-04.stdout.txt`. The unchanged complete owner passed
with exit 0 in 1.8 s:

```sh
mise run test:logged -- --name recorded-backend-profiles -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

Passing output was removed by the logged runner; its summary remains in
`orkestrator-test-run.D8MNsY` below the host temporary directory. The cause
remains unconfirmed; no owner implementation, assertion or timeout changed.

The required exact aggregate rerun (`mise run test:logged -- --name
repaired-unit-suite -- mise run test`) repeated the same assertion at 266.79 ms.
The complete owner had passed alone earlier in this repair turn; no source in
this owner changed. Evidence: `orkestrator-test-run.jn7K1f/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory.

## Occurrence 2026-10-30

`mise run test` on the todo 0742 structured-tickets branch (a Kanban storage
fix; nothing in `design/` changed) failed this test after 140.80 ms with the
same symptom: the profile was gone and `48963-48966-0123abcd.json` was still in
the ledger. The owner then passed alone three times in a row (27 pass each,
`bun --cwd=apps/backend test ./src/core/design/browser-profiles.test.ts`).
Aggregate evidence: `orkestrator-test-run.bzzSIG/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
in the host temporary directory.

## Leaf-check readiness review — 2026-10-30

The exact final `mise run test` rerun repeated the same ledger assertion at
line 348 after 300.67 ms. It ran the backend with four file workers (six slots
reserved for the workspace group); backend totals were 11,323 passed,
87 skipped and this one failure. All other test groups and packages passed.
The complete unchanged owner passed alone with one worker (exit 0, 0.9 s):

```sh
mise run test:logged -- --name pr-review-browser-profiles-owner -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

Evidence:
`orkestrator-test-run.mtfML9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory. No design cleanup implementation,
assertion, timeout or skip changed. Asynchronous ledger removal remains a
hypothesis. Other outcomes are in
[1254](../aggregate-validation-runs/1254-merge-readiness-review-validation.md).

## Hidden flow graph review — 2026-10-31

The required exact `mise run test` rerun repeated this assertion after 261.25 ms.
The profile had been removed but its JSON ledger entry remained at line 505.
The web package passed all 10,876 tests; the backend had two failures,
including the other timing case recorded in this review.

Both complete unchanged owners then passed with one file worker
(exit 0, 2.4 s):

```sh
mise run test:logged -- --name recorded-backend-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/standalone-ready.test.ts ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `orkestrator-test-run.Od2gTp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. No implementation, assertion, timeout or
skip in either owner changed. This repeats the existing intermittent symptom;
no new cause was established.

## Failed-turn restart validation observation

On 2026-10-31, while validating [0940](../../../todo/cross-cutting/0940-failed-turn-reads-as-completed.md)
task 3, `mise run test` failed this case in 100.81 ms: the JSON ledger entry was
still present at line 505 after the profile had gone. The backend reported
11,713 passed, 103 skipped and this one failure across 804 files (109.36 s), on a
host running other workers (the whole run took 1,002 s against 521 s earlier the
same day). The same test passed in that earlier run. The complete unchanged owner
then passed alone three times out of three (37 passed):

```sh
mise exec -- bun test src/core/design/browser-profiles.test.ts
```

run from `apps/backend`. No design code, assertion, timeout or skip changed.
Asynchronous ledger removal remains a hypothesis.
