# Static HTML browser specs time out under host load

- **ID:** 6040
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Tests:** in `e2e/StaticHtmlTranscript.spec.ts`, including `Find matches a report's body once it has been shown, and leads back to its card`, `opening a conversation frames nothing until a report is reached` and `scrolling through more reports than slots stays bounded, with no reload or failure`; in `e2e/StaticHtmlArtifact.spec.ts`, including `the real frame reports the document's text to the card, and nothing else` and `a reload replays the same published document`. Mobile and desktop projects both.
- **File:** `e2e/StaticHtmlTranscript.spec.ts`, `e2e/StaticHtmlArtifact.spec.ts`
- **Original command:** `bunx playwright test --config e2e/playwright.config.ts e2e/StaticHtmlTranscript.spec.ts e2e/StaticHtmlArtifact.spec.ts`, plus a temporary screenshot spec, through `test:logged`, on the branch for to-do 5780 (retired 2026-11-11; `git show 498b68766:docs/todo/transcripts-and-observation/5780-find-inside-static-documents.md`) before its commit.
- **Worker configuration:** the default (half the cores), on a host with a load average of about 44 from other work.
- **Failure:** `Test timeout of 30000ms exceeded`, on steps that do nothing slow themselves: `page.reload`, `keyboard.press`, `locator.fill`. The run reported 44 passed and 24 failed, four of the 24 being the temporary spec.
- **Reruns:** `--project=desktop-chromium --workers=2 e2e/StaticHtmlTranscript.spec.ts -g Find` at the default timeout: 2 passed, and `Find matches a report's body…` failed at about 31 s. Its trace shows every step finished: 15 s were the first navigation, and 5.5 s and 6.3 s were the two passes that index the 3,000-message fixture. `--workers=3 --timeout=150000` over both files and both projects: all passed, load average about 27.
- **Not established:** no run at the default timeout passed on an idle host, and the base commit was not measured under the same load, so this does not show how much of the budget each cost.
- **Hypothesis:** the 30 s budget is close to what these specs need on a loaded host, because the fixture's first load and Find's full index take most of it. Unconfirmed. The two Find specs added with 5780 use `test.slow()` for that reason; the existing ones were left as they are.


## Find review repair — 2026-11-11

On `document-find-bug-3a3f9ad04ef2-r1` at `bdc583ce4` (base `498b68766`), a
targeted ten-spec browser run beside another checkout's browser suite (load
average about 30 to 36, default workers) failed four mobile `StaticHtmlArtifact.spec.ts` cases on `page.goto`/`page.reload` 30 s timeouts. The complete unchanged
owner then passed alone with two workers. `mise run flaky:recurrence -- <case>
--base 498b68766` reported the case open. Details and commands:
[9954](../aggregate-validation-runs/9954-find-review-targeted-browser-run-under-host-load.md).
No assertion, skip or timeout changed; root cause remains unconfirmed.

## Triage note (2026-11-15)

Class A candidate. A navigation (`page.goto`/`page.reload`) or step used up Playwright's 30 s test deadline, or an assertion hit the 5 s `expect` default, while the host was loaded. The spec has no fixed sleep or ad-hoc wall-clock check of its own on the failing path. Nothing was changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`timeout` and `expect.timeout`), but every group's component specs share that config, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced, because the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** Playwright's default deadlines ran out on a loaded host while the test was waiting on a real signal. Every recorded failure is the 30 s default test timeout (`Test timeout of 30000ms exceeded`, in `page.goto`, `page.reload`, a click or a web-first assertion still in progress) or the 5 s default `expect` budget; none is a value mismatch, crash or lost interaction, and the failing calls pass no smaller timeout of their own. The specs measure no latency, so those defaults were acting as speed checks rather than hang watchdogs.
- **Fix:** the component browser config, `e2e/playwright.config.ts` (`mise run test:browser`), now sets `timeout: 120_000` (was Playwright's 30 s default) and `expect: { timeout: 30_000 }` (was 5 s). Navigations carry no timeout of their own, so they are bounded by the 120 s test timeout. No assertion changed.
- **Reproduced:** no — the recorded failure was not reproduced before the change. The evidence is weaker: a rerun of the component browser specs that had failed in a loaded run, with the new config, gave 112 passed; the one remaining failure there (`ToolGroupFold.spec.ts:127`, [1012](../web-ui/1012-live-tool-fold-threshold-gap.md)) also fails with main's config and is unrelated.
- **Stress:** none beyond that rerun.

A recurrence that hangs until near the new budget (a navigation or assertion timing out at 120 s or 30 s) is a real hang, not this deadline: reopen this case and record it.
