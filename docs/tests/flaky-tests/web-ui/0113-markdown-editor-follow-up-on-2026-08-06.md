# Markdown editor follow-up on 2026-08-06

- **ID:** 0113
- **Status:** open
### `TiptapMarkdownEditor` rendered-edit synchronization

- Test file: `apps/web/src/components/markdown/TiptapMarkdownEditor.test.tsx`
- Initial aggregate command: `bun run test` (web workspace group:
  `bun test src --parallel=2`)
- Initial aggregate result: 5,256 passed, 1 skipped, 96 failed; most failures
  were unrelated UI timeouts during the same load-triggered cascade
- Initial target failure: `inserts a separator when adding the first body to
  EOF frontmatter` did not observe its second debounced `onChange` within the
  Testing Library deadline (1,600.74 ms), although the failure DOM already
  contained `Second body`
- Recurrent reduced-worker command: the repository test runner invoked through
  `runAllTests({ cores: 4 })`, which ran the web suite with one Bun worker
- Recurrent target failure: `debounces rich-editor changes into Markdown` did
  not observe the 300 ms callback within a 2,000 ms Testing Library deadline
  (2,105.63 ms)
- Isolated command before the fix: `bun test src --parallel=2` from `apps/web`
- Isolated result before the fix: 5,352 passed, 1 skipped, 0 failed across 217
  files in 82.02 seconds

The production debounce was correctly scheduled, but these tests used elapsed
wall time as their synchronization signal. Under the aggregate runner, unrelated
process and UI-test load could delay both the 300 ms production timer and the
Testing Library polling timer past the assertion deadline.

Fix: serialization-only cases now call the editor's explicit
`flushPendingChanges()` boundary. Debounce-specific cases intercept only the
300 ms store-sync timeout, assert that no early write occurs, run the captured
callback explicitly, and verify that repeated updates leave only the latest
callback scheduled.

Verification:

```sh
bun test src/components/markdown/tiptap-extensions.test.ts \
  src/components/markdown/TiptapMarkdownEditor.test.tsx \
  src/components/markdown/MarkdownEditorTab.test.tsx --parallel
```

Result: 51 passed, 0 failed in 0.98 seconds. Web typechecking and
`git diff --check` also passed.

Status: resolved; the Markdown coverage no longer depends on elapsed wall time.
The aggregate runs also produced failures outside the Markdown scope. Those are
not classified here unless their owning file was rerun independently.

A follow-up full-file stress run exposed the same test-harness pattern in
`preserves EOF TOML frontmatter when saving the first body`: 3 of 280 cases
failed because direct DOM mutation plus one microtask did not always establish
Tiptap's pending state before Ctrl+S. The exact test passed 50/50 alone. All
remaining rich-editor test mutations now use `editor.commands.setContent()`
inside `act`. The stress run also showed that a source-preservation test could
not require the React.lazy fallback after the mock module had already loaded;
that assertion was removed while retaining the raw-source assertion.

Post-fix stress verification:

- `TiptapMarkdownEditor.test.tsx`: 280 passed, 0 failed across 20 runs
- `MarkdownEditorTab.test.tsx`: 260 passed, 0 failed across 20 runs

### `DiffViewerTab` aggregate cascade

- Test file: `apps/web/src/components/terminal/DiffViewerTab.test.tsx`
- Status: resolved
- Original command: `bun test src --parallel=2` from `apps/web`
- Worker configuration: Bun reported `2x PARALLEL`
- Aggregate result: 5,349 passed, 1 skipped, 3 failed across 217 files
- Failures:
  - `DiffViewerTab immutable base cache > bounds retained commit bases to 128
    entries` timed out after 5,000 ms (duration: 5,003.66 ms)
  - `DiffViewerTab editor lifecycle and controls > waits for Monaco
    configuration before mounting the diff editor` expected one Monaco setup
    call but received 39 (duration: 1,015.27 ms)
  - `DiffViewerTab editor lifecycle and controls > keeps the diff editor retry
    usable after a second consecutive failure` expected three Monaco setup calls
    but received five (duration: 8.19 ms); the log also reported a late cache
    assertion from the timed-out test as an unhandled between-test error
- Isolated command: `bun test src/components/terminal/DiffViewerTab.test.tsx
  --parallel`
- Isolated result: 47 passed, 0 failed with 165 assertions in 0.91 seconds
- Hypothesis: the first timeout left cache work and renders alive across test
  boundaries, contaminating later Monaco call counts. The owning file's clean
  rerun proves the aggregate failure is intermittent, but the trigger and a
  deterministic fix have not yet been established.
- Root cause: the cache-cap test mounted, initialized, queried, and unmounted a
  complete React diff viewer 130 times merely to exercise a 128-entry module
  cache. Aggregate scheduling could push that unrelated UI work beyond Bun's
  five-second budget. Once the test timed out, its remaining async renders ran
  across the test boundary and inflated the following Monaco setup call counts.
- Fix: expose a narrow test helper around the same production cache function and
  drive the 130 cache keys directly. Component-level tests still cover cache
  reuse, moving refs, rejection eviction, and key separation; only the capacity
  test avoids redundant editor lifecycles.
- Verification: `bun test src/components/terminal/DiffViewerTab.test.tsx
  --rerun-each 10` -> 470 passed, 0 failed. The capacity case now completes in
  0.13-0.37 ms, and the following Monaco lifecycle tests retained their exact
  call-count assertions across all ten runs.
