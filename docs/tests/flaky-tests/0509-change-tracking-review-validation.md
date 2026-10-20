# Change-tracking review validation under concurrent host load

- **ID:** 0509
- **Status:** open
- **Date observed:** 2026-10-20
- **Checkout:** `implement-file-change-f3950a40ac3a-r1`
- No assertion, timeout, or skip was weakened.

## Backend aggregate

`mise run test:logged -- --name complete-tests -- mise run test` reserved
workspace/root/bridges/protocol slots 4/1/2/1; the backend used two isolated
workers. The backend reported 9,705 passed, 67 skipped, four failed, and one
between-tests error across 550 files in 511.61 seconds. Root reported 3,149
passed, one skipped and one failed. Bridges and protocol generation passed.

Two failures were deterministic integration findings and were fixed: the
provider-name architecture boundary and the public CLI history ordering.
Renderer history now requests newest-first pages explicitly, preserving the
CLI's documented oldest-first contract.

The unrelated backend failures were:

- `Electron backend environment lifecycle commands > removes the environment even when remote branch deletion fails for a non-404 reason`
  (`apps/backend/tests/commands-registry-environments.test.ts`): 5,328.61 ms,
  beyond the five-second timeout.
- `Electron backend environment lifecycle commands > retains the environment and process ownership when deletion cannot reap a server`
  (same file): 7,321.12 ms, beyond the five-second timeout (0226 recurrence).
- `restart recovery re-links submodules of an adopted or abandoned copy`
  (`apps/backend/src/core/environment-move.test.ts`): 5,142.10 ms, followed by
  its interrupted asynchronous assertion (0248 recurrence).

The unchanged owning files passed separately:

- `mise run test:logged -- --name deletion-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures`
  passed in 24.2 seconds.
- `mise run test:logged -- --name move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures`
  passed in 24.5 seconds.

The logged runner deletes passing output; isolated per-test counts were not
retained. The aggregate evidence is
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.OL6bYf/`
and the outer log is in `orkestrator-test-run.9b7NoV/` beside it. Host contention
is a plausible contributor, consistent with 0226 and 0248; not established.

## Component browser aggregate

`mise run test:logged -- --name browser-suite -- mise run test:browser` used
nine Playwright workers: 364 passed, 80 skipped, four failed in 160.8 seconds.
All failures were mobile cases in the unchanged `e2e/MultiReviewFlow.spec.ts`:

- `shows elapsed time and tokens side by side on running nodes`
- `settles across the graph breakpoint with an 8px scrollbar gutter`
- `keeps the node reached from the keyboard in view at the 32-reviewer maximum`
- `pans the zoomed graph by dragging the canvas and with Ctrl + wheel zoom`

The breakpoint case reported `Execution context was destroyed, most likely
because of a navigation`. Renderer sources were being finalized during that
run, making Vite reloads a plausible contributor. This is not evidence of a
Multi Review product regression. The unchanged owner passed with one worker:

`mise run test:logged -- --name multi-review-browser-repro -- bunx playwright test --config e2e/playwright.config.ts MultiReviewFlow.spec.ts --project=mobile-chromium --workers=1`

The owning file passed in 38.7 seconds; passing output was deleted by the
runner. Original evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.l0Jg7L/`.
A complete component rerun with frozen renderer sources and two workers was
started, alongside a separate public-site browser run.

## Finalized component rerun and Claude fixture recurrence

The complete component browser rerun passed with two workers in 296.7 seconds:
`mise run test:logged -- --name final-browser -- bunx playwright test --config e2e/playwright.config.ts --workers=2`.
The public-site browser suite passed separately with two workers in 10.7 seconds.

The second non-iOS aggregate repeated the known 0385 Claude fixture race:
`plan approval flow > keeps plan mode enabled when an approved exit cannot be persisted`
in `bridges/claude-bridge/src/services/session-manager-interactions.test.ts:863`
failed with `EISDIR` while planting its `.claude` sentinel (1.64 ms). The
unchanged owning file passed via
`mise run test:logged -- --name claude-interactions-owner -- bun test ./bridges/claude-bridge/src/services/session-manager-interactions.test.ts --parallel=1 --only-failures`
in 0.3 seconds. Evidence is in `orkestrator-test-run.W1VMY3/bridges.log`
(compressed after aggregate completion) beside the other temporary directories.

## Isolated gateway validation

The full credential-free isolated browser run used profile
`qa-browser-c5d17b0b-f7b`: 27 passed, 37 skipped, two failed in 436.7 seconds.
One failure was the old diff-tooltip assertion; it now checks the full pinned
baseline and current-file endpoint. The other was the known narrow repository
settings picker at `browser-gateway.spec.ts:239` (0494): its button became
hidden while Playwright attempted to click it.

A fresh profile, `qa-browser-a82cc8b1-f1c`, ran the entire gateway owning file
with one worker: 14 passed, six skipped, one failed in 156.5 seconds. The
persisted-diff background/reload scenario passed with the updated endpoint
assertion. The unchanged narrow picker failed again at the same line, so this
observation does **not** independently establish a flake. It remains an
unrelated validation limitation; no picker code or assertion was changed.
Evidence: `orkestrator-test-run.R5wvQY/` and `orkestrator-test-run.E1bIkd/` in
the same temporary directory root. Both profiles were stopped and reset by the
isolated runner, including exact-owner process and disposable-state cleanup.

## Final non-iOS aggregate

`mise run test:logged -- --name final-complete-tests -- mise run test` finished
in 502.2 seconds. Root passed (3,150 passed, one skipped), protocol generation
passed, and web, desktop, public web, CLI, toolchain, protocol, Pi, Cursor,
Codex and ACP package suites passed. The only remaining failures were:

- Backend: `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches`
  (`apps/backend/src/core/coordinator-service.test.ts:623`), 5,189.58 ms, past
  its five-second deadline. Backend totals: 9,710 passed, 67 skipped, one
  failed across 550 files. This is a 0165 recurrence. The unchanged owning
  file passed in 11.1 seconds with
  `mise run test:logged -- --name coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`.
- Claude: the 0385 fixture race recorded above (1,600 passed, five skipped,
  one failed); its unchanged owning file passed separately in 0.3 seconds.

Final aggregate evidence: `orkestrator-test-run.W1VMY3/`; outer wrapper:
`orkestrator-test-run.pzs1nF/`. Final format, lint and typechecks passed via
`final-types-and-lint` (13.3 seconds). Focused change-tracking, shell,
protocol, renderer, Pi, architecture and test-ownership checks passed. Real
container execution was covered by the Docker command shim; standalone
Docker, Electron and iOS scenario suites were omitted because those platform
lifecycles were unchanged. Credentialed live-provider scenarios were skipped
in the credential-free isolated profile.
