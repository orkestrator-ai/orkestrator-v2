# Diagram source arrow entry intermittently remains collapsed

- **ID:** 2392
- **Status:** resolved
- **Test:** `arrow keys enter and leave a collapsed diagram fence without losing source`
- **File:** `e2e/MarkdownEditorDiagram.spec.ts:39`

On 2026-11-01, notification-bar preparation's `mise run test:logged -- --name browser -- mise run test:browser` reported this mobile Chromium case flaky after a retry. The first attempt expected `data-markdown-diagram-source="open"` and received `collapsed` at the 5000 ms assertion deadline. Captured output does not expose the granted worker count. Browser totals: 1041 passed, 108 skipped, four unrelated Cursor failures and this one flaky case. Evidence: `.orkestrator/review-artifacts/review-validation-eb40d1d2-656b-44f0-9a8f-1c2970a9e415/validation-06.stderr.txt`.

The unchanged case passed on both desktop and mobile with one worker, alongside the notification-bar reload regression (four cases total; logged command passed in 25.1 s):

```sh
ORKESTRATOR_E2E_PORT=15488 mise run test:logged -- --name fix-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/MultiReviewFlow.spec.ts e2e/MarkdownEditorDiagram.spec.ts --grep 'omits redundant fix success|arrow keys enter' --workers=1
```

The cause remains unknown. No diagram code, assertion, timeout or skip changed.

## Coordinator unavailable-platform review — 2026-11-06

The mobile diagram arrow-entry assertion kept data-state=collapsed instead of open for 5 s.
The five-worker browser repeat named nine failures and hit the 1800000 ms
group deadline after starting 708/1596 cases; complete pass totals are not
available. The command was
`ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name browser -- mise run test:browser`.

The unchanged complete owner passed alone, exit 0, in 59.2 s:

```sh
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-diagram-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/MarkdownEditorDiagram.spec.ts --workers=1 --output output/agent-testing/review-address-owners/diagram
```

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.8yBzhf/browser.log.gz`.
Passing output was deleted by the logged runner; individual passing counts
were not retained. This establishes intermittence, not a cause or an overall
browser pass. No assertion, timeout, skip or implementation was changed.


## Bridge authority review repairs — 2026-11-06

At `451fccdf1`, the nine-worker command
`mise run test:logged -- --name repair-browser -- mise run test:browser`
reported 1,513 passed, 135 skipped and six failed (1,654 cases; 1,225.3 s).
Evidence: host temporary artifact
`orkestrator-test-run.C3ovaT/repair-browser.log.gz`. The browser implementation
and this test are unchanged by the bridge-authority branch.

The mobile arrow-entry case again stayed `collapsed` instead of `open` at
line 55. In the unchanged complete one-worker owner it passed in both viewports,
but the owner failed a different desktop editing assertion at line 31
(`B --> C[GraphRun]` absent from the typed source): ten passed, one skipped,
one failed, 32.8 s. This is not a complete owner pass.

```sh
mise run test:logged -- --name isolate-diagram -- bunx playwright test --config e2e/playwright.config.ts e2e/MarkdownEditorDiagram.spec.ts --workers=1 --output output/agent-testing/address-browser-reruns/diagram
```

Owner failure evidence: host temporary artifact
`orkestrator-test-run.35iCrD/isolate-diagram.log.gz`. Status remains open;
no implementation, assertion, timeout or skip changed.

## Resolution — 2026-11-10

**Reproduced: yes.** Before the fix, the three-worker, three-repeat selection
of the diagram editing/arrow and streaming-find cases failed the desktop
editing assertion (the typed prefix was missing). After synchronizing editor
focus, the arrow case still failed three times across desktop/mobile.
A new focused unit test failed for both Mermaid and chart fences: ArrowLeft
left the selection in the paragraph instead of entering the source.

**Root cause and fix.** Tiptap schedules DOM focus in an animation frame; the
node view opens before that frame. The typing test now waits for editor focus.
The arrow test now sets the editor's selection rather than racing a raw DOM
selectionchange. That exposed the product gap: the collapsed source has no
useful native caret geometry. `MarkdownCodeBlock` now crosses only adjacent
diagram boundaries through document selections, retaining ordinary editing
and the parent shortcuts. Unit coverage checks both entry/exit directions,
Mermaid/chart sources, ranges, and ordinary within-source movement.

**Verification.** The focused unit owner passes. Both complete browser owners
(`MarkdownEditorDiagram.spec.ts` and `StreamingTranscript.spec.ts`) passed
three repeats at three workers after the fixes, without changing timeouts,
skips or assertions. Commands ran through `test:logged`: `diagram-arrow-repro`
(failed before), `diagram-arrow-fixed` (passed), and
`diagram-and-streaming-fixed` (passed in 92.4 s). Evidence is under
`output/agent-testing/notes-repair-{before,after,owners-fixed}/`.
