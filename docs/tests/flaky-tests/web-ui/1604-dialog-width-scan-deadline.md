# Dialog width source scan exceeds the test deadline

- **ID:** 1604
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `DialogContent width > keeps callers on size or --modal-max-width rather than max-w classes`.
- **File:** `apps/web/src/components/ui/dialog.test.tsx:321`.
- **Original command:** `mise run test`, the exact held-history review preparation rerun, with two isolated web workers.
- **Failure:** the source-scan test exceeded its 5000 ms deadline after 5343.46 ms.
- **Web group:** 11,165 passed, ten skipped and one failed; the full aggregate finished in 952.9 s including 287.2 s queued.
- **Complete unchanged owner:** `mise run test:logged -- --name current-dialog-width -- bun test --cwd apps/web ./src/components/ui/dialog.test.tsx --parallel=1 --only-failures` passed, exit zero in 6.3 s.
- **Evidence:** `/tmp/orkestrator-test-run.NettPR/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` (compressed after aggregate completion).

The source scan passed when the complete owner ran by itself. Shared-host
contention is a possible explanation; no root cause is established. No dialog
implementation, assertion, deadline or skip changed. The aggregate also
reported failures in unchanged backend and root owners and remains non-green.

### Resolution — 2026-11-06

**Root cause.** The source-scan guard parsed and walked the full AST of every
non-test renderer `.tsx` file (565 today) with `oxc-parser`, which took 2.01 s
alone. Under load that exceeded the five-second deadline (5343 ms observed).
Only a file that names `DialogContent`/`AlertDialogContent` and contains a
`max-w-` string can produce an offender: the scan matches only those JSX names,
and same-file constants only.

**Fix.** `apps/web/src/components/ui/dialog.test.tsx`: the scan skips a file
unless its text contains both `DialogContent` and `max-w-`, which leaves 36
files to parse. The case now takes 0.24 s. Detection is unchanged: a temporary
`apps/web/src/zz-dialog-guard-probe/Probe.tsx` holding
`<DialogContent className={WIDE}>`, with `WIDE = "sm:max-w-lg"`, still failed
the guard and was then removed. (Edge case: a `max-w-` class written only
through escape sequences in a string literal would now be missed.)

**Verification.** `mise run test:logged -- --name web-1604-stress -- bun --cwd=apps/web test src/components/ui/dialog.test.tsx --rerun-each=10`
passed (exit 0, 4.3 s). The deadline overrun was not reproduced under load;
the fix removes most of the measured work.
