# Reviewer session models arrive in a different order

- **ID:** 0243
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `build pipeline multi-model review > fans out to every reviewer, consolidates, then addresses the merged report`
- **Owning file:** `apps/backend/src/core/build-pipeline-review-fanout.test.ts:186`
  (registered as line 716. The failing assertion is now at line 247.)
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`
  on `vh-multireview-fence-checks-14f5158f73c9`, merging `origin/main` at
  `d087e44f` into `acb1807e`.
- **Worker configuration:** four workspace slots (two package tasks with two
  Bun workers each), one root slot, two bridge slots and one protocol slot.
  Other worktrees were also validating on the host.
- **Failure:** Expected reviewer session models `[opus, sonnet]`; received `[sonnet, opus]` (69.42 ms).
- **Suite counts:** Backend: 7,983 passed, 39 skipped, 2 failed across 434 files (299.03 s). The full run exited 1 after 344.9 s;
  backend had two failures and root had one. Bridges and protocol passed.
- **Isolated owning-file rerun:** `mise run test:logged -- --name merge-fanout-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/build-pipeline-review-fanout.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0 (2.1 s).
- **Evidence:** `/tmp/orkestrator-test-run.ZdmgHl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  aggregate summary at `/tmp/orkestrator-test-run.Dt7ssz/summary.json`.
- **Second observation:** GitHub Actions `main` run 38893184821, job "Unit
  and integration tests", in `@orkestrator/backend:test:workspace`
  (`--only-failures --parallel=${ORKESTRATOR_TEST_WORKERS:-2}`). The
  assertion at line 247 received `[sonnet, opus]` (207.10 ms).
- **Original hypothesis:** The assertion compares the insertion order of asynchronously admitted reviewer sessions. The observed reversal suggests completion order can differ from configured reviewer order; no implementation change or deterministic reproduction was attempted.
- **Root cause:** the test asserted an order that production does not
  guarantee. `ReviewFanoutRunner` advances reviewers as concurrent bounded
  tasks (`runBoundedTasks` in `review-fanout.ts`). The build pipeline creates
  each reviewer's `PipelineSession` lazily, when the runner first observes that
  reviewer with a provider session (`mirrorReviewerSession` → `ensureSession` in
  `build-pipeline-review-fanout.ts`). So `pipeline.sessions` is in admission
  order, not panel order. Under load, the sonnet reviewer's `createSession` can
  resolve first and be pushed first. Order is not part of the contract.
  Each session's panel slot is carried by its `Review N` label
  (`pipelineIndependentReviewLabel(index)`). The web stage rail letters
  reviewers from that slot. `apps/web/src/components/build-pipeline/BuildChatTab.test.tsx`
  already covers out-of-order sessions:
  `letters a surviving later reviewer from its Review N slot, not session order`.
  `pipeline.sessions` is also a chronological journal, and
  `currentSessionIndex` follows the newest session. Reordering it by slot in
  production would therefore be wrong.
- **Fix:** this branch. The assertion now binds models to panel slots
  instead of array positions. The label-to-model map built from
  `reviewSessions` must equal `{ "Review 1": "opus", "Review 2": "sonnet" }`.
  This is stricter than an order-insensitive model comparison because it
  still catches a model attached to the wrong slot. Production code is
  unchanged.
- **Verification:**
  - Reproduced before the fix: a temporary 20 ms delay in
    `FanoutProvider.createSession` for `options.model === "opus"`
    (`build-pipeline-review-fanout-test-support.ts`) made the old assertion
    fail deterministically, receiving `[sonnet, opus]`. With that delay in
    place, the new assertion passed. The injection was reverted.
  - Owning file, from `apps/backend`:
    `bun test --preload ../../tests/setup-node.ts ./src/core/build-pipeline-review-fanout.test.ts --rerun-each 50`
    → 2,300 pass, 0 fail (67.3 s).
  - CPU stress: 18 `yes` burners on 18 cores, same file `--rerun-each 20` →
    920 pass, 0 fail (40.5 s).
  - Backend workspace suite:
    `bun test --preload ../../tests/setup-node.ts src tests --only-failures --parallel=2`
    → 8,467 pass, 12 fail across 454 files. The fan-out file passed, and none
    of the 12 failures are in it. They were standalone backend service cases
    that need a packaged runtime, plus timeouts on a loaded host: overlong
    drifted paths, git askpass and Electron tmux hooks.
  - `oxfmt`, `oxlint` and `tsc --noEmit -p tsconfig.json` /
    `tsconfig.test.json` in `apps/backend` passed.
