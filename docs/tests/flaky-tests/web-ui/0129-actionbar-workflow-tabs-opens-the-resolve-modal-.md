# `ActionBar workflow tabs > opens the Resolve modal after a mobile long press without launching a default resolve` (`apps/web/src/components/layout/ActionBar.test.tsx:2910`)

- **ID:** 0129
- **Status:** resolved
- **Date observed:** 2026-08-16
- **Original command:**
  `bun run test:logged -- --name web-all -- bun --cwd=apps/web test --parallel=4 --only-failures`,
  at `a9107f112ffe2642388c0279aada5c8430019e7c` on `unify-agent-components`.
- **Worker configuration:** four Bun workers on the web package alone, not under
  `scripts/test-all.ts`. An isolated `dev:test` profile (Electron, Vite, backend,
  bridges) had been running on this host earlier in the same session, so host
  load was above a quiet single-suite run.
- **Failure:** `getElementError` from `tests/bounded-test-diagnostics.ts:28`,
  raised at `ActionBar.test.tsx:2933` — the
  `screen.getByRole("dialog", { name: "Configure conflict resolution" })`
  assertion found no dialog. Duration 736.72 ms.
- **Suite counts:** `5095 pass, 1 fail. Ran 5096 tests across 221 files. [53.17s]`
- **Isolated rerun:** `bun --cwd=apps/web test src/components/layout/ActionBar --parallel=2`
  → exit 0, no failures. The aggregate command had also passed twice earlier in
  the same session at the same commit.
- **Recurrence (retry-gate review follow-up, 2026-08-25):** `bun run test` on
  `environment-log-flood` failed this case after 712.65 ms, now reported at
  `ActionBar.test.tsx:3041` with the same `getElementError` from
  `tests/bounded-test-diagnostics.ts:28`. It failed in the same run as
  `ActionBar keyboard shortcuts and tab guards > dispatches tab, workflow,
  editor, and panel shortcuts`; web workspace group 5,393 passed, 1 skipped,
  2 failed across 233 files. The isolated rerun
  `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` passed
  189/189 in 14.54 s. Consistent with the hypothesis below: the bare
  `setTimeout(575)` has no margin left once the whole file is running behind.
- **Recurrence (backend environment naming, 2026-08-27):** `bun run test`
  (`scripts/test-all.ts`, four top-level groups concurrently; web package at two
  workers) failed this case after 620.13 ms at `ActionBar.test.tsx:3161` with
  the same missing `Configure conflict resolution` dialog. The web package
  reported 5,531 passed, 1 skipped, and 1 failed across 242 files; the other
  three top-level groups passed. The immediate isolated rerun,
  `bun test src/components/layout/ActionBar.test.tsx` from `apps/web`, passed
  198/198 with 770 assertions in 14.10 s; the target passed in 612.04 ms. The
  environment-naming change does not touch `ActionBar`, its long-press timer, or
  conflict-resolution launch state.
- **Hypothesis:** the same wall-clock race already documented and fixed for
  `clears active long-press click suppression when the action bar unmounts`
  above. The case fires a touch `pointerDown`, sleeps a bare
  `setTimeout(575)` — the entire margin over the component's long-press
  threshold — then asserts synchronously. Under contention the timer fires late
  or React commits the dialog after the sleep resolves, and the immediate
  `getByRole` misses it. The documented fix for the sibling case (wait for the
  accessible dialog with a bounded UI wait instead of sleeping past the
  threshold) applies unchanged here; this occurrence is a second instance of the
  same pattern in a case the earlier sweep did not convert. Nothing in the
  failing path touches the transcript, agent cards, or background tasks, which
  are the only areas the change that observed this touched.
