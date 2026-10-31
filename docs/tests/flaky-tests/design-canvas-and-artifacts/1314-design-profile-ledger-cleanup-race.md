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
