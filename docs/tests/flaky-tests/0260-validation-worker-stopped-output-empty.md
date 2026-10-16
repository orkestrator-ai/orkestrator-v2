# Stopped cooperative validation command loses its partial output in the aggregate

- **ID:** 0260
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `stopping a running cooperative command preserves incomplete evidence`
- **Owning file:** `apps/backend/src/core/review-validation-worker.test.ts:544`
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridge/protocol reservations 4/1/2/1, backend two isolated workers, alongside component and isolated-stack browser checks.
- **Failure:** expected stdout to contain `partial cooperative output`, received an empty string (1491.28 ms).
- **Suite counts:** backend 8,456 passed, 40 skipped, two failed and one error across 8,498 tests (481.96 s); aggregate exited 1 in 645.7 s.
- **Owning-file reruns:** the first two reruns passed this case but failed `drops overlong drifted paths and makes a 1024-path cap observable` because its `python3` subprocess used the host's hanging mise/pyenv shim (45 passed, one failed; 61.2 and 57.5 s). These runs alone did not establish a flake.
- **Isolated verification:** `mise run test:logged -- --name merge-validation-worker-system-python -- env PATH="<pinned Bun and GNU utilities>:/usr/bin:/bin:<remaining host PATH>" bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures` passed the unchanged owning file in 51.1 s (exit 0), placing system Python ahead of the host shims.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.Gj6LAK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; shim-related reruns are in `orkestrator-test-run.B3iYcu` and `orkestrator-test-run.K498Kb` under the same temporary root.
- **Hypothesis:** the stop raced the fixture's first stdout write under aggregate load; unconfirmed. No assertions, timeouts or skips changed.
