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

## Container state observation main merge — 2026-10-24

- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`, merging feature `66a9736cc` and main `d6ed0717d`; default workspace/root/bridge/protocol 4/1/2/1 plan alongside browser, Electron and Docker checks.
- **Owning-file rerun:** `stopping a running cooperative command preserves incomplete evidence` expected `partial cooperative output` but received empty stdout (1236.62 ms). The cooperative-group deadline case also failed. This stop case did not fail in the original aggregate.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-review-worker-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures` failed: 47 passed and two failed across 49 tests in 100.73 s.
- **Evidence:** `orkestrator-test-run.bFHIz7/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.pQ8a8n/merge-review-worker-owner.log.gz` below the host temporary directory.
- **Assessment:** no new isolated pass or root cause was established. No implementation, assertion, timeout or skip changed.

## Failing-tests branch main merge — 2026-10-25

- **Merge parents:** feature `d0769b278573edbdafc6de496e7108fd6ee146c1` and main `b52267c2611fc7fd418e346640309b16a28bc8d4`.
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, default workspace/root/bridge/protocol reservations 4/1/2/1 and two isolated backend workers. Formatting, lint and typechecking also ran; no browser scenario suite ran.
- **Failure:** expected stdout to contain `partial cooperative output`, received an empty string at `review-validation-worker.test.ts:567` (1068.79 ms).
- **Suite counts:** backend 11,524 passed, 151 skipped and one failed across 11,676 tests (467.94 s). All other packages and the root, bridge and protocol groups passed. The aggregate exited 1 in 696.4 s.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-review-worker-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures` passed, exit 0 in 35.3 s, after the aggregate finished.
- **Evidence:** `/tmp/orkestrator-test-run.67KJPk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer logged command `/tmp/orkestrator-test-run.urQT6W/merge-tests.log.gz`.
- **Assessment:** recurrence of the recorded intermittent missing-output failure, confirmed by the complete unchanged owner's isolated pass. The stop racing the fixture's first stdout write remains an unconfirmed hypothesis. No implementation, assertion, timeout or skip changed.
