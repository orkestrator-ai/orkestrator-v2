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
