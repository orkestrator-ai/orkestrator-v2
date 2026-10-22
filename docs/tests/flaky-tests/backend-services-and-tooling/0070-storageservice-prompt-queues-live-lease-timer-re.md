# `StorageService prompt queues > live lease timer restores and announces a sole claimed head` (`apps/backend/src/core/storage-prompt-queues.test.ts`)

- **ID:** 0070
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-review-980919fe-full-tests.log`
- **Worker configuration:** The backend workspace package ran `bun test src tests --parallel` while the other workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The queue had recovered the expired sole claim and reached revision 3, but `events` was still `[]` instead of containing the expected `{ resource: "prompt-queue", id: "e1" }` announcement (duration: 44.42 ms).
- **Suite counts:** Backend package: 1,647 total, 1,646 passed, 1 failed across 55 files. The aggregate also had one separate deterministic root-suite failure from the reviewed activity-source change.
- **Isolated rerun:** `bun test --cwd apps/backend src/core/storage-prompt-queues.test.ts` -> 57 passed, 0 failed, 197 assertions in 1.87 seconds; the target passed in 51.94 ms.
- **Recurrence (session-liveness review, 2026-08-14):** `set -o pipefail; bun test --cwd apps/backend src tests --parallel` at `c4ce823fb218e0f858115c0e0ada81203998c10a` failed identically — `expect(received).toContainEqual(expected)` with `Expected to contain: ObjectContaining { resource: "prompt-queue", id: "e1" }` and `Received: []` at `storage-prompt-queues.test.ts:366:22` (duration: 83.60 ms). Backend package: 1,696 total, 1,695 passed, 1 failed across 55 files. The immediate isolated rerun, `bun test --cwd apps/backend ./src/core/storage-prompt-queues.test.ts`, passed all 57 tests. A preceding backend run at the same head passed this test and failed a different one in the same package, so the two alternate rather than compound. Evidence: `/tmp/rev-backend-tests-c4ce823f.log`, `/tmp/rev-isolated-storage-prompt-queues.log`.
- **Hypothesis:** The test uses a 25 ms real-time lease, clears claim-announcement events immediately after the claim call, and then polls the durable queue separately from the listener. Under aggregate scheduling, lease recovery can race that reset/observation boundary even though the recovered queue state is correct. A deterministic clock or explicit recovery boundary should be evaluated before changing the product timer.
