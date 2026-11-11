# Inspector transcript: a reader's place across another node, restored short under WebKit

- **ID:** 9981
- **Status:** open
- **Date observed:** 2026-11-11
- **Base:** `14df965440e658e09a7b3ce03530bc1781ac2b01` (`main`).
- **Observed head:** `6cdc3e629` on branch `fix-failing-ci-fc33ea27615f-r1`,
  and the same spec with only a comment changed. The branch's spec change
  (a wheel retry in `wheelUpFromEnd`) runs before this assertion and does not
  touch it; the app code under test is unchanged.
- **Test:** `Build Pipeline keeps a reader's place across another node` and
  `Build Pipeline with a review report keeps a reader's place across another node`
- **File:** `e2e/InspectorTranscriptHide.spec.ts` (the assertion
  `expect(await firstVisibleFrame.evaluate((result) => result.top)).toBe(readerOffset)`
  after the stage tab is clicked again)
- **Browser:** Playwright WebKit (`ORKESTRATOR_E2E_BROWSER=webkit`), both
  viewport projects. Not seen in Chromium.

## Symptom

The transcript's offset in its first visible frame after returning from the
Ticket differs from the reader's settled offset recorded before. The received
value is the same in every failure for a given view and project, while the
expected value varies, as in resolved case
[6380](6380-inspector-transcript-hide-webkit-offset.md):

| View, project | Expected | Received |
| --- | --- | --- |
| Build Pipeline, `mobile-chromium` | 12051 to 12103 | 11550 |
| Build Pipeline with a review report, `desktop-chromium` | 12302 to 12345 | 12243 |
| Build Pipeline, `desktop-chromium` | 11051, 11056 | 10486 |

## Runs

All in Docker with `mcr.microsoft.com/playwright:v1.64.0-noble`, the host's
Playwright 1.65.0 (WebKit build 2388) and Bun 1.4.4, the worktree mounted at
its own path, `CI=1`:

```sh
ORKESTRATOR_E2E_BROWSER=webkit bun x playwright test --config e2e/playwright.config.ts e2e/InspectorTranscriptHide.spec.ts --workers=<n> --repeat-each=<r> [--grep "reader's place"]
```

- `6cdc3e629`'s spec, whole file, `--workers=2 --repeat-each=4`: 56 passed.
- `6cdc3e629`'s spec, `--grep "reader's place" --workers=2 --repeat-each=10`:
  32 passed, 8 failed, all at this assertion (4 in each view).
- The final spec (comment change only), whole file,
  `--workers=1 --repeat-each=4` (CI's worker count): 55 passed, 1 failed at
  this assertion (Build Pipeline, `mobile-chromium`, expected 12089, received
  11550).

Whether CI's Mobile shell (webkit) job hits it was not checked.

## Hypothesis

Unconfirmed. A fixed received value suggests the transcript returns to an
offset recorded earlier (or clamped to a fixed range), not the reader's
settled place. The reader's place is recorded after the wheel animation and
Virtuoso's correction settle (5 unchanged frames, from 6380), so the gap of
about 500 px is more than late movement. Start from 6380's clamp fix in the
transcript controller.

## Recurrence — 2026-11-11 (main CI)

Observed 2026-11-11 in `main` CI run 43093113394, job "Mobile shell
(webkit)", step "Test inspector transcript preservation and settling", head
`963ffa6ab` (PR #2176, agent-testing specs only; nothing under
`e2e/InspectorTranscriptHide.spec.ts` or the transcript controller). This
answers the open question above: CI's WebKit job does hit it. Recorded from
branch `fix-ci-main-1727044b99e3-r1`, base `51456e887`
(`mise run flaky:recurrence -- 9981 --base 51456e887` answered "open").

- **Command:** `bunx playwright test --config e2e/playwright.config.ts e2e/InspectorTranscriptHide.spec.ts --workers=1`
  with `ORKESTRATOR_E2E_BROWSER=webkit`, through `test:logged`.
- **Failure:** `[mobile-chromium] Build Pipeline keeps a reader's place across another node`,
  line 220, expected 12046, received 11550 — the same fixed received value
  as every earlier mobile failure. 13 of 14 passed.
- **Isolated rerun:** not run; this host has no Linux WebKit image set up for
  the spec. The earlier Docker runs above remain the reproduction.

Status stays open; no assertion or wait changed.
