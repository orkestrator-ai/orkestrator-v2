# Docker image identity aggregate timeout

- **ID:** 0263
- **Status:** open
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
