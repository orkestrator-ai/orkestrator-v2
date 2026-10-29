# Temporary-directory cleanup (0247) review validation

- **ID:** 1304
- **Status:** open
- **Date observed:** 2026-10-29

Host: Arch Linux, Bun 1.4.4, implementation commit `0e1c9ffe5`.
The failing owners below are unchanged by that commit. No tests were skipped,
loosened or reordered to conceal failures.

## Default suite

Command: `mise run test:logged -- --name review-fixes-default -- mise run test`.
Completed with exit 1 after 627.2 s. Root/agent support (471.3 s), bridges
(192.2 s), and the protocol lockfile (954 ms) passed. The workspace group
failed: backend had 10,163 passed, 89 skipped, 2 failed across 667 files;
web had 10,396 passed, 10 skipped, 3 failed across 655 files. Backend used
four Bun workers, web two, root one, and the bridge group two worker slots.
The browser suite below ran concurrently. Host load measured near the end
was 21.76 / 30.11 / 20.44; load is a possible contributor to deadline
failures, not an established explanation for every failure.

Evidence: `/tmp/orkestrator-test-run.VMMftv/summary.json` and its compressed
per-group logs; wrapper evidence `/tmp/orkestrator-test-run.uEqd1z/`.

Complete owner reruns used `mise run test:logged -- --name <label> -- bun test
--cwd <workspace> ./<owner> --parallel=1 --only-failures`. The following table
supplies the workspace and owner for each command; labels were respectively
`review-storage-guard`, `review-coordinator-starts`, `review-markdown-parse`,
`review-native-commands`, and `review-node-approval`.

| Workspace and owner | Aggregate failure | Complete owner rerun |
| --- | --- | --- |
| `apps/backend`, `src/core/storage-writer-guards.test.ts` | `raw StorageDatabase writers outside StorageService > name the store they write`: 5 s deadline, reported 8,026.58 ms. | Still failed at 5,875.95 ms; 35 passed, 1 failed, 10.5 s. `/tmp/orkestrator-test-run.UAm6wH/`. Not newly classified as flaky. |
| `apps/backend`, `src/core/commands-registry-coordinator.test.ts` | `coordinator command registry > deduplicates concurrent build starts`: `Associated build pipeline was not found`, 258.72 ms. | Complete unchanged owner passed in 9.1 s. Credible flake; the pending-association race needs investigation. |
| `apps/web`, `src/lib/chat/rich-markdown/incremental-parse.test.tsx` | `incremental parse reuse > a long streamed answer parses each completed segment once`: 5 s deadline, reported 5,695.01 ms. | Complete unchanged owner passed in 19.2 s. Credible aggregate deadline flake. |
| `apps/web`, `src/components/native-agent/AgentNativeTab.commands.test.tsx` | `AgentNativeTab commands > typing after the sigil filters a maximal list without fetching, refreshing or scanning`: expected 1 projection read, received 2, 2,432.99 ms. | Still failed with 2 reads, 2,547.23 ms; 25 passed, 1 failed, 11.7 s. `/tmp/orkestrator-test-run.k3Bfp8/`. Existing [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md); this occurrence is not isolated-green. |
| `apps/web`, `src/components/federation/node-action-requests.test.tsx` | `root-change approval handles over-limit and still permits rejection`: 5 s deadline, reported 6,158.20 ms. | Still failed at 6,311.44 ms; 10 passed, 1 failed, 9.1 s. `/tmp/orkestrator-test-run.W6gxdO/`. Not newly classified as flaky. |

Initial root-directory attempts to run the three web owner files collected no
tests because the root Bun configuration excludes `apps/web/src/**`. Only the
corrected workspace commands in this table count as owner reruns.

## Browser suite: incomplete and non-green

The preparation command was rerun verbatim with separate fixture ports:

```bash
ORKESTRATOR_E2E_PORT=15427 ORKESTRATOR_PUBLIC_E2E_PORT=45427 mise run test:logged -- --name browser -- mise run test:browser
```

This repaired the previous HTTP 403 from another checkout's fixture server.
E2E typechecking passed (2,041 files). The component suite used six workers.
After 606.6 s it was deliberately interrupted with SIGINT to its own
Playwright CLI, having reported failures in unchanged owners. Final result:
18 failed, 5 interrupted, 57 skipped, 785 not run, 173 passed; exit 130.
The public-site suite after the component command did not run. No browser
owner reruns were performed, so these failures are not newly classified as
flakes.

Failures included the two `AgentUsage.spec.ts:38` mobile cases, Agent Stop
layout in `BackgroundTaskOutcome.spec.ts:47`, the real-change recovery case
in `ChangeTracking.spec.ts:80`, Claude URL/pause rehydration, the restored
pane switcher, DesignCanvas, environment/global settings, five keyboard
shortcut cases, mail search, and two MultiReviewFlow cases. Most were 30 s
timeouts or missing controls; the full titles, errors and traces are retained
in `/tmp/orkestrator-test-run.dOl62H/browser.log.gz` and
`output/playwright/test-results/`.

## Changed-area checks

The nine focused backend owners passed (125 tests), including the added late
queue, stop-error, removed-storage, and Git exclude-write ordering cases.
The final worktree-location owner rerun passed in 10.4 s. The documentation
workspace guard passed. Changed-file formatting, lint, and backend production
and test typechecking passed. Preparation's passing repository-wide lint and
typecheck were reused; neither was rerun globally. No live-agent, Docker,
Electron or iOS qualification was performed for these test-only changes.
