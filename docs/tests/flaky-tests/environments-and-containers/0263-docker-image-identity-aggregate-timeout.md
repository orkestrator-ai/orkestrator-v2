# Docker image identity aggregate timeout

- **ID:** 0263
- **Status:** resolved
- **Date observed:** 2026-10-16
- **Test:** `image identity > resolves a tag to its immutable id and registry digest`
  (`apps/backend/tests/docker-image.test.ts:152`).
- **Original command:** `mise run test:logged -- --name review-tests -- mise run test`.
- **Worker configuration:** standard aggregate runner; workspace group reserved
  four worker slots, with two Bun workers per package, while root, bridge and
  protocol groups also ran.
- **Failure:** the case timed out after 5003.82 ms, and Bun killed one dangling
  process. The fixture replaces Docker with a local shell script.
- **Suite counts:** backend reported 8,386 passed, 40 skipped, four failed and
  two between-tests errors across 449 files;
  the other three failures reproduced in their owning files with the original
  PATH and involved Python helpers.
- **Isolated rerun:** `mise run test:logged -- --name docker-image-isolated --
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/docker-image.test.ts --parallel=1 --only-failures` passed unchanged,
  exit 0, in 2.8 seconds, with the original PATH.
- **Evidence:** original compressed workspace log at
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.uz1gk2/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** fixture subprocess work exceeded the generic five-second
  budget under aggregate host load. The isolated pass establishes timing
  sensitivity, but does not identify which subprocess stalled.

## Resolution (2026-11-15)

- **Root cause:** Tag resolution through fake Docker exceeded Bun's 5 s default under aggregate load.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-b -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 13 --burners 6 -- bun test --preload ../../tests/setup-node.ts <seventeen container, pipeline, move, worktree and native-agent owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 1,139 passed, 1 failed — `git fsmonitor > fixture repositories inherit fsmonitor off from the test preload` on its second rerun, which fails the same way without contention and with the unchanged file (`git-fsmonitor.test.ts` is not rerun-safe).
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
