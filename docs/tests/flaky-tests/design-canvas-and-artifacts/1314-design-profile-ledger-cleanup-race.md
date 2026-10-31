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

## Docker Settings probe repair — 2026-10-31

After provisioning the missing pinned Codex binary, `NODE_ENV=test mise run test`
failed the unchanged startup test at line 505 after 77.53 ms: profile deletion
was observable while `2964482-2964484-0123abcd.json` remained in the ledger.
The aggregate reserved six workspace worker slots (four backend file workers);
the root, bridge and protocol groups passed, and the captured web summary had
zero failures. Total duration was 719.7 s, including 453.3 s waiting for host
capacity. Evidence: `/tmp/docker-fix-full-test.log` and
`/tmp/orkestrator-test-run.kjM79q/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The complete unchanged owner passed alone on the Docker Settings branch (0.4 s)
and on detached `origin/main` at `931e554171e86e1d640425b1839fc30d39a25970`
(0.3 s), using independently installed dependencies:

```sh
NODE_ENV=test mise run test:logged -- --name docker-validation-backend-owner -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1
```

Thirty further owner repeats on that main checkout passed in 2.8 s:

```sh
NODE_ENV=test mise run test:logged -- --name docker-main-ledger-repro -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --rerun-each=30
```

Logs: `/tmp/docker-fix-backend-owner.log`,
`/tmp/docker-fix-main-backend-owner.log`, and
`/tmp/docker-fix-main-ledger-repro.log`. This confirms aggregate-versus-isolated
variance, not target-branch reproduction of the failure. No cleanup code,
assertion, timeout or skip changed; asynchronous ledger removal remains a
hypothesis.
