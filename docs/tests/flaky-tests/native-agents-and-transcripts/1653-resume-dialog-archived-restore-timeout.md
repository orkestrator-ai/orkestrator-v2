# Resume dialog archived restore timeout under load

- **ID:** 1653
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `NativeResumeSessionDialog > keeps archived history restorable after reopening with %s live rows`, both parameterized cases.
- **File:** `apps/web/src/components/chat/NativeResumeSessionDialog.test.tsx:298`.
- **Original command:** `mise run test:logged -- --name web-focus -- bun --cwd=apps/web test src/components/settings src/components/chat src/components/terminal/FileViewerTab.test.tsx src/components/markdown src/hooks src/lib/portal src/lib/federation src/lib/backend.test.ts src/components/federation src/components/sidebar src/components/layout/AppDialogHost.test.tsx src/components/native-agent/AgentNativeTab.test.tsx --parallel=4 --only-failures`.
- **Worker configuration:** four Bun workers, on a host also running other agents' test work.
- **Failure:** each case hit the default 5000 ms limit (5136.91 ms and 5200.67 ms). The late assertion surfaced as an unhandled error between tests: `expect(received).toHaveBeenCalledWith(...expected)`, `Expected: [ "kept" ]`, `But it was not called`.
- **Suite counts:** 3,726 passed, 2 failed, 1 error, across 234 files in 150.34 s.
- **Owning-file rerun:** `mise run test:logged -- --name resume-dialog -- bun --cwd=apps/web test src/components/chat/NativeResumeSessionDialog.test.tsx --parallel=2 --only-failures` passed.
- **Evidence:** `/tmp/orkestrator-test-run.cBikIh/` holds the failing log.
- **Hypothesis:** the cases exceed the per-test limit when workers compete for CPU; the cause is not established. The change under test at the time did not touch this dialog, and no source assertion, timeout or skip was changed to obtain the pass.

## Main-merge retry — 2026-11-01

- **Original command:** `mise run test:logged -- --name retry-default -- mise run test`, Bun 1.4.4, two web workers alongside other aggregate groups and a two-worker component-browser run.
- **Failure:** the archived-history restoration case exceeded its 5,000 ms deadline at 5,407.25 ms.
- **Counts:** web 11,115 passed, ten skipped and six failed. The other five failures were outdated project-header accessible-name assertions in `WorkspaceRealmHost.test.tsx`; those were corrected separately. The aggregate failed after 399.6 s.
- **Complete unchanged owner:** `mise run test:logged -- --name retry-resume-dialog-isolated -- bun test --cwd apps/web ./src/components/chat/NativeResumeSessionDialog.test.tsx --parallel=1 --only-failures` passed in 6.3 s.
- **Evidence:** `/tmp/orkestrator-test-run.IH1qlx/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** recurrence of the existing deadline symptom. No resume-dialog source, assertion, timeout or skip changed; the cause remains unconfirmed.

## Delivery-policy main merge — 2026-11-02

- **Original command:** `mise run test:logged -- --name merge-default-tests -- mise run test`, Bun 1.4.4, two web workers within a six-slot workspace group, alongside the root and bridge groups and a two-worker pipeline component-browser run.
- **Failure:** the archived-history restoration case exceeded its 5,000 ms deadline at 5,270.49 ms.
- **Counts:** web 11,367 passed, ten skipped and five failed across 755 files in 422.16 s. The other four web failures were terminal link-routing assertions, which also failed in their isolated owning-file rerun. Root tests had 3,434 passed, one skipped and four failed. The aggregate failed after 426.2 s.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-resume-dialog-rerun -- bun test --cwd apps/web ./src/components/chat/NativeResumeSessionDialog.test.tsx --parallel=1 --only-failures` passed in 4.0 s.
- **Evidence:** `/tmp/orkestrator-test-run.YwLvvl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; aggregate wrapper evidence is under `/tmp/orkestrator-test-run.XCqUci/`.
- **Assessment:** recurrence under aggregate load; the cause remains unconfirmed. No resume-dialog source, assertion, timeout or skip changed.


### Coordinator retention fix validation, 2026-11-02

`mise run test:logged -- --name repaired-validation-test -- mise run test`
failed `NativeResumeSessionDialog > keeps archived history restorable after reopening with %s live rows` in `apps/web/src/components/chat/NativeResumeSessionDialog.test.tsx`: 5000 ms timeout after 5278.41 ms.
Backend summary: 13349 pass, one fail, 13450 tests; web: 11406 pass,
one fail, 11417 tests. The aggregate scheduled six workspace worker slots, one root worker, two
bridge workers and one protocol-lockfile slot.
Evidence: `/tmp/orkestrator-test-run.kQC3bQ/repaired-validation-test.log.gz`
(and inner artifact directory `/tmp/orkestrator-test-run.OxYauT`).

The unchanged complete owner passed alone via `mise run test:logged` with
name `resume-owner`, explicit owner path and `--parallel=1 --only-failures`
(3.2 s). The same owner passed in a separately installed detached
`origin/main` worktree at `d7cdfaa8b` (main-resume-owner); the worktree was removed.
No target-branch failure or environmental cause was reproduced, so this
observation does not excuse the aggregate failure. The next exact aggregate
rerun passed the workspace group (308.1 s), including this owner. It exposed
three malformed flake-index rows introduced while recording these observations;
the rows were repaired and the complete index owner passed alone. That rerun
artifact is `/tmp/orkestrator-test-run.eKA8Rz/validation-test-final.log.gz`.
A post-repair exact aggregate rerun is recorded separately.
