# Cold-restart main-merge validation limits

- **ID:** 0662
- **Status:** open
- **Date observed:** 2026-10-21
- **Scope:** merge `origin/main` at `d4171748` into `e9e603a3` on `qualify-cold-restart-reconcile-c5a876531b5f`; 44 incoming or resolved paths, including backend, desktop, renderer, protocol, Docker and test changes.
- **Configuration:** pinned Bun 1.4.3; concurrent worktrees occupied all 18 host scheduler slots at admission. This establishes queue contention, not the cause of individual assertion failures.

## Aggregate and component browser results

`mise run test:logged -- --name merge-full-suite -- mise run test` exited 1
after 1801.0 seconds when the outer logged command reached its 30-minute absolute
deadline. The workspace group never obtained capacity. Root/support started after
404.7 seconds but did not complete; it had reported 15 timeout failures in
`test-all.test.ts`, `firewall-refresh.test.ts`, `firewall-policy.test.ts`,
`pi-bridge-vendor.test.ts`, `test-diagnostic-bounds.test.ts` and
`disk-report.test.ts`. None of those owners changed in the merge.

The Codex protocol regeneration check passed. Bridges started only after 1794.3
seconds: although cancellation printed a `PASS bridges` label, the captured Turbo
summary reports zero successful tasks out of five. Do not count this as bridge
coverage. The aggregate is incomplete, not green.

Evidence: `orkestrator-test-run.JNAw7y/merge-full-suite.log.gz` and the bounded
group logs in `orkestrator-test-run.UlOCv4` below the host temporary directory.

The first `mise run test:browser` attempt refused port 1422 because its fixture
belonged to another checkout (`orkestrator-test-run.M0RtSb`). A rerun with private
component/public ports (`merge-component-browser-private`) exited 1 after 1473.6
seconds: 184 passed, 80 skipped, 188 failed. Navigation timeouts were common.
Renderer sources, component fixtures and component specs match the target main;
the component owners were not rerun individually, so these observations are not
classified as flakes. The subsequent public-site smoke command did not run.
Evidence: `orkestrator-test-run.hj309s/merge-component-browser-private.log.gz`.

## Focused checks

All commands used `test:logged`; focused Bun runs used `--parallel=1` and the
owning package's preload. Subsequent focused invocations removed inherited `PORT`.
Root reruns also used the testing guide's GNU-tool PATH prefix. No implementation,
assertion, skip or timeout was changed in response to a failure.

| Check | Result |
| --- | --- |
| Repository formatting, lint, typecheck and desktop build | Passed. The environment-input component's existing effect warning predates the merge. |
| Changed backend owners: container accounts, model catalogue, commands, server registry and portable inputs | Passed, 112.5 s. |
| Desktop profile credential seeding and backend process owners | Passed, 160.0 s. |
| Protocol login snapshots; environment-input component | Passed, 0.4 s and 3.4 s. |
| Flake index contract | Passed, 2.9 s before this evidence entry. |
| Root `test-all`, firewall refresh, firewall policy, diagnostic bounds and disk report owners, each separately | Passed unchanged, 34.8 / 15.8 / 21.8 / 12.1 / 4.7 s. These confirm intermittent aggregate failures for those owners. |
| Root `runtime-env-wiring.test.ts`, including imported login restriction | Passed, 7.5 s. |
| Root Pi vendoring owner | Still timed out at 30,000 ms; 3 passed, 1 failed, 32.3 s overall. This occurrence does not independently establish a flake. Evidence: `orkestrator-test-run.3o0ptb`. |

## Real-stack browser and Electron results

- Isolated browser: `merge-browser-isolated` hit its 15-minute suite deadline
  (951.4 s including lifecycle). It reported narrow host-picker and maintenance
  drawer failures before interruption. Evidence: `orkestrator-test-run.dqUqcH`.
- Gateway owning-file rerun on fresh credential-free profile
  `merge-cold-c5a87653-owner`: 11 passed, nine skipped, three failed in 10.4 min.
  The narrow host picker still could not find its navigation controls; agent mail
  timed out during a click; narrow maintenance could not select the fixture
  project. This owner remains non-green. Evidence: `orkestrator-test-run.B2645l`.
- Full Electron: 16 passed, one skipped, four failed, two did not run (1000.2 s).
  Independent windows and remote nicknames exceeded 120 s; terminal resume missed
  its environment entry; annotation keyboard selection missed native focus.
  Evidence: `orkestrator-test-run.I3nN63`.
- Separate unchanged Electron owners: terminal resume passed (122.0 s).
  `electron-main.spec.ts` still timed out in remote nicknames (two passed, one
  skipped, one failed; 283.5 s; `orkestrator-test-run.stCCBb`). Annotation keyboard
  selection passed on rerun, but the complete annotations owner failed a different
  focus assertion in capture-pixels (eight passed, one failed, one did not run;
  131.3 s; `orkestrator-test-run.qOknf3`). Neither whole owner is qualified green.

## Docker results and cleanup

The worktree-specific development image built successfully (932.5 s). On
credential-free profile `merge-cold-c5a87653-docker`, `mise run test:agent:docker`
reported eight passed, two skipped and one failed (445.0 s). The new access-only
Codex/Grok boot-and-restart imports and withheld-login UI rehydration passed.
The unchanged rebuild scenario missed `Before a rebuild` after reload; its full
owning file passed unchanged alone (66.9 s), confirming an intermittent failure.
Evidence: `orkestrator-test-run.3kLiRI` and sanitized results under
`output/agent-testing/merge-cold-c5a87653-docker*`.

The one-shot runner stopped/reset its profile. Both manual profiles above were
stopped and reset with `dev:stop` and `dev:reset`; Docker reset removed only that
profile's three containers, six volumes and one network. Credentialed provider
tests retained their opt-ins. CLI scenario and iOS suites were omitted because
those areas did not change. Browser/native failures, Pi staging and incomplete
aggregate coverage remain validation limitations; host load is not a proven
explanation for them.

## Second main merge — 2026-10-22

Baseline `a973416e`, target `edcd60d92`; 415 incoming or resolved paths before
these validation evidence updates. Eight conflicts
combined the cold-restart and Claude revision-token qualification records,
test-suite registration, flake evidence and todo counts. Both suites remain
registered. The full path inventory contained no conflict markers or broken
local Markdown link targets.

- Formatting, lint, typecheck and the desktop build passed. After the test fix
  below, final formatting/lint/typecheck passed again. Focused flake-index,
  test-runner, mise-task, spec-loading and both live-test-helper contracts passed
  (26.3 s).
- Component and public-site browser suites passed (`main-refresh2-browser`,
  250.4 s), as did CLI scenarios (58.7 s) and the worktree-specific Docker image
  build (127.0 s).
- The first full non-iOS run failed only on the unchanged submodule-move owner
  (558.2 s). Its complete owning file passed unchanged alone (19.1 s); see
  [0248](0248-move-restart-recovery-submodule-timeout.md). Root/support, bridges
  and protocol regeneration passed in the aggregate. Evidence:
  `orkestrator-test-run.ZQ12yB` and `orkestrator-test-run.1b7Rd4`.
- Isolated browser: 28 passed, 45 skipped, one failed (503.0 s). The capped-file
  tree case could not find its `build` folder after reload. Its trace then
  exceeded the sanitizer's 16 MiB limit, producing a separate teardown error;
  the limit was retained. Evidence: `orkestrator-test-run.HUNzaS` and sanitized
  artifacts under `output/agent-testing/qa-browser-ede86f62-840/browser/`.
- Docker initially reported nine passed, two skipped and one failed (106.1 s):
  the incoming command-only seed test read `/workspace/.env.review-seed`
  immediately after `start_environment` returned, before asynchronous workspace
  setup copied it. This test now waits for authoritative `setupScriptsComplete`
  before checking file content and staging deletion. Its assertions and overall
  test deadline are retained. The full Docker suite passed after that fix
  (`main-refresh2-docker-fixed`, 72.2 s). Initial evidence:
  `orkestrator-test-run.U25409`; passing results:
  `output/agent-testing/cold-refresh2-c5a8-docker-fixed/browser/results.json`.
- A whole `browser-gateway.spec.ts` rerun with Docker enabled and `--trace=off`
  (to avoid another oversized trace) passed the capped-tree and seed scenarios,
  but still failed narrow maintenance navigation at line 2426: the drawer could
  not select project `origin`. Result: 19 passed, four skipped, one failed
  (150.8 s). The whole owner remains non-green, so this is not classified as an
  unchanged-owner flake. Evidence: `orkestrator-test-run.gho0st` and
  `output/agent-testing/cold-refresh2-c5a8-gateway-owner/browser/`.
- Full Electron validation passed (29 passed, one skipped;
  `main-refresh2-electron`, 139.3 s), with
  results under `output/agent-testing/cold-refresh2-c5a8-electron/electron/`.
- The complete non-iOS retry passed all four groups
  (`env -u PORT mise run test:logged -- --name main-refresh2-warm -- mise run test`,
  exit 0, 445.8 s). Passing summary: `orkestrator-test-run.GZGyER/summary.json`.
  This qualifies the aggregate retry; the separate isolated/browser-owner
  failures above remain validation limitations.

The isolated runner stopped/reset its own profile. Manual profile
`cold-refresh2-c5a8-docker` was stopped and reset after its suites; reset removed
three exact-owner containers, six volumes and one network. Live provider tests
retained their opt-ins; iOS was not run because its implementation did not change.
