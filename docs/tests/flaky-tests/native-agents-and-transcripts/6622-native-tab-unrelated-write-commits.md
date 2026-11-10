# Native tab unrelated-write assertion observes two commits

- **ID:** 6622
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `an unrelated environment field does not render a tab holding a transcript`.
- **File:** `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx:359`.
- **Original command:** `mise run test:logged -- --name findings-owning-units -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx ./src/components/chat/NativeChatShell.test.tsx ./src/lib/transcript-scroll/keep-mounted.test.ts ./src/components/chat/SuborkGroup.test.tsx --parallel=2 --only-failures`.
- **Worker configuration:** two isolated Bun workers; other worktrees were running validation on the same host.
- **Failure:** at line 365, `expect(commits).toBe(0)` received `2`; test duration 2313.25 ms. Suite: 107 passed, 1 failed, 440 assertions, four files, 34.95 s.
- **Original artifact:** `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.yozIGN/findings-owning-units.log.gz`.
- **Owning-file rerun:** `mise run test:logged -- --name findings-render-count-alone -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures` first repeated the same failure (33 passed, 1 failed, 121 assertions, 28.70 s; artifact `orkestrator-test-run.x4F2lX/findings-render-count-alone.log.gz` under the same private temporary root). Repeating that exact command with the original file unchanged then passed all 34 tests (logged runner 35.4 s).
- **Additional diagnostic:** selecting the failing test alone passed (7.9 s). Temporary logging probes were removed before the passing complete-file rerun; no assertion, mock, production behavior, or timeout was changed.
- **Context:** observed while adding browser coverage for Claude task snapshots and Subork dialog render counts, on `55e77dea5`. Those browser-only files are not imported by this unit test. All 16 desktop transcript browser cases passed.
- **Hypothesis:** the helper ends startup settling after a single quiet 40 ms interval; delayed startup work may arrive during the subsequent unrelated write. This has not been established as the cause. A failure in a complete-file run alone means worker parallelism is not a sufficient explanation.

## Resolution (2026-11-05)

Temporary probes showed a fresh message array arriving during the unrelated-write measurement, although the environment changes retained the selected settings. The fixture answered every metadata read with a full snapshot, including requests carrying its current token. It now answers those reads `unchanged` for transcript, session state and discovery, matching the progressive-read protocol and the browser fixture. The zero-commit assertion and its timeout are unchanged.

Fix: the token-aware mocks in `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx`. After the fix, the exact isolated owner command passed all 34 cases (30.4 s), and the original two-worker four-file command passed all 108 cases (30.3 s). The previously observed worktree-path timeout is recorded separately as 6623; its cause is unestablished.

## Recurrence (2026-11-10)

Observed on base `60afa4b715bd465d441d28a4cb9a513928d2ccb8`, which contains
fix `e1b83430d7` (`mise run flaky:recurrence -- 6622 --base 60afa4b715bd465d441d28a4cb9a513928d2ccb8`
confirms this is a recurrence). The recorded command was
`mise run test:logged -- --name review-default-tests -- mise run test` (default
aggregate worker plan). The same assertion at line 406 received 1 instead of 0
(462.79 ms); captured totals: 32,008 passed, 1 failed, 161 not run.
Evidence is retained in
`.orkestrator/review-artifacts/review-validation-da793d72-6b7e-4681-bb5d-425de17c0d17/validation-04.stderr.txt`.
The branch changes the imported protocol pane-layout module, so failure triage
labels the failure related (`imports-changed-file`); this alone does not establish
a cause for the render. The unchanged owning file passed when rerun:
`mise run test:logged -- --name findings-render-count-alone -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures`
(logged runner 4.7 s). No production or assertion change was made for this
failure. The recurrence's cause remains unestablished; token-aware mocks are
already present, so the prior fix does not explain this observation.

The exact recorded default-suite command was rerun after the Notes repair.
Its web group passed (14,330 passed, 0 failed, 10 skipped; 984 files, 485.34 s),
clearing this round's render-count failure. The aggregate still exited 1 because
of the separate voice-chat fixture readiness failure recorded in case
[9915](9915-voice-chat-reply-start-readiness.md). This pass does not establish a
fix for case 6622's intermittent cause; the case remains open.
