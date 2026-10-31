# Focus composer shortcut review validation

- **ID:** 1313
- **Status:** open
- **Date observed:** 2026-10-29
- **Branch:** `focus-input-shortcut-049973214627-r1`, uncommitted changes on
  `022238f56`.
- **Command:** `mise run test` (the exact failed preparation command).
- **Duration:** 447.2 seconds. Root and agent-support, bridges, and the Codex
  protocol lockfile passed. Workspace failed: web 10,762 passed, ten skipped,
  one failed; backend 11,222 passed, 89 skipped, two failed. Desktop, protocol,
  CLI, toolchain, and web-public passed.
- **Host:** shared Linux host, load average about 17–23 during validation.
- **Evidence:** `/tmp/orkestrator-test-run.fvrlPW` (compressed workspace log).

| Unchanged owner | Aggregate failure | Complete owner rerun |
| --- | --- | --- |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | `root-change approval handles over-limit and still permits rejection` exceeded its 5,000 ms deadline (5,380.73 ms). | Passed alone, 3.4 s. |
| `apps/backend/src/core/storage-writer-guards.test.ts` | `raw StorageDatabase writers outside StorageService > name the store they write` exceeded its 5,000 ms deadline (5,781.68 ms). | Passed alone, 5.3 s for the complete file. See existing case 1309. |
| `apps/backend/tests/codex-subagent-cards.test.ts` | `each child keeps one card, its transcript and status across a fresh backend and a cold restart` expected `idle`, received `recovering` (930.21 ms). | Passed alone, 1.8 s. See existing case 0310. |

The complete owner rerun commands were:

```bash
mise run test:logged -- --name approval-timeout-owner -- bun test --cwd apps/web ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name storage-scan-owner -- bun test --cwd apps/backend ./src/core/storage-writer-guards.test.ts --parallel=1 --only-failures
mise run test:logged -- --name codex-subagent-owner -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures
```

All exited zero without assertion, deadline, or skip changes.

The two deadline failures are consistent with shared-host contention; the
cold-restart status mismatch recurs in case 0310. These observations do not
establish a new root cause or turn the failed aggregate into a pass.

## Shortcut regression checks

- `mise run test:logged -- --name focus-shortcut-targeted -- bun test --cwd apps/web ./src/hooks/useFocusComposerShortcut.test.tsx ./src/hooks/useEscapeToStop.test.tsx ./src/components/native-agent/AgentNativeTab.test.tsx ./src/lib/native-draft-attachments.test.tsx --parallel=2 --only-failures`
  passed (27.8 s).
- `mise run test:logged -- --name focus-shortcut-browser -- bunx playwright test --config e2e/playwright.config.ts KeyboardShortcuts.spec.ts --workers=2`
  passed all 60 cases (159.9 s). The eight new cases use the real native agent
  tab, MentionableInput, pane tree, and terminal compose bar for assigned and
  unassigned conversations, both modifiers, and both viewport projects.
- Web and browser-fixture typechecks, scoped lint and formatting, the
  flake-index test, and `git diff --check` passed. Preparation's passing
  full static checks and renderer build were not repeated.

The first strengthened pane-return probe tried clicking a draggable tab in a
fixture with the default immediate drag sensor; its click was suppressed and
its pane stayed inactive. The final probe activates the pane through the input,
then focuses a different control before invoking the chord. No product guard,
assertion, timeout, or skip was relaxed to obtain a pass.

## Exact broad browser rerun

`mise run test:logged -- --name browser -- mise run test:browser` was rerun
verbatim. The browser-fixture typecheck passed. The component suite scheduled
1,009 of 1,068 cases before the logged runner's 1,800-second group deadline
terminated it; 68 failures had been reported. The command exited one and
remains incomplete. The chained public-site suite did not start. Evidence:
`/tmp/orkestrator-test-run.jqU0Jn/browser.log.gz` and
`output/playwright/test-results/`.

All 60 keyboard-shortcut cases, including the eight new focus cases, completed
without a reported failure in this broad run too. The pane-breakpoint cases
also ran without a reported failure. Reported failures were in unchanged
Design Canvas, GitHub setup, mail, shimmer, Multi Review, sidebar drag,
streaming/folding/paging, launch-dialog and data-saving tests. These broad
browser failures were not individually requalified or classified as new flakes;
the targeted green results do not certify the full browser suite. No unrelated
assertion, timeout, skip, or production code was changed to hide them.

## Coordinator recovery review recurrence — 2026-10-31

`mise run test:logged -- --name repaired-full-suite -- mise run test:full`
repeated `root-change approval handles over-limit and still permits rejection`
in `apps/web/src/components/federation/node-action-requests.test.tsx`: the
5,000 ms deadline expired at 7052.91 ms. Workspace reserved four slots with
two isolated workers per package; root reserved one and bridges two. Browser
and Electron reruns also ran on the shared Linux host.

The complete unchanged owner passed alone:
`mise run test:logged -- --name isolated-node-actions-existing -- bun test --cwd apps/web ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures`
(exit zero, 8.2 s; passing output removed by the runner). The same owner also
timed out in preparation before these backend fixes. Evidence is retained in
`/tmp/orkestrator-test-run.eeYqDS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed after completion). This confirms a recurrence without establishing
its cause; no owner assertion, deadline or skip changed. The aggregate also
reported the existing projection-read failure (0722), the unchanged ACP
child-limit assertion and existing DOM-diagnostic guard violations. Its root
group finished with 3,650 passed, one skipped and one failed. None of those
results makes the aggregate green.

The post-storage-repair exact `mise run test:full` rerun completed in 913.8 s
including 204.5 s queued. The web group passed in full (10,963 passed, 10
skipped, zero failed), so the root-change approval owner also passed in this
aggregate. Existing root, ACP and preview/rendering failures keep the command
non-green. Evidence: `/tmp/orkestrator-test-run.UVuLi8/` and
`/tmp/orkestrator-test-run.sFiOj2/`.

## Root-change approval: session history review — 2026-10-31

- **Original command:** `mise run test:logged -- --name review-full-suite -- mise run test`;
  web used two isolated Bun workers alongside component-browser validation.
- **Failure:** `root-change approval handles over-limit and still permits rejection` timed out at 5,125.50 ms. Web totals were 10,879 passed, ten skipped and two failed
  across 720 files. The other web owner also passed separately.
- **Complete unchanged owner:** `mise run test:logged -- --name review-node-request-owner -- sh -c 'cd apps/web && bun test ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures'` passed, exit 0, in 7.3 seconds.
- **Evidence:** `orkestrator-test-run.oNZxqS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory. No implementation, assertion or deadline changed.

## Main merge recurrence — 2026-10-31

`mise run test:logged -- --name merge-default-tests -- mise run test`
repeated `root-change approval handles over-limit and still permits rejection` in
`apps/web/src/components/federation/node-action-requests.test.tsx`: the 5,000 ms deadline expired at 6159.97 ms. The
workspace group reserved six slots (two isolated workers for web), root one
slot, and bridges two; focused merge checks also ran on the shared Linux host.

The complete unchanged owner passed alone (exit zero, 4.3 s):

```sh
mise run test:logged -- --name merge-node-action-owner -- bun test --cwd apps/web ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.L6nmbv/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
and `/tmp/orkestrator-test-run.v7lAtX/`. Passing focused output was removed
by the logger. This confirms a recurrence; shared-host contention remains a
hypothesis. No owner assertion, deadline, skip or implementation changed, and
the isolated pass does not make the aggregate green.

The original aggregate completed in 351.4 s. Web reported 11,111 passed,
ten skipped and three failed across 733 files (343.48 s); the other two
failures were settings guard references to a removed component, repaired
without changing its layout assertions. The backend passed all 12,376 tests.
