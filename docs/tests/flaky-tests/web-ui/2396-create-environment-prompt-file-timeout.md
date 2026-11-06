# Retained prompt-file attachment did not appear before the query deadline

- **ID:** 2396
- **Status:** resolved
- **Date observed:** 2026-11-02
- **Test:** `CreateEnvironmentDialog feature builds > counts retained prompt-file bytes when feature mode adds an image`
- **File:** `tests/unit/components/CreateEnvironmentDialog.test.tsx:4173`
- **Original command:** `mise run test:logged -- --name review-fix-tests -- mise run test`. The root group ran with one worker alongside the workspace group and a separate eight-worker Playwright run. Root group result: 3412 pass, 1 skip, 2 fail across 171 files (289.47 s); the other failure was the existing raw-console ratchet count.
- **Failure:** `Unable to find an element with the text: prompt-2.bin` at `screen.findByText`, after 3273.36 ms. Evidence: `/tmp/orkestrator-test-run.MoBWRf/root-and-agent-support-tests.log.gz`. The aggregate finished in 417.1 s; workspace, bridges and protocol groups passed.
- **Isolated rerun:** `NODE_ENV=test mise run test:logged -- --name create-environment-isolated -- bun test ./tests/unit/components/CreateEnvironmentDialog.test.tsx --parallel=1 --only-failures` passed the complete unchanged owner (140 tests; logged duration 18.0 s).
- **Diagnostic caveat:** The first isolated invocation omitted `NODE_ENV=test` and inherited production mode, causing `React.act is not a function` (1 pass, 139 fail). The aggregate sanitizes that variable; the corrected isolated command restores comparable test conditions.
- **Hypothesis:** Host contention may delay processing the three 7 MiB attachments beyond the query deadline. This is unconfirmed; no timeout or assertion was changed. The implementation change only strengthens a pipeline browser zoom assertion.

### Resolution — 2026-11-06

**Root cause.** After the drop of three 7 MiB prompt files, the test waited for
`prompt-2.bin` with Testing Library's one-second default. Timing the unchanged
case five times at a load average of about 20 gave 1.53–2.10 s until the
attachment appeared. It passed only because the synchronous attachment work
also delays the timeout timer. The later size check in the same case already
used a 10 s bound.

**Fix.** `tests/unit/components/CreateEnvironmentDialog.test.tsx`: the
`findByText("prompt-2.bin")` wait gets `{ timeout: 10_000 }`, matching the
size check (the file's test budget is 30 s), with a comment. No assertion
changed.

**Verification.** `mise run test:logged -- --name root-2396-stress -- bun test tests/unit/components/CreateEnvironmentDialog.test.tsx -t "prompt-file|prompt-only" --rerun-each=8`
passed (exit 0). The unchanged case did not fail in eight local repetitions,
so the fix rests on the measured latency rather than a reproduction.
