# WebKit generation reader intermittently receives EINVAL

- **ID:** 6193
- **Status:** open
- **Observed:** 2026-11-05 on macOS
- **Test:** `review regressions > exported paths reuse and force refresh; concurrent publishers preserve readers; idle pruning removes retired revisions`
- **File:** `tests/unit/playwright-webkit-host-libs.test.ts:651`

During `mise run test:logged -- --name merge-default-tests -- mise run test`,
the root group (one worker, alongside five workspace and two bridge slots)
failed opening `private/webkit-1/INSTALLATION_COMPLETE` with `EINVAL` in its
concurrent reader. The test took 41.10 ms and also produced an unhandled error.
Root totals: 3,635 passed, four failed, one error, 185 files, 178.24 seconds.
Two failures were flake-register integration issues subsequently corrected;
the remaining sidebar failure reproduced alone.

The complete owner passed alone (exit 0, 0.4 seconds) with:

```sh
mise run test:logged -- --name merge-webkit-alone -- bun test ./tests/unit/playwright-webkit-host-libs.test.ts --parallel=1 --only-failures
```

It also passed in a three-owner serial rerun. The owner matches `origin/main`
at `df4445371740bf3099c5c50876b2dff397b69758`. A race around publishing or
retiring a generation is a hypothesis; the precise filesystem operation that
caused EINVAL is unproved. No implementation, assertion, timeout or skip changed.

Original group evidence is under
`/private/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.o1RGn7/`
(`root-and-agent-support-tests.log`, compressed on aggregate completion).
The outer logged command uses `orkestrator-test-run.Bg16TH/merge-default-tests.log.gz`
under the same temporary root. Passing rerun output was deleted by the runner.
