# Empty process-group probe can report a live member

- **ID:** 7271
- **Status:** resolved
- **Date observed:** 2026-11-06
- **Test:** `groupHasLiveMember > sees a running member and ignores an empty group`
- **File:** `packages/protocol/src/node/shell-process-state.test.ts:96`
- **Original command:** `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1 mise run test:logged -- --name review-default-tests -- mise run test`
- **Worker configuration:** protocol workspace tests in the concurrent default aggregate; the workspace group reserved six worker slots alongside root and bridge groups.
- **Failure:** `groupHasLiveMember(2 ** 22 + 1)` returned `true` instead of `false`, after 542.77 ms.
- **Suite counts:** the enclosing default aggregate failed in 1,265.2 s; its root group reported 3,738 passed and 12 failed. Workspace and root groups failed; bridge and protocol-regeneration groups passed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.PCIx5Q/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` (compressed on finalization); outer directory `orkestrator-test-run.WDOGkE`.
- **Isolated rerun:** `mise run test:logged -- --name repair-shell-state-alone -- bun test --cwd packages/protocol ./src/node/shell-process-state.test.ts --parallel=1 --only-failures` passed, exit 0, in 1.7 s. Passing output was deleted by the logged runner; individual assertion counts were not retained.
- **Scope:** this transcript-restoration branch changes neither the process-state implementation nor its tests. No test or timeout was loosened.
- **Hypothesis:** none established. The isolated pass establishes intermittent behavior, not its cause.

## Resolution (2026-11-10)

- **Root cause:** on macOS `groupHasLiveMember`
  (`packages/protocol/src/node/shell-process-state.ts`) runs a synchronous
  `/bin/ps -A -o pgid=,stat=` with `PROCESS_INSPECTION_OPTIONS` (100 ms
  timeout, `SIGKILL`) and, by design, answers `true` ("unknown is yes") when
  the scan does not finish. On a loaded host a real `ps -A` over ~1,300
  processes takes longer: five timed runs at load ~50 took 80 to 210 ms. The
  test asserted the classification of a real, unbounded-in-practice scan, so
  an empty group (`2 ** 22 + 1`) or a zombie-only group read `true`. The
  product side is intended: its only caller, `commandGroupAlive` in
  `command-capture.ts`, polls again with backoff, so a slow scan delays a
  command's settlement instead of deciding it wrongly.
- **Fix:** `shell-process-state.test.ts` runs the two classification cases
  through `withUnhurriedInspection`, which passes `/bin/ps` calls through to
  the real `Bun.spawnSync` with a 30 s timeout, so they check what a
  completed scan means. The 100 ms bound and the unknown-is-yes answer stay
  covered by `process inspection times out and treats failed ps as unknown`.
  `withZombie` now throws if no zombie appeared within its 3 s wait rather
  than running the check against a still-running shell. No assertion was
  loosened.
- **Reproduced:** yes — on the unchanged owner at host load ~50,
  `mise run test:logged -- --name repro-group-live -- bun test --cwd
  packages/protocol --preload ../../tests/setup-node.ts
  ./src/node/shell-process-state.test.ts -t groupHasLiveMember
  --rerun-each=20` failed 15 of 40 (both cases, `true` for `false`). The same
  command after the fix (`fixed-group-live`) passed 40 of 40.
- **Stress:** `mise run test:logged -- --name whole-process-state -- bun test
  --cwd packages/protocol --preload ../../tests/setup-node.ts
  ./src/node/shell-process-state.test.ts --rerun-each=20` passed (macOS, load
  ~50).
