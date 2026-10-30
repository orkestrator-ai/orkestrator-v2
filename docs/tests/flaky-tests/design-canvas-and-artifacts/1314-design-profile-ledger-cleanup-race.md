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

## Occurrence 2026-10-30

`mise run test` on the todo 0742 structured-tickets branch (a Kanban storage
fix; nothing in `design/` changed) failed this test after 140.80 ms with the
same symptom: the profile was gone and `48963-48966-0123abcd.json` was still in
the ledger. The owner then passed alone three times in a row (27 pass each,
`bun --cwd=apps/backend test ./src/core/design/browser-profiles.test.ts`).
Aggregate evidence: `orkestrator-test-run.bzzSIG/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
in the host temporary directory.
