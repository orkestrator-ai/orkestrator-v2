# Retained prompt-file attachment did not appear before the query deadline

- **ID:** 2396
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `CreateEnvironmentDialog feature builds > counts retained prompt-file bytes when feature mode adds an image`
- **File:** `tests/unit/components/CreateEnvironmentDialog.test.tsx:4173`
- **Original command:** `mise run test:logged -- --name review-fix-tests -- mise run test`. The root group ran with one worker alongside the workspace group and a separate eight-worker Playwright run. Root group result: 3412 pass, 1 skip, 2 fail across 171 files (289.47 s); the other failure was the existing raw-console ratchet count.
- **Failure:** `Unable to find an element with the text: prompt-2.bin` at `screen.findByText`, after 3273.36 ms. Evidence: `/tmp/orkestrator-test-run.MoBWRf/root-and-agent-support-tests.log.gz`. The aggregate finished in 417.1 s; workspace, bridges and protocol groups passed.
- **Isolated rerun:** `NODE_ENV=test mise run test:logged -- --name create-environment-isolated -- bun test ./tests/unit/components/CreateEnvironmentDialog.test.tsx --parallel=1 --only-failures` passed the complete unchanged owner (140 tests; logged duration 18.0 s).
- **Diagnostic caveat:** The first isolated invocation omitted `NODE_ENV=test` and inherited production mode, causing `React.act is not a function` (1 pass, 139 fail). The aggregate sanitizes that variable; the corrected isolated command restores comparable test conditions.
- **Hypothesis:** Host contention may delay processing the three 7 MiB attachments beyond the query deadline. This is unconfirmed; no timeout or assertion was changed. The implementation change only strengthens a pipeline browser zoom assertion.
