# Inspector transcript hide: a review report's first offset under WebKit

- **ID:** 6380
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `Build Pipeline with a review report shows the newest message when its pane returns`
- **File:** `e2e/InspectorTranscriptHide.spec.ts:74`
- **Browser:** Playwright WebKit (`ORKESTRATOR_E2E_BROWSER=webkit`), both viewports

Reported at about 75% of runs on WebKit. In the `mobile-shell-browser` job on
`main`, the step `inspector-transcript-webkit` failed in 4 of the 5 completed CI
runs from 2026-11-05 checked:

| Run | Commit | `inspector-transcript-webkit` |
| --- | --- | --- |
| 42095512494 | `44d22d844` | failed |
| 42095657507 | `8c1c54c10` | failed |
| 42095680675 | `009da1548` | failed |
| 42095902842 | `209b1249b` | failed |
| 42096069100 | `41f9eb638` | no failure in the failed-steps log |

In all four failures this view failed and the other two views in the spec
(`Build Pipeline`, `Graph Run`) did not. The failing assertion compares the
overview offset with the value recorded before the hide: `mobile-chromium`
received 12686 in all four runs (expected 12688, 12715, 12707, 12759) and
`desktop-chromium` received 11953 in the three runs that failed there (expected
12005, 11991, 12004). The expected value varies and the received one does not.
This is the brief offset [to-do 5620](../../../todo/coordinator-and-multi-review/5620-pipeline-transcript-place-and-webkit-settling.md),
task 2 describes, and the cause is not traced there.

```sh
ORKESTRATOR_E2E_BROWSER=webkit mise run test:logged -- --name inspector-transcript-webkit -- bunx playwright test --config e2e/playwright.config.ts e2e/InspectorTranscriptHide.spec.ts --workers=1
```

Not reproduced locally: on beelink on 2026-11-05 Playwright's WebKit could not
launch (`browserType.launch` failed for all 48 attempts of `--repeat-each=8`), so
no isolated rerun was possible there. No assertion, timeout or retry was changed.
